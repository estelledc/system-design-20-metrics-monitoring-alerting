# API and process contracts

## Common rules

- Monitor origin: `http://127.0.0.1:<PORT>`.
- Provider origin: `http://127.0.0.1:<PROVIDER_PORT>`.
- `GET /health` is public and proves only that the process can answer HTTP.
- Every `/v1/*` monitor route requires `Authorization: Bearer <MON_API_TOKEN>`.
- The provider accept route requires `Authorization: Bearer <MON_PROVIDER_TOKEN>`.
- Tokens must contain at least 16 characters. v0.1 has one fixed synthetic principal; it is not production authorization.
- JSON bodies reject missing, extra, mistyped, non-finite, or out-of-bound fields.
- Timestamps use canonical UTC millisecond form such as `2026-08-19T00:09:00.000Z`.
- Responses use `Cache-Control: no-store` and one JSON object.
- `Idempotency-Key` is 8–128 characters matching `[A-Za-z0-9._:-]`; one key binds one canonical intent.

Examples below are synthetic. Their dates illustrate shape; callers must stay inside the configured seven-day sample age/five-
minute future-skew bounds at execution time.

## Sources and samples

### `POST /v1/sources`

Create or read an idempotent source identity.

```json
{
  "sourceId": "source-a"
}
```

`201` on creation, `200` when already present:

```json
{
  "phase": "source_ready",
  "sourceId": "source-a",
  "sourceEpoch": 0,
  "nextBatchSequence": 0,
  "created": true
}
```

### `POST /v1/sources/{sourceId}/epochs`

Requires `Idempotency-Key`. Rotates the source epoch and resets its batch sequence after matching `expectedEpoch`.

```json
{
  "expectedEpoch": 0
}
```

An old source epoch receives `fenced`; a changed retry under the same key receives `conflict`.

### `POST /v1/samples`

The natural stable identity is `(sourceId, sourceEpoch, batchSequence)`, so no additional key is accepted.

```json
{
  "sourceId": "source-a",
  "sourceEpoch": 0,
  "batchSequence": 0,
  "samples": [
    {
      "metric": "cpu_utilization",
      "labels": { "host": "synthetic-01", "zone": "west" },
      "observedAt": "2026-08-19T00:09:00.000Z",
      "type": "gauge",
      "value": 72.5
    }
  ]
}
```

`201` for the first committed batch, `200` for exact replay:

```json
{
  "phase": "query_visible",
  "sourceId": "source-a",
  "sourceEpoch": 0,
  "batchSequence": 0,
  "batchDigest": "<64 lowercase hex characters>",
  "ingestRevision": 1,
  "submittedCount": 1,
  "uniqueCount": 1,
  "insertedCount": 1,
  "duplicateCount": 0,
  "newSeriesCount": 1,
  "replayed": false
}
```

The receipt proves the lab transaction committed and is visible to queries by revision. It does not prove scrape success,
replication, dashboard rendering, evaluation, incident creation, or human observation.

Limits include 128 samples/batch, eight labels/series, 2,048 active series, seven-day sample age, and five-minute future skew.
Only finite `gauge` values are supported. Exact duplicates inside a batch collapse; a changed same-series/same-time value rejects
the entire batch.

## Stable queries

### `POST /v1/queries`

Requires `Idempotency-Key`. The range is half-open: `start <= observedAt < end`.

```json
{
  "metric": "cpu_utilization",
  "labels": { "host": "synthetic-01", "zone": "west" },
  "start": "2026-08-19T00:00:00.000Z",
  "end": "2026-08-19T01:00:00.000Z",
  "limit": 100
}
```

`201` first materialization, `200` replay:

```json
{
  "phase": "query_materialized",
  "status": "complete",
  "snapshotRevision": 1,
  "series": {
    "metric": "cpu_utilization",
    "labels": { "host": "synthetic-01", "zone": "west" },
    "seriesDigest": "<64 lowercase hex characters>"
  },
  "range": {
    "start": "2026-08-19T00:00:00.000Z",
    "end": "2026-08-19T01:00:00.000Z"
  },
  "absence": "none",
  "samples": [
    { "observedAt": "2026-08-19T00:09:00.000Z", "value": 72.5, "ingestRevision": 1 }
  ],
  "replayed": false
}
```

Absence values:

- `none`: at least one sample returned;
- `series_absent`: series did not exist at the frozen revision;
- `no_samples_in_range`: series existed but no sample matched the range;
- `not_applicable`: paired with `status: result_limit_exceeded`; no silently truncated sample list is returned.

## Rules, authority, and evaluation

### `POST /v1/rules`

Requires `Idempotency-Key`.

```json
{
  "ruleId": "cpu-hot",
  "metric": "cpu_utilization",
  "labels": { "host": "synthetic-01" },
  "threshold": 80,
  "lookbackSeconds": 120,
  "intervalSeconds": 60,
  "consecutiveTrueSlots": 2
}
```

The returned generation is immutable and always carries:

```json
{
  "predicate": { "operator": "gt", "threshold": 80 },
  "missingPolicy": "reset_pending_keep_firing",
  "state": "inactive"
}
```

### `POST /v1/rules/{ruleId}/generations`

