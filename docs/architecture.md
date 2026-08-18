# Architecture

## The invariant, in one picture

```text
source batch                    query / rule evaluation
    |                                    |
    v                                    v
canonical intent ---- PostgreSQL ingest_revision snapshot
    |                                    |
    +---- committed samples -------------+
                                         |
                                         v
                              true / false / unknown
                                         |
                              incident transition (optional)
                                         |
                    +--------------------+--------------------+
                    |                                         |
              active silence                           no active silence
                    |                                         |
          suppression receipt                       notification outbox
                                                              |
                                                     fenced lease attempt
                                                              |
                                                  synthetic provider accepted
                                                              |
                                          device / human / remediation UNKNOWN
```

All durable boxes are PostgreSQL rows. The final line is deliberately outside the evidence boundary.

## Components

| Component | Responsibility | Does not prove |
|---|---|---|
| HTTP monitor process | authentication, strict JSON routing, request/result vocabulary | storage durability before repository commit |
| contract layer | canonical labels/batches, bounds, timestamps, metric-type rejection | caller identity or source authenticity |
| PostgreSQL repository | receipts, row locks, revisions, samples, rule state, incidents, routes, leases | database HA or time-series production scale |
| pure rule model | deterministic `inactive/pending/firing` transition | scheduling, persistence, or notification |
| notification worker process | fenced claim, provider request, completion | exactly-once provider effect or human delivery |
| synthetic provider process | durable request-attempt row and deduplicated acceptance row | real email/SMS/page/device behavior |

## Identity model

### Series

```text
SHA-256(canonical JSON {
  tenant: "synthetic-lab",
  metric: validated_metric_name,
  labels: sorted_label_object
})
```

SHA-256 is used for stable integrity/identity, not authentication. The full metric and label object remains in PostgreSQL so a
digest is never the only description of intent.

### Ingest

```text
(source_id, source_epoch, batch_sequence) -> one canonical batch digest -> one immutable result
```

The canonical batch sorts samples by series and timestamp and collapses exact in-batch duplicates. Changing a value changes the
digest. Sequence advances by one batch, not one sample.

### Query and evaluation

```text
(principal, idempotency_key) -> one query intent + materialized snapshot result
(rule_id, generation, aligned_slot) -> one evaluation snapshot/result
```

Evaluator worker/epoch is execution authority, not evaluation meaning. Therefore an already committed evaluation can be replayed
after authority rotation, while a stale worker cannot create the next slot.

### Incident and notification

```text
(rule_id, generation, episode) -> incident_id
(incident_id, transition_kind, slot) -> transition_id
(transition_id, fixed_destination) -> notification_id
```

Repeated true evaluations do not produce more episodes or outbox rows. A new firing episode begins only after the preceding one
resolved.

## Time and snapshot semantics

The system keeps these clocks separate:

- `observed_at`: when a synthetic gauge became current;
- database receive/commit time: when the batch transaction committed;
- `ingest_revision`: monotonic application snapshot assigned at that commit;
- query range and frozen query snapshot;
- aligned rule evaluation slot and event-time lookback;
- incident transition slot;
- silence start/end;
- notification claim/lease time, provider request time, and provider acceptance time.

A query or evaluation first reads the visible global revision, then filters every sample by `ingest_revision <= snapshot`. An
uncommitted ingester cannot publish a revision. A later batch always receives a newer revision, so it cannot leak into an old
receipt even under PostgreSQL Read Committed statement snapshots.

The query result is stored as bounded JSON with its receipt. This is intentionally expensive but removes pagination/cache drift
from v0.1.

## Transaction boundaries

### Ingestion transaction

1. Serialize the natural batch identity and check an existing receipt.
2. Lock the source row; verify epoch and exact next sequence.
3. Lock the global revision row and reserve the next revision in memory.
4. Insert new series and samples; resolve same-value duplicates; abort on any changed value.
5. Enforce the active-series cap inside the same serialized transaction.
6. Insert the immutable receipt, advance source sequence and global revision, then commit.

If any sample conflicts, every earlier insert in that batch rolls back. A killed HTTP process after commit loses only the response;
retry returns the stored receipt.

### Evaluation transaction

1. Serialize `(rule, generation, slot)` and replay an existing result if present.
2. Lock the current rule head/state and share-lock evaluator authority.
3. Verify generation, worker epoch, slot alignment, and exact sequential slot.
4. Freeze the visible ingest revision and read the newest sample inside the event-time lookback.
5. Compute `true`, `false`, or `unknown`; advance the pure state model.
6. If firing/resolved, mutate the incident and insert a transition.
7. Check silence at the transition slot and insert either a suppression receipt or outbox item.
8. Store the evaluation result and updated rule state, then commit.

The transition and routing decision cannot be split by a process crash. A killed HTTP process after commit replays all IDs without
creating a duplicate incident or notification.

### Notification claim and completion

1. A claim share-locks current notification authority and verifies worker/epoch.
2. It selects the oldest pending or expired item with `FOR UPDATE SKIP LOCKED`.
3. It records worker, epoch, incremented attempt, and lease deadline.
4. The worker sends stable notification identity plus transition kind and attempt to the loopback provider.
5. Completion rechecks authority and exact claim tuple before storing `provider_accepted`.

Authority may rotate while an old process is at the provider. The provider can accept, then the old completion can be fenced. After
lease expiry a new worker sends another request. The provider records both attempts but one acceptance identity.

## Rule state machine

```text
inactive -- true (1..N-1) --> pending -- enough consecutive true --> firing
    ^                              |                                  |
    |                              +-- false / unknown ---------------+
    |                                                                 |
    +---------------- false (resolved transition) --------------------+

firing + true/unknown -> firing, no transition
pending + unknown      -> inactive, continuity reset
```

Unknown while firing is availability-biased: it keeps the episode open but does not send a repeat notification. This is one fixed
lab policy, not a universal recommendation.

## Concurrency and lock order

- Ingestion: natural-identity advisory lock -> source row -> global revision row.
- Rule mutation/evaluation: mutation/evaluation advisory lock -> rule head/state -> evaluator authority share lock.
- Notification: notification authority share lock -> selected outbox row.
- Stable identities are also backed by primary/unique constraints.
- Transactions are short; no provider network call occurs while a database transaction is open.

The global revision row and per-rule sequential slot are deliberate serialization points. They make the invariant visible and are
not offered as a horizontally scalable design.

## Storage tables by evidence layer

| Layer | Tables |
|---|---|
| ingest identity/visibility | `mm_sources`, `mm_ingest_receipts`, `mm_system_state` |
| series/sample facts | `mm_series`, `mm_samples` |
| stable reads | `mm_query_receipts` |
| rule definition/state | `mm_rule_heads`, `mm_rule_generations`, `mm_rule_states`, `mm_evaluator_authority` |
| evaluation/incident truth | `mm_evaluations`, `mm_incidents`, `mm_transitions` |
| notification policy | `mm_silences`, `mm_routing_receipts` |
| delivery attempt | `mm_notification_authority`, `mm_notification_outbox` |
| synthetic provider boundary | `mm_provider_attempts`, `mm_provider_acceptances` |

## Scaling path deliberately not implemented

A production design would need a real TSDB/WAL/index/compaction path, partitioned ingestion revisions or published watermarks,
query planning and partial results, counter/histogram semantics, rule-group scheduling, Alertmanager-style clustering/routing,
retention/downsampling lineage, multi-tenant quotas, replicas/consensus, and independent dead-man monitoring. None can be inferred
from this single PostgreSQL authority or its benchmark.
