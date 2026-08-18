# Metrics Monitoring and Alerting Lab

This clean-room system-design practice answers one question: when metric samples are duplicated, late, missing, or queried after
new data arrives, what exact snapshot made an alert pending, firing, or resolved—and how does that transition survive a crash
without becoming a false claim that a person was notified?

The prompt title is “Metrics Monitoring and Alerting.” This repository does not copy a monitoring product, source chapter,
protocol, diagram, benchmark, incident, or proprietary behavior. The initial contract is frozen from the title alone before reading
the fixed secondary chapter.

## Current phase

The v0.1 implementation and public implementation verification are complete. PostgreSQL 17 is the single explicit authority for
bounded synthetic gauges, stable ingest/query/evaluation receipts, pending/firing/resolved incidents, versioned silence receipts,
and a fenced notification outbox. Node 22/24/26 × PostgreSQL 17.11 all passed; the final documentation consistency run remains.

This is not a Prometheus, OpenTelemetry, Remote Write, Alertmanager, Grafana, PagerDuty, email, SMS, chat, or production time-series
implementation. The source comparison explains why unsupported metric types and external outcomes are rejected instead of guessed.

## Read first

- [Requirements and acceptance gates](docs/requirements.md)
- [Architecture and transaction boundaries](docs/architecture.md)
- [API and process contracts](docs/api.md)
- [Operations and crash recovery](docs/operations.md)
- [Threat model](docs/threat-model.md)
- [Verification and benchmark boundary](docs/verification.md)
- [Closed-book contract](docs/closed-book-contract.md)
- [Research log and source comparison](docs/research-log.md)
- [ADR 0001: PostgreSQL snapshot evaluations and a fenced notification outbox](docs/adr/0001-postgres-snapshot-evaluations-and-fenced-notification-outbox.md)
- [Security policy](SECURITY.md)

## What is executable

- Canonical gauge series and `(source, epoch, sequence)` batch receipts; exact retry replays, changed intent conflicts.
- A monotonic ingest revision; stable queries and rule evaluations read only samples visible at their frozen revision.
- Explicit `true`, `false`, and `unknown`; missing input never becomes zero.
- Immutable rule generations and sequential slots; pending continuity, firing episode, and resolved transition are durable.
- Silence suppresses routing without changing truth. Transition plus suppression/outbox commit atomically.
- Notification leases are epoch/attempt fenced. A provider-accepted response lost to `SIGKILL` produces another request with the
  same notification identity, not an exactly-once claim.

## Verification summary

Local Node `v26.7.0` + PostgreSQL `17.11` full gate:

```text
15 pure tests + 10 PostgreSQL tests, 0 skip/fail/todo
3 real SIGKILL windows recovered
2 provider requests -> 1 stable provider acceptance
npm audit: 0 vulnerabilities
```

The bounded benchmark uses 64 series × 32 points (2,048 samples), 64 queries, 32 rules, and 32 evaluations. Its exact raw
observations and exclusions are in [verification](docs/verification.md); they are not production capacity or SLA evidence.

Public implementation receipt: [GitHub Actions run 32197886283](https://github.com/estelledc/system-design-20-metrics-monitoring-alerting/actions/runs/32197886283),
three successful jobs with zero skipped/failed/todo tests.

## Run the gates

```bash
npm ci --ignore-scripts
npm run check
DATABASE_URL='postgres://...' npm run test:infra
DATABASE_URL='postgres://...' npm run smoke:infra
DATABASE_URL='postgres://...' npm run benchmark:infra
```

The included Compose service pins PostgreSQL 17.11. Infrastructure gates fail when `DATABASE_URL` is absent; they never skip.

## Evidence boundary

A client send, gateway validation, durable batch receipt, query-visible sample, rule evaluation, alert transition, notification
enqueue, provider acceptance, device delivery, human acknowledgement, remediation, and service recovery are different facts. This
lab will name and test only the boundaries it reaches. It will abstain from production availability, paging delivery, human
response, incident correctness, remediation, SLA, or external acceptance unless matching evidence exists.

## License

MIT. Third-party study material, real metrics, and alert data are not included.
