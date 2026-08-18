import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { digestValue, limits, monitorContract } from './contracts.js';
import { transitionRuleState } from './model.js';
import {
  cardinalityLimit,
  conflict,
  fenced,
  notFound,
  outOfOrder,
  precondition,
} from './errors.js';

const schemaUrl = new URL('../sql/schema.sql', import.meta.url);

function integer(value) {
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new Error('database integer exceeded the safe range');
  return result;
}

function instant(value) {
  return new Date(value).toISOString();
}

async function rollback(client) {
  await client.query('ROLLBACK').catch(() => {});
}

export async function initializeDatabase(pool) {
  await pool.query(await readFile(fileURLToPath(schemaUrl), 'utf8'));
}

export async function resetDatabase(pool, confirmation) {
  if (confirmation !== 'snapshot-monitoring-lab-reset') {
    throw new Error('refusing to reset without the explicit lab confirmation');
  }
  await pool.query(`
    TRUNCATE mm_evaluations, mm_provider_acceptances, mm_provider_attempts,
      mm_notification_outbox, mm_routing_receipts, mm_silences, mm_transitions,
      mm_incidents, mm_rule_states, mm_rule_generations, mm_rule_heads,
      mm_query_receipts, mm_mutation_receipts, mm_ingest_receipts, mm_samples,
      mm_series, mm_sources, mm_evaluator_authority, mm_notification_authority,
      mm_system_state CASCADE;
    INSERT INTO mm_system_state (singleton, ingest_revision, updated_at)
    VALUES (true, 0, clock_timestamp());
    INSERT INTO mm_evaluator_authority (singleton, worker_id, worker_epoch, updated_at)
    VALUES (true, NULL, 0, clock_timestamp());
    INSERT INTO mm_notification_authority (singleton, worker_id, worker_epoch, updated_at)
    VALUES (true, NULL, 0, clock_timestamp());
  `);
}

export class MonitorRepository {
  constructor(pool) {
    this.pool = pool;
  }

