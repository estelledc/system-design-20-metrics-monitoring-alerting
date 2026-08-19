# Verification

## Identity-safe history

The identity-safe rewrite preserved every existing tree, message, and timestamp while mapping the four commits in order:

- `67b7dc41607c6a76ab83828f4d6d5113e8da7ece` → `f114d62dee11946d67073da488e0a9a383f4e1f7`
- `aff311d789cf2023e6a948375705deb13b89758f` → `04327aa8fdc2915152d1b6fdf4f817ce9c51c39d`
- `3ad1dc5f4276db252cf090dc244723bc9186d2fe` → `d5fd03bc984c841ed6318ab74729b9cbfb095b8a`
- `509ded88288db48548463ab4ac2188df113f3dbb` → `168e46f9c59ea528fa0ded7e6898876cbeea6043`

Current reachable `main` uses the repository owner's GitHub noreply identity. Rewritten baseline
`168e46f9c59ea528fa0ded7e6898876cbeea6043` passed [CI run 32227754117](https://github.com/estelledc/system-design-20-metrics-monitoring-alerting/actions/runs/32227754117)
on Node 22, 24, and 26 with PostgreSQL 17.11 and the full quality gate.

## Evidence ladder

| Gate | Proves | Does not prove |
|---|---|---|
| repository policy check | required files/contracts/pins, JS syntax, local links, portable-data/log-field policy | runtime behavior |
| 15 pure tests | canonical validation, rule model, HTTP auth/error routing | PostgreSQL durability/concurrency |
| 10 PostgreSQL tests | transaction replay/conflict, snapshots, late data, rule/silence/outbox/lease semantics | process response-loss recovery or DB HA |
| true-process smoke | three real `SIGKILL` windows recover from committed database/provider receipts | power loss, network partition, real provider/device/human outcome |
| bounded benchmark | observations for one exact local/CI fixture and runtime | production capacity, latency, scale, cost, availability, or SLA |
| dependency audit | installed dependency graph had no high-or-higher advisory at run time | absence of all vulnerabilities/supply-chain compromise |
| public CI matrix | the commit repeated all gates on Node 22/24/26 with PostgreSQL 17.11 | deployment, external acceptance, production behavior |

Infrastructure gates throw when `DATABASE_URL` is absent; they never convert missing PostgreSQL into a skipped/pass result.

## Local full-gate receipt

Observed on 2026-08-19 with Node `v26.7.0` and local PostgreSQL `17.11 (Homebrew)`:

```text
npm run check:ci
repository policy: 33 files, 15 explicit log sites, links and syntax checked
pure tests: 15 pass, 0 fail, 0 skipped, 0 todo
PostgreSQL tests: 10 pass, 0 fail, 0 skipped, 0 todo
npm audit --audit-level=high: 0 vulnerabilities
crash smoke: 3 x SIGKILL; ingest replay query_visible; evaluation replay firing
silence route: suppressed; provider boundary: accepted; human delivery proved: false
provider attempts: 2; unique provider acceptances: 1
```

The local database was an ephemeral single PostgreSQL process. It is not public or independently attested; public CI is the
portable implementation receipt.

## Crash windows

### 1. Ingest response loss

The monitor commits one source batch, emits its low-cardinality event, and receives `SIGKILL` before the HTTP response. A restarted
process retries the exact natural identity and receives the original `query_visible` revision with `replayed: true`. Sample and
receipt counts remain one.

### 2. Evaluation response loss

The second consecutive true slot commits one firing incident, transition, routing receipt, and outbox item, then the monitor
receives `SIGKILL` before response. Restart/retry returns the same evaluation/incident/transition/notification identities and does
not add rows.

### 3. Provider-acceptance uncertainty

The worker claims attempt 1, the synthetic provider commits acceptance, and the worker receives `SIGKILL` before outbox completion.
Authority rotates; after lease expiry attempt 2 sends the same notification identity. The provider records two attempts and one
acceptance. Only then does the second worker mark the outbox `provider_accepted`.

This is direct evidence against an exactly-once-delivery claim. It says nothing about a real device or person.

## Bounded local benchmark

Fixture:

- one synthetic tenant and source;
- gauge only;
- 64 series × 32 points = 2,048 samples;
- 128 samples/batch = 16 ingest transactions;
- 64 materialized exact-series queries returning 2,048 total samples;
- 32 immutable rules and 32 evaluations;
- direct service/repository calls against one local PostgreSQL process; no HTTP/TLS.

One full-gate observation on Node `v26.7.0` / PostgreSQL `17.11 (Homebrew)`:

| Observation | Value |
|---|---:|
| ingest samples/s | 3,637.115 |
| ingest batch p50 / p95 | 17.774 / 286.389 ms |
| query p50 / p95 | 0.630 / 0.751 ms |
| evaluation p50 / p95 | 0.977 / 2.095 ms |
| firing incidents / pending notifications | 16 / 16 |

The first ingest transaction dominated p95 in this run, illustrating why one small sample and an unseparated warm-up cannot be a
capacity conclusion. The script emits every raw batch/query/evaluation latency in its JSON receipt. It intentionally does not
compare vendors or extrapolate beyond the fixture.

Excluded: HTTP ingestion/query hop, TLS, compression, replication, failover, compaction, rollup, real cardinality churn, concurrent
dashboard/alert load, notification provider network, deployment, production cost, availability, and SLA.

## Historical public implementation CI receipt

[GitHub Actions run 32197886283](https://github.com/estelledc/system-design-20-metrics-monitoring-alerting/actions/runs/32197886283)
completed successfully for pre-rewrite implementation object `3ad1dc5f4276db252cf090dc244723bc9186d2fe` on 2026-08-19
Asia/Shanghai. Its tree-equivalent commit in current reachable history is `d5fd03bc984c841ed6318ab74729b9cbfb095b8a`; the historical
run remains bound to the old commit object.

All three jobs used the digest-pinned PostgreSQL `17.11` service and ran repository policy, 15 pure tests, dependency audit, 10
PostgreSQL tests, three-`SIGKILL` smoke, and the bounded benchmark:

| Job | Result |
|---|---|
| [Node 22 + PostgreSQL 17.11](https://github.com/estelledc/system-design-20-metrics-monitoring-alerting/actions/runs/32197886283/job/95905472422) | success |
| [Node 24 + PostgreSQL 17.11](https://github.com/estelledc/system-design-20-metrics-monitoring-alerting/actions/runs/32197886283/job/95905472400) | success |
| [Node 26 + PostgreSQL 17.11](https://github.com/estelledc/system-design-20-metrics-monitoring-alerting/actions/runs/32197886283/job/95905472412) | success |

Every job reported 15/15 pure and 10/10 PostgreSQL tests, zero skipped/failed/todo tests, zero audit vulnerabilities, three
`SIGKILL` exits, two provider attempts, one provider acceptance, and `humanDeliveryProved: false`.

Public benchmark observations for the identical fixture:

| Node | ingest samples/s | ingest batch p50 / p95 ms | query p50 / p95 ms | evaluation p50 / p95 ms |
|---|---:|---:|---:|---:|
| `v22.23.2` | 1,473.694 | 86.162 / 108.219 | 2.237 / 2.789 | 3.747 / 5.574 |
| `v24.19.0` | 1,331.138 | 93.402 / 124.504 | 2.739 / 2.942 | 5.215 / 9.460 |
| `v26.7.0` | 1,299.542 | 95.087 / 129.652 | 2.875 / 4.421 | 4.289 / 10.148 |

These are three shared-runner observations, not a Node-version ranking. No warm-up separation, repetitions, confidence interval,
hardware isolation, saturation search, or production topology justifies comparative/performance conclusions.

The final documentation commit still requires its own public consistency run; that later run can verify links/policy/tests but does
not retroactively change this implementation receipt.

## How to reproduce

```bash
npm ci --ignore-scripts
npm run check
DATABASE_URL='postgres://...' npm run test:infra
DATABASE_URL='postgres://...' npm run smoke:infra
DATABASE_URL='postgres://...' npm run benchmark:infra
```

The Compose file supplies the pinned PostgreSQL service used by public CI. Exact public Node-specific benchmark observations remain
in their job logs; documentation records only the fixture and bounded interpretation.
