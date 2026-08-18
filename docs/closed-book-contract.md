# Closed-book contract: snapshot-bound metrics and incident transitions

## Reading boundary

This contract was written from the case title alone, before reading the fixed `system-design-notes` chapter. “Metrics Monitoring
and Alerting” names a broad problem family, not one product contract. Pull versus push ingestion, cumulative versus delta values,
event versus processing time, time-series storage, query language, recording rules, alert lifecycle, silence/inhibition, routing,
notification providers, retention, downsampling, high availability, and multi-tenancy are hypotheses for this lab—not facts about
Prometheus, Alertmanager, Grafana, Datadog, CloudWatch, OpenTelemetry, PagerDuty, or any other system. Later research must record
confirmations, conflicts, omissions, and changes instead of silently rewriting this baseline.

## Users and core behavior

### Instrumentation source or collector

1. An authenticated synthetic source publishes a bounded batch of metric samples under a stable source epoch and batch sequence.
2. Each series has a canonical identity derived from a metric name plus sorted, validated labels inside one tenant/namespace.
3. A successful ingestion response states whether the batch was merely validated, durably accepted, or visible at a named query
   watermark. It does not imply a dashboard read, rule evaluation, incident, or human observation.
4. Retrying the same source epoch/sequence and canonical bytes returns the original receipt. Reusing that identity for changed
   bytes conflicts; stale source epochs and sequence gaps fail explicitly.

### Dashboard or query user

1. A caller requests a bounded series selector, time range, step, aggregation, and explicit work/result limits.
2. One response is evaluated against a named immutable read snapshot/watermark. Pagination or chunking must not mix different
   snapshots under one logical query identity.
3. Raw absence, stale series, delayed ingestion, retention loss, rejected samples, and numeric zero are distinct outcomes.
4. Approximation, downsampling, partial shard results, or timeout must be explicit; a graph must not silently turn missing work into
   a valid zero or complete result.

### Rule owner

1. A rule definition is immutable under a generation and contains a bounded expression, evaluation interval, optional pending
   duration, missing-data policy, labels/annotations, and routing policy reference.
2. Each `(rule generation, evaluation slot, series identity)` has one stable evaluation intent and one stored result bound to an
   input snapshot/watermark.
3. Re-evaluation after response loss returns that result. New late samples do not silently rewrite a previously committed alert
   transition; a deliberate correction/backfill is a separate versioned operation.
4. Updating a rule creates a new generation and defines how old pending/firing state is retired or migrated. It never edits the
   historical meaning of an old incident.

### On-call recipient or automation target

1. Notification routing turns an incident transition into a durable outbox item with a stable destination-independent identity.
2. Retry may create multiple provider requests. Provider acceptance, provider deduplication, device delivery, user visibility,
   human acknowledgement, remediation action, and recovery are separate receipts.
3. Silence and inhibition suppress routing under explicit versions/time bounds; they do not erase the underlying rule evaluation
   or incident history.
4. Acknowledgement or close by an operator is an audited action distinct from the metric returning to a healthy state.

### Platform operator

1. An operator can set cardinality/sample/query/evaluation/notification budgets, retention/downsampling policy, source/rule
   generations, and maintenance/silence state under strong preconditions.
2. Health exposes lag, rejection, evaluation age, notification backlog, and storage state without metric values, sensitive labels,
   query text, rule annotations, recipients, tokens, or incident payloads in ordinary logs/metric labels.
3. Repartitioning, replica takeover, retention, compaction, and recovery must preserve series identity, query snapshot identity,
   and incident transition history or return an explicit gap/partial result.

## Non-goals for v0.1

- real tenant/host/service identity, credentials, internal topology, production metrics, incident history, on-call contacts, or
  notification endpoints;
- compatibility with Prometheus remote write/PromQL, OpenTelemetry OTLP, Graphite, Influx line protocol, StatsD, Alertmanager,
  Grafana, PagerDuty, SMS, email, chat, webhooks, or any vendor;
- arbitrary query language, joins, traces/logs/profiles, service maps, anomaly detection, forecasting, SLO/error-budget product,
  machine learning, root-cause analysis, remediation, or incident management;
