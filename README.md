# Metrics Monitoring and Alerting Lab

This clean-room system-design practice starts with one question: when metric samples are duplicated, late, missing, or queried
while storage is still converging, what exact snapshot and state transition let an alert become pending, firing, or resolved without
turning ingestion noise and notification retries into invented incidents?

The prompt title is “Metrics Monitoring and Alerting.” This repository does not copy a monitoring product, source chapter,
protocol, diagram, benchmark, incident, or proprietary behavior. The initial contract is frozen from the title alone before reading
the fixed secondary chapter.

## Current phase

Closed-book contract only. Metric model, source comparison, primary references, storage, implementation, tests, benchmark, public
remote, CI, deployment, SLA, and external acceptance are all pending.

Candidate concerns include bounded series identity/cardinality, stable ingest retries, event time and late data, query snapshots,
rule generation/evaluation slots, pending/firing/resolved incidents, missing-data policy, silence/inhibition, notification outbox
recovery, and evidence separation. They are hypotheses until source review and executable validation.

## Read first

- [Closed-book contract](docs/closed-book-contract.md)
- [Security policy](SECURITY.md)

## Evidence boundary

A client send, gateway validation, durable batch receipt, query-visible sample, rule evaluation, alert transition, notification
enqueue, provider acceptance, device delivery, human acknowledgement, remediation, and service recovery are different facts. This
lab will name and test only the boundaries it reaches. It will abstain from production availability, paging delivery, human
response, incident correctness, remediation, SLA, or external acceptance unless matching evidence exists.

## License

MIT. Third-party study material, real metrics, and alert data are not included.
