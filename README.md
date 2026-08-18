# Metrics Monitoring and Alerting Lab

This clean-room system-design practice starts with one question: when metric samples are duplicated, late, missing, or queried
while storage is still converging, what exact snapshot and state transition let an alert become pending, firing, or resolved without
turning ingestion noise and notification retries into invented incidents?

The prompt title is “Metrics Monitoring and Alerting.” This repository does not copy a monitoring product, source chapter,
protocol, diagram, benchmark, incident, or proprietary behavior. The initial contract is frozen from the title alone before reading
the fixed secondary chapter.

## Current phase

Closed-book analysis and source/ADR review are frozen. The selected v0.1 is a deliberately small PostgreSQL 17 authority for
bounded synthetic gauges, stable ingest/query/evaluation receipts, pending/firing/resolved incidents, versioned silence receipts,
and a fenced notification outbox. Implementation, tests, crash smoke, benchmark, public remote, and public CI are pending.

This is not a Prometheus, OpenTelemetry, Remote Write, Alertmanager, Grafana, PagerDuty, email, SMS, chat, or production time-series
implementation. The source comparison explains why unsupported metric types and external outcomes are rejected instead of guessed.

## Read first

- [Closed-book contract](docs/closed-book-contract.md)
- [Research log and source comparison](docs/research-log.md)
- [ADR 0001: PostgreSQL snapshot evaluations and a fenced notification outbox](docs/adr/0001-postgres-snapshot-evaluations-and-fenced-notification-outbox.md)
- [Security policy](SECURITY.md)

## Evidence boundary

A client send, gateway validation, durable batch receipt, query-visible sample, rule evaluation, alert transition, notification
enqueue, provider acceptance, device delivery, human acknowledgement, remediation, and service recovery are different facts. This
lab will name and test only the boundaries it reaches. It will abstain from production availability, paging delivery, human
response, incident correctness, remediation, SLA, or external acceptance unless matching evidence exists.

## License

MIT. Third-party study material, real metrics, and alert data are not included.
