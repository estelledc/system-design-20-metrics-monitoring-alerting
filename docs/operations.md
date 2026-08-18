# Operations

## Local boundary

This runbook starts one PostgreSQL 17.11 service, one loopback monitor process, and optionally one loopback synthetic provider plus
one-shot notifier processes. It is a development/verification topology, not a deployment guide.

## Prerequisites

- Node.js 22 or newer;
- npm with the committed lockfile;
- PostgreSQL 17.11, either from the pinned Compose image or an equivalent local service;
- loopback ports for monitor/provider;
- synthetic data only.

## Start PostgreSQL

```bash
docker compose up -d postgres
```

The pinned service creates database `metrics_alerting` with the documented local test credentials. Do not reuse those credentials
outside an isolated lab.

Set the application connection and two distinct synthetic tokens in the shell, then install exactly the lockfile:

```bash
export DATABASE_URL='postgres://postgres:postgres@127.0.0.1:5432/metrics_alerting'
export MON_API_TOKEN='replace-with-a-local-token-at-least-16-chars'
export MON_PROVIDER_TOKEN='replace-with-another-local-token-at-least-16-chars'
npm ci --ignore-scripts
```

The values above are placeholders. Never commit real credentials or place them in URLs/logs/metric labels.

## Start the monitor

```bash
PORT=3000 npm start
```

Startup applies the idempotent v0.1 schema and emits one low-cardinality `monitor_ready` event. `GET /health` proves only process
reachability. `GET /v1/state` additionally proves an authenticated database read of aggregate state.

## Start the synthetic provider

```bash
PROVIDER_PORT=3001 node src/main.js provider
```

The provider accepts only loopback HTTP requests authenticated with `MON_PROVIDER_TOKEN`. It stores attempt receipts in the same
PostgreSQL service for deterministic lab inspection; this shared failure domain is not representative of a real provider.

## Run one notification worker

First rotate notification authority through the monitor API. Then run:

```bash
export MON_PROVIDER_URL='http://127.0.0.1:3001'
export MON_NOTIFICATION_WORKER_ID='notifier-a'
export MON_NOTIFICATION_WORKER_EPOCH='1'
export MON_NOTIFICATION_LEASE_SECONDS='2'
node src/main.js notify-once
```

The process claims at most one item and exits. A nonzero exit leaves work pending/leased for explicit retry; it must never be
interpreted as a provider rejection or a human not being notified unless a matching receipt exists.

## Verification commands

Pure gates:

```bash
npm run check
```

PostgreSQL gates:

```bash
npm run test:infra
npm run smoke:infra
npm run benchmark:infra
```

All public-CI-equivalent gates:

```bash
npm run check:ci
```

Infrastructure commands require `DATABASE_URL` and fail instead of skipping when it is absent.

## Test-only crash controls

The smoke script starts isolated child processes with these one-shot environment variables:

- `MON_CRASH_AFTER_INGEST_COMMIT=1`
- `MON_CRASH_AFTER_EVALUATION_COMMIT=1`
- `MON_CRASH_AFTER_PROVIDER_ACCEPTED=1`

Each invokes a real process `SIGKILL` at a named ambiguity window. Never enable them in a shared or production-like environment.
The ordinary server has no HTTP switch that activates them.

## Recovery interpretation

### Monitor dies after ingest commit

1. Restart the monitor against the same database.
2. Retry the exact `(source, epoch, sequence)` batch.
3. Accept only `replayed: true` with the original `ingestRevision` and counts.
4. `conflict` means the supposedly stable identity changed; do not advance sequence automatically.

### Monitor dies after evaluation/transition commit

1. Restart the monitor.
2. Retry the exact `(rule, generation, slot)` evaluation.
3. Confirm the same evaluation/incident/transition/notification identities and `replayed: true`.
4. Do not submit a later slot until the missing slot receipt is recovered.

### Worker dies after provider acceptance

1. Treat the outcome as unknown until the outbox or provider receipt is read.
2. Rotate notification authority if ownership changes.
3. Wait for the stored lease to expire; do not mutate lease fields manually.
4. Retry with the same notification identity under a higher attempt number.
5. Expect duplicate provider requests. A deduplicated provider acceptance still does not prove device/human delivery.

### Missing metric input

1. Read the stored evaluation outcome and sample field; do not infer zero from absence.
2. Pending resets under v0.1. Firing remains open with no new transition.
3. Investigate source/ingest revision independently; the same monitor path cannot prove itself healthy.

## Observable state

Ordinary logs are JSON lines with operation, result class, counts, and duration. The aggregate endpoint exposes backlog/counts and
authority epochs. Neither surface contains high-cardinality identities or metric/notification payload data.

For forensic inspection in this synthetic lab, query PostgreSQL tables by evidence layer as listed in
[architecture](architecture.md). This is privileged debugging, not an ordinary observability interface.

## Backup, retention, upgrade, and rollback

v0.1 implements none of these production controls. The schema uses `CREATE TABLE IF NOT EXISTS` only; it is not a general migration
framework. Test reset requires the exact `snapshot-monitoring-lab-reset` confirmation and truncates all lab tables. Never point
tests at valuable data.

Before any real deployment work, define independent backup/restore tests, schema versioning, raw/evaluation/audit retention cuts,
encryption, secrets, rollback compatibility, database HA, RPO/RTO, and an external dead-man path. This repository has no evidence
for them.
