import assert from 'node:assert/strict';
import test from 'node:test';
import { createMonitorServer } from '../../src/http.js';

const token = 'unit-monitor-token-0001';

async function withServer(run) {
  const calls = [];
  const service = {
    async createSource(body) {
      calls.push(['source', body]);
      return { phase: 'source_ready', created: true };
    },
    async query(input) {
      calls.push(['query', input]);
      return { phase: 'query_materialized', replayed: false };
    },
  };
  const repository = {
    async getState() { return { phase: 'state_read', sampleCount: 0 }; },
  };
  const logs = [];
  const server = createMonitorServer({ service, repository, apiToken: token, logger: (value) => logs.push(value) });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  try {
    await run({ base: `http://127.0.0.1:${address.port}`, calls, logs });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('health is public while state requires bearer authentication', async () => {
  await withServer(async ({ base }) => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/v1/state`)).status, 401);
    const response = await fetch(`${base}/v1/state`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).phase, 'state_read');
  });
});

test('source and query routes pass only authenticated parsed input', async () => {
  await withServer(async ({ base, calls }) => {
    const source = await fetch(`${base}/v1/sources`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ sourceId: 'source-a' }),
    });
    assert.equal(source.status, 201);
    const query = await fetch(`${base}/v1/queries`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'idempotency-key': 'query-key-0001',
      },
      body: JSON.stringify({ metric: 'cpu_utilization' }),
    });
    assert.equal(query.status, 201);
    assert.deepEqual(calls.map(([name]) => name), ['source', 'query']);
    assert.equal(calls[1][1].principal, 'lab-operator');
    assert.equal(calls[1][1].requestKey, 'query-key-0001');
  });
});

test('unknown routes and invalid JSON return bounded error vocabulary', async () => {
  await withServer(async ({ base, logs }) => {
    const missing = await fetch(`${base}/v1/missing`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, 'not_found');
    const invalid = await fetch(`${base}/v1/sources`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{',
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, 'invalid_request');
    assert.ok(logs.every((entry) => !('body' in entry) && !('authorization' in entry)));
  });
});
