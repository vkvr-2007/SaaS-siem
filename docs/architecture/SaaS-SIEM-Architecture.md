# SaaS SIEM/SOC Platform — Implementation-Grade Architecture

This is the authoritative architecture document for the project. CLAUDE.md at the repository
root contains the durable invariants, technology defaults, and decisions log derived from this
document — if the two ever disagree, treat that as drift to be resolved, not as license to
follow whichever is more convenient.

---

## 1. Architectural Topology & Fluid Pipelines

**Topology choice: Kappa architecture, not Lambda.**

Lambda architectures maintain two code paths (a batch layer for correctness and a speed layer
for latency), which for a SIEM means duplicating detection logic in both a stream processor and
a batch reprocessor — a maintenance and drift nightmare when a detection rule needs to be
identical whether it runs live or during a backfill. Kappa treats everything — live traffic and
historical replay — as the same append-only log, re-processed through the identical
stream-processing code path. Kafka/Redpanda's retention + compaction gives you the "batch"
capability for free: to backfill a new detection rule against the last 30 days, you just replay
the topic through the same Flink job with a different consumer group and a bounded time range.

**System topology, layer by layer:**

```
[Edge Agents] → [Regional Collectors] → [Kafka/Redpanda Ingestion Bus]
     → [Stream Normalization (OCSF)] → [Kafka: normalized.events]
        ├──→ [Flink Detection Engine] → [Kafka: alerts.raw] → [Alert Consolidation Service] → [Postgres: incidents]
        │                                                                                          ↓
        │                                                                                   [Temporal SOAR Workers]
        ├──→ [ClickHouse Sink (hot, 0–14d)]
        ├──→ [OpenSearch Sink (warm, full-text/IOC search, 14–90d)]
        └──→ [Parquet/S3 Sink (cold, 90d–7yr, via Iceberg table format)]

[Frontend] ⇄ [WebSocket Gateway] ⇄ [Redis Pub/Sub / Kafka Consumer bridging live tail]
[Frontend] ⇄ [GraphQL/REST Query API] ⇄ [ClickHouse / OpenSearch / Iceberg-on-S3 via Trino]
```

**Step-by-step lifecycle of a single log line** (Windows Security Event ID 4624 as the running
example):

1. **Generation** — Windows Event Log service emits the event; a lightweight agent daemon
   subscribes to the Security channel via the Windows Event Log API (`EvtSubscribe` with a
   bookmark for exactly-once local delivery), not polling `wevtutil`.
2. **Local buffering** — The agent writes to a local disk-backed ring buffer (~256MB per host)
   so a network partition to the collector doesn't drop events. First backpressure absorber.
3. **Transport to regional collector** — Agent batches events (up to 1MB or 500ms, whichever
   first) and ships over mutually-authenticated TLS 1.3 to a regional Vector/Fluent Bit fleet.
4. **Collector-side buffering** — Vector's `disk` buffer type (`when_full = "block"`, not
   `drop_newest`) absorbs bursts before Kafka. Second backpressure absorber — critical during a
   DDoS or log-storm scenario.
5. **Ingestion bus write** — Vector produces to Kafka topic `raw.events.windows` with the
   tenant_id embedded in the Kafka message key (`tenant_id:host_id`) so all events from one host
   land on the same partition, preserving per-host ordering.
6. **Normalization** — A Flink (or Kafka Streams) job consumes `raw.events.windows`, applies the
   Windows-specific parser (maps Event ID 4624 fields → OCSF `Authentication` class), and
   produces to `normalized.events` in OCSF JSON.
7. **Fan-out (multi-sink)** — Three consumer groups read `normalized.events` independently and
   in parallel: the Detection Engine (Flink CEP), the ClickHouse Sink Connector (native ClickHouse
   `HTTP INSERT` batching), and the S3/Parquet Archiver (Kafka Connect S3 sink, batched every 5
   minutes or 128MB).
8. **Detection match** — If the event participates in a correlation pattern, the Flink job emits
   a candidate signal to `alerts.raw`.
9. **Alert consolidation** — The Alert Consolidation Service dedupes/groups the signal into an
   Alert (and possibly an Incident) and writes to Postgres; it also publishes a "new alert" event
   to a Redis pub/sub channel scoped to the tenant.
10. **Live UI delivery** — The WebSocket Gateway, subscribed to that Redis channel, pushes the
    alert to any connected browser session for that tenant within tens of milliseconds.
