import assert from 'node:assert/strict';
import test from 'node:test';
import {
  digestValue,
  limits,
  normalizeEvaluation,
  normalizeLabels,
  normalizeQuery,
  normalizeRule,
  normalizeSilence,
  normalizeWrite,
} from '../../src/contracts.js';

const now = new Date('2026-08-19T00:10:00.000Z');

function sample(overrides = {}) {
  return {
    metric: 'cpu_utilization',
    labels: { zone: 'west', host: 'synthetic-01' },
    observedAt: '2026-08-19T00:09:00.000Z',
    type: 'gauge',
    value: 72.5,
    ...overrides,
  };
}

test('canonical JSON and series identity ignore object insertion order', () => {
  const left = digestValue({ labels: normalizeLabels({ zone: 'west', host: 'synthetic-01' }) });
  const right = digestValue({ labels: normalizeLabels({ host: 'synthetic-01', zone: 'west' }) });
  assert.equal(left, right);
});

test('write canonicalization ignores sample order and exact duplicates', () => {
  const first = sample();
  const second = sample({ labels: { host: 'synthetic-02', zone: 'west' }, value: 41 });
  const left = normalizeWrite({
    sourceId: 'source-a',
    sourceEpoch: 0,
    batchSequence: 0,
    samples: [first, second, first],
  }, { now });
  const right = normalizeWrite({
    sourceId: 'source-a',
    sourceEpoch: 0,
    batchSequence: 0,
    samples: [second, first],
  }, { now });
  assert.equal(left.intentDigest, right.intentDigest);
  assert.equal(left.submittedCount, 3);
  assert.equal(left.uniqueCount, 2);
});

test('one batch rejects changed values for one series timestamp', () => {
  assert.throws(() => normalizeWrite({
    sourceId: 'source-a',
    sourceEpoch: 0,
    batchSequence: 0,
    samples: [sample(), sample({ value: 73 })],
  }, { now }), { code: 'conflict' });
});

test('metric input rejects unsupported type, non-finite value, and unsafe times', () => {
  for (const changed of [
    { type: 'counter' },
    { value: Number.NaN },
    { observedAt: '2026-08-11T00:00:00.000Z' },
    { observedAt: '2026-08-19T00:16:00.000Z' },
  ]) {
    assert.throws(() => normalizeWrite({
      sourceId: 'source-a',
      sourceEpoch: 0,
      batchSequence: 0,
      samples: [sample(changed)],
    }, { now }), { code: 'invalid_request' });
  }
});

test('labels are bounded, canonical, and reject sensitive high-cardinality names', () => {
  assert.deepEqual(normalizeLabels({ zone: 'west', host: 'one' }), { host: 'one', zone: 'west' });
  assert.throws(() => normalizeLabels({ request_id: 'synthetic' }), { code: 'invalid_request' });
  assert.throws(
    () => normalizeLabels(Object.fromEntries(Array.from({ length: limits.maximumLabels + 1 }, (_, index) => [`l${index}`, 'x']))),
    { code: 'invalid_request' },
  );
});

test('query range is half-open, canonical, and bounded', () => {
  const query = normalizeQuery({
    metric: 'cpu_utilization',
    labels: { host: 'synthetic-01' },
    start: '2026-08-19T00:00:00.000Z',
    end: '2026-08-19T01:00:00.000Z',
    limit: 100,
  });
  assert.equal(query.start, '2026-08-19T00:00:00.000Z');
  assert.equal(query.end, '2026-08-19T01:00:00.000Z');
  assert.throws(() => normalizeQuery({
    metric: 'cpu_utilization',
    labels: {},
    start: '2026-08-18T00:00:00.000Z',
    end: '2026-08-19T00:00:00.001Z',
    limit: 1,
  }), { code: 'invalid_request' });
});

test('rule contract fixes gauge threshold, missing policy, and work bounds', () => {
  const rule = normalizeRule({
    ruleId: 'cpu-hot',
    metric: 'cpu_utilization',
    labels: { host: 'synthetic-01' },
    threshold: 80,
    lookbackSeconds: 120,
    intervalSeconds: 60,
    consecutiveTrueSlots: 2,
  });
  assert.equal(rule.missingPolicy, 'reset_pending_keep_firing');
  assert.equal(rule.seriesDigest.length, 64);
  assert.throws(() => normalizeRule({
    ruleId: 'cpu-hot',
    metric: 'cpu_utilization',
    labels: {},
    threshold: 80,
    lookbackSeconds: 120,
    intervalSeconds: 1,
    consecutiveTrueSlots: 2,
  }), { code: 'invalid_request' });
});

test('evaluation and silence require canonical timestamps and bounded duration', () => {
  assert.equal(normalizeEvaluation({
    generation: 1,
    evaluatorId: 'evaluator-a',
    evaluatorEpoch: 1,
    slot: '2026-08-19T00:10:00.000Z',
  }).slot, '2026-08-19T00:10:00.000Z');
  assert.throws(() => normalizeSilence({
    ruleId: 'cpu-hot',
    startsAt: '2026-08-19T00:00:00.000Z',
    endsAt: '2026-08-20T00:00:00.001Z',
  }), { code: 'invalid_request' });
});
