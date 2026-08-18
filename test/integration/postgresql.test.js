import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test, { after, before, beforeEach } from 'node:test';
import pg from 'pg';
import { initializeDatabase, MonitorRepository, resetDatabase } from '../../src/repository.js';
import { MonitorService } from '../../src/service.js';

const { Pool } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required; infrastructure tests never skip');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12, statement_timeout: 10_000 });
const repository = new MonitorRepository(pool);
const service = new MonitorService(repository);
const principal = 'lab-operator';

const slotBaseMs = Math.floor(Date.now() / 60_000) * 60_000 - 5 * 60_000;
const slot = (offset) => new Date(slotBaseMs + offset * 60_000).toISOString();

function gauge({ host = 'synthetic-01', observedAt = slot(0), value = 90 } = {}) {
  return { metric: 'cpu_utilization', labels: { host }, observedAt, type: 'gauge', value };
}

function batch(sequence, samples, overrides = {}) {
  return {
    sourceId: 'source-a',
    sourceEpoch: 0,
    batchSequence: sequence,
    samples,
    ...overrides,
  };
}

function rule(ruleId = 'cpu-hot', overrides = {}) {
  return {
    ruleId,
    metric: 'cpu_utilization',
    labels: { host: 'synthetic-01' },
    threshold: 80,
    lookbackSeconds: 120,
    intervalSeconds: 60,
    consecutiveTrueSlots: 2,
    ...overrides,
  };
}

async function createSource() {
  return service.createSource({ sourceId: 'source-a' });
}

async function createRule(body = rule(), requestKey = 'rule-key-0001') {
  return service.createRule({ principal, requestKey, body });
}

async function evaluator(workerId = 'evaluator-a', expectedEpoch = 0, requestKey = 'evaluator-key-0001') {
  return service.rotateAuthority({
    principal,
    requestKey,
    kind: 'evaluator',
    body: { workerId, expectedEpoch },
  });
}

async function evaluate(at, overrides = {}) {
  return service.evaluate({
    ruleId: overrides.ruleId ?? 'cpu-hot',
    body: {
      generation: overrides.generation ?? 1,
      evaluatorId: overrides.evaluatorId ?? 'evaluator-a',
      evaluatorEpoch: overrides.evaluatorEpoch ?? 1,
      slot: at,
    },
  });
}

before(async () => initializeDatabase(pool));
beforeEach(async () => resetDatabase(pool, 'snapshot-monitoring-lab-reset'));
after(async () => pool.end());

test('ingest replay is stable and changed intent conflicts', async () => {
  await createSource();
  const input = batch(0, [gauge()]);
  const first = await service.ingest(input);
  const replay = await service.ingest(input);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(replay.ingestRevision, first.ingestRevision);
  await assert.rejects(service.ingest(batch(0, [gauge({ value: 91 })])), { code: 'conflict' });
  assert.deepEqual(await repository.getState(), {
    phase: 'state_read',
    ingestRevision: 1,
    sourceCount: 1,
    seriesCount: 1,
    sampleCount: 1,
    ingestReceiptCount: 1,
    queryReceiptCount: 0,
    ruleGenerationCount: 0,
    evaluationCount: 0,
    firingIncidentCount: 0,
    resolvedIncidentCount: 0,
    suppressedTransitionCount: 0,
    pendingNotificationCount: 0,
    leasedNotificationCount: 0,
    acceptedNotificationCount: 0,
    providerAttemptCount: 0,
    providerAcceptanceCount: 0,
    evaluatorEpoch: 0,
    notificationEpoch: 0,
  });
});

test('same value across batches deduplicates while a changed value rolls the whole batch back', async () => {
  await createSource();
  await service.ingest(batch(0, [gauge()]));
  const duplicate = await service.ingest(batch(1, [gauge()]));
  assert.equal(duplicate.insertedCount, 0);
  assert.equal(duplicate.duplicateCount, 1);
  await assert.rejects(service.ingest(batch(2, [
    gauge({ host: 'synthetic-02', observedAt: slot(1), value: 50 }),
    gauge({ value: 99 }),
  ])), { code: 'conflict' });
  const state = await repository.getState();
  assert.equal(state.ingestRevision, 2);
  assert.equal(state.seriesCount, 1);
  assert.equal(state.sampleCount, 1);
  const recovered = await service.ingest(batch(2, [gauge({ host: 'synthetic-02', observedAt: slot(1), value: 50 })]));
  assert.equal(recovered.ingestRevision, 3);
});