11. **Dashboard refresh** — The React frontend receives the WebSocket push, updates a virtualized
    alert list, and optionally triggers a background re-fetch of aggregate counts from
    ClickHouse's pre-aggregated materialized views.

**Target end-to-end latency** (agent write → dashboard visibility): under 2 seconds at p95,
excluding the detection window itself (bounded by the window length, not pipeline latency).

---

## 2. Ingestion, Backpressure & Data Pipeline Layer

### 2.1 Edge Collection & Protocol Termination

| Source Type | Protocol | Termination Point | Auth |
|---|---|---|---|
| Custom agents / API-based apps | HTTPS HEC (`POST /services/collector/event`) | Envoy-fronted ingress, ALPN h2 | mTLS client cert per tenant, rotated via cert-manager (90-day expiry) |
| Legacy network gear / firewalls | Syslog over TLS (RFC 5425), port 6514 | `syslog-ng` fleet behind NLB with PROXY protocol | TLS client cert or PSK fallback |
| Cloud provider logs | Pull-based (AWS CloudTrail → Kinesis Firehose → HTTPS webhook; GCP Audit Logs → Pub/Sub push) | Dedicated cloud-ingest microservice per provider | IAM role assumption (cross-account `sts:AssumeRole` with external ID) |
| Endpoint agents (Windows/Linux/macOS) | gRPC bidi-stream (agent-initiated, survives NAT) | gRPC gateway (Envoy + gRPC-Web translation) | mTLS + short-lived JWT (15-min expiry, refreshed via the same mTLS channel) |
| Kubernetes/container logs | OTLP over gRPC | OTel Collector gateway deployment (not sidecar) | mTLS via SPIFFE/SPIRE workload identity |

mTLS is used everywhere rather than API keys alone because a client certificate bound to a
hardware-backed or file-permission-restricted key is materially harder to lift than a header
value, and per-tenant cert issuance means a compromised key can be revoked (CRL/OCSP) without
rotating a shared secret across the whole tenant fleet.

### 2.2 Backpressure Mechanism

Three-tier backpressure, each tier engaging only once the tier below it is saturated:

1. **Agent-local (disk-backed, bounded):**
```yaml
sinks:
  kafka_out:
    type: kafka
    buffer:
      type: disk
      max_size: 268435488   # 256MB
      when_full: block      # NOT drop_newest — security data can't be silently dropped
    bootstrap_servers: "collector.internal:9092"
    encoding.codec: json
    batch:
      max_bytes: 1048576
      timeout_secs: 0.5
```
   When the disk buffer hits `max_size`, the agent's log source itself blocks/back-pressures
   upstream. The OS's own ring buffer absorbs the delay up to a configurable ceiling (default
   64MB) before it starts dropping — surfaced as a `dropped_events_total` agent-health metric
   that itself becomes a security signal ("agent under duress" = investigate why).

2. **Collector-tier** (regional Vector/Fluent Bit fleet, horizontally scaled via HPA on Kafka
   producer lag): Kubernetes HPA custom metric `kafka_producer_queue_time_seconds`. When p99
   producer send latency exceeds 200ms for 60s, scale the collector Deployment by +25%
   replicas, capped at 3x baseline.

3. **Kafka/Redpanda broker-tier** (the ultimate backstop): Redpanda over vanilla Kafka — no JVM
   GC pauses, lower tail latency at the P99.9 percentile that matters for correlation windows
   measured in seconds. `raw.events.*` topics: `retention.ms = 259200000` (3 days),
   `min.insync.replicas = 2`, `replication.factor = 3`. Partition count sized for peak sustained
   throughput (16 partitions minimum at ~500K events/sec peak), keyed by `tenant_id` hash-modulo
   so no single large tenant starves smaller ones — actual noisy-neighbor control is the
   tenant-level rate limiter in Section 6.2.

### 2.3 Unified Schema Normalization (OCSF)

Raw Windows Security Event ID 4624 arrives as XML from the Security channel. The normalization
job (a Flink `ProcessFunction`, not a stateless map — some fields require a small lookup cache,
e.g. resolving a SID to a previously-seen username) maps it into OCSF's `Authentication` event
class (class_uid 3002).

**Canonical normalized OCSF payload:**