Requires `Idempotency-Key`. The body has the same rule specification plus `expectedGeneration`; it must not contain `ruleId`.
The current rule state must be inactive. Pending/firing migration is deliberately unsupported.

### `POST /v1/evaluator/authority`

Requires `Idempotency-Key`.

```json
{
  "workerId": "evaluator-a",
  "expectedEpoch": 0
}
```

Returns the next `workerEpoch`. This epoch authorizes only new evaluation slots.

### `POST /v1/rules/{ruleId}/evaluations`

The natural identity is `(ruleId, generation, slot)`.

```json
{
  "generation": 1,
  "evaluatorId": "evaluator-a",
  "evaluatorEpoch": 1,
  "slot": "2026-08-19T00:10:00.000Z"
}
```

The slot must align to the rule interval. After the first slot, it must be exactly the preceding slot plus that interval.

```json
{
  "phase": "evaluation_committed",
  "evaluationId": "<64 lowercase hex characters>",
  "ruleId": "cpu-hot",
  "generation": 1,
  "slot": "2026-08-19T00:10:00.000Z",
  "snapshotRevision": 1,
  "outcome": "true",
  "sample": {
    "observedAt": "2026-08-19T00:09:00.000Z",
    "value": 90,
    "ingestRevision": 1
  },
  "stateBefore": "pending",
  "stateAfter": "firing",
  "consecutiveTrue": 2,
  "incidentId": "<64 lowercase hex characters>",
  "transition": {
    "transitionId": "<64 lowercase hex characters>",
    "incidentId": "<64 lowercase hex characters>",
    "kind": "firing",
    "routing": {
      "status": "routable",
      "notificationId": "<64 lowercase hex characters>"
    }
  },
  "replayed": false
}
```

If no eligible point exists, `outcome` is `unknown` and `sample` is `null`. A no-transition evaluation returns `transition: null`.
Exact replay is allowed even if evaluator authority later rotated; stale authority cannot append a new slot.

## Silence and incident reads

### `POST /v1/silences`

Requires `Idempotency-Key`.

```json
{
  "ruleId": "cpu-hot",
  "startsAt": "2026-08-19T00:10:00.000Z",
  "endsAt": "2026-08-19T01:10:00.000Z"
}
```

The interval is inclusive at start, exclusive at end. A transition committed in the interval receives:

```json
{
  "routing": {
    "status": "suppressed",
    "silenceId": "<64 lowercase hex characters>"
  }
}
```

The evaluation and incident remain true/firing or false/resolved. Existing outbox work is not retroactively removed.

### `GET /v1/incidents/{incidentId}`

Returns the firing episode and ordered immutable transitions with their routing receipt. It does not return notification provider
payloads or claim a human incident response.

## Notification authority and processes

### `POST /v1/notification-workers/authority`

Requires `Idempotency-Key` and the same `{workerId, expectedEpoch}` shape as evaluator authority.

There is no public claim/complete HTTP endpoint. The worker uses the database-backed internal contract through:

```bash
node src/main.js notify-once
```

Required environment:

- `DATABASE_URL`
- `MON_PROVIDER_URL`, restricted to a loopback HTTP origin
- `MON_PROVIDER_TOKEN`
- `MON_NOTIFICATION_WORKER_ID`
- `MON_NOTIFICATION_WORKER_EPOCH`
- optional `MON_NOTIFICATION_LEASE_SECONDS` from 1 through 60

The worker returns either `no_notification_work` or `notification_provider_accepted`. Any network/receipt ambiguity leaves the item
leased until expiry; it is not marked delivered.

### `POST <provider>/v1/accept`

Internal synthetic provider request:

```json
{
  "notificationId": "<64 lowercase hex characters>",
  "transitionKind": "firing",
  "attempt": 1
}
```

`202` receipt:

```json
{
  "phase": "provider_accepted",
  "notificationId": "<same identity>",
  "providerAttempt": 1,
  "replayed": false
}
```

Another worker attempt can return `replayed: true`: one provider acceptance identity already exists, although a second request was
observed. This is not device delivery or human acknowledgement.

## Aggregate state

### `GET /v1/state`

Returns only low-cardinality evidence counts and authority/revision numbers:

- ingest revision; source/series/sample/ingest/query receipt counts;
- rule generation/evaluation counts;
- firing/resolved incident and suppressed transition counts;
- pending/leased/provider-accepted notification counts;
- provider request-attempt and unique-acceptance counts;
- evaluator and notification authority epochs.

No source, series, label, value, rule, incident, silence, notification, or token is returned by this endpoint.

## Error vocabulary

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `invalid_request` | malformed/extra/missing/unsupported/unbounded input |
| 401 | `unauthorized` | bearer token missing or mismatched |
| 404 | `not_found` | source/rule/incident/route missing |
| 409 | `conflict` | stable identity reused for changed intent or slot misaligned |
| 409 | `fenced` | source/rule/evaluator/notifier/claim epoch is stale; response includes current value |
| 409 | `out_of_order` | source batch sequence or rule slot skipped/reordered; response includes expected value |
| 412 | `precondition_failed` | generation update attempted while the rule is active |
| 429 | `cardinality_limit` | active series cap would be exceeded |
| 503 | `unavailable` | provider outcome/receipt or required durable state is unavailable |
| 500 | `internal_error` | unexpected failure; details are not exposed |