test('concurrent exact ingest has one mutation and one replay', async () => {
  await createSource();
  const results = await Promise.all([
    service.ingest(batch(0, [gauge()])),
    service.ingest(batch(0, [gauge()])),
  ]);
  assert.deepEqual(results.map((entry) => entry.replayed).sort(), [false, true]);
  const state = await repository.getState();
  assert.equal(state.ingestRevision, 1);
  assert.equal(state.sampleCount, 1);
});

test('query retry keeps its snapshot after a late sample becomes visible', async () => {
  await createSource();
  await service.ingest(batch(0, [gauge({ observedAt: slot(0), value: 70 })]));
  const body = {
    metric: 'cpu_utilization',
    labels: { host: 'synthetic-01' },
    start: slot(-1),
    end: slot(3),
    limit: 10,
  };
  const first = await service.query({ principal, requestKey: 'query-key-0001', body });
  await service.ingest(batch(1, [gauge({ observedAt: slot(1), value: 90 })]));
  const replay = await service.query({ principal, requestKey: 'query-key-0001', body });
  const current = await service.query({ principal, requestKey: 'query-key-0002', body });
  assert.equal(first.snapshotRevision, 1);
  assert.equal(replay.snapshotRevision, 1);
  assert.equal(replay.replayed, true);
  assert.equal(replay.samples.length, 1);
  assert.equal(current.snapshotRevision, 2);
  assert.equal(current.samples.length, 2);
  await assert.rejects(service.query({
    principal,
    requestKey: 'query-key-0001',
    body: { ...body, limit: 9 },
  }), { code: 'conflict' });
});

test('late sample never rewrites a committed firing evaluation', async () => {
  await createSource();
  await service.ingest(batch(0, [gauge({ observedAt: slot(0), value: 90 })]));
  await createRule();
  await evaluator();
  const pending = await evaluate(slot(0));
  const firing = await evaluate(slot(1));
  assert.equal(pending.stateAfter, 'pending');
  assert.equal(firing.stateAfter, 'firing');
  assert.equal(firing.transition.kind, 'firing');
  await service.ingest(batch(1, [gauge({ observedAt: slot(1), value: 10 })]));
  const replay = await evaluate(slot(1));
  assert.equal(replay.replayed, true);
  assert.equal(replay.outcome, 'true');
  assert.equal(replay.snapshotRevision, 1);
  const resolved = await evaluate(slot(2));
  assert.equal(resolved.outcome, 'false');
  assert.equal(resolved.transition.kind, 'resolved');
  assert.equal(resolved.incidentId, firing.incidentId);
});

test('unknown input is explicit and does not satisfy pending continuity', async () => {
  await createSource();
  await createRule(rule('cpu-hot', { lookbackSeconds: 30 }));
  await evaluator();
  const missing = await evaluate(slot(0));
  assert.equal(missing.outcome, 'unknown');
  assert.equal(missing.sample, null);
  await service.ingest(batch(0, [gauge({ observedAt: slot(1), value: 90 })]));
  const pending = await evaluate(slot(1));
  const reset = await evaluate(slot(2));
  assert.equal(pending.stateAfter, 'pending');
  assert.equal(reset.outcome, 'unknown');
  assert.equal(reset.stateAfter, 'inactive');
  assert.equal(reset.transition, null);
});

test('silence suppresses routing without changing firing truth or incident state', async () => {
  await createSource();
  await service.ingest(batch(0, [gauge({ observedAt: slot(0), value: 90 })]));
  await createRule(rule('cpu-hot', { consecutiveTrueSlots: 1 }));
  await evaluator();
  await service.createSilence({
    principal,
    requestKey: 'silence-key-0001',
    body: { ruleId: 'cpu-hot', startsAt: slot(0), endsAt: slot(2) },
  });
  const result = await evaluate(slot(0));
  assert.equal(result.outcome, 'true');
  assert.equal(result.stateAfter, 'firing');
  assert.equal(result.transition.routing.status, 'suppressed');
  const incident = await repository.getIncident(result.incidentId);
  assert.equal(incident.status, 'firing');
  assert.equal(incident.transitions[0].routing.status, 'suppressed');
  const state = await repository.getState();
  assert.equal(state.suppressedTransitionCount, 1);
  assert.equal(state.pendingNotificationCount, 0);
});

