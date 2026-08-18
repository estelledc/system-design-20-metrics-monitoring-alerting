# Research log

## Evidence boundary

The secondary chapter is fixed at repository commit `9d8388721e7231442763ad37398b8d82224aa68f`, chapter tree
`8a411d9d4870e6b703a51773b0441445bf38f632`, and `README.md` blob
`ca659470078b3e84a8e81f17350f61f187b39780`. The source tree has no detected license, so this repository contains only
independent analysis and implementation. It does not copy the chapter's prose, diagrams, images, tables, example data, benchmark
figures, or code.

The chapter is an interview-oriented architecture sketch, not a protocol specification or a current contract for Prometheus,
Alertmanager, OpenTelemetry, PostgreSQL, Kafka, InfluxDB, Grafana, or a notification provider. Its numbers and product statements
remain secondary evidence unless a primary source or this lab verifies them.

Controlled public-source acquisition produced locally verified, hashed bundles for the fixed chapter, Prometheus's data model,
exposition formats, query/staleness behavior, alerting rules, Alertmanager behavior/configuration/high availability, Remote Write
2.0, OpenTelemetry's metrics data model, and PostgreSQL 17 isolation/locking. The Gorilla paper PDF was downloaded and hashed, but
the controlled reader could not normalize it; that partial acquisition is retained only as a diagnostic, and this log does not use
the paper's contents as evidence. These are acquisition receipts, not third-party attestations.

The primary pages were observed on 2026-08-19 Asia/Shanghai. URLs containing `latest` can drift; these raw SHA-256 values identify
the exact bytes reviewed:

