import { sha256 } from './crypto.js';
import { conflict, invalid } from './errors.js';

export const monitorContract = Object.freeze({
  tenant: 'synthetic-lab',
  metricType: 'gauge',
  missingPolicy: 'reset_pending_keep_firing',
  destination: 'local-synthetic-provider',
  version: 1,
});

export const limits = Object.freeze({
  requestBodyBytes: 256 * 1024,
  requestKeyChars: 128,
  identifierChars: 64,
  metricNameChars: 64,
  maximumLabels: 8,
  labelNameChars: 48,
  labelValueBytes: 128,
  maximumSamplesPerBatch: 128,
  maximumActiveSeries: 2048,
  maximumPastAgeMs: 7 * 24 * 60 * 60 * 1000,
  maximumFutureSkewMs: 5 * 60 * 1000,
  maximumQueryRangeMs: 24 * 60 * 60 * 1000,
  maximumQuerySamples: 1024,
  maximumLookbackSeconds: 60 * 60,
  maximumIntervalSeconds: 5 * 60,
  maximumConsecutiveTrueSlots: 12,
  maximumSilenceMs: 24 * 60 * 60 * 1000,
  maximumLeaseSeconds: 60,
});

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const metricPattern = /^[a-z][a-z0-9_]*$/;
const forbiddenLabelNames = new Set([
  'authorization',
  'email',
  'phone',
  'request_id',
  'token',
  'trace_id',
  'user_id',
]);

function plainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw invalid(`${name} must be a JSON object`);
  }
  return value;
}

export function exactKeys(value, expected, name) {
  plainObject(value, name);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw invalid(`${name} must contain exactly: ${wanted.join(', ')}`);
  }
  return value;
}

function text(value, name, maximumBytes, pattern = identifierPattern) {
  if (typeof value !== 'string' || !value.length || Buffer.byteLength(value, 'utf8') > maximumBytes || !pattern.test(value)) {
    throw invalid(`${name} is invalid`);
  }
  return value;
}

function printableText(value, name, maximumBytes, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.length) || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw invalid(`${name} is invalid`);
  }
  if (/\u0000|[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw invalid(`${name} contains a forbidden control character`);
  }
  return value.normalize('NFC');
}

