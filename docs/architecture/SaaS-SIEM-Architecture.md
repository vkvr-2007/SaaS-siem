# CLAUDE.md — SaaS SIEM/SOC Platform: Durable Engineering Rules

This file is the persistent memory of this project's architectural intent across sessions.
Read it fully before making non-trivial changes. Keep it current: if you make or learn
something that changes a durable rule or constraint below, update this file in the same
change — don't let it drift out of sync with reality.

## What this product is

A cloud-based, multi-tenant SIEM/SOC platform. Organizations send security and operational
logs; the platform turns that raw telemetry into actionable security understanding —
comparable in purpose to Splunk, Microsoft Sentinel, and Wazuh, with a simpler UX.

Organizing philosophy for the whole system:

```
LIVE DATA → NORMALIZATION → CORRELATION → DETECTION → ALERT → INCIDENT
          → INVESTIGATION → AUTOMATION → RESPONSE
```

This is not a log viewer. The correlation/detection/consolidation stages are the actual
product — a searchable pile of raw logs is substrate, not the deliverable.

## Two personas, one UI

- A time-pressed analyst must understand current posture within seconds from the dashboard.
- An experienced analyst must be able to drill from dashboard → alert → event timeline → raw
  log → related entities → automated response, without hitting a dead end.

Simplicity comes from organizing depth well, not from hiding it behind a separate "expert mode."

## Architectural invariants (do not change without explicit sign-off + written tradeoffs)

1. **Kappa, not Lambda.** One append-only event log is the single source of truth. Live
   processing and historical replay/backfill run the *same* code path against that log — never
   a separate batch pipeline with duplicated detection logic.
2. **Normalization preserves raw content.** Arbitrary source logs are transformed into a
   structured, vendor-neutral event schema (OCSF or a deliberate documented equivalent), but
   the original raw content is always retained alongside the structured result. Normalization
   must never be lossy toward forensics. Unmapped/vendor-specific fields go in a designated
   escape-hatch field, never silently dropped.
3. **Correlation is genuine stateful stream processing.** Keyed (by resolved identity, asset,
   or another correlation key), time-windowed, capable of expressing ordered multi-stage
   sequences across unrelated source types. A periodic SQL query polling for "N events in the
   last M minutes" is NOT correlation and must not stand in for it, even temporarily, without
   being explicitly flagged as a stub.
4. **Alerts are consolidated before they reach an analyst.** Raw detection signals are
   deduplicated/merged into a stable Alert via deterministic fingerprinting (tenant + rule +
   identity + asset, or equivalent). Related alerts group further into Incidents. Raw
   per-signal noise is never the default experience.
5. **tenant_id is a security boundary, enforced everywhere.** Ingestion routing, message-bus
   partitioning/keying, stream-processing keying, storage partition/row-level policy, and the
   API/query layer all enforce it — and the query layer never trusts a client-supplied
   tenant_id without cross-checking it against the authenticated user's actual tenant claims.
   Treat any gap here as a vulnerability, not a missing feature.
6. **Real-time delivery is push-based.** WebSockets (or an equivalent persistent-connection
   push mechanism) deliver live alerts and activity to the frontend. Client-side polling is not
   an acceptable substitute for "real-time."
7. **The pipeline model organizes the domain and the codebase**, not just the docs — the
   live→normalize→correlate→detect→alert→incident→investigate→automate→respond stages should be
   visible in how the system is structured, not just described in prose.

## Established (but adjustable with reasoning) technology defaults

| Concern | Default | Why | Free to swap? |
|---|---|---|---|
| Event bus | Kafka / Redpanda | Ordered, durable, replayable log; Redpanda avoids JVM GC pauses for tighter tail latency | Yes, if the replacement preserves durable, replayable, partition-ordered semantics |
| Stream/correlation engine | Apache Flink (CEP) | Native support for keyed, temporal, multi-stage pattern matching | Yes, if genuine stateful CEP capability is preserved |
| Hot analytical store | ClickHouse | Sub-second tenant-scoped aggregate queries | Yes, if sub-second tenant-scoped query performance is preserved |
| Search store | OpenSearch | Full-text/IOC search | Yes |
| Cold storage | Parquet + Iceberg on S3 | Cheap, compliant retention with rehydration path | Yes, if lifecycle + forensic rehydration is preserved |
| SOAR orchestrator | Temporal | Durable, resumable multi-step workflow execution surviving process crashes | Yes, if durable/resumable execution is preserved |
| Normalization schema | OCSF | Vendor-neutral, industry-adopted taxonomy | Yes, if a real structured schema replaces it (not ad hoc per-source parsing with no common shape) |

## What counts as incomplete regardless of what currently exists in the repo

- A "detection engine" that's actually a periodic query, not stream correlation.
- An event bus that's a mock/stub logger instead of a real durable message bus.
- Alerts shown 1:1 from raw signals with no fingerprint/dedup.
- Any query path trusting a client-supplied tenant_id without server-side verification.
- A "live" frontend view that's secretly polling on an interval.
- Automation actions with no tenant-boundary validation before they act.
- Normalization that discards original raw content.
- Dashboards that fetch raw rows to the client and aggregate there instead of querying
  pre-aggregated views.

