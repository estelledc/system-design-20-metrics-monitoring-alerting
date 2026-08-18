# Requirements

## Product slice

v0.1 is a clean-room executable lab for one monitoring invariant:

> A rule evaluation must name the exact committed metric snapshot that produced its result, and a firing/resolved transition must
> commit atomically with either a notification outbox item or an explicit silence receipt.

The lab has one synthetic tenant, one PostgreSQL authority, finite gauges, exact-series queries, one threshold predicate, one
missing-data policy, one versioned silence matcher, and one local synthetic notification provider. It is not a general monitoring
product or protocol implementation.

## Functional requirements

### Sources and ingestion

1. An operator can create a named synthetic source and rotate its epoch with an expected-epoch precondition.
2. One `(source ID, epoch, batch sequence)` binds one canonical gauge batch.
3. Exact batch retry returns the original receipt; changed intent conflicts; stale epoch and sequence gaps are fenced.
4. Label order and sample order do not change identity. Exact duplicates inside a batch collapse before storage.
5. A same-series/same-time value already stored is idempotent; a changed value rejects and rolls back the whole batch.
6. One successful receipt names the PostgreSQL commit/query-visible ingest revision and exact submitted/unique/inserted/duplicate/
   new-series counts.
7. Metric type, label names/values/count, batch size, timestamp skew/age, and active series have hard limits.

### Queries

1. An authenticated caller submits one exact metric/label selector, half-open time range `[start, end)`, and result cap under an
   idempotency key.
2. The first request freezes the visible ingest revision and materializes the complete bounded result.
3. Exact retry returns the original result after later ingestion. Reusing the key for changed intent conflicts.
4. `series_absent`, `no_samples_in_range`, `result_limit_exceeded`, and a numeric zero are distinguishable.

### Rules and incidents

1. A rule generation fixes exact series identity, `value > threshold`, lookback, interval, consecutive true slots, and
   `reset_pending_keep_firing` missing policy.
2. A new generation requires the current generation number and an inactive state; v0.1 does not migrate an active episode.
3. One evaluator authority epoch fences new slots from superseded workers.
4. Each aligned, sequential `(rule, generation, slot)` stores one snapshot revision, selected sample or explicit absence, outcome,
   state before/after, and optional transition.
5. Exact evaluation replay returns its original result even after authority rotation or late sample ingestion.
6. True advances `inactive -> pending -> firing`; repeated true remains in one episode. False clears pending or resolves firing.
   Unknown clears pending but leaves a firing episode open without a transition.
7. Firing and resolved transitions have stable identities and immutable history.

### Silence and notification

1. A stable mutation key creates a rule-specific, inclusive-start/exclusive-end silence no longer than 24 hours.
2. Silence affects routing at transition commit. It does not alter evaluation outcome, incident state, or earlier outbox work.
3. A transition atomically stores either a routable outbox item or a suppressed routing receipt.
4. One notification authority epoch and lease attempt fence claim/completion. Expired work can be retried; stale completion fails.
5. Every provider request carries one stable notification identity and monotonically increasing attempt number.
6. The synthetic provider records request attempts and one deduplicated acceptance. Provider acceptance is the final claimed
   outcome; device delivery, human visibility, acknowledgement, remediation, and recovery remain unknown.

### Operator state

1. An authenticated state endpoint exposes only revisions, epochs, and low-cardinality aggregate counts.
2. Ordinary logs expose event/phase/result, counts, duration, and failure class but no source/series/rule/incident/notification
   identity, metric label/value, request body, token, destination payload, or provider body.

## Non-functional requirements

- **Determinism:** canonical identity and stored receipts make exact retries byte-semantic, not timing-dependent.
- **Atomicity:** ingestion batch mutation is all-or-nothing; evaluation, incident transition, and routing receipt share one database
  transaction.
- **Concurrency:** source, rule state, authority, and outbox rows are locked under explicit ordering; natural identities also have
  unique constraints/advisory serialization.
- **Crash evidence:** true processes must be killed after ingest commit, evaluation/transition commit, and provider acceptance.
- **Fail closed:** unsupported metric types, unbounded work, ambiguous timestamps, changed stable intent, stale epochs, skipped
  sequences/slots, and malformed provider receipts fail explicitly.
- **Portability:** the repository contains no machine paths, credentials, internal data, copied third-party material, or local
  cache artifacts.
- **Reproducibility:** dependencies, GitHub Actions, PostgreSQL image/service version, fixture sizes, and benchmark exclusions are
  pinned or recorded.

## Acceptance gates

1. Repository policy/syntax/link/privacy check passes.
2. Pure tests pass with zero skip/fail/todo.
3. PostgreSQL 17.11 tests pass with zero infrastructure skip/fail/todo.
4. True-process smoke observes three `SIGKILL` exits and recovers stable receipts.
5. Provider-unknown recovery observes two provider attempts, one provider acceptance, and one completed outbox item.
6. The bounded benchmark reports exact fixture, runtime/service versions, raw latency observations, exclusions, and no production
   extrapolation.
7. Dependency audit reports no high-or-higher vulnerability.
8. Public CI passes on Node 22, 24, and 26 against PostgreSQL 17.11.

## Explicit non-goals

- Prometheus/OpenMetrics/Remote Write/PromQL, OpenTelemetry/OTLP, Alertmanager, Grafana, or vendor compatibility;
- counters, delta/cumulative sums, resets, histograms, exemplars, recording rules, aggregation, downsampling, retention, or cache;
- scraping/discovery, collector handoff, queue/storage pipeline, custom TSDB, replication, sharding, consensus, HA, or DR;
- multi-tenancy, production auth/authorization, encryption/key management, webhook egress, real recipient/channel integration;
- anomaly detection, SLO/error budgets, diagnosis, remediation, incident-management workflow, or business outcomes;
- production capacity, cost, latency, availability, RPO/RTO, deployment, SLA, or external acceptance claims.
