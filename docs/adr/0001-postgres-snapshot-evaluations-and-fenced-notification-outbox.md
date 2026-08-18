# ADR 0001: PostgreSQL snapshot evaluations and a fenced notification outbox

- Status: accepted for v0.1
- Date: 2026-08-19

## Context

The fixed chapter separates collection, transport, storage, alerting, and visualization but does not define the durable join among
them. A retry can duplicate samples, a late sample can change a later query, an evaluator can rerun after losing its response, and
a process can crash between committing a firing incident and enqueueing its notification. A second worker can also take over while
the first still holds a provider response.

The lab needs an executable correctness slice, not a miniature production time-series database. It must preserve these distinctions:

- observation time versus ingest commit revision versus evaluation slot;
- exact zero versus missing/stale/unsupported data;
- rule truth versus notification suppression;
- incident transition versus provider request/acceptance versus human delivery;
- exact request replay versus changed intent under a reused key.

## Decision

Use PostgreSQL 17 as one explicit authority for a single-tenant, gauge-only lab.

### Ingestion and series identity

- A series is a validated metric name plus sorted label pairs. Canonical JSON and SHA-256 give a stable series/batch identity.
- A source has an operator-rotated epoch and next sequence. `(source, epoch, sequence)` binds one canonical batch digest.
- One row-locked transaction validates the bounded batch, rejects any conflicting same-series/same-time value, inserts novel
  samples, stores the immutable receipt, and advances a monotonically increasing `ingest_revision`.
- An exact retry returns the original receipt. Changed intent, stale epoch, and future/gapped sequence fail without mutation.
- PostgreSQL commit is the lab's durability and query-visibility boundary. No extra queue, WAL, indexer, or segment publisher is
  claimed.

### Stable queries and evaluations

- A stable query key binds one exact-series selector, time range, and result cap. The first execution freezes the current ingest
  revision and stores the complete bounded result. A retry replays that receipt even after new samples arrive.
- A rule generation is immutable and supports one exact gauge series, `value > threshold`, an event-time lookback, a slot interval,
  a required count of consecutive true slots, and one missing policy: `reset_pending_keep_firing`.
- An evaluation request names rule generation, aligned slot, evaluator authority epoch, and stable identity. Slots are sequential.
  It freezes the current ingest revision and chooses the newest eligible sample at or before the slot.
- A late sample committed later may influence a future slot. It cannot change a stored evaluation receipt or historical transition.
- Missing input stores `unknown`; it clears pending continuity but leaves an already firing episode open. It never becomes zero.

### Incident, silence, and outbox transaction

- Rule state is `inactive`, `pending`, or `firing`. Consecutive true slots create at most one firing episode. False resolves one
  firing episode. Repeated truth updates no external effect.
- A firing/resolved transition, incident mutation, and routing receipt commit in the evaluation transaction.
- An active versioned silence for the rule produces a `suppressed` routing receipt. It does not modify evaluation truth, incident
  state, or already committed outbox work.
- An unsuppressed transition creates one pending outbox item with a stable notification ID and fixed synthetic destination.

### Fenced notification delivery

- PostgreSQL stores one current notification worker identity and monotonically increasing authority epoch.
- A claim records worker, authority epoch, attempt number, and lease deadline. Expired work may be reclaimed under a newer epoch.
- Completion succeeds only for the current claim tuple. A stale worker cannot overwrite a newer attempt.
- The local synthetic provider stores each request attempt and deduplicates its accepted effect by stable notification ID. A worker
  killed after provider acceptance but before outbox completion causes a retry request, not a claim of exactly-once delivery.
- `provider_accepted` is the final evidence boundary. Device delivery, user visibility, acknowledgement, remediation, and recovery
  remain unknown.

### Isolation and deadlock discipline

- Mutating paths use short PostgreSQL transactions, row locks, unique constraints, and compare-and-set preconditions.
- Ingestion locks source then global revision. Rule generation/evaluation locks rule then its state; evaluation reads the visible
  revision and filters every sample by it. Notification paths lock authority before outbox work.
- Stable identities and unique constraints are the final duplicate guard. Retryable transaction failures are bounded and visible;
  they are never reported as successful work.

## Alternatives rejected

### Build a custom time-series store

Rejected because chunk encoding, WAL, index, compaction, replication, repair, and distributed query would dominate the exercise
without closing the alert/outbox boundary. A PostgreSQL bottleneck is explicit and testable.

### Implement Prometheus Remote Write, PromQL, or OTLP

Rejected because compatibility requires far more metric types, metadata, temporality, staleness, protocol, and partial-write
semantics than v0.1 can verify. The lab rejects unsupported inputs instead of shipping a misleading subset under a real protocol
name.

### Put Kafka between every stage

Rejected because a queue does not by itself atomically join database state, evaluation, and notification. It would add producer,
consumer, retention, ordering, and checkpoint contracts while the single-database transactional outbox already demonstrates the
target failure windows.

### Re-evaluate historical slots when late data arrives

Rejected because silent mutation would make incident and notification history unstable. A future correction/backfill generation
could be designed separately, but v0.1 only appends new evaluation slots.

### Treat missing data as healthy or zero

Rejected because transport/storage failure could erase the exact evidence needed to detect an outage. The explicit `unknown`
result and fixed state policy keep the ambiguity visible.

### Claim exactly-once notification

Rejected because a crash can occur after a provider commits but before the worker records completion. Stable identity permits
deduplication where supported; at-least-once requests and possible duplicates are the honest contract.

## Consequences

### Positive

- Ingest, query, evaluation, incident, routing, and notification retries each have one stable receipt and conflict rule.
- Late data cannot rewrite previously committed alert history.
- Silence suppresses routing without erasing truth.
- A crash between transition and enqueue cannot lose the notification intent because both share one transaction.
- A stale evaluator or notification worker is fenced by generation/authority epoch.
- True-process tests can kill processes at the ambiguous response boundaries and inspect durable state after restart.

### Negative

- A global revision row, sequential evaluation per rule, and one notification authority are deliberate bottlenecks.
- Materialized query results trade storage for deterministic replay and are unsuitable for large/open-ended queries.
- Gauge-only exact-series rules do not demonstrate production query languages, aggregation, counter resets, histograms, or alert
  groups.
- PostgreSQL is one correlated failure domain; local tests prove neither database failover nor monitoring-platform availability.
- The synthetic provider can prove only its own committed acceptance and deduplication behavior.

## Verification obligations

- Unit/property tests for canonical identities, batch replay/conflict, time/label/cardinality bounds, missing policy, state
  transitions, silence boundaries, and low-cardinality logs.
- PostgreSQL tests for concurrent ingest, all-or-nothing sample conflict, stable query snapshots, late sample behavior, evaluation
  replay, generation/slot fencing, atomic transition/outbox, silence receipts, lease expiry, and stale completion.
- A true-process smoke that kills the API after ingest commit, kills it after firing transition commit, and kills a notification
  worker after synthetic provider acceptance; each restart must recover one stable stored intent without inventing delivery.
- A bounded benchmark with exact series/sample/rule/query fixture and raw Node/PostgreSQL-versioned observations.