## Known deliberate MVP simplifications from an earlier implementation pass

An earlier Copilot-oriented implementation plan intentionally simplified some pieces for a
different coding workflow. These are NOT architectural requirements — replace them with real
implementations as the project matures:

- A mock/stub event bus publish function standing in for real Kafka/Redpanda.
- A simplified Redis-backed token-bucket rate limiter standing in for full ingestion-tier
  backpressure.
- A local mock event generator standing in for real agent/collector traffic during development
  (this one is fine to keep — it's a legitimate dev/test tool, not a production shortcut).

## Testing expectations

- Normalization: given a raw input, assert the correct normalized fields (including that raw
  content is preserved).
- Detection: given an event sequence, assert both correct matches AND correct non-matches
  (false-positive avoidance is as important as true-positive detection).
- Tenant isolation: explicit tests asserting a query scoped to tenant A can never return
  tenant B's data — never just assumed from code review.
- Rate limiting/backpressure: tested under simulated burst load.
- Prefer real integration tests over heavy mocking anywhere touching correlation or the
  tenant-isolation boundary — those are exactly the places a mock hides the bug that matters.

## Security expectations

- Strong auth (mTLS or equivalent) on every ingestion surface.
- Tenant-boundary enforcement at every layer (see invariant 5).
- Least-privilege credentials for any external API the SOAR layer calls.
- No secrets in source control.
- Dependency and container scanning in CI.
- Audit logging of automated actions taken on a tenant's behalf.

## How to prioritize work

1. Dependency order first — correlation can't be real if the event bus underneath it is a
   stub. Foundational plumbing that everything else depends on comes before polish.
2. Product value second — normalization, correlation, and alert consolidation make this a SIEM
   rather than a log viewer; prioritize them ahead of dashboard cosmetics.
3. Keep the repository runnable after every meaningful change.

## Updating this file

If you change a technology default in the table above, or discover that an invariant needs
adjustment, update this file in the same commit/session and note the reasoning — this file is
read fresh at the start of future sessions and is the only durable record of *why* the system
is shaped the way it is.

## Decisions log

Append a dated, one-paragraph entry here every time a real architectural or contract decision
is made — this log, not a restatement of the invariants above, is what actually prevents drift
over a long project, because it records what *this* repository specifically decided, not just
the abstract rules.

- **2026-09-26 — Repo structure.** Adopted a single monorepo with `services/` directories named
  after pipeline stages (`ingest`, `normalize`, `detect`, `consolidate`, `query-api`,
  `live-gateway`, `respond`), a `contracts/` directory as the single source of truth for the
  shared domain schema (JSON Schema, generated into `contracts/gen/ts` and `contracts/gen/java`),
  and `detections/` holding rule files plus match/non-match fixtures. Rejected grouping by
  runtime/language (violates the pipeline-shaped-codebase invariant) and multiple separate repos
  (the contract would drift between them).
- **2026-09-26 — Domain contract, schema source and strictness.** Normalized events are strict
  OCSF 1.8/1.9 JSON plus a documented platform extension object (`enrichment`, holding
  `resolved_identity`, `asset_uid`, `access_method`, `src_geo_anomaly_score`) rather than an
  "OCSF-like" ad hoc schema. Schema source of truth is JSON Schema in `contracts/schemas/`,
  generated into TypeScript and Java. Wire format and generated TS both use snake_case, matching
  OCSF, to avoid a camelCase mapping layer becoming a second place for drift.
- **2026-09-26 — Deterministic IDs.** Event, signal, and alert IDs are derived deterministically
  from their inputs (not random ULIDs), because Kappa replay must produce identical IDs on
  reprocessing or dedup/exactly-once semantics break.
- **2026-09-26 — Alert/Incident lifecycle.** A signal never reopens a resolved alert (including
  an analyst's false-positive call) — it opens a new alert linked via `supersedes_alert_id`, so
  resolutions stay permanent in the audit trail. When a new alert's identity/asset overlap spans
  two open incidents, the older incident survives and the other is marked `merged` with a
  `merged_into` pointer, rather than attaching the alert to only one.
- **2026-09-26 — Architecture document corrections.** The original architecture document's
  normalized-event example and detection rule contained real OCSF non-compliance: a non-OCSF
  `logon` object and a `"VPN"` logon type value (fixed to `logon_type_id`/`auth_protocol_id`/
  `session.uid` plus `enrichment.access_method`), an invented Sigma `temporal_sequence`
  correlation dialect (fixed to real Sigma `event_count` + `temporal_ordered` correlation types
  chained across named base rules), and cloud IAM privilege-escalation actions placed under the
  wrong OCSF class (fixed to API Activity, class_uid `6003`, category_uid `6`, `api.operation`).
  All fixed directly in `docs/architecture/SaaS-SIEM-Architecture.md` rather than patched around
  in code — see that document's inline revision notes for detail.
- **2026-09-26 — Existing frontend prototype is disposable.** The pre-existing `src/types/alert.ts`
  and `src/store/alerts.ts` (hand-written IDs, 4-value severity string, no tenant_id, no
  fingerprint, `dismissAlert` deleting rows outright) predate this contract and do not constrain
  it. The frontend will be updated to consume the contract above; the contract is not adjusted to
  stay compatible with the prototype.