```json
{
  "class_uid": 3002,
  "class_name": "Authentication",
  "category_uid": 3,
  "category_name": "Identity & Access Management",
  "activity_id": 1,
  "activity_name": "Logon",
  "type_uid": 300201,
  "severity_id": 1,
  "severity": "Informational",
  "time": 1758870042123,
  "metadata": {
    "version": "1.3.0",
    "product": {
      "name": "Windows Security Auditing",
      "vendor_name": "Microsoft"
    },
    "log_provider": "Microsoft-Windows-Security-Auditing",
    "uid": "a9f3c2e1-8b7d-4e6a-9f21-3d8c7b2a1e90",
    "correlation_uid": "4624-9f21-3d8c",
    "original_time": "2026-09-26T09:00:42.1230000Z"
  },
  "tenant_id": "t_7f2a91b3",
  "src_endpoint": {
    "ip": "10.14.22.87",
    "hostname": "vpn-gw-01.corp.internal",
    "port": 51422
  },
  "dst_endpoint": {
    "hostname": "DC01-FINANCE",
    "ip": "10.14.0.5",
    "instance_uid": "host_8ac21fd0"
  },
  "user": {
    "name": "j.rao",
    "uid": "S-1-5-21-3623811015-3361044348-30300820-1013",
    "domain": "CORP",
    "type": "User"
  },
  "logon": {
    "type": "3",
    "type_name": "Network",
    "logon_id": "0x3E7A21",
    "authentication_package": "NTLM"
  },
  "status": "Success",
  "status_id": 1,
  "raw_data": "<EventData><Data Name='TargetUserName'>j.rao</Data>...</EventData>",
  "unmapped": {
    "windows_event_id": 4624,
    "process_name": "-",
    "elevated_token": "%%1843"
  },
  "observables": [
    { "type": "IP Address", "name": "src_endpoint.ip", "value": "10.14.22.87" },
    { "type": "User Name", "name": "user.name", "value": "j.rao" }
  ]
}
```

Key design rule: `raw_data` is retained (not discarded) inside the normalized event so analysts
can always pivot back to ground truth without a second lookup against cold storage. `unmapped`
is OCSF's designated escape hatch for vendor-specific fields — this is where lossy normalization
is avoided. Any normalizer implementation must preserve both of these fields; dropping either is
a structural violation of the architecture, not an acceptable simplification.

---

## 3. Data Retention & Multi-Tier Storage Engine

### 3.1 Hot/Warm Analytics Layer — ClickHouse (primary) + OpenSearch (secondary)

ClickHouse is unmatched for aggregate analytical queries (dashboard counts, time-series
rollups, GROUP BY over billions of rows) but weaker at full-text/IOC search. OpenSearch
(Lucene-based) is the reverse. Both consume from the same `normalized.events` Kafka topic
independently — no dependency between them.

**ClickHouse table design:**

```sql
CREATE TABLE events_local ON CLUSTER siem_cluster
(
    tenant_id       LowCardinality(String),
    event_time      DateTime64(3, 'UTC'),
    event_date      Date MATERIALIZED toDate(event_time),
    class_uid       UInt16,
    severity_id     UInt8,
    src_ip          IPv4,
    dst_hostname    String,
    user_name       String,
    raw_json        String CODEC(ZSTD(3))
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/events', '{replica}')
PARTITION BY (tenant_id, toYYYYMMDD(event_date))   -- daily buckets per tenant
ORDER BY (tenant_id, event_time, class_uid)
TTL event_date + INTERVAL 14 DAY TO VOLUME 'cold_disk',
    event_date + INTERVAL 90 DAY DELETE
SETTINGS index_granularity = 8192;

CREATE TABLE events_distributed ON CLUSTER siem_cluster AS events_local
ENGINE = Distributed(siem_cluster, default, events_local, cityHash64(tenant_id));
```

- **Partition key = `(tenant_id, daily bucket)`**: dashboard queries are almost always scoped to
  one tenant and a bounded recent time range, so ClickHouse can prune entire partitions before
  touching a single row. Daily (not hourly) partitions keep partition count manageable while
  staying small enough for fast pruning.
- `ORDER BY (tenant_id, event_time, class_uid)` makes both "tenant + time range" and "tenant +
  time range + specific event class" queries sort-merge efficient.
- The `TTL … TO VOLUME 'cold_disk'` clause moves data older than 14 days to cheaper storage
  automatically without deleting it — the "warm" tier living inside the same table.
- Materialized views pre-aggregate the dashboard's most common rollups so the frontend never
  runs a raw scan for the landing dashboard.