- globally distributed ingestion/query, multi-region disaster recovery, consensus implementation, arbitrary shard movement,
  production backup/restore, deployment, SLA, capacity, or cost claims;
- proving pager/device delivery, human visibility, human acknowledgement, correct diagnosis, remediation, recovery, business impact,
  or external acceptance;
- accepting unbounded label cardinality, timestamps, query ranges, rule expressions, result rows, notification fanout, retries,
  silence duration, or history.

## Hypothetical scale envelope

These numbers select failure modes; they are not sourced requirements:

- 100,000 synthetic sources × 200 active series each gives 20 million active series before cardinality mistakes;
- one sample every 15 seconds gives about 1.33 million samples/s average;
- at a hypothetical 16 raw bytes per timestamp/value pair, samples alone are about 21.3 MB/s or 1.84 TB/day before labels,
  indexes, metadata, WAL, compression, replication, queries, and alerts;
- replication factor 3 would make that raw sample component about 5.53 TB/day; 30 days would be about 166 TB before the omitted
  overheads and any downsampling;
- one accidental unbounded `request_id` label at 50,000 values/minute creates 72 million new series/day even if sample throughput
  looks moderate;
- 100,000 rules every 30 seconds is about 3,333 evaluations/s before expanding each rule across matched series;
- 1% of evaluations entering a notification path would still be roughly 33 transitions/s, and a correlated outage could create a
  much larger burst.

The runnable lab will use a small synthetic fixture, report exact series/sample/rule/incident counts, and never extrapolate it to a
production monitoring platform.

## Candidate data and state model

Canonical series identity:

```text
(tenant, metric name, sorted label pairs) -> stable series digest
source epoch + batch sequence + canonical batch digest -> ingest receipt
event timestamp + series -> sample identity within the selected duplicate policy
```

Ingestion visibility:

```text
received -> validated -> durable batch -> indexed segment -> published query watermark
               \-> rejected with bounded per-reason count
```

Alert lifecycle:

```text
inactive --true with coverage--> pending --true for required slots/time--> firing
   ^              |                         |                         |
   |              +--false-----------------+--false-----------------+--> resolved
   |              +--missing/partial--> explicit unknown policy
   +---------------- rule generation retired / explicit reset
```

Notification lifecycle:

```text
incident transition -> durable outbox -> claimed lease -> provider request
                                |              |             |
                                |              |             +-> accepted / rejected / unknown
                                |              +-> lease expires -> retry same stable item
                                +-> suppressed by versioned silence/inhibition receipt
```

## Core invariants

1. **Canonical bounded series identity.** Label order cannot create a new series, duplicate label names conflict, and names/values,
   label count, active series, and new-series rate have hard limits. Sensitive/unbounded labels are rejected rather than hashed into
   an invisible cardinality bill.
2. **Stable ingest identity.** One source epoch/sequence binds one canonical batch and immutable result. Exact retry replays;
   changed bytes conflict; stale epoch and sequence gaps cannot silently append.
3. **Event time is explicit.** Sample timestamp, receive time, durable time, query-visible time, evaluation slot, transition time,
   notification-attempt time, and acknowledgement time are different clocks.
4. **Duplicate/out-of-order policy is deterministic.** Same identity/same value is idempotent. Same series/timestamp with changed
   value, bounded late arrival, and samples beyond allowed skew each have explicit accept/reject/correction semantics.
5. **Acknowledgement names durability.** Gateway validation, durable WAL/transaction, replica acknowledgement, query visibility,
   and client receipt are separate. An unavailable later stage cannot retroactively upgrade an earlier receipt.
6. **Published watermark is monotonic.** Query-visible state advances only when every required partition/segment up to that boundary
   is complete or an explicit gap/partial marker is published.
7. **One query, one snapshot.** Pagination, aggregation, and repeated reads under one stable query identity cannot mix watermarks or
   retention generations. Changed query intent conflicts.
8. **No silent zero.** Missing, stale, rejected, retained-away, partial, unknown, NaN/invalid, and actual numeric zero remain
   distinguishable through query and alert evaluation.
