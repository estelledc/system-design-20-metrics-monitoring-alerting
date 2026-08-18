import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { initializeDatabase, MonitorRepository, resetDatabase } from '../src/repository.js';

const { Pool } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required; infrastructure smoke never skips');

const root = fileURLToPath(new URL('..', import.meta.url));
const apiToken = 'smoke-monitor-token-0001';
const providerToken = 'smoke-provider-token-0001';
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4, statement_timeout: 10_000 });
const repository = new MonitorRepository(pool);
const children = new Set();

function exitReceipt(child) {
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

async function startServer(command, readyEvent, extraEnv = {}) {
  const child = spawn(process.execPath, ['src/main.js', command], {
    cwd: root,
    env: {
      ...process.env,
      MON_API_TOKEN: apiToken,
      MON_PROVIDER_TOKEN: providerToken,
      PORT: '0',
      PROVIDER_PORT: '0',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const ready = new Promise((resolve, reject) => {
    const onExit = (code, signal) => reject(new Error(
      `${command} exited before readiness: code=${code} signal=${signal} stderr=${stderr}`,
    ));
    child.once('exit', onExit);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const lines = stdout.split('\n');
      stdout = lines.pop();
      for (const line of lines) {
        if (!line) continue;
        const event = JSON.parse(line);
        if (event.event === readyEvent) {
          child.off('exit', onExit);
          resolve({ child, port: event.port, output: () => stdout, stderr: () => stderr });
        }
      }
    });
  });
  return ready;
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = exitReceipt(child);
  child.kill('SIGTERM');
  await exited;
}

async function post(base, path, body, { key, expected = 200 } = {}) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiToken}`,
      'content-type': 'application/json',
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: JSON.stringify(body),
  });
  const value = await response.json();
  assert.equal(response.status, expected, JSON.stringify(value));
  return value;
}

async function state(base) {
  const response = await fetch(`${base}/v1/state`, { headers: { authorization: `Bearer ${apiToken}` } });
  assert.equal(response.status, 200);
  return response.json();
}

async function crashPost(server, path, body) {
  const exited = exitReceipt(server.child);
  await assert.rejects(fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }));
  const receipt = await exited;
  assert.equal(receipt.signal, 'SIGKILL');
  return receipt;
}

async function runNotifier(extraEnv = {}) {
  const child = spawn(process.execPath, ['src/main.js', 'notify-once'], {
    cwd: root,
    env: { ...process.env, MON_PROVIDER_TOKEN: providerToken, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exit = await exitReceipt(child);
  return { ...exit, stdout, stderr };
}

const slotBaseMs = Math.floor(Date.now() / 60_000) * 60_000 - 4 * 60_000;
const slot = (offset) => new Date(slotBaseMs + offset * 60_000).toISOString();
const highBatch = {
  sourceId: 'source-smoke',
  sourceEpoch: 0,
  batchSequence: 0,
  samples: [{
    metric: 'cpu_utilization',
    labels: { host: 'synthetic-smoke' },
    observedAt: slot(0),
    type: 'gauge',
    value: 95,
  }],
};

let api;
let provider;
try {
  await initializeDatabase(pool);
  await resetDatabase(pool, 'snapshot-monitoring-lab-reset');

  const ingestCrashApi = await startServer('serve', 'monitor_ready', { MON_CRASH_AFTER_INGEST_COMMIT: '1' });
  const ingestCrashBase = `http://127.0.0.1:${ingestCrashApi.port}`;
  await post(ingestCrashBase, '/v1/sources', { sourceId: 'source-smoke' }, { expected: 201 });
  const ingestCrash = await crashPost(ingestCrashApi, '/v1/samples', highBatch);

  api = await startServer('serve', 'monitor_ready');
  let base = `http://127.0.0.1:${api.port}`;
  const replayedIngest = await post(base, '/v1/samples', highBatch, { expected: 200 });
  assert.equal(replayedIngest.replayed, true);
  assert.equal(replayedIngest.phase, 'query_visible');

  await post(base, '/v1/rules', {
    ruleId: 'cpu-hot-smoke',
    metric: 'cpu_utilization',
    labels: { host: 'synthetic-smoke' },
    threshold: 80,
    lookbackSeconds: 120,
    intervalSeconds: 60,
    consecutiveTrueSlots: 2,
  }, { key: 'smoke-rule-0001', expected: 201 });
  await post(base, '/v1/evaluator/authority', {
    workerId: 'evaluator-smoke',
    expectedEpoch: 0,
  }, { key: 'smoke-evaluator-0001' });
  const pending = await post(base, '/v1/rules/cpu-hot-smoke/evaluations', {
    generation: 1,
    evaluatorId: 'evaluator-smoke',
    evaluatorEpoch: 1,
    slot: slot(0),
  }, { expected: 201 });
  assert.equal(pending.stateAfter, 'pending');

  await stop(api.child);
  const evaluationCrashApi = await startServer('serve', 'monitor_ready', { MON_CRASH_AFTER_EVALUATION_COMMIT: '1' });
  const evaluationCrash = await crashPost(evaluationCrashApi, '/v1/rules/cpu-hot-smoke/evaluations', {
    generation: 1,
    evaluatorId: 'evaluator-smoke',
    evaluatorEpoch: 1,
    slot: slot(1),
  });

  api = await startServer('serve', 'monitor_ready');
  base = `http://127.0.0.1:${api.port}`;
  const firingReplay = await post(base, '/v1/rules/cpu-hot-smoke/evaluations', {
    generation: 1,
    evaluatorId: 'evaluator-smoke',
    evaluatorEpoch: 1,
    slot: slot(1),
  });
  assert.equal(firingReplay.replayed, true);
  assert.equal(firingReplay.transition.kind, 'firing');
  assert.equal(firingReplay.transition.routing.status, 'routable');

  await post(base, '/v1/silences', {
    ruleId: 'cpu-hot-smoke',
    startsAt: slot(2),
    endsAt: slot(3),
  }, { key: 'smoke-silence-0001', expected: 201 });
  await post(base, '/v1/samples', {
    ...highBatch,
    batchSequence: 1,
    samples: [{ ...highBatch.samples[0], observedAt: slot(2), value: 10 }],
  }, { expected: 201 });
  const resolved = await post(base, '/v1/rules/cpu-hot-smoke/evaluations', {
    generation: 1,
    evaluatorId: 'evaluator-smoke',
    evaluatorEpoch: 1,
    slot: slot(2),
  }, { expected: 201 });
  assert.equal(resolved.outcome, 'false');
  assert.equal(resolved.stateAfter, 'inactive');
  assert.equal(resolved.transition.routing.status, 'suppressed');
  assert.equal(resolved.incidentId, firingReplay.incidentId);

  await post(base, '/v1/notification-workers/authority', {
    workerId: 'notifier-smoke-a',
    expectedEpoch: 0,
  }, { key: 'smoke-notifier-auth-0001' });
  provider = await startServer('provider', 'provider_ready');
  const providerUrl = `http://127.0.0.1:${provider.port}`;
  const notifierCrash = await runNotifier({
    MON_PROVIDER_URL: providerUrl,
    MON_NOTIFICATION_WORKER_ID: 'notifier-smoke-a',
    MON_NOTIFICATION_WORKER_EPOCH: '1',
    MON_NOTIFICATION_LEASE_SECONDS: '1',
    MON_CRASH_AFTER_PROVIDER_ACCEPTED: '1',
  });
  assert.equal(notifierCrash.signal, 'SIGKILL', notifierCrash.stderr);

  await post(base, '/v1/notification-workers/authority', {
    workerId: 'notifier-smoke-b',
    expectedEpoch: 1,
  }, { key: 'smoke-notifier-auth-0002' });
  await delay(1100);
  const notifierRecovery = await runNotifier({
    MON_PROVIDER_URL: providerUrl,
    MON_NOTIFICATION_WORKER_ID: 'notifier-smoke-b',
    MON_NOTIFICATION_WORKER_EPOCH: '2',
    MON_NOTIFICATION_LEASE_SECONDS: '1',
  });
  assert.equal(notifierRecovery.code, 0, notifierRecovery.stderr);
  assert.match(notifierRecovery.stdout, /"phase":"notification_provider_accepted"/);

  const finalState = await state(base);
  assert.equal(finalState.ingestRevision, 2);
  assert.equal(finalState.sampleCount, 2);
  assert.equal(finalState.evaluationCount, 3);
  assert.equal(finalState.resolvedIncidentCount, 1);
  assert.equal(finalState.suppressedTransitionCount, 1);
  assert.equal(finalState.pendingNotificationCount, 0);
  assert.equal(finalState.leasedNotificationCount, 0);
  assert.equal(finalState.acceptedNotificationCount, 1);
  assert.equal(finalState.providerAttemptCount, 2);
  assert.equal(finalState.providerAcceptanceCount, 1);

  process.stdout.write(`${JSON.stringify({
    evidence: 'true_process_crash_recovery',
    killedProcesses: [ingestCrash.signal, evaluationCrash.signal, notifierCrash.signal],
    ingestReplayPhase: replayedIngest.phase,
    evaluationReplayState: firingReplay.stateAfter,
    silenceRoutingStatus: resolved.transition.routing.status,
    notificationBoundary: 'provider_accepted',
    humanDeliveryProved: false,
    providerAttempts: finalState.providerAttemptCount,
    providerAcceptances: finalState.providerAcceptanceCount,
  })}\n`);
} finally {
  await Promise.all([...children].map((child) => stop(child)));
  await pool.end();
}