### 3.2 Cold & Archival Storage — Parquet on S3 + Iceberg table format

Kafka Connect S3 Sink writes `normalized.events` to Parquet, partitioned identically to the hot
tier: `s3://siem-archive/{tenant_id}/{year}/{month}/{day}/part-*.parquet`, using **Apache
Iceberg** as the table format specifically for atomic, ACID-compliant partition evolution and
time-travel — necessary because retention/compliance policies change per-tenant contract.

**Lifecycle policy (per tenant tier):**
- Day 0–90: S3 Standard (queryable via Trino/Presto).
- Day 90–365: S3 Intelligent-Tiering.
- Day 365–2555 (7yr, common compliance floor): S3 Glacier Flexible Retrieval.
- Beyond contractual retention: automated Iceberg `expire_snapshots` + S3 object deletion,
  logged to an immutable audit trail (itself an OCSF `Audit` event, ingested back into the
  platform's own tenant).

**Rehydration for forensic investigation:** a Trino query directly against Iceberg/Parquet
files in S3, issuing an S3 `RestoreObject` call for Glacier-tier objects and polling for
completion (typically 3–5 hours for Flexible Retrieval), surfaced to the analyst as a
"rehydration in progress" job status. Once restored, results are optionally materialized back
into a temporary ClickHouse table (`events_forensic_{investigation_id}`) with a 7-day TTL.

---

## 4. Stateful Event Correlation & Detection Engine

### 4.1 Stream Processing Engine: Apache Flink

Flink over Kafka Streams because Flink's CEP library (`flink-cep`) natively supports
non-contiguous, cross-source, time-bounded event sequences with per-key state
(`keyBy(user_id)` or `keyBy(src_ip)`), backed by RocksDB state backend, with exactly-once
semantics via Kafka transactional producers + Flink checkpointing (aligned checkpoints, 30s
interval, incremental RocksDB checkpoints).

### 4.2 Advanced Stateful Windowing

Example scenario: 5 failed VPN logins → 1 successful login from an anomalous geo-IP → an IAM
privilege escalation call, all within a rolling 15-minute window. This requires **keyed,
non-contiguous CEP over a sliding window**, not a tumbling count window, because the three
sub-events come from different log sources that must be joined on a common identity key (an
identity-resolution side-table, a Flink broadcast state pattern, normalizes `jrao` vs.
`j.rao@corp.com` before the CEP stage), and the window must be **per-key**, not global.

```java
Pattern<AuthEvent, ?> bruteForceToPrivEsc = Pattern
  .<AuthEvent>begin("failed_logins")
  .where(evt -> evt.eventClass == VPN_AUTH && evt.status == FAILED)
  .timesOrMore(5)
  .within(Time.minutes(15))
  .followedBy("successful_login")
  .where(evt -> evt.eventClass == VPN_AUTH && evt.status == SUCCESS
             && geoIpAnomalyScore(evt.srcIp, evt.identity) > 0.8)
  .followedBy("priv_escalation")
  .where(evt -> evt.eventClass == IAM_AUDIT
             && PRIV_ESC_ACTIONS.contains(evt.iamAction))
  .within(Time.minutes(15));   // outer bound across the whole chain

CEP.pattern(authEventStream.keyBy(evt -> evt.resolvedIdentity), bruteForceToPrivEsc)
   .select(match -> AlertSignal.from(match, "T1110_TO_T1078_CHAIN"));
```

State backend note: RocksDB-backed keyed state with TTL (`StateTtlConfig`, cleanup on read +
background compaction filter) evicts identities with no activity in the trailing window
automatically, preventing unbounded state growth.

### 4.3 Detection DSL — Sigma Rule

Sigma over a bespoke DSL because it's an already-adopted community standard, translatable to
ClickHouse SQL, OpenSearch DSL, or Splunk SPL via `sigma-cli` backends:

```yaml
title: VPN Brute Force Followed by Anomalous Success and Privilege Escalation
id: 8f1b2e4a-6c3d-4a9e-b1f7-2d9c8e4a1b3c
status: production
description: >
  Detects a sequence of 5+ failed VPN authentications, followed by a
  successful authentication from an anomalous geo-IP, followed by an
  IAM privilege escalation action, all within a 15-minute window for
  the same resolved identity.
logsource:
  category: authentication
  product: multi_source
correlation:
  type: temporal_sequence
  window: 15m
  group-by:
    - resolved_identity
  rules:
    - name: failed_logins
      detection:
        selection:
          class_uid: 3002
          status: 'Failure'
          logon.type_name: 'VPN'
        condition: selection
      count: '>=5'
    - name: anomalous_success
      detection:
        selection:
          class_uid: 3002
          status: 'Success'
          logon.type_name: 'VPN'
          src_endpoint.geo_anomaly_score: '>0.8'
        condition: selection
      count: '>=1'
      after: failed_logins
    - name: priv_escalation
      detection:
        selection:
          class_uid: 3005
          category_name: 'Identity & Access Management'
          activity_name:
            - 'Attach Policy'
            - 'Create Access Key'
            - 'Assume Role'
        condition: selection
      count: '>=1'
      after: anomalous_success
level: critical
tags:
  - attack.credential_access
  - attack.t1110
  - attack.privilege_escalation
  - attack.t1078
falsepositives:
  - Legitimate password reset immediately followed by first successful login and routine admin task
```

---

## 5. Actionable Incident & Automation (SOAR) Pipeline

### 5.1 Signal Consolidation & Deduplication

Raw Flink CEP matches land on `alerts.raw` at a rate that, unfiltered, would flood analysts. The
Alert Consolidation Service groups signals using a fingerprint hash:

```
fingerprint = SHA256(tenant_id + rule_id + resolved_identity + normalize(dst_asset))
```

Any new signal matching an existing open Alert's fingerprint within a correlation debounce
window (default 30 minutes, tenant-configurable) merges into that Alert as an additional
"supporting event" — the Alert's `event_count` increments and `last_seen` updates, but the
analyst sees one entity, not N. Alerts sharing overlapping `resolved_identity` or `dst_asset`
fingerprints across different rule_ids within a shorter window (10 minutes) escalate into a
single Incident.

### 5.2 SOAR Orchestrator: Temporal.io

Temporal over a raw Kafka-consumer-driven state machine or a simpler job queue, because
containment workflows are long-running, multi-step, and must survive process crashes
mid-execution — Temporal's durable execution model persists workflow state after every activity
completion, so execution resumes exactly where it left off.

### 5.3 Containment Workflow — Concrete Execution Logic

```typescript
export async function containInfectedAssetWorkflow(input: ContainmentInput): Promise<ContainmentResult> {
  const { tenantId, incidentId, assetId, requiresApproval } = input;

  // Step 1: Tenant isolation boundary check — never allow a workflow
  // to act outside the tenant that owns the asset.
  const boundaryOk = await activities.validateTenantOwnership(tenantId, assetId);
  if (!boundaryOk) {
    throw new ApplicationFailure('Tenant boundary violation — aborting containment', 'TENANT_BOUNDARY_ERROR');
  }

  // Step 2: Human-in-the-loop gate for high-blast-radius actions
  if (requiresApproval) {
    const approval = await workflow.condition(
      () => analystApprovalSignal.value !== undefined,
      '30 minutes'  // auto-timeout: escalate to on-call if no response
    );
    if (!approval || analystApprovalSignal.value === 'REJECTED') {
      await activities.notifyEscalation(incidentId, 'Containment approval timed out or rejected');
      return { status: 'ABORTED_NO_APPROVAL' };
    }
  }

  // Step 3: Query current EDR posture (idempotent, retried with backoff)
  const edrStatus = await activities.queryEndpointProtectionApi(assetId, {
    retry: { maximumAttempts: 5, backoffCoefficient: 2 }
  });

  // Step 4: Isolate at the EDR layer first
  await activities.isolateEndpoint(assetId);

  // Step 5: Cloud-layer containment — mutate security group,
  // scoped strictly to this tenant's cloud account role
  await activities.updateSecurityGroup({
    tenantId,
    assetId,
    action: 'QUARANTINE',
    allowedEgress: ['edr-vendor-management-ip-range-only']
  });

  // Step 6: Verify containment took effect before closing the loop
  const verified = await activities.verifyIsolation(assetId, { timeout: '5 minutes' });
  if (!verified) {
    await activities.notifyEscalation(incidentId, 'Containment could not be verified — manual intervention required');
    return { status: 'VERIFICATION_FAILED' };
  }

  await activities.updateIncidentStatus(incidentId, 'CONTAINED');
  return { status: 'CONTAINED', assetId, timestamp: workflow.now() };
}
```

Every `activities.*` call is a separate Temporal Activity — its own retry policy, its own
timeout, independently observable in the Temporal Web UI for audit purposes.

---

## 6. SaaS Multi-Tenancy & Compute Isolation Strategy

### 6.1 Tenant Isolation Model: Pooled cluster with strict `tenant_id` partitioning

Pooled compute (shared Kafka, shared Flink, shared ClickHouse) with `tenant_id` as a mandatory
first-class partition/shard key everywhere, rather than fully isolated per-tenant environments —
per-tenant silos don't scale operationally past a few hundred tenants. Isolation is enforced at
the data and query layer, not the infrastructure layer:

- **Row-level security enforcement:** every ClickHouse and OpenSearch query issued by the API
  layer has `tenant_id = :current_tenant` injected server-side by the query-building service —
  never trusted from client input. ClickHouse role-based row policies provide a second,
  database-enforced layer in case the application layer has a bug — defense in depth.
- **Cryptographic tenant keys at rest:** each tenant gets a unique Data Encryption Key (DEK)
  issued from a per-region KMS Customer Master Key. S3 objects for that tenant's Parquet
  archives are encrypted with SSE-KMS using the tenant's DEK. For tenants with data residency
  contracts, the DEK and KMS key are provisioned in a region-pinned KMS instance, and the
  ingestion routing layer directs that tenant's agents to region-pinned Kafka clusters
  exclusively.

### 6.2 Noisy-Neighbor Mitigation — Token Bucket at Ingestion

Enforced at the mTLS termination/Envoy layer using a distributed token bucket backed by Redis
(Envoy's `rate_limit` filter calling out to a gRPC rate-limit service):

```yaml
domain: siem_ingest
descriptors:
  - key: tenant_id
    rate_limit:
      unit: second
      requests_per_unit: 5000       # baseline: events/sec per tenant
    descriptors:
      - key: burst_allowance
        rate_limit:
          unit: minute
          requests_per_unit: 450000  # allows short bursts within a 90s window before sustained throttling
```

Each tenant's contracted tier maps to a distinct `requests_per_unit` ceiling stored in tenant
metadata and hot-reloaded into the rate-limit service every 60 seconds. When a tenant exceeds
its bucket, Envoy returns HTTP 429 or applies TCP backpressure, which — combined with the
agent's disk-backed buffer from Section 2.2 — means an over-limit tenant experiences increased
latency, not silent data loss, without starving Kafka broker I/O from other tenants.

---

## 7. Frontend State Engine & Real-Time Dashboard Architecture

### 7.1 Real-Time Stream Delivery: WebSockets

WebSockets over Server-Sent Events because the alert triage workflow is bidirectional — an
analyst acknowledging an alert or triggering a SOAR action needs a client→server channel. The
WebSocket Gateway is a stateless fleet behind an ALB with sticky sessions disabled; session
affinity is handled at the Redis pub/sub subscription layer, so any gateway pod can serve any
client:

```
Client → wss://api.siem.io/v1/live?tenant_id=X (JWT in Sec-WebSocket-Protocol header)
       → Gateway validates JWT, subscribes to Redis channel `tenant:{X}:alerts` and `tenant:{X}:events:sample`
       → Alert Consolidation Service PUBLISHes to `tenant:{X}:alerts` on every new/updated Alert
       → Gateway forwards as a WS frame: {"type":"alert.new","payload":{...}}
```

The `events:sample` channel is deliberately a sampled stream (1-in-N or top-N-by-severity) of
raw live events for the "live activity feed" view — only Alerts get the full, unsampled
real-time guarantee.

### 7.2 Browser Rendering Performance

Three combined techniques:

1. **Viewport virtualization** for the alert/event list — the DOM only contains the visible
   rows, regardless of whether the underlying result set is 50 or 5 million rows.
2. **Canvas-based rendering for dense visualizations** (network graph of correlated entities,
   event-volume heatmap) — a single `<canvas>` element with manual hit-testing (a spatial index
   mapping screen coordinates back to entity IDs), rendering offloaded to a Web Worker via
   `OffscreenCanvas` so a heavy graph re-layout never blocks the main thread.
3. **Backend-driven pre-aggregation** — every chart's data is the output of a ClickHouse
   materialized view, already bucketed, so the payload over the wire is at most a few hundred
   data points regardless of how many billions of raw events underlie it. The frontend's job is
   purely to render pre-shaped data, never to reduce it.