9. **Rule generation is immutable.** Expression, interval, pending duration, missing-data policy, labels, and routing reference are
   fixed for one generation. Updates do not rewrite prior evaluations/incidents.
10. **Evaluation slot is idempotent.** One rule generation/slot/series binds one input watermark and outcome. Crash or response loss
    cannot count the same truth interval twice or create a second transition.
11. **Pending continuity is defined.** `for`/pending state advances only across the exact qualifying slots and coverage policy.
    Missing or partial inputs cannot accidentally satisfy elapsed time.
12. **Incident identity survives repeated truth.** Consecutive firing evaluations update one incident, not one incident per poll.
    False/unknown/recovered transitions follow explicit policy and cannot oscillate only because workers retry.
13. **Stale evaluator is fenced.** A superseded rule generation, scheduler lease, or evaluation worker cannot append a transition
    after a current generation/lease has taken over.
14. **Silence/inhibition does not alter truth.** Suppression records why routing did not occur while preserving evaluation and
    incident state. Expiry or policy changes do not manufacture a new firing transition without a defined repeat policy.
15. **Outbox is atomic with transition.** A routable incident transition and its notification intent commit together, or neither
    does. Claim/attempt/result are versioned so lease expiry can retry without losing the stable item.
16. **Provider acceptance is not delivery.** A `2xx`, provider ID, webhook response, or queued status does not prove device delivery,
    display, reading, acknowledgement, remediation, or recovery.
17. **Retention is an explicit evidence gap.** Raw/downsampled retention and rule/evaluation/incident history have versioned cuts.
    Queries/evaluations below a cut return explicit loss/unsupported resolution rather than invented continuity.
18. **Backpressure is visible.** Cardinality, ingest, storage, query, evaluation, incident, and notification limits reject/throttle/
    shed with typed receipts; no silent sample, alert, or notification drop is labeled success.
19. **Evidence is privacy-bounded.** Ordinary logs and low-cardinality metrics omit tenant/source/series IDs, label values, query
    text, rule annotations, incident payload, recipient, provider token/ID, and synthetic sample values used as sentinels.
20. **Monitoring the monitor is not self-proof.** Internal health signals, watchdogs, and dead-man rules require an independent
    path/receipt; a dashboard rendered by the same failed pipeline cannot prove the pipeline healthy.

## Initial API and event sketch

Authenticated ingest routes:

- `POST /v1/sources` to create/rotate a synthetic source epoch under a stable operator key;
- `POST /v1/write` with source ID/epoch, batch sequence, canonical series labels, timestamps/values, and required durability level;
- `GET /v1/ingest-receipts/{id}` for non-value status after response loss.

Authenticated query routes:

- `POST /v1/queries` with selector, time range, step, aggregation, work/result caps, and stable query key;
- `GET /v1/queries/{id}/pages/{cursor}` bound to one published watermark/retention generation;
- `GET /v1/series-metadata` for bounded cardinality/last-seen metadata without exposing sample values in logs.

Authenticated rule/operator routes:

- `POST /v1/rules` and `POST /v1/rules/{id}/generations` with strong expected revision;
- `POST /v1/evaluations/{slot}` for a scheduler-owned, generation/lease-fenced evaluation intent;
- `GET /v1/incidents/{id}` for immutable transition history and current state;
- `POST /v1/silences` with matcher, start/end, owner/audit fields, and stable mutation key;
- `POST /v1/notification-workers/{worker}/claim` plus attempt completion under a lease epoch;
- `GET /v1/state` for watermarks, lag, rejection/backlog counts, oldest-age and health without payload identities.

Exact metric types, duplicate rules, query semantics, timestamp/skew bounds, auth, storage, scheduler, rule expression language,
notification destination, silence/inhibition behavior, retention, and error vocabulary remain hypotheses until primary sources are
reviewed.

## Failure matrix

