# Threat model

## Scope and assumptions

This model covers the local synthetic v0.1 topology: authenticated monitor API, PostgreSQL authority, loopback provider, and
one-shot notification workers. It assumes the host, database administrator, and process environment are trusted. That assumption
is unacceptable for a production multi-tenant monitoring service and is recorded as residual risk.

## Assets

- source epoch/sequence and immutable ingest receipts;
- metric/label identity, synthetic values, and observation times;
- query snapshots and materialized results;
- rule generations, evaluation results, incident/transition history;
- silence windows and routing receipts;
- notification claim/attempt/provider acceptance receipts;
- API/provider bearer tokens and database credentials;
- audit meaning: which boundary was actually proved.

Even synthetic metric labels and values are treated as payload data. Ordinary logs/state must not expose them.

## Trust boundaries

```text
untrusted JSON caller
        |
  bearer + strict contract
        v
monitor process -------- PostgreSQL trusted lab boundary
                              ^
notification worker ----------+
        |
  distinct bearer + loopback URL restriction
        v
synthetic provider process ----+
```

The provider shares PostgreSQL for test determinism, so it is not an independent durability or security domain.

## Threats and controls

| Threat | v0.1 control | Residual risk |
|---|---|---|
| unauthenticated mutation/read | bearer required for every `/v1/*`; constant-time digest comparison | one coarse principal; no rotation, revocation, RBAC, mTLS, or audit identity |
| token/payload leak in logs | static log allowlist check; low-cardinality fields only; generic unexpected errors | process environment, database, HTTP capture, or privileged debugger can still read values |
| request smuggling/oversized JSON | Node HTTP parser, one JSON object, 256 KiB body cap, exact keys/types | no reverse-proxy hardening, header-count/timeout/TLS policy |
| label cardinality/resource exhaustion | syntax/length/count limits, forbidden sensitive names, 2,048-series cap, serialized enforcement | no per-source rate/new-series window, adaptive quota, tenant fairness, or disk/query budget |
| NaN/infinity/type confusion | finite-number validation and database checks; gauge-only type | no counter/histogram/temporality contract |
| duplicate/reordered ingestion | canonical batch identity, source epoch/sequence, receipt replay, changed-intent conflict | compromised current source can submit false but valid gauges |
| hash collision/substitution | canonical intent retained alongside SHA-256; relational uniqueness | no cryptographic signature/MAC; SHA collision is not operationally handled |
| partial batch corrupts truth | one transaction; changed same-series/time value aborts the entire batch | PostgreSQL/storage corruption and backup recovery are untested |
| late data rewrites incident history | evaluation stores snapshot revision/result; replay precedes current authority checks | no authorized correction/backfill generation |
| stale evaluator appends transitions | immutable generation, evaluator epoch, sequential slot, row lock, unique evaluation key | single authority row is a bottleneck/failure domain |
| silence hides truth | silence is checked only after evaluation/transition; suppression has separate receipt | malicious authorized operator can suppress within 24-hour window; no approval workflow |
| crash loses transition notification | incident transition and routing/outbox commit together | PostgreSQL loss/restore inconsistency is untested |
| stale notifier overwrites retry | authority epoch, lease deadline, attempt tuple, completion preconditions | clock/database availability controls lease progress |
| duplicate provider side effect | stable notification ID; synthetic provider deduplicates acceptance | real providers may not deduplicate; requests are at-least-once |
| webhook SSRF/data exfiltration | provider URL is restricted to `http://127.0.0.1:<port>`; no arbitrary channel/payload | production egress/channels are entirely unimplemented |
| fake provider receipt upgrades evidence | exact receipt keys/phase/identity/attempt checked before completion | bearer theft or compromised loopback provider can forge acceptance |
| provider acceptance called human delivery | explicit phase vocabulary, smoke assertion `humanDeliveryProved: false`, documentation gates | downstream teams can still misuse fields without governance |
| query exfiltration/work amplification | exact-series only, 24-hour range, 1,024 result cap, authenticated materialized receipt | no per-series authorization, rate limit, expiration, or encrypted storage |
| SQL injection | parameterized values; dynamic authority table comes only from internal fixed enum | no independent SAST/penetration test |
| dependency/workflow supply chain | lockfile, `npm ci --ignore-scripts`, high-level audit, full action SHA pins, service image digest | upstream registry/action compromise, no signed provenance/SBOM |
| test crash controls abused | environment-only switches, no HTTP control, isolated smoke children | enabling crash variables in a shared environment causes deliberate process death |

## Privacy and cardinality policy

Rejected label names include common per-request/person/credential identifiers (`request_id`, `trace_id`, `user_id`, `email`,
`phone`, `token`, `authorization`). This list is only a lab guard, not data classification. A production design needs schema-level
allowlists, tenant policy, secret detection, erasure/retention, access audit, and review of values—not just names.

Stable identities, labels, values, query bodies, thresholds, incident IDs, silence IDs, notification IDs, provider bodies, and
tokens are forbidden in ordinary service/provider/notifier logs. The repository policy check inspects each explicit log call and
portable files for common credential/path patterns.

## Abuse and availability boundaries

The lab has no rate limiter, load shedding, disk quota, tenant isolation, DB connection admission, query scheduler, notification
fanout budget, replication, failover, or independent watchdog. An authenticated caller can still exhaust the single database within
allowed per-request bounds. A database/host/network failure can stop ingestion, queries, evaluation, and notification together.

Therefore the repository makes no availability, security, privacy, compliance, or production incident-detection claim.

## Required production work

- real identity, least-privilege RBAC, credential rotation/revocation, mTLS/TLS, encryption/key management;
- per-tenant/source/rule/channel quotas, rate limits, admission control, and abuse response;
- metric schema/data classification, purpose limitation, retention/erasure, access/audit controls;
- isolated provider egress with allowlists, DNS/IP revalidation, payload minimization, signing, and response policy;
- database/TSDB replication, backup/restore, consensus/failover, chaos/partition testing, independent dead-man monitoring;
- signed build provenance, SBOM, dependency review, vulnerability response, deploy/rollback and external acceptance gates.
