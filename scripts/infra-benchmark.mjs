import { performance } from 'node:perf_hooks';
import pg from 'pg';
import { initializeDatabase, MonitorRepository, resetDatabase } from '../src/repository.js';
import { MonitorService } from '../src/service.js';

const { Pool } = pg;
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required; infrastructure benchmark never skips');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 12, statement_timeout: 20_000 });
const repository = new MonitorRepository(pool);
const service = new MonitorService(repository);
const principal = 'benchmark-operator';

function rounded(value) {
  return Math.round(value * 1000) / 1000;
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return rounded(sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]);
}

async function measure(run) {
  const started = performance.now();
  const result = await run();
  return { result, durationMs: rounded(performance.now() - started) };
}

try {
  await initializeDatabase(pool);
  await resetDatabase(pool, 'snapshot-monitoring-lab-reset');
  const version = await pool.query(`SHOW server_version`);
  const seriesCount = 64;
  const pointsPerSeries = 32;
  const samplesPerBatch = 128;
  const queryCount = 64;
  const ruleCount = 32;
  const baseMs = Math.floor(Date.now() / 60_000) * 60_000 - 40 * 60_000;
  const at = (minute) => new Date(baseMs + minute * 60_000).toISOString();

  await service.createSource({ sourceId: 'benchmark-source' });
  const samples = [];
  for (let hostIndex = 0; hostIndex < seriesCount; hostIndex += 1) {
    for (let pointIndex = 0; pointIndex < pointsPerSeries; pointIndex += 1) {
      samples.push({
        metric: 'cpu_utilization',
        labels: { host: `synthetic-${hostIndex.toString().padStart(3, '0')}` },
        observedAt: at(pointIndex),
        type: 'gauge',
        value: (hostIndex * 7 + pointIndex * 3) % 101,
      });
    }
  }

  const ingestLatencies = [];
  const ingestStarted = performance.now();
  let sequence = 0;
  for (let index = 0; index < samples.length; index += samplesPerBatch) {
    const observation = await measure(() => service.ingest({
      sourceId: 'benchmark-source',
      sourceEpoch: 0,
      batchSequence: sequence,
      samples: samples.slice(index, index + samplesPerBatch),
    }));
    ingestLatencies.push(observation.durationMs);
    sequence += 1;
  }
  const ingestDurationMs = performance.now() - ingestStarted;

  const queryLatencies = [];
  let queriedSamples = 0;
  for (let hostIndex = 0; hostIndex < queryCount; hostIndex += 1) {
    const observation = await measure(() => service.query({
      principal,
      requestKey: `benchmark-query-${hostIndex.toString().padStart(3, '0')}`,
      body: {
        metric: 'cpu_utilization',
        labels: { host: `synthetic-${hostIndex.toString().padStart(3, '0')}` },
        start: at(0),
        end: at(pointsPerSeries),
        limit: pointsPerSeries,
      },
    }));
    queryLatencies.push(observation.durationMs);
    queriedSamples += observation.result.samples.length;
  }

  for (let ruleIndex = 0; ruleIndex < ruleCount; ruleIndex += 1) {
    await service.createRule({
      principal,
      requestKey: `benchmark-rule-${ruleIndex.toString().padStart(3, '0')}`,
      body: {
        ruleId: `cpu-hot-${ruleIndex.toString().padStart(3, '0')}`,
        metric: 'cpu_utilization',
        labels: { host: `synthetic-${ruleIndex.toString().padStart(3, '0')}` },
        threshold: 50,
        lookbackSeconds: 120,
        intervalSeconds: 60,
        consecutiveTrueSlots: 1,
      },
    });
  }
  await service.rotateAuthority({
    principal,
    requestKey: 'benchmark-evaluator-authority',
    kind: 'evaluator',
    body: { workerId: 'benchmark-evaluator', expectedEpoch: 0 },
  });
  const evaluationLatencies = [];
  for (let ruleIndex = 0; ruleIndex < ruleCount; ruleIndex += 1) {
    const observation = await measure(() => service.evaluate({
      ruleId: `cpu-hot-${ruleIndex.toString().padStart(3, '0')}`,
      body: {
        generation: 1,
        evaluatorId: 'benchmark-evaluator',
        evaluatorEpoch: 1,
        slot: at(pointsPerSeries - 1),
      },
    }));
    evaluationLatencies.push(observation.durationMs);
  }
  const finalState = await repository.getState();

  process.stdout.write(`${JSON.stringify({
    evidence: 'bounded_infrastructure_benchmark',
    runtime: {
      node: process.version,
      postgresql: version.rows[0].server_version,
    },
    fixture: {
      tenantCount: 1,
      sourceCount: 1,
      metricType: 'gauge',
      seriesCount,
      pointsPerSeries,
      sampleCount: samples.length,
      samplesPerBatch,
      ingestBatchCount: sequence,
      queryCount,
      querySamplesReturned: queriedSamples,
      ruleCount,
      evaluationCount: ruleCount,
    },
    observations: {
      ingestSamplesPerSecond: rounded(samples.length / (ingestDurationMs / 1000)),
      ingestBatchMs: ingestLatencies,
      ingestBatchP50Ms: percentile(ingestLatencies, 0.5),
      ingestBatchP95Ms: percentile(ingestLatencies, 0.95),
      queryMs: queryLatencies,
      queryP50Ms: percentile(queryLatencies, 0.5),
      queryP95Ms: percentile(queryLatencies, 0.95),
      evaluationMs: evaluationLatencies,
      evaluationP50Ms: percentile(evaluationLatencies, 0.5),
      evaluationP95Ms: percentile(evaluationLatencies, 0.95),
      firingIncidentCount: finalState.firingIncidentCount,
      pendingNotificationCount: finalState.pendingNotificationCount,
    },
    exclusions: [
      'single local PostgreSQL process',
      'no HTTP ingestion or query hop',
      'no TLS, compression, replication, failover, compaction, rollup, or real notification provider',
      'no production capacity, latency, availability, cost, or SLA inference',
    ],
  })}\n`);
} finally {
  await pool.end();
}