test('authority and generation fences reject stale new work while exact evaluation replay survives', async () => {
  await createSource();
  await service.ingest(batch(0, [gauge({ observedAt: slot(0), value: 10 })]));
  await createRule();
  await evaluator();
  const first = await evaluate(slot(0));
  await evaluator('evaluator-b', 1, 'evaluator-key-0002');
  const replay = await evaluate(slot(0));
  assert.equal(replay.replayed, true);
  assert.equal(replay.evaluationId, first.evaluationId);
  await assert.rejects(evaluate(slot(1)), { code: 'fenced' });
  const generation = await service.createRuleGeneration({
    principal,
    requestKey: 'generation-key-0001',
    ruleId: 'cpu-hot',
    body: {
      expectedGeneration: 1,
      metric: 'cpu_utilization',
      labels: { host: 'synthetic-01' },
      threshold: 70,
      lookbackSeconds: 120,
      intervalSeconds: 60,
      consecutiveTrueSlots: 2,
    },
  });
  assert.equal(generation.generation, 2);
  await assert.rejects(evaluate(slot(1), { generation: 1, evaluatorId: 'evaluator-b', evaluatorEpoch: 2 }), {
    code: 'fenced',
  });
});

test('transition and routable outbox commit atomically and evaluation replay does not duplicate either', async () => {
  await createSource();
  await service.ingest(batch(0, [gauge({ observedAt: slot(0), value: 90 })]));
  await createRule(rule('cpu-hot', { consecutiveTrueSlots: 1 }));
  await evaluator();
  const first = await evaluate(slot(0));
  const replay = await evaluate(slot(0));
  assert.equal(replay.transition.transitionId, first.transition.transitionId);
  assert.equal(replay.transition.routing.notificationId, first.transition.routing.notificationId);
  const counts = await pool.query(`
    SELECT
      (SELECT count(*) FROM mm_transitions) AS transitions,
      (SELECT count(*) FROM mm_routing_receipts) AS routes,
      (SELECT count(*) FROM mm_notification_outbox) AS outbox
  `);
  assert.deepEqual(Object.values(counts.rows[0]).map(Number), [1, 1, 1]);
});

test('expired notification claim retries under a new epoch and stale completion is fenced', async () => {
  await createSource();
  await service.ingest(batch(0, [gauge({ observedAt: slot(0), value: 90 })]));
  await createRule(rule('cpu-hot', { consecutiveTrueSlots: 1 }));
  await evaluator();
  await evaluate(slot(0));
  await service.rotateAuthority({
    principal,
    requestKey: 'notify-auth-0001',
    kind: 'notification',
    body: { workerId: 'notifier-a', expectedEpoch: 0 },
  });
  const first = await repository.claimNotification({ workerId: 'notifier-a', workerEpoch: 1, leaseSeconds: 1 });
  await service.rotateAuthority({
    principal,
    requestKey: 'notify-auth-0002',
    kind: 'notification',
    body: { workerId: 'notifier-b', expectedEpoch: 1 },
  });
  await assert.rejects(repository.completeNotification({
    workerId: 'notifier-a',
    workerEpoch: 1,
    notificationId: first.notificationId,
    attempt: first.attempt,
    providerReceipt: { phase: 'provider_accepted' },
  }), { code: 'fenced' });
  await delay(1100);
  const second = await repository.claimNotification({ workerId: 'notifier-b', workerEpoch: 2, leaseSeconds: 1 });
  assert.equal(second.notificationId, first.notificationId);
  assert.equal(second.attempt, 2);
  const accepted = await repository.acceptProvider({
    notificationId: second.notificationId,
    transitionKind: second.transitionKind,
    attempt: second.attempt,
  });
  const replay = await repository.acceptProvider({
    notificationId: second.notificationId,
    transitionKind: second.transitionKind,
    attempt: second.attempt,
  });
  assert.equal(accepted.replayed, false);
  assert.equal(replay.replayed, true);
  await repository.completeNotification({
    workerId: 'notifier-b',
    workerEpoch: 2,
    notificationId: second.notificationId,
    attempt: second.attempt,
    providerReceipt: accepted,
  });
  const state = await repository.getState();
  assert.equal(state.acceptedNotificationCount, 1);
  assert.equal(state.providerAttemptCount, 1);
  assert.equal(state.providerAcceptanceCount, 1);
});