  async #now(client) {
    const result = await client.query(`SELECT clock_timestamp() AS now`);
    return new Date(result.rows[0].now);
  }

  async #advisory(client, value) {
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [value]);
  }

  async #existingMutation(client, principal, requestKey, intentDigest) {
    const found = await client.query(
      `SELECT intent_digest, result_json FROM mm_mutation_receipts WHERE principal = $1 AND request_key = $2`,
      [principal, requestKey],
    );
    if (!found.rowCount) return null;
    if (found.rows[0].intent_digest !== intentDigest) throw conflict();
    return { ...found.rows[0].result_json, replayed: true };
  }

  async #recordMutation(client, { principal, requestKey, intentDigest, operation, result, now }) {
    await client.query(`
      INSERT INTO mm_mutation_receipts (
        principal, request_key, intent_digest, operation, result_json, created_at
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
    `, [principal, requestKey, intentDigest, operation, JSON.stringify(result), now]);
    return { ...result, replayed: false };
  }

  async createSource(sourceId) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const now = await this.#now(client);
      const inserted = await client.query(`
        INSERT INTO mm_sources (source_id, source_epoch, next_batch_sequence, created_at, updated_at)
        VALUES ($1, 0, 0, $2, $2)
        ON CONFLICT (source_id) DO NOTHING
        RETURNING source_id
      `, [sourceId, now]);
      const source = await client.query(`
        SELECT source_id, source_epoch, next_batch_sequence
        FROM mm_sources WHERE source_id = $1
      `, [sourceId]);
      await client.query('COMMIT');
      const row = source.rows[0];
      return {
        phase: 'source_ready',
        sourceId: row.source_id,
        sourceEpoch: integer(row.source_epoch),
        nextBatchSequence: integer(row.next_batch_sequence),
        created: inserted.rowCount === 1,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async rotateSourceEpoch({ principal, requestKey, intentDigest, sourceId, expectedEpoch }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.#advisory(client, `mutation:${principal.length}:${principal}:${requestKey}`);
      const existing = await this.#existingMutation(client, principal, requestKey, intentDigest);
      if (existing) {
        await client.query('COMMIT');
        return existing;
      }
      const source = await client.query(`SELECT * FROM mm_sources WHERE source_id = $1 FOR UPDATE`, [sourceId]);
      if (!source.rowCount) throw notFound();
      const current = integer(source.rows[0].source_epoch);
      if (current !== expectedEpoch) throw fenced('source epoch', current);
      const now = await this.#now(client);
      const next = current + 1;
      await client.query(`
        UPDATE mm_sources
        SET source_epoch = $2, next_batch_sequence = 0, updated_at = $3
        WHERE source_id = $1
      `, [sourceId, next, now]);
      const result = {
        phase: 'source_epoch_rotated',
        sourceId,
        sourceEpoch: next,
        nextBatchSequence: 0,
      };
      const receipt = await this.#recordMutation(client, {
        principal,
        requestKey,
        intentDigest,
        operation: 'rotate_source_epoch',
        result,
        now,
      });
      await client.query('COMMIT');
      return receipt;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async ingest(input) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.#advisory(
        client,
        `ingest:${input.sourceId.length}:${input.sourceId}:${input.sourceEpoch}:${input.batchSequence}`,
      );
      const existing = await client.query(`
        SELECT intent_digest, result_json
        FROM mm_ingest_receipts
        WHERE source_id = $1 AND source_epoch = $2 AND batch_sequence = $3
      `, [input.sourceId, input.sourceEpoch, input.batchSequence]);
      if (existing.rowCount) {
        if (existing.rows[0].intent_digest !== input.intentDigest) throw conflict();
        await client.query('COMMIT');
        return { ...existing.rows[0].result_json, replayed: true };
      }

      const source = await client.query(`SELECT * FROM mm_sources WHERE source_id = $1 FOR UPDATE`, [input.sourceId]);
      if (!source.rowCount) throw notFound();
      const currentEpoch = integer(source.rows[0].source_epoch);
      const expectedSequence = integer(source.rows[0].next_batch_sequence);
      if (currentEpoch !== input.sourceEpoch) throw fenced('source epoch', currentEpoch);
      if (expectedSequence !== input.batchSequence) throw outOfOrder('batch sequence', expectedSequence);

      const state = await client.query(`SELECT * FROM mm_system_state WHERE singleton = true FOR UPDATE`);
      const nextRevision = integer(state.rows[0].ingest_revision) + 1;
      const now = await this.#now(client);
      let newSeriesCount = 0;
      let insertedCount = 0;
      let duplicateCount = 0;

      for (const sample of input.samples) {
        const series = await client.query(`
          INSERT INTO mm_series (
            series_digest, tenant, metric_name, labels_json, created_revision, created_at
          ) VALUES ($1, $2, $3, $4::jsonb, $5, $6)
          ON CONFLICT (series_digest) DO NOTHING
          RETURNING series_digest
        `, [
          sample.seriesDigest,
          monitorContract.tenant,
          sample.metric,
          JSON.stringify(sample.labels),
          nextRevision,
          now,
        ]);
        newSeriesCount += series.rowCount;

        const inserted = await client.query(`
          INSERT INTO mm_samples (series_digest, observed_at, value, ingest_revision, received_at)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (series_digest, observed_at) DO NOTHING
          RETURNING series_digest
        `, [sample.seriesDigest, sample.observedAt, sample.value, nextRevision, now]);
        if (inserted.rowCount) {
          insertedCount += 1;
          continue;
        }
        const prior = await client.query(`
          SELECT value FROM mm_samples WHERE series_digest = $1 AND observed_at = $2
        `, [sample.seriesDigest, sample.observedAt]);
        if (!prior.rowCount || Number(prior.rows[0].value) !== sample.value) {
          throw conflict('one series timestamp is already bound to a different value');
        }
        duplicateCount += 1;
      }

      const seriesCount = await client.query(`SELECT count(*) AS count FROM mm_series`);
      if (integer(seriesCount.rows[0].count) > limits.maximumActiveSeries) {
        throw cardinalityLimit(limits.maximumActiveSeries);
      }

      const result = {
        phase: 'query_visible',
        sourceId: input.sourceId,
        sourceEpoch: input.sourceEpoch,
        batchSequence: input.batchSequence,
        batchDigest: input.intentDigest,
        ingestRevision: nextRevision,
        submittedCount: input.submittedCount,
        uniqueCount: input.uniqueCount,
        insertedCount,
        duplicateCount,
        newSeriesCount,
      };
      await client.query(`
        INSERT INTO mm_ingest_receipts (
          source_id, source_epoch, batch_sequence, intent_digest, ingest_revision,
          submitted_count, unique_count, inserted_count, duplicate_count,
          new_series_count, result_json, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
      `, [
        input.sourceId,
        input.sourceEpoch,
        input.batchSequence,
        input.intentDigest,
        nextRevision,
        input.submittedCount,
        input.uniqueCount,
        insertedCount,
        duplicateCount,
        newSeriesCount,
        JSON.stringify(result),
        now,
      ]);
      await client.query(`
        UPDATE mm_sources
        SET next_batch_sequence = next_batch_sequence + 1, updated_at = $2
        WHERE source_id = $1
      `, [input.sourceId, now]);
      await client.query(`
        UPDATE mm_system_state SET ingest_revision = $1, updated_at = $2 WHERE singleton = true
      `, [nextRevision, now]);
      await client.query('COMMIT');
      return { ...result, replayed: false };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async query({ principal, requestKey, intentDigest, ...input }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.#advisory(client, `query:${principal.length}:${principal}:${requestKey}`);
      const existing = await client.query(`
        SELECT intent_digest, result_json FROM mm_query_receipts
        WHERE principal = $1 AND request_key = $2
      `, [principal, requestKey]);
      if (existing.rowCount) {
        if (existing.rows[0].intent_digest !== intentDigest) throw conflict();
        await client.query('COMMIT');
        return { ...existing.rows[0].result_json, replayed: true };
      }

      const state = await client.query(`SELECT ingest_revision FROM mm_system_state WHERE singleton = true`);
      const snapshotRevision = integer(state.rows[0].ingest_revision);
      const series = await client.query(`
        SELECT series_digest
        FROM mm_series
        WHERE series_digest = $1 AND created_revision <= $2
      `, [input.seriesDigest, snapshotRevision]);
      let absence = 'series_absent';
      let samples = [];
      let status = 'complete';
      if (series.rowCount) {
        const rows = await client.query(`
          SELECT observed_at, value, ingest_revision
          FROM mm_samples
          WHERE series_digest = $1
            AND observed_at >= $2 AND observed_at < $3
            AND ingest_revision <= $4
          ORDER BY observed_at ASC
          LIMIT $5
        `, [input.seriesDigest, input.start, input.end, snapshotRevision, input.limit + 1]);
        if (rows.rowCount > input.limit) {
          status = 'result_limit_exceeded';
          absence = 'not_applicable';
        } else {
          samples = rows.rows.map((row) => ({
            observedAt: instant(row.observed_at),
            value: Number(row.value),
            ingestRevision: integer(row.ingest_revision),
          }));
          absence = samples.length ? 'none' : 'no_samples_in_range';
        }
      }
      const result = {
        phase: 'query_materialized',
        status,
        snapshotRevision,
        series: { metric: input.metric, labels: input.labels, seriesDigest: input.seriesDigest },
        range: { start: input.start, end: input.end },
        absence,
        samples,
      };
      const now = await this.#now(client);
      await client.query(`
        INSERT INTO mm_query_receipts (
          principal, request_key, intent_digest, snapshot_revision, result_json, created_at
        ) VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      `, [principal, requestKey, intentDigest, snapshotRevision, JSON.stringify(result), now]);
      await client.query('COMMIT');
      return { ...result, replayed: false };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async createRule({ principal, requestKey, intentDigest, ...input }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.#advisory(client, `mutation:${principal.length}:${principal}:${requestKey}`);
      const existing = await this.#existingMutation(client, principal, requestKey, intentDigest);
      if (existing) {
        await client.query('COMMIT');
        return existing;
      }
      const now = await this.#now(client);
      await client.query(`
        INSERT INTO mm_rule_heads (rule_id, current_generation, created_at, updated_at)
        VALUES ($1, 1, $2, $2)
      `, [input.ruleId, now]).catch((error) => {
        if (error.code === '23505') throw conflict('ruleId already exists');
        throw error;
      });
      await this.#insertRuleGeneration(client, input.ruleId, 1, input, now);
      const result = this.#ruleResult(input.ruleId, 1, input, 'inactive');
      const receipt = await this.#recordMutation(client, {
        principal,
        requestKey,
        intentDigest,
        operation: 'create_rule',
        result,
        now,
      });
      await client.query('COMMIT');
      return receipt;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async #insertRuleGeneration(client, ruleId, generation, input, now) {
    await client.query(`
      INSERT INTO mm_rule_generations (
        rule_id, generation, series_digest, metric_name, labels_json, threshold,
        lookback_seconds, interval_seconds, consecutive_true_slots, missing_policy, created_at
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11)
    `, [
      ruleId,
      generation,
      input.seriesDigest,
      input.metric,
      JSON.stringify(input.labels),
      input.threshold,
      input.lookbackSeconds,
      input.intervalSeconds,
      input.consecutiveTrueSlots,
      input.missingPolicy,
      now,
    ]);
    await client.query(`
      INSERT INTO mm_rule_states (
        rule_id, generation, status, consecutive_true, last_slot,
        episode, active_incident_id, updated_at
      ) VALUES ($1, $2, 'inactive', 0, NULL, 0, NULL, $3)
    `, [ruleId, generation, now]);
  }

  #ruleResult(ruleId, generation, input, status) {
    return {
      phase: 'rule_generation_ready',
      ruleId,
      generation,
      series: { metric: input.metric, labels: input.labels, seriesDigest: input.seriesDigest },
      predicate: { operator: 'gt', threshold: input.threshold },
      lookbackSeconds: input.lookbackSeconds,
      intervalSeconds: input.intervalSeconds,
      consecutiveTrueSlots: input.consecutiveTrueSlots,
      missingPolicy: input.missingPolicy,
      state: status,
    };
  }

  async createRuleGeneration({ principal, requestKey, intentDigest, ruleId, ...input }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.#advisory(client, `mutation:${principal.length}:${principal}:${requestKey}`);
      const existing = await this.#existingMutation(client, principal, requestKey, intentDigest);
      if (existing) {
        await client.query('COMMIT');
        return existing;
      }
      const head = await client.query(`SELECT * FROM mm_rule_heads WHERE rule_id = $1 FOR UPDATE`, [ruleId]);
      if (!head.rowCount) throw notFound();
      const currentGeneration = integer(head.rows[0].current_generation);
      if (currentGeneration !== input.expectedGeneration) throw fenced('rule generation', currentGeneration);
      const state = await client.query(`
        SELECT status FROM mm_rule_states WHERE rule_id = $1 AND generation = $2 FOR UPDATE
      `, [ruleId, currentGeneration]);
      if (state.rows[0].status !== 'inactive') {
        throw precondition('rule generation can change only while the current state is inactive');
      }
      const now = await this.#now(client);
      const nextGeneration = currentGeneration + 1;
      await this.#insertRuleGeneration(client, ruleId, nextGeneration, input, now);
      await client.query(`
        UPDATE mm_rule_heads SET current_generation = $2, updated_at = $3 WHERE rule_id = $1
      `, [ruleId, nextGeneration, now]);
      const result = this.#ruleResult(ruleId, nextGeneration, input, 'inactive');
      const receipt = await this.#recordMutation(client, {
        principal,
        requestKey,
        intentDigest,
        operation: 'create_rule_generation',
        result,
        now,
      });
      await client.query('COMMIT');
      return receipt;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async rotateAuthority({ principal, requestKey, intentDigest, kind, workerId, expectedEpoch }) {
    const table = kind === 'evaluator' ? 'mm_evaluator_authority' : 'mm_notification_authority';
    const operation = kind === 'evaluator' ? 'rotate_evaluator_authority' : 'rotate_notification_authority';
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.#advisory(client, `mutation:${principal.length}:${principal}:${requestKey}`);
      const existing = await this.#existingMutation(client, principal, requestKey, intentDigest);
      if (existing) {
        await client.query('COMMIT');
        return existing;
      }
      const authority = await client.query(`SELECT * FROM ${table} WHERE singleton = true FOR UPDATE`);
      const current = integer(authority.rows[0].worker_epoch);
      if (current !== expectedEpoch) throw fenced(`${kind} authority epoch`, current);
      const next = current + 1;
      const now = await this.#now(client);
      await client.query(`
        UPDATE ${table} SET worker_id = $1, worker_epoch = $2, updated_at = $3 WHERE singleton = true
      `, [workerId, next, now]);
      const result = { phase: `${kind}_authority_rotated`, workerId, workerEpoch: next };
      const receipt = await this.#recordMutation(client, {
        principal,
        requestKey,
        intentDigest,
        operation,
        result,
        now,
      });
      await client.query('COMMIT');
      return receipt;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async createSilence({ principal, requestKey, intentDigest, ...input }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.#advisory(client, `mutation:${principal.length}:${principal}:${requestKey}`);
      const existing = await this.#existingMutation(client, principal, requestKey, intentDigest);
      if (existing) {
        await client.query('COMMIT');
        return existing;
      }
      const rule = await client.query(`SELECT rule_id FROM mm_rule_heads WHERE rule_id = $1`, [input.ruleId]);
      if (!rule.rowCount) throw notFound();
      const now = await this.#now(client);
      const silenceId = digestValue({ kind: 'silence', principal, requestKey });
      await client.query(`
        INSERT INTO mm_silences (silence_id, rule_id, starts_at, ends_at, created_at)
        VALUES ($1, $2, $3, $4, $5)
      `, [silenceId, input.ruleId, input.startsAt, input.endsAt, now]);
      const result = {
        phase: 'silence_created',
        silenceId,
        ruleId: input.ruleId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
      };
      const receipt = await this.#recordMutation(client, {
        principal,
        requestKey,
        intentDigest,
        operation: 'create_silence',
        result,
        now,
      });
      await client.query('COMMIT');
      return receipt;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async evaluate({ ruleId, ...input }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.#advisory(client, `evaluation:${ruleId.length}:${ruleId}:${input.generation}:${input.slot}`);
      const existing = await client.query(`
        SELECT result_json FROM mm_evaluations
        WHERE rule_id = $1 AND generation = $2 AND slot = $3
      `, [ruleId, input.generation, input.slot]);
      if (existing.rowCount) {
        await client.query('COMMIT');
        return { ...existing.rows[0].result_json, replayed: true };
      }

      const head = await client.query(`SELECT * FROM mm_rule_heads WHERE rule_id = $1 FOR UPDATE`, [ruleId]);
      if (!head.rowCount) throw notFound();
      const currentGeneration = integer(head.rows[0].current_generation);
      if (currentGeneration !== input.generation) throw fenced('rule generation', currentGeneration);
      const generation = await client.query(`
        SELECT generation.*, state.status, state.consecutive_true, state.last_slot,
          state.episode, state.active_incident_id
        FROM mm_rule_generations AS generation
        JOIN mm_rule_states AS state USING (rule_id, generation)
        WHERE generation.rule_id = $1 AND generation.generation = $2
        FOR UPDATE OF state
      `, [ruleId, input.generation]);
      const row = generation.rows[0];
      const authority = await client.query(`
        SELECT worker_id, worker_epoch FROM mm_evaluator_authority WHERE singleton = true FOR SHARE
      `);
      const currentEvaluatorEpoch = integer(authority.rows[0].worker_epoch);
      if (authority.rows[0].worker_id !== input.evaluatorId || currentEvaluatorEpoch !== input.evaluatorEpoch) {
        throw fenced('evaluator authority epoch', currentEvaluatorEpoch);
      }

      const intervalSeconds = integer(row.interval_seconds);
      const slotMs = new Date(input.slot).getTime();
      if (slotMs % (intervalSeconds * 1000) !== 0) throw conflict('evaluation slot is not aligned to the rule interval');
      if (row.last_slot !== null) {
        const expected = new Date(new Date(row.last_slot).getTime() + intervalSeconds * 1000).toISOString();
        if (input.slot !== expected) throw outOfOrder('evaluation slot', expected);
      }

      const state = await client.query(`SELECT ingest_revision FROM mm_system_state WHERE singleton = true`);
      const snapshotRevision = integer(state.rows[0].ingest_revision);
      const lowerBound = new Date(slotMs - integer(row.lookback_seconds) * 1000).toISOString();
      const sample = await client.query(`
        SELECT observed_at, value, ingest_revision
        FROM mm_samples
        WHERE series_digest = $1
          AND observed_at >= $2 AND observed_at <= $3
          AND ingest_revision <= $4
        ORDER BY observed_at DESC
        LIMIT 1
      `, [row.series_digest, lowerBound, input.slot, snapshotRevision]);
      const outcome = sample.rowCount ? (Number(sample.rows[0].value) > Number(row.threshold) ? 'true' : 'false') : 'unknown';
      const before = { status: row.status, consecutiveTrue: integer(row.consecutive_true) };
      const next = transitionRuleState(before, outcome, integer(row.consecutive_true_slots));
      const now = await this.#now(client);
      let episode = integer(row.episode);
      let activeIncidentId = row.active_incident_id;
      let transition = null;

      if (next.transition === 'firing') {
        episode += 1;
        activeIncidentId = digestValue({ kind: 'incident', ruleId, generation: input.generation, episode });
        await client.query(`
          INSERT INTO mm_incidents (
            incident_id, rule_id, generation, episode, status,
            opened_slot, resolved_slot, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, 'firing', $5, NULL, $6, $6)
        `, [activeIncidentId, ruleId, input.generation, episode, input.slot, now]);
        transition = await this.#recordTransition(client, {
          incidentId: activeIncidentId,
          kind: 'firing',
          slot: input.slot,
          ruleId,
          now,
        });
      } else if (next.transition === 'resolved') {
        if (!activeIncidentId) throw new Error('firing state is missing its active incident');
        await client.query(`
          UPDATE mm_incidents
          SET status = 'resolved', resolved_slot = $2, updated_at = $3
          WHERE incident_id = $1 AND status = 'firing'
        `, [activeIncidentId, input.slot, now]);
        transition = await this.#recordTransition(client, {
          incidentId: activeIncidentId,
          kind: 'resolved',
          slot: input.slot,
          ruleId,
          now,
        });
        activeIncidentId = null;
      }

      const evaluationId = digestValue({ kind: 'evaluation', ruleId, generation: input.generation, slot: input.slot });
      const result = {
        phase: 'evaluation_committed',
        evaluationId,
        ruleId,
        generation: input.generation,
        slot: input.slot,
        snapshotRevision,
        outcome,
        sample: sample.rowCount ? {
          observedAt: instant(sample.rows[0].observed_at),
          value: Number(sample.rows[0].value),
          ingestRevision: integer(sample.rows[0].ingest_revision),
        } : null,
        stateBefore: before.status,
        stateAfter: next.status,
        consecutiveTrue: next.consecutiveTrue,
        incidentId: activeIncidentId ?? transition?.incidentId ?? null,
        transition,
      };
      await client.query(`
        UPDATE mm_rule_states
        SET status = $3, consecutive_true = $4, last_slot = $5,
          episode = $6, active_incident_id = $7, updated_at = $8
        WHERE rule_id = $1 AND generation = $2
      `, [
        ruleId,
        input.generation,
        next.status,
        next.consecutiveTrue,
        input.slot,
        episode,
        activeIncidentId,
        now,
      ]);
      await client.query(`
        INSERT INTO mm_evaluations (
          evaluation_id, rule_id, generation, slot, evaluator_id, evaluator_epoch,
          snapshot_revision, outcome, sample_observed_at, sample_value,
          state_before, state_after, transition_id, result_json, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)
      `, [
        evaluationId,
        ruleId,
        input.generation,
        input.slot,
        input.evaluatorId,
        input.evaluatorEpoch,
        snapshotRevision,
        outcome,
        sample.rowCount ? sample.rows[0].observed_at : null,
        sample.rowCount ? Number(sample.rows[0].value) : null,
        before.status,
        next.status,
        transition?.transitionId ?? null,
        JSON.stringify(result),
        now,
      ]);
      await client.query('COMMIT');
      return { ...result, replayed: false };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async #recordTransition(client, { incidentId, kind, slot, ruleId, now }) {
    const transitionId = digestValue({ kind: 'incident_transition', incidentId, transition: kind, slot });
    await client.query(`
      INSERT INTO mm_transitions (transition_id, incident_id, kind, slot, created_at)
      VALUES ($1, $2, $3, $4, $5)
    `, [transitionId, incidentId, kind, slot, now]);
    const silence = await client.query(`
      SELECT silence_id
      FROM mm_silences
      WHERE rule_id = $1 AND starts_at <= $2 AND ends_at > $2
      ORDER BY starts_at DESC, silence_id ASC
      LIMIT 1
    `, [ruleId, slot]);
    if (silence.rowCount) {
      await client.query(`
        INSERT INTO mm_routing_receipts (
          transition_id, status, silence_id, notification_id, created_at
        ) VALUES ($1, 'suppressed', $2, NULL, $3)
      `, [transitionId, silence.rows[0].silence_id, now]);
      return {
        transitionId,
        incidentId,
        kind,
        routing: { status: 'suppressed', silenceId: silence.rows[0].silence_id },
      };
    }
    const notificationId = digestValue({ kind: 'notification', transitionId, destination: monitorContract.destination });
    await client.query(`
      INSERT INTO mm_routing_receipts (
        transition_id, status, silence_id, notification_id, created_at
      ) VALUES ($1, 'routable', NULL, $2, $3)
    `, [transitionId, notificationId, now]);
    await client.query(`
      INSERT INTO mm_notification_outbox (
        notification_id, transition_id, transition_kind, destination, status,
        worker_id, worker_epoch, attempt, lease_until, provider_result_json,
        created_at, updated_at
      ) VALUES ($1, $2, $3, $4, 'pending', NULL, NULL, 0, NULL, NULL, $5, $5)
    `, [notificationId, transitionId, kind, monitorContract.destination, now]);
    return {
      transitionId,
      incidentId,
      kind,
      routing: { status: 'routable', notificationId },
    };
  }

  async claimNotification(input) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const authority = await client.query(`
        SELECT worker_id, worker_epoch
        FROM mm_notification_authority WHERE singleton = true FOR SHARE
      `);
      const currentEpoch = integer(authority.rows[0].worker_epoch);
      if (authority.rows[0].worker_id !== input.workerId || currentEpoch !== input.workerEpoch) {
        throw fenced('notification authority epoch', currentEpoch);
      }
      const now = await this.#now(client);
      const selected = await client.query(`
        SELECT *
        FROM mm_notification_outbox
        WHERE status = 'pending' OR (status = 'leased' AND lease_until <= $1)
        ORDER BY created_at ASC, notification_id ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `, [now]);
      if (!selected.rowCount) {
        await client.query('COMMIT');
        return { phase: 'no_notification_work' };
      }
      const row = selected.rows[0];
      const attempt = integer(row.attempt) + 1;
      const leaseUntil = new Date(now.getTime() + input.leaseSeconds * 1000);
      await client.query(`
        UPDATE mm_notification_outbox
        SET status = 'leased', worker_id = $2, worker_epoch = $3,
          attempt = $4, lease_until = $5, updated_at = $6
        WHERE notification_id = $1
      `, [row.notification_id, input.workerId, input.workerEpoch, attempt, leaseUntil, now]);
      await client.query('COMMIT');
      return {
        phase: 'notification_claimed',
        notificationId: row.notification_id,
        transitionKind: row.transition_kind,
        destination: row.destination,
        workerId: input.workerId,
        workerEpoch: input.workerEpoch,
        attempt,
        leaseUntil: leaseUntil.toISOString(),
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async completeNotification({ workerId, workerEpoch, notificationId, attempt, providerReceipt }) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const authority = await client.query(`
        SELECT worker_id, worker_epoch
        FROM mm_notification_authority WHERE singleton = true FOR SHARE
      `);
      const currentEpoch = integer(authority.rows[0].worker_epoch);
      if (authority.rows[0].worker_id !== workerId || currentEpoch !== workerEpoch) {
        throw fenced('notification authority epoch', currentEpoch);
      }
      const outbox = await client.query(`
        SELECT * FROM mm_notification_outbox WHERE notification_id = $1 FOR UPDATE
      `, [notificationId]);
      if (!outbox.rowCount) throw notFound();
      const row = outbox.rows[0];
      if (row.status === 'provider_accepted') {
        await client.query('COMMIT');
        return {
          phase: 'notification_provider_accepted',
          notificationId,
          attempt: integer(row.attempt),
          replayed: true,
        };
      }
      if (
        row.status !== 'leased'
        || row.worker_id !== workerId
        || integer(row.worker_epoch) !== workerEpoch
        || integer(row.attempt) !== attempt
      ) throw fenced('notification claim attempt', integer(row.attempt));
      const now = await this.#now(client);
      await client.query(`
        UPDATE mm_notification_outbox
        SET status = 'provider_accepted', worker_id = NULL, worker_epoch = NULL,
          lease_until = NULL, provider_result_json = $2::jsonb, updated_at = $3
        WHERE notification_id = $1
      `, [notificationId, JSON.stringify(providerReceipt), now]);
      await client.query('COMMIT');
      return { phase: 'notification_provider_accepted', notificationId, attempt, replayed: false };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async acceptProvider(input) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.#advisory(client, `provider:${input.notificationId}:${input.attempt}`);
      const requestDigest = digestValue(input);
      const priorAttempt = await client.query(`
        SELECT provider_attempt_id, request_digest
        FROM mm_provider_attempts
        WHERE notification_id = $1 AND attempt = $2
      `, [input.notificationId, input.attempt]);
      let providerAttemptId;
      if (priorAttempt.rowCount) {
        if (priorAttempt.rows[0].request_digest !== requestDigest) throw conflict();
        providerAttemptId = integer(priorAttempt.rows[0].provider_attempt_id);
      } else {
        const now = await this.#now(client);
        const inserted = await client.query(`
          INSERT INTO mm_provider_attempts (
            notification_id, attempt, request_digest, received_at
          ) VALUES ($1, $2, $3, $4)
          RETURNING provider_attempt_id
        `, [input.notificationId, input.attempt, requestDigest, now]);
        providerAttemptId = integer(inserted.rows[0].provider_attempt_id);
      }
      const existing = await client.query(`
        SELECT transition_kind FROM mm_provider_acceptances WHERE notification_id = $1
      `, [input.notificationId]);
      if (existing.rowCount && existing.rows[0].transition_kind !== input.transitionKind) throw conflict();
      if (!existing.rowCount) {
        const now = await this.#now(client);
        await client.query(`
          INSERT INTO mm_provider_acceptances (
            notification_id, transition_kind, first_provider_attempt_id, accepted_at
          ) VALUES ($1, $2, $3, $4)
        `, [input.notificationId, input.transitionKind, providerAttemptId, now]);
      }
      await client.query('COMMIT');
      return {
        phase: 'provider_accepted',
        notificationId: input.notificationId,
        providerAttempt: input.attempt,
        replayed: existing.rowCount > 0,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async getIncident(incidentId) {
    const incident = await this.pool.query(`
      SELECT incident_id, rule_id, generation, episode, status,
        opened_slot, resolved_slot
      FROM mm_incidents WHERE incident_id = $1
    `, [incidentId]);
    if (!incident.rowCount) throw notFound();
    const transitions = await this.pool.query(`
      SELECT transition.transition_id, transition.kind, transition.slot,
        routing.status AS routing_status, routing.silence_id, routing.notification_id
      FROM mm_transitions AS transition
      JOIN mm_routing_receipts AS routing USING (transition_id)
      WHERE transition.incident_id = $1
      ORDER BY transition.slot, transition.transition_id
    `, [incidentId]);
    const row = incident.rows[0];
    return {
      phase: 'incident_read',
      incidentId: row.incident_id,
      ruleId: row.rule_id,
      generation: integer(row.generation),
      episode: integer(row.episode),
      status: row.status,
      openedSlot: instant(row.opened_slot),
      resolvedSlot: row.resolved_slot === null ? null : instant(row.resolved_slot),
      transitions: transitions.rows.map((entry) => ({
        transitionId: entry.transition_id,
        kind: entry.kind,
        slot: instant(entry.slot),
        routing: entry.routing_status === 'suppressed'
          ? { status: 'suppressed', silenceId: entry.silence_id }
          : { status: 'routable', notificationId: entry.notification_id },
      })),
    };
  }

  async getState() {
    const result = await this.pool.query(`
      SELECT
        (SELECT ingest_revision FROM mm_system_state WHERE singleton = true) AS ingest_revision,
        (SELECT count(*) FROM mm_sources) AS source_count,
        (SELECT count(*) FROM mm_series) AS series_count,
        (SELECT count(*) FROM mm_samples) AS sample_count,
        (SELECT count(*) FROM mm_ingest_receipts) AS ingest_receipt_count,
        (SELECT count(*) FROM mm_query_receipts) AS query_receipt_count,
        (SELECT count(*) FROM mm_rule_generations) AS rule_generation_count,
        (SELECT count(*) FROM mm_evaluations) AS evaluation_count,
        (SELECT count(*) FROM mm_incidents WHERE status = 'firing') AS firing_incident_count,
        (SELECT count(*) FROM mm_incidents WHERE status = 'resolved') AS resolved_incident_count,
        (SELECT count(*) FROM mm_routing_receipts WHERE status = 'suppressed') AS suppressed_transition_count,
        (SELECT count(*) FROM mm_notification_outbox WHERE status = 'pending') AS pending_notification_count,
        (SELECT count(*) FROM mm_notification_outbox WHERE status = 'leased') AS leased_notification_count,
        (SELECT count(*) FROM mm_notification_outbox WHERE status = 'provider_accepted') AS accepted_notification_count,
        (SELECT count(*) FROM mm_provider_attempts) AS provider_attempt_count,
        (SELECT count(*) FROM mm_provider_acceptances) AS provider_acceptance_count,
        (SELECT worker_epoch FROM mm_evaluator_authority WHERE singleton = true) AS evaluator_epoch,
        (SELECT worker_epoch FROM mm_notification_authority WHERE singleton = true) AS notification_epoch
    `);
    const row = result.rows[0];
    return Object.fromEntries(Object.entries({
      phase: 'state_read',
      ingestRevision: row.ingest_revision,
      sourceCount: row.source_count,
      seriesCount: row.series_count,
      sampleCount: row.sample_count,
      ingestReceiptCount: row.ingest_receipt_count,
      queryReceiptCount: row.query_receipt_count,
      ruleGenerationCount: row.rule_generation_count,
      evaluationCount: row.evaluation_count,
      firingIncidentCount: row.firing_incident_count,
      resolvedIncidentCount: row.resolved_incident_count,
      suppressedTransitionCount: row.suppressed_transition_count,
      pendingNotificationCount: row.pending_notification_count,
      leasedNotificationCount: row.leased_notification_count,
      acceptedNotificationCount: row.accepted_notification_count,
      providerAttemptCount: row.provider_attempt_count,
      providerAcceptanceCount: row.provider_acceptance_count,
      evaluatorEpoch: row.evaluator_epoch,
      notificationEpoch: row.notification_epoch,
    }).map(([key, value]) => [key, key === 'phase' ? value : integer(value)]));
  }
}