function safeInteger(value, name, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw invalid(`${name} must be a safe integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function finiteNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw invalid(`${name} must be a finite number`);
  return Object.is(value, -0) ? 0 : value;
}

function timestamp(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw invalid(`${name} must use canonical UTC millisecond format`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw invalid(`${name} is invalid`);
  return parsed;
}

export function canonicalStringify(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid('canonical JSON cannot contain NaN or infinity');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  plainObject(value, 'canonical value');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`).join(',')}}`;
}

export function digestValue(value) {
  return sha256(Buffer.from(`${canonicalStringify(value)}\n`, 'utf8'));
}

export function validateIdentifier(value, name = 'identifier') {
  return text(value, name, limits.identifierChars);
}

export function validateRequestKey(value) {
  return text(value, 'Idempotency-Key', limits.requestKeyChars, /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
}

export function normalizeLabels(raw, name = 'labels') {
  plainObject(raw, name);
  const entries = Object.entries(raw);
  if (entries.length > limits.maximumLabels) throw invalid(`${name} has too many labels`);
  const normalized = {};
  for (const [rawName, rawValue] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    const labelName = text(rawName, `${name} name`, limits.labelNameChars, metricPattern);
    if (forbiddenLabelNames.has(labelName)) throw invalid(`${name}.${labelName} is forbidden in this lab`);
    normalized[labelName] = printableText(rawValue, `${name}.${labelName}`, limits.labelValueBytes, true);
  }
  return normalized;
}

export function normalizeSeries(metric, labels) {
  const normalizedMetric = text(metric, 'metric', limits.metricNameChars, metricPattern);
  const normalizedLabels = normalizeLabels(labels);
  const identity = { tenant: monitorContract.tenant, metric: normalizedMetric, labels: normalizedLabels };
  return { metric: normalizedMetric, labels: normalizedLabels, seriesDigest: digestValue(identity) };
}

export function normalizeSource(body) {
  exactKeys(body, ['sourceId'], 'source body');
  return { sourceId: validateIdentifier(body.sourceId, 'sourceId') };
}

export function normalizeSourceEpoch(body) {
  exactKeys(body, ['expectedEpoch'], 'source epoch body');
  return { expectedEpoch: safeInteger(body.expectedEpoch, 'expectedEpoch') };
}

export function normalizeWrite(body, { now = new Date() } = {}) {
  exactKeys(body, ['sourceId', 'sourceEpoch', 'batchSequence', 'samples'], 'write body');
  if (!Array.isArray(body.samples) || body.samples.length < 1 || body.samples.length > limits.maximumSamplesPerBatch) {
    throw invalid(`samples must contain 1 through ${limits.maximumSamplesPerBatch} entries`);
  }
  const nowMs = now.getTime();
  const normalized = body.samples.map((raw, index) => {
    exactKeys(raw, ['metric', 'labels', 'observedAt', 'type', 'value'], `samples[${index}]`);
    if (raw.type !== monitorContract.metricType) throw invalid(`samples[${index}].type must be gauge`);
    const series = normalizeSeries(raw.metric, raw.labels);
    const observed = timestamp(raw.observedAt, `samples[${index}].observedAt`);
    if (observed.getTime() < nowMs - limits.maximumPastAgeMs) throw invalid(`samples[${index}] is too old`);
    if (observed.getTime() > nowMs + limits.maximumFutureSkewMs) throw invalid(`samples[${index}] is too far in the future`);
    return {
      ...series,
      observedAt: observed.toISOString(),
      type: monitorContract.metricType,
      value: finiteNumber(raw.value, `samples[${index}].value`),
    };
  }).sort((left, right) => (
    left.seriesDigest.localeCompare(right.seriesDigest)
    || left.observedAt.localeCompare(right.observedAt)
  ));

  const unique = [];
  for (const sample of normalized) {
    const prior = unique.at(-1);
    if (prior?.seriesDigest === sample.seriesDigest && prior.observedAt === sample.observedAt) {
      if (prior.value !== sample.value) throw conflict('one batch contains changed values for one series timestamp');
      continue;
    }
    unique.push(sample);
  }
  const request = {
    version: monitorContract.version,
    sourceId: validateIdentifier(body.sourceId, 'sourceId'),
    sourceEpoch: safeInteger(body.sourceEpoch, 'sourceEpoch'),
    batchSequence: safeInteger(body.batchSequence, 'batchSequence'),
    samples: unique,
  };
  return {
    ...request,
    submittedCount: body.samples.length,
    uniqueCount: unique.length,
    intentDigest: digestValue(request),
  };
}

export function normalizeQuery(body) {
  exactKeys(body, ['metric', 'labels', 'start', 'end', 'limit'], 'query body');
  const series = normalizeSeries(body.metric, body.labels);
  const start = timestamp(body.start, 'start');
  const end = timestamp(body.end, 'end');
  if (start >= end) throw invalid('query start must precede end');
  if (end.getTime() - start.getTime() > limits.maximumQueryRangeMs) throw invalid('query range is too large');
  return {
    ...series,
    start: start.toISOString(),
    end: end.toISOString(),
    limit: safeInteger(body.limit, 'limit', 1, limits.maximumQuerySamples),
  };
}

function normalizeRuleSpec(body, name) {
  exactKeys(
    body,
    ['metric', 'labels', 'threshold', 'lookbackSeconds', 'intervalSeconds', 'consecutiveTrueSlots'],
    name,
  );
  return {
    ...normalizeSeries(body.metric, body.labels),
    threshold: finiteNumber(body.threshold, 'threshold'),
    lookbackSeconds: safeInteger(body.lookbackSeconds, 'lookbackSeconds', 1, limits.maximumLookbackSeconds),
    intervalSeconds: safeInteger(body.intervalSeconds, 'intervalSeconds', 10, limits.maximumIntervalSeconds),
    consecutiveTrueSlots: safeInteger(
      body.consecutiveTrueSlots,
      'consecutiveTrueSlots',
      1,
      limits.maximumConsecutiveTrueSlots,
    ),
    missingPolicy: monitorContract.missingPolicy,
  };
}

export function normalizeRule(body) {
  exactKeys(
    body,
    ['ruleId', 'metric', 'labels', 'threshold', 'lookbackSeconds', 'intervalSeconds', 'consecutiveTrueSlots'],
    'rule body',
  );
  const { ruleId, ...spec } = body;
  return { ruleId: validateIdentifier(ruleId, 'ruleId'), ...normalizeRuleSpec(spec, 'rule specification') };
}

export function normalizeRuleGeneration(body) {
  exactKeys(
    body,
    [
      'expectedGeneration',
      'metric',
      'labels',
      'threshold',
      'lookbackSeconds',
      'intervalSeconds',
      'consecutiveTrueSlots',
    ],
    'rule generation body',
  );
  const { expectedGeneration, ...spec } = body;
  return {
    expectedGeneration: safeInteger(expectedGeneration, 'expectedGeneration', 1),
    ...normalizeRuleSpec(spec, 'rule generation specification'),
  };
}

export function normalizeAuthority(body, label) {
  exactKeys(body, ['workerId', 'expectedEpoch'], `${label} authority body`);
  return {
    workerId: validateIdentifier(body.workerId, 'workerId'),
    expectedEpoch: safeInteger(body.expectedEpoch, 'expectedEpoch'),
  };
}

export function normalizeEvaluation(body) {
  exactKeys(body, ['generation', 'evaluatorId', 'evaluatorEpoch', 'slot'], 'evaluation body');
  return {
    generation: safeInteger(body.generation, 'generation', 1),
    evaluatorId: validateIdentifier(body.evaluatorId, 'evaluatorId'),
    evaluatorEpoch: safeInteger(body.evaluatorEpoch, 'evaluatorEpoch', 1),
    slot: timestamp(body.slot, 'slot').toISOString(),
  };
}

export function normalizeSilence(body) {
  exactKeys(body, ['ruleId', 'startsAt', 'endsAt'], 'silence body');
  const startsAt = timestamp(body.startsAt, 'startsAt');
  const endsAt = timestamp(body.endsAt, 'endsAt');
  if (startsAt >= endsAt) throw invalid('silence startsAt must precede endsAt');
  if (endsAt.getTime() - startsAt.getTime() > limits.maximumSilenceMs) throw invalid('silence duration is too large');
  return {
    ruleId: validateIdentifier(body.ruleId, 'ruleId'),
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
  };
}

export function normalizeClaim(input) {
  exactKeys(input, ['workerId', 'workerEpoch', 'leaseSeconds'], 'notification claim');
  return {
    workerId: validateIdentifier(input.workerId, 'workerId'),
    workerEpoch: safeInteger(input.workerEpoch, 'workerEpoch', 1),
    leaseSeconds: safeInteger(input.leaseSeconds, 'leaseSeconds', 1, limits.maximumLeaseSeconds),
  };
}

export function normalizeProviderRequest(body) {
  exactKeys(body, ['notificationId', 'transitionKind', 'attempt'], 'provider request');
  if (!/^[0-9a-f]{64}$/.test(body.notificationId)) throw invalid('notificationId is invalid');
  if (!['firing', 'resolved'].includes(body.transitionKind)) throw invalid('transitionKind is invalid');
  return {
    notificationId: body.notificationId,
    transitionKind: body.transitionKind,
    attempt: safeInteger(body.attempt, 'attempt', 1),
  };
}