| Failure window | Required result |
|---|---|
| source loses response after durable ingest | exact source epoch/sequence returns original receipt; changed batch conflicts |
| gateway accepts but durable store fails | no durable/query-visible success; bounded retry or explicit unavailable result |
| two workers ingest the same batch | one stored intent/result; duplicate work cannot double sample/index counts |
| late sample arrives after watermark/evaluation | explicit reject, correction generation, or future-only visibility; no silent historical alert rewrite |
| label explosion crosses budget | typed cardinality rejection before unbounded series/index allocation |
| compactor dies before manifest publication | partial segment remains invisible; exact recovery completes/reuses or discards it safely |
| query page response is lost | exact query/cursor returns same snapshot page; changed intent conflicts |
| retention crosses query/rule window | explicit gap/unsupported resolution; no fabricated zero or continuous pending duration |
| evaluator dies after result commit | stable slot replay returns same result/transition; no duplicate incident/outbox |
| old evaluator finishes after lease/generation takeover | stale finalize is fenced and cannot append a transition |
| input is missing during pending/firing | configured unknown/missing policy applies; absence is not automatically healthy or firing |
| silence begins while incident is firing | evaluation remains firing; routing suppression has a separate versioned receipt |
| transaction commits transition then process dies | matching outbox item remains claimable; transition cannot exist without routing intent when policy requires it |
| provider accepts request but worker loses response | same outbox item may retry; provider effect may duplicate and is not called exactly once |
| notifier dies while holding lease | lease expiry permits fenced retry; old worker completion cannot overwrite newer result |
| correlated outage creates alert storm | grouping/dedup/rate limits expose backlog and suppression; no unbounded fanout or silent success |
| monitoring path itself stalls | independent dead-man/heartbeat receipt becomes missing; same-path dashboard is not accepted as proof |

## Required executable evidence before v0.1 completion

1. A clean-room README, source comparison, requirements, architecture, API/events, operations, threat model, and at least one ADR.
2. Exact series/batch/query/rule/evaluation/incident/outbox validation and stable-identity/error-vocabulary tests.
3. Generated/property tests for canonical series identity, duplicate/out-of-order samples, watermark monotonicity, snapshot-stable
   queries, pending/firing/resolved transitions, missing-data policy, silence, lease fencing, and notification replay.
4. Real persistence or real multi-process tests for concurrent ingest, durable retry, atomic watermark/segment publication,
   evaluation/outbox atomicity, stale worker fencing, retention gaps, and durable restart.
5. A true-process crash/restart smoke covering ingest response loss, partial segment/manifest recovery, rule transition response loss,
   silence/routing boundary, notification lease expiry, provider-unknown retry, and no human-delivery claim.
6. A bounded benchmark with exact series/sample/label/rule/query/incident fixture, runtime/service versions, exclusions, and raw
   observations—without production extrapolation or vendor comparison.
7. Node 22/24/26 public CI with pinned actions/services, dependency audit, zero skipped infrastructure tests, and exact commit/run
   receipts.
8. Privacy/evidence scans that reject synthetic secret/label/value/recipient sentinels and any claim of production SLA, human
   acknowledgement, incident resolution, or external acceptance without matching evidence.

## Initial design choices to challenge after source review

- Does the chapter define counters, gauges, histograms, events, or treat all metrics as interchangeable numeric points?
- Is ingestion push, pull, or both, and what exact durable/query-visible acknowledgement does each offer?
- How are canonical series identity, label cardinality, tenant limits, source restarts, duplicate batches, out-of-order points, clock
  skew, and late correction defined?
- Is storage append-only, mutable by timestamp, log-structured, columnar, or delegated—and what makes a compacted block visible?
- Do range queries bind one snapshot/watermark, and can pagination/downsampling/partial shards change the answer mid-read?
- Does alert evaluation name an input watermark, rule generation, evaluation slot, missing-data/staleness policy, pending continuity,
  and stable incident identity?
- Are silence, inhibition, grouping, repeat interval, acknowledgement, and resolution separate states or blurred into “send alert”?
- What happens after provider timeout/unknown status, and which receipt—if any—proves device delivery or human response?
- Which throughput, retention, compression, query, rule, notification, and availability numbers are cited/reproducible versus assumed?
- Which claims require a real TSDB, database, object store, queue, notification provider, multi-region runtime, or human evidence that
  this lab must abstain from?

Implementation remains pending until this baseline is committed, the fixed source is inspected, primary specifications are
verified, and the smallest executable invariant is selected.