| Source | Role | Observed raw SHA-256 |
|---|---|---|
| [Prometheus data model](https://prometheus.io/docs/concepts/data_model/) | series identity | `b46da13d737ca9cb93879d63a70e314f5474eefe82efe04dd6dc8ec85ad363ec` |
| [Prometheus exposition formats](https://prometheus.io/docs/instrumenting/exposition_formats/) | input grammar/uniqueness | `6e120a85dbcf2c148d8a26b63b90a82ca23b5679a1227eb0659d3d83a506e0c7` |
| [Prometheus query basics](https://prometheus.io/docs/prometheus/latest/querying/basics/) | evaluation time/lookback/staleness | `794dcdd4ce768a7f2c294ccf2691b380e81622a83720a450037d2ae609d2902c` |
| [Prometheus alerting rules](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/) | pending/firing lifecycle | `831abfb08ac68f372388703c0a6657a8e6cdced43bc88bba41b0f73135c63edc` |
| [Alertmanager overview](https://prometheus.io/docs/alerting/latest/alertmanager/) | grouping/routing/silence/inhibition | `918826fcbf25844ff97dd834f2a38a920c06c5ccea0758c0c0702e8203b419e9` |
| [Alertmanager configuration](https://prometheus.io/docs/alerting/latest/configuration/) | routing and timing controls | `c6f9d78ca11e37eac2ca5faeeb5abc95995562823be93929ebe1ea7181e98883` |
| [Alertmanager high availability](https://prometheus.io/docs/alerting/latest/high_availability/) | fail-open/dedup boundary | `273ef7b7d58adc51b7dbc5e5af222041a37350da1fd9d955d82d6d4b7a88adb9` |
| [Remote Write 2.0](https://prometheus.io/docs/specs/prw/remote_write_spec_2_0/) | accept/partial/retry semantics | `1ccf8a3658fb1bd34c1a5e126aceec02598e5b8bf80ff4ff02245958026e0c54` |
| [OpenTelemetry metrics data model](https://opentelemetry.io/docs/specs/otel/metrics/data-model/) | type/temporality/missing/single-writer semantics | `f5fe5c0bfe3ee2566206def7ac4e7a9873ec53fdde248b379ebbf5cfddf2bfc7` |
| [PostgreSQL 17 transaction isolation](https://www.postgresql.org/docs/17/transaction-iso.html) | snapshot/isolation behavior | `70cf332f46ff2d0537fe7706a7922fee9f1d8092fe98a8ea05947fe7cc1c769d` |
| [PostgreSQL 17 explicit locking](https://www.postgresql.org/docs/17/explicit-locking.html) | row/advisory lock behavior | `dc13a9df72216e8bde3a9b6a4640493a6af8436c2ce7f06023bbce41e06cac44` |

## Closed-book comparison

| Question | Closed-book decision | Fixed chapter | Result for v0.1 |
|---|---|---|---|
| series identity | metric name plus canonical, bounded labels; duplicate label names conflict | metric name plus tags, but the example repeats the same identity and timestamp with different values | canonicalize and hash exact gauge identities; reject conflicting duplicates and cardinality overflow |
| ingest retry | source ID, epoch, sequence, and canonical batch digest bind one immutable receipt | pull/push and Kafka are shown without request identity or response-loss behavior | one PostgreSQL transaction stores batch receipt, samples, and monotonic ingest revision |
| time | observation, receive, commit, query snapshot, evaluation slot, transition, and notification attempt are different clocks | timestamps are data fields, but late arrival, skew, gaps, and evaluation-time meaning are not defined | bounded event timestamps; committed late gauges may affect future evaluations but never rewrite stored evaluations |
| query | one stable request freezes a named snapshot and explicit absence state | a query service/cache is optional; no snapshot, pagination, or partial-result contract | materialize each bounded query result against one ingest revision; exact retry replays it |
| metric type | start with gauges only; counter/histogram temporality is a separate contract | CPU gauges and request/message counters are treated as interchangeable numeric points | reject unsupported types instead of inventing reset/rate semantics |
| alert evaluation | immutable rule generation and idempotent evaluation slot bind input snapshot, value/absence, and transition | an alert manager periodically queries and creates an event when a condition is met | a rule evaluator stores every slot; Alertmanager-like routing is kept downstream of truth evaluation |
| missing data | missing/stale/rejected/retained-away/partial are not numeric zero | collection loss is called acceptable while reliability must avoid critical misses | v0.1 resets pending on missing data, keeps an existing firing incident open, and records `unknown` |
| lifecycle | inactive, pending, firing, resolved; repeated truth does not create repeated incidents | a YAML `for` example is shown, but durable pending/firing/resolved state is absent | exact consecutive slots advance pending; one firing episode has one incident and versioned transitions |
| silence | suppress routing under a versioned time window without changing evaluation truth | filtering/merging/dedup are named without a silence/evaluation boundary | evaluate first; atomically store either a routable outbox item or a suppression receipt |
| notification | transition and outbox commit together; provider acceptance is not human receipt | Cassandra, Kafka, retries, and “at least once” are asserted without one atomic join | lease-fenced worker may retry one stable notification ID; duplicate provider requests remain possible |
| evidence | name validated, committed, query-visible, evaluated, transitioned, enqueued, accepted, and acknowledged separately | component arrows can be read as end-to-end delivery | executable vocabulary stops at a synthetic provider's durable acceptance receipt |

## What the chapter contributes

- It scopes the interview problem to infrastructure/application metrics and separates collection, transport, storage, alerting,
  and visualization. That decomposition is a useful first map as long as the joins have explicit receipts.
- It identifies label cardinality, long retention, downsampling, write-heavy ingestion, bursty incident-time reads, and alert storms
  as distinct pressures. Those dimensions matter more than choosing a database by name.
- Pull and push have different discovery, reachability, short-job, debug, and backpressure trade-offs. A heterogeneous source
  estate may need both, but transport direction alone says nothing about authentication or durability.
- Buffering collection from storage can isolate outages and permit replay. A queue helps only when request identity, ordering,
  retention, backpressure, and the database acknowledgement boundary are also specified.
- Aggregation at source, pipeline, storage, or query time trades fidelity, bandwidth, write cost, state ownership, and query work.
  Downsampling is a versioned data product, not merely a cheaper copy.
- Reusing a time-series database, rule engine, Alertmanager, and Grafana is often more defensible than building every layer. The
  lab therefore implements one narrow correctness join rather than pretending to replace a production observability stack.

The runnable slice focuses on the seam that the component diagram leaves open: which immutable sample snapshot made a rule
pending/firing/resolved, and whether the corresponding notification intent survived a crash without becoming evidence of human
delivery.

## Defects and missing contracts in the fixed chapter

1. **The scale unit is ambiguous.** “Ten million metrics” could mean active series, metric names, instruments, or samples. Storage,
   indexes, query fanout, and cardinality risk differ by orders of magnitude across those meanings.
2. **The arithmetic omits sample frequency and representation.** One-year retention cannot be sized from series count alone;
   interval, labels, indexes, metadata, WAL, compression, replicas, downsample overlap, churn, and query state are missing.
3. **The sample example violates its own identity.** Multiple values appear for the same metric name, label set, and timestamp. No
   duplicate, conflict, correction, or multi-writer rule says which value is true.
4. **Metric types are collapsed into numbers.** CPU load is gauge-like, while request/message counts may be cumulative or delta.
   Rate, reset, rollup, interpolation, and missing-point semantics cannot be shared without declaring type and temporality.
5. **The “line protocol” attribution is imprecise.** Prometheus's official text exposition uses a metric/label/value/optional
   timestamp grammar and requires each metric-name/label combination to be unique in one exposition. The chapter's example neither
   names a precise protocol nor follows that uniqueness rule.
6. **Cardinality has advice but no control plane.** There is no label schema, per-tenant/metric budget, churn/new-series rate,
   rejection receipt, top offender view, sensitive-label policy, or emergency limit.
7. **The general-database rejection is unsupported.** Engine, schema, access pattern, indexes, durability, fixture, hardware, and
   measurements are absent. PostgreSQL is not a production TSDB substitute here, but it is sufficient to verify a bounded state
   machine and transaction boundary.
8. **The InfluxDB throughput figure is not reproducible.** It lacks exact product/version, workload, batch size, tag distribution,
   retention, durability, replication, query load, hardware/storage, warm-up, repetitions, and raw observations.
9. **Pull does not guarantee authenticity.** Preconfigured discovery identifies an intended target, but TLS identity,
   authentication, authorization, compromised endpoints, relabeling, and tenant isolation still matter.
10. **Transport claims are overgeneralized.** Push is not inherently UDP and pull is not inherently a new TCP connection per
    scrape. Protocol, connection reuse, TLS, batching, compression, acknowledgement, and loss policy decide the behavior.
11. **Collector ownership lacks a generation fence.** Consistent hashing can suggest placement, but membership changes can create
    overlapping collectors or gaps. Assignment epoch, lease, handoff watermark, stale-worker rejection, and recovery are absent.
12. **“Occasional loss is acceptable” conflicts with critical alert reliability.** A missing scrape might be the outage signal.
    Each metric/rule needs explicit tolerance, freshness, gap, and dead-man semantics rather than a global fire-and-forget policy.
13. **Kafka retention is not an ingestion receipt.** Accepted by a collector, written to Kafka, replicated, consumed, stored,
    indexed, and visible to a query are different states. No stable batch identity or watermark joins them.
14. **One partition per metric name is not generally scalable.** A hot name can remain hot, label repartitioning can reorder one
    series, and partition-count/schema changes need a versioned routing and replay contract.
15. **Partial batches are undefined.** The chapter does not state whether invalid samples reject the whole batch, valid members
    are retained, or a retry can duplicate the accepted subset.
16. **Late and out-of-order samples are undefined.** There is no skew/late window, per-series order, correction version, compaction
    interaction, or rule-backfill policy.
17. **Downsampling has no bucket contract.** Boundary inclusivity, timezone, late updates, aggregate fields, counter reset handling,
    histogram merge, completion watermark, correction, and source-to-rollup lineage are missing.
18. **The worked downsampling table is inconsistent.** The first three shown values average about 15.33, not 19. Including the
    value at the 30-second boundary produces 19 but changes the bucket rule; the remaining row then needs a separately stated
    boundary and timestamp policy.
19. **A query cache has no correctness key.** Selector, time range, step, evaluation time, lookback, ingest watermark, retention
    generation, authorization, partial status, invalidation, and maximum work all affect identity.
20. **SQL is dismissed from one awkward query.** That example does not establish that SQL is ineffective, nor does a shorter DSL
    establish storage performance. Language ergonomics, optimizer, physical layout, indexes, aggregates, and fixture must be
    measured separately.
21. **Absence is not modeled.** Numeric zero, no matching series, stale series, scrape failure, delayed batch, rejected sample,
    retention gap, and partial query can produce different operational decisions.
22. **Evaluation time is absent.** A rule needs an immutable definition generation, schedule/slot, query time, lookback, input
    snapshot, result, retry identity, and policy for late data. Polling “periodically” is not enough.
23. **Pending continuity is absent.** The YAML `for` field is shown, but no rule says which consecutive evaluations count, how gaps
    behave, or whether restart/reconfiguration preserves pending state.
24. **Repeated truth, recovery, and rule updates are underspecified.** Without incident identity and generation, every poll can
    create a new alert, a late false can resolve the wrong episode, and editing a rule can rewrite historical meaning.
25. **Alert truth and notification policy are mixed.** Filtering, grouping, deduplication, silence, inhibition, routing, rate
    limits, and retries should not mutate the stored evaluation result.
26. **The state/outbox atomic join is missing.** A process can commit a firing transition and crash before publishing Kafka, or
    publish and crash before recording state. Cassandra plus Kafka does not itself make those effects atomic.
27. **“At least once” has no endpoint.** It could describe enqueue, provider request, provider acceptance, device delivery, or
    human awareness. Retries can duplicate any non-idempotent downstream effect.
28. **Notification worker ownership is unfenced.** A timed-out worker can finish after takeover and overwrite a newer attempt
    unless claim epoch, lease deadline, and completion preconditions are stored.
29. **Alert storm controls are only names.** Group key, group wait, inhibition dependency, per-destination quota, backlog limit,
    drop/suppression receipt, and dead-man alert require concrete semantics.
30. **Retention can erase evidence silently.** Raw samples, rollups, query receipts, evaluation receipts, incidents, suppressions,
    notification attempts, and audit records need separate cuts and an explicit historical-gap response.
31. **Security and privacy are absent.** Source/rule/operator auth, tenant isolation, label/value sensitivity, query authorization,
    recipient secrets, webhook SSRF, template injection, audit, erasure, and log/metric cardinality are not designed.
32. **Availability is asserted without a failure model.** Process crash, storage loss, zone loss, partition, clock skew, backlog,
    dependency failure, recovery time, and RPO have different outcomes. A dashboard produced by the failed path cannot prove the
    monitor is healthy.
33. **The design stops before external outcomes.** There is no receipt for provider durability, device delivery, user visibility,
    acknowledgement, correct diagnosis, remediation, service recovery, deployment, SLA, or external acceptance.

## Primary-source corrections

### Series identity and missingness are first-class semantics

Prometheus's official [data model](https://prometheus.io/docs/concepts/data_model/) defines a series by metric name plus label set;
changing any label value creates another series. Its official
[exposition-format documentation](https://prometheus.io/docs/instrumenting/exposition_formats/) defines the text grammar and says
each metric-name/label combination in one exposition must be unique or ingestion behavior is undefined.

Prometheus's [query basics](https://prometheus.io/docs/prometheus/latest/querying/basics/) select the newest eligible point within a
lookback (five minutes by default) and remove a series after a stale marker. OpenTelemetry's
[metrics data model](https://opentelemetry.io/docs/specs/otel/metrics/data-model/) has an explicit “no recorded value” flag and a
single-writer principle. These sources disprove the shortcut “no point means zero” and make identity conflicts observable errors.

v0.1 accepts only finite double-precision gauges. A series is a canonical metric name plus sorted labels. A same-series/same-time
same-value sample is idempotent; a changed value conflicts. Missing at an evaluation slot is stored as `unknown`, never coerced to
zero.

### Counter and histogram semantics cannot be inferred from a float

OpenTelemetry distinguishes gauge, sum, histogram, aggregation temporality, observation time, start time, resets, gaps, and the
single-writer rule. Its delta-to-cumulative discussion explicitly describes a stateful conversion and how overlap, loss, late
points, or restart can force reset/deduplication decisions.

v0.1 therefore rejects counters, deltas, histograms, exemplars, and arbitrary rollups. That narrow choice is more truthful than
accepting a number and silently guessing whether it is an instantaneous value, increment, or cumulative total.

### Remote-write acceptance is receiver-defined, partial, and retry-sensitive

The official but experimental
[Prometheus Remote Write 2.0 specification](https://prometheus.io/docs/specs/prw/remote_write_spec_2_0/) says the meaning of
“written” is receiver-defined and may stop before persistent storage or WAL. It requires exact written-count response headers,
prohibits a success response for partial failure, permits whole-request retry for some partial failures only when the receiver is
idempotent, requires retry/backoff for server errors, and keeps per-series samples in timestamp order. It also says cross-entity
transactionality is not defined.

v0.1 is deliberately not Remote Write compatible. Its much smaller API gives one batch all-or-nothing transactional semantics,
names a committed ingest revision, and replays the immutable receipt for an exact `(source, epoch, sequence)` retry. This proves
only this lab's PostgreSQL boundary.

### Query and evaluation need a frozen snapshot

Prometheus's query documentation gives evaluation-time and staleness rules, while PostgreSQL 17's
[transaction isolation](https://www.postgresql.org/docs/17/transaction-iso.html) distinguishes statement snapshots from a stable
transaction snapshot and requires callers to retry serialization failures at Serializable isolation.

v0.1 assigns each committed ingest batch a monotonically increasing revision. A stable query/evaluation request freezes the
currently published revision and reads only samples whose ingest revision is no newer. Its bounded result is materialized with the
receipt, so response loss or later samples cannot change the replay. This is application-level snapshot identity, not PromQL or a
PostgreSQL point-in-time recovery claim.

### Rule truth belongs upstream of notification policy

Prometheus's [alerting-rule documentation](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/) defines
active label sets, pending and firing states, optional `for`/`keep_firing_for`, synthetic alert series, and periodic sending to
Alertmanager. Alertmanager then groups, deduplicates, routes, silences, and inhibits notifications.

The official [Alertmanager overview](https://prometheus.io/docs/alerting/latest/alertmanager/) and
[configuration reference](https://prometheus.io/docs/alerting/latest/configuration/) also show that grouping delays and silence/
inhibition are notification choices. A silence mutes matching notifications; it does not make the source expression false.

v0.1 follows that separation: the evaluator first stores `true`, `false`, or `unknown` and advances one incident state machine.
Only a firing/resolved transition is routed. An active versioned silence creates a suppression receipt instead of an actionable
outbox item, without changing the evaluation or incident.

### High availability may prefer duplicate notifications to silence

Alertmanager's official [high-availability documentation](https://prometheus.io/docs/alerting/latest/high_availability/) instructs
Prometheus to send alerts to every Alertmanager instance rather than a load balancer. Its cluster design is intentionally
fail-open: during a partition, multiple sides may notify so an alert is less likely to be lost. Silences and a notification log are
replicated, alerts themselves are not persisted there, and Prometheus resends active alerts.

v0.1 does not imitate Alertmanager clustering. It uses one PostgreSQL-backed outbox and a fenced worker lease. If a worker loses
the result after the synthetic provider commits acceptance, the same stable notification ID may be sent again. Duplicate provider
requests are an admitted consequence; neither request nor acceptance proves a person was reached.

### PostgreSQL provides locks and snapshots, not the monitoring product

PostgreSQL 17's [explicit-locking documentation](https://www.postgresql.org/docs/17/explicit-locking.html) defines row-lock blocking
and transaction-lifetime release; transaction-level advisory locks are application-defined and automatically released. The
database supplies primitives, while the application must still define identities, preconditions, and evidence.

v0.1 uses ordinary row locks and unique constraints around the source sequence, global ingest revision, rule generation/state,
evaluation slot, incident transition, outbox, silence mutation, and worker epoch. It makes PostgreSQL a visible single authority
and bottleneck. It does not claim time-series compression, horizontal scale, availability, or a substitute for Prometheus.

## Decisions after comparison

- Accept only one synthetic tenant and finite gauge samples. Metric/label syntax, label count/length, batch size, time skew, active
  series, new-series rate, query range/result, rule, silence, and notification work have hard bounds.
- Canonical JSON fixes label ordering and batch identity. SHA-256 is an integrity/identity aid, not authentication or secrecy.
- `(source ID, source epoch, batch sequence)` binds one canonical batch digest. Exact retry returns its stored receipt; changed
  bytes conflict; stale epoch and future sequence fail before sample mutation.
- One ingestion transaction locks the source and system revision rows, validates every sample, resolves same-value duplicates,
  rejects any changed-value conflict, stores the batch receipt, and advances a committed `ingest_revision`.
- No separate indexer/segment publisher exists in v0.1. PostgreSQL transaction commit is both the durable lab boundary and query
  visibility boundary. The docs do not pretend there is an unimplemented WAL/segment watermark.
- A stable query key binds a canonical selector/range/limit. Creation freezes `snapshot_revision` and materializes a bounded JSON
  result. Exact retry returns it; changed intent conflicts. No pagination, cache, aggregation, or partial shard result is exposed.
- A rule generation is immutable and targets one exact gauge series with a `value > threshold` predicate, lookback, fixed slot
  interval, required consecutive true slots, and the fixed missing policy `reset_pending_keep_firing`.
- Each `(rule ID, generation, slot)` binds one snapshot revision and stored `true`/`false`/`unknown` outcome. Slots must be aligned
  and strictly sequential for that generation; exact replay returns the receipt, while gaps and stale generation/worker epoch fail.
- `true` advances inactive to pending to firing; repeated true keeps the same episode. `false` clears pending or resolves a firing
  episode. `unknown` clears pending but keeps an existing firing episode open without creating a transition.
- The firing episode and every transition have stable identities. A firing/resolved transition and its routing receipt commit in
  the same transaction. Re-evaluation or response loss cannot create a second incident, transition, or outbox row.
- A silence targets one rule and an inclusive start/exclusive end interval under a stable mutation key. It affects only routing
  decisions committed while active; it neither changes truth nor retroactively removes already-routable outbox work.
- A routable transition creates one pending outbox item for a fixed local synthetic provider. A silenced transition creates a
  suppressed routing receipt with no provider work. Inhibition, grouping, repeat notifications, escalation, and real channels are
  non-goals.
- One notification authority epoch fences claims and completion. Lease expiry permits retry of the same notification identity;
  an old worker cannot finalize after takeover. The synthetic provider records every request plus one deduplicated acceptance.
- Ordinary JSON logs contain only low-cardinality operation/phase/result, counts, duration, and failure class. They omit source,
  series, query, rule, silence, incident, outbox, recipient, digest, labels, sample values, auth material, and provider bodies.

## Remaining unknowns

- Prometheus/OTLP/Remote Write/OpenMetrics compatibility, pull scraping, service discovery, collector scheduling, target auth,
  relabeling, counters, histograms, exemplars, native histograms, recording rules, PromQL, federation, and long-term remote storage.
- A production TSDB's chunk format, compression, WAL, index, compaction, tombstones, out-of-order window, cache, rollups, retention,
  repair, backup/restore, horizontal sharding, replication, consensus, multi-region recovery, and query partial-results model.
- Multiple tenants/sources, source lease/handoff, high-cardinality discovery, adaptive quotas, hot series, clock synchronization,
  schema registry, correction/backfill generations, and raw-to-rollup lineage.
- Arbitrary rule expressions, joins, aggregation, vector matching, evaluation groups, scheduler HA, `keep_firing_for`, rule migration,
  inhibition graphs, notification grouping/repeats/escalation, templates, and alert clustering.
- Real email/SMS/chat/PagerDuty/webhook credentials, egress policy, SSRF, provider rate limits, provider idempotency, provider
  durability, device delivery, human visibility/acknowledgement, on-call response, remediation, and service recovery.
- Production authentication/authorization, tenant isolation, encryption, key management, privacy classification, audit/erasure,
  compliance, abuse response, capacity, cost, SLO/SLA, deployment, rollback, external acceptance, and business outcomes.
