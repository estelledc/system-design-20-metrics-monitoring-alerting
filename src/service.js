import {
  digestValue,
  normalizeAuthority,
  normalizeEvaluation,
  normalizeQuery,
  normalizeRule,
  normalizeRuleGeneration,
  normalizeSilence,
  normalizeSource,
  normalizeSourceEpoch,
  normalizeWrite,
  validateIdentifier,
  validateRequestKey,
} from './contracts.js';

function maybeCrash(name) {
  if (process.env[name] === '1') process.kill(process.pid, 'SIGKILL');
}

export class MonitorService {
  constructor(repository, logger = () => {}) {
    this.repository = repository;
    this.logger = logger;
  }

  async createSource(body) {
    const input = normalizeSource(body);
    const result = await this.repository.createSource(input.sourceId);
    this.logger({ event: 'source_ready', created: result.created });
    return result;
  }

  async rotateSourceEpoch({ principal, requestKey, sourceId, body }) {
    validateRequestKey(requestKey);
    validateIdentifier(sourceId, 'sourceId');
    const input = normalizeSourceEpoch(body);
    const result = await this.repository.rotateSourceEpoch({
      principal,
      requestKey,
      sourceId,
      intentDigest: digestValue({ operation: 'rotate_source_epoch', sourceId, ...input }),
      ...input,
    });
    this.logger({ event: 'source_epoch_rotated', replayed: result.replayed });
    return result;
  }

  async ingest(body, options = {}) {
    const input = normalizeWrite(body, options);
    const result = await this.repository.ingest(input);
    this.logger({
      event: 'ingest_query_visible',
      replayed: result.replayed,
      submittedCount: result.submittedCount,
      uniqueCount: result.uniqueCount,
      insertedCount: result.insertedCount,
      duplicateCount: result.duplicateCount,
      newSeriesCount: result.newSeriesCount,
    });
    maybeCrash('MON_CRASH_AFTER_INGEST_COMMIT');
    return result;
  }

  async query({ principal, requestKey, body }) {
    validateRequestKey(requestKey);
    const input = normalizeQuery(body);
    const result = await this.repository.query({
      principal,
      requestKey,
      intentDigest: digestValue({ operation: 'query', ...input }),
      ...input,
    });
    this.logger({
      event: 'query_materialized',
      replayed: result.replayed,
      queryStatus: result.status,
      absence: result.absence,
      sampleCount: result.samples.length,
    });
    return result;
  }

  async createRule({ principal, requestKey, body }) {
    validateRequestKey(requestKey);
    const input = normalizeRule(body);
    const result = await this.repository.createRule({
      principal,
      requestKey,
      intentDigest: digestValue({ operation: 'create_rule', ...input }),
      ...input,
    });
    this.logger({ event: 'rule_generation_ready', replayed: result.replayed });
    return result;
  }

  async createRuleGeneration({ principal, requestKey, ruleId, body }) {
    validateRequestKey(requestKey);
    validateIdentifier(ruleId, 'ruleId');
    const input = normalizeRuleGeneration(body);
    const result = await this.repository.createRuleGeneration({
      principal,
      requestKey,
      ruleId,
      intentDigest: digestValue({ operation: 'create_rule_generation', ruleId, ...input }),
      ...input,
    });
    this.logger({ event: 'rule_generation_ready', replayed: result.replayed });
    return result;
  }

  async rotateAuthority({ principal, requestKey, kind, body }) {
    validateRequestKey(requestKey);
    const input = normalizeAuthority(body, kind);
    const result = await this.repository.rotateAuthority({
      principal,
      requestKey,
      kind,
      intentDigest: digestValue({ operation: `rotate_${kind}_authority`, ...input }),
      ...input,
    });
    this.logger({ event: `${kind}_authority_rotated`, replayed: result.replayed });
    return result;
  }

  async evaluate({ ruleId, body }) {
    validateIdentifier(ruleId, 'ruleId');
    const input = normalizeEvaluation(body);
    const result = await this.repository.evaluate({ ruleId, ...input });
    this.logger({
      event: 'evaluation_committed',
      replayed: result.replayed,
      outcome: result.outcome,
      stateBefore: result.stateBefore,
      stateAfter: result.stateAfter,
      transitionKind: result.transition?.kind ?? 'none',
      routingStatus: result.transition?.routing.status ?? 'not_applicable',
    });
    maybeCrash('MON_CRASH_AFTER_EVALUATION_COMMIT');
    return result;
  }

  async createSilence({ principal, requestKey, body }) {
    validateRequestKey(requestKey);
    const input = normalizeSilence(body);
    const result = await this.repository.createSilence({
      principal,
      requestKey,
      intentDigest: digestValue({ operation: 'create_silence', ...input }),
      ...input,
    });
    this.logger({ event: 'silence_created', replayed: result.replayed });
    return result;
  }
}
