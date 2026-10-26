# Observability Runbook — First-Party Telemetry (issue #66, D5)

This is the operator + engineer runbook for Balashikshana's observability
stack. Everything here is FIRST-PARTY (roadmap D5: no third-party
ad/analytics/tracking SDKs ever; observability collects internal signals
only). The #68 COPPA legal pack and the #69 store Data Safety forms are
cross-checked against THIS document as the "telemetry reality".

Contents:
1. [What is measured](#1-what-is-measured) — the metric set, labels, SLOs
2. [Where it is exposed](#2-where-it-is-exposed) — the internal metrics listener
3. [Redaction policy](#3-redaction-policy) — what may and may not appear in telemetry
4. [Alerting](#4-alerting) — rules, thresholds, rationale, first response
5. [Error tracking](#5-error-tracking) — the first-party error_events store
6. [Correlation IDs](#6-correlation-ids) — client -> edge -> origin continuity
7. [Operator wiring](#7-operator-wiring) — Prometheus, Grafana, Alertmanager (self-hosted)
8. [Decisions](#8-decisions) — recorded ADRs (no OTel SDK, Postgres over GlitchTip, separate listener)
9. [Cost & doctrine](#9-cost--doctrine) — containerInsights off, lean stack

---

## 1. What is measured

Metric registry: `services/api/observability/metrics.mjs` (zero-dependency;
vocabulary declared once in `observability/api-metrics.mjs`).

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `http_request_duration_seconds` | histogram | `route_class`, `method`, `status_class` | request latency; buckets 5ms..10s +Inf |
| `http_requests_total` | counter | `route_class`, `method`, `status_class` | request volume; the 5xx slice is the error rate |
| `gate_evaluate_total` | counter | `outcome=pass\|fail` | boss-gate ENGINE outcomes (not HTTP statuses — a 200 carrying a failed gate counts `fail`) |
| `sync_requests_total` | counter | `endpoint=attempts\|progress`, `outcome=success\|error` | sync protocol success rate; success = final 2xx, everything else (401/403/400/429/5xx) = error BY DESIGN — a device fleet locked out by an auth change is a sync outage |
| `error_events_total` | counter | `outcome=captured\|flood-capped\|insert-failed` | error-capture outcomes (see §5) |
| `db_pool_total` / `db_pool_idle` / `db_pool_waiting` | gauge | — | pg pool saturation (pool max 10) |
| `metrics_observations_rejected_total` | gauge | `metric` | cardinality-guard rejections — should be flat zero; any growth means label-guard rejections or an attack (dashboard panel 8) |

**Route classes are Fastify route patterns** (`/api/students/:studentId`)
— the server's own registered route inventory, pinned by test against
the OpenAPI baseline. Unrouted requests classify as `unmatched`; the raw
URL is NEVER a label. Cardinality is therefore bounded by construction:
validators reject out-of-vocabulary label values, a 512-series-per-metric
cap rejects pathological growth, and both rejections are counted on
`metrics_observations_rejected_total` instead of allocating memory.

**p95 definition**: `histogram_quantile(0.95, ...)` — cumulative-bucket
linear interpolation (the Prometheus algorithm; the identical JS
implementation `histogramQuantile()` in metrics.mjs is unit-tested
against hand-computed matrices and documented as the p95 contract).
Known edge divergence: `histogramQuantile()` at `q=0` with an empty
first bucket returns `0`, where Prometheus `histogram_quantile(0, ...)`
returns `NaN` — a deliberate simplification at the q=0 edge; the p95
contract (q=0.95) is unaffected.

**SLOs** (targets the alerts defend):
- p95 request latency per route class: **500 ms** (kid-device round trips
  on home/school networks; server-side engine work is <10 ms, so the
  budget is network-dominated).
- Request success: **99%** non-5xx.
- Sync success: **>95%** (offline-first devices queue and retry, so brief
  failures are absorbed; sustained failure risks device queue overflow).
- Gate pass rate: no numeric SLO — a near-zero pass rate at volume is the
  regression signal (engine/content bug, not harder kids).

## 2. Where it is exposed

A SEPARATE internal listener (`observability/metrics-listener.mjs`),
deliberately not a Fastify app route:

- `METRICS_PORT` env: when set, `GET /metrics` serves the Prometheus
  text format (0.0.4) on that port. Unset = no listener at all.
- `METRICS_HOST` (default `127.0.0.1`): a local run never exposes it.
  The container wiring binds `0.0.0.0` only because Fargate task
  networking requires it — the task security group is the enforcement
  point (see §7).
- `METRICS_TOKEN` (optional): bearer-token gate on the listener —
  defense in depth for shared private networks.
- Never on the public app port; never routed at the Dwara edge (the edge
  routes `/api/*` only — an origin `/metrics` path 404s at the app and is
  unreachable through the gateway). Not child-facing by construction.

Why not a public `/metrics` on the app: the public port is the child
surface; metrics exposition is an operator surface. Separate port =
separate SG rules + optional token, and no new public API contract.

## 3. Redaction policy (D5/COPPA — test-enforced)

The build-failing gate: `services/api/test/observability-pii.test.mjs`
plants a child name, parent email, phone number, and one-time tokens in
URL queries, crafted paths, and headers, then asserts ZERO occurrences
in the captured pino logs, the live metrics exposition, and every
`error_events` row.

Rules (implemented in `observability/redact.mjs` and the logging seam):

1. **Free text is scrubbed at the seam**: emails, bearer/verification
   token shapes, phone numbers, and IP addresses are pattern-replaced
   (`[redacted-email]`, `[redacted-token]`, ...) from error messages and
   stack traces BEFORE logging or persistence. Over-redaction is the
   safe direction.
2. **Request/response bodies are never telemetry.** The error store has
   no body column at all; the PII test asserts this structurally.
3. **Logged URLs are paths with query strings stripped.** One-time
   verify/reset tokens never enter logs. Unmatched (attacker-shaped)
   paths are never logged verbatim — only the `unmatched` class.
4. **Client IPs are truncated** — IPv4 to the first three octets (/24);
   IPv6 to the first three TEXTUAL colon groups plus `::`. COPPA treats
   persistable IPs as personal information; truncation keeps
   ISP/network signal for abuse response without a per-device
   identifier. Actual shape behavior (test-pinned): IPv6 truncation
   splits the PRINTED form, not the expanded address — a fully expanded
   address yields its true /48 network prefix, but a partially
   compressed address whose text still has three or more groups can
   retain a host-side group value in the third slot (at most 16 bits of
   host signal), and addresses compressed below three groups
   (`fe80::1`, `::1`) collapse to `[ip-anon]` entirely (over-redaction —
   the safe direction). Malformed inputs never echo: shapes that do not
   match degrade to `[ip-anon]` or a numeric-only truncation, so there
   is no injection vector.
5. **The opaque-UUID exemption (documented)**: `studentId`, `parentId`,
   and `requestId` are random surrogate identifiers with no semantic
   link to a person — they are the correlation keys (§6) and are only
   resolvable through authorized database access, like every other API
   surface. They appear in logs and `error_events.request_id` by
   design; the PII test asserts their PRESENCE (correlation must work)
   while asserting the absence of everything planted.
6. **Child names**: arbitrary names cannot be pattern-detected in free
   text; the mitigation is structural — telemetry never captures bodies
   or body-derived text, so names have no path into it. The PII test
   plants a name end-to-end to prove the path does not exist.

The 405/404/401 mechanics of the metrics listener are token-gated when
configured; the listener itself emits no request logs.

## 4. Alerting

Rules as code: `deploy/observability/alert-rules.yml` (Prometheus rule
format; thresholds + rationale are annotations on every rule). Synthetic
exercise: `deploy/observability/alert-tests.yml` — the promtool unit-test
file (`promtool test rules alert-tests.yml` from that directory) proves
every rule fires and stays quiet; the CI suite
(`test/alert-rules.test.mjs`) additionally validates structure, that
every expr references only registry-exported metrics (no silent
never-firing alerts), and that every threshold fires above / stays quiet
below its bound.

| Alert | Fires when | Severity | First response |
|---|---|---|---|
| `ApiP95LatencyHigh` | route-class p95 > 0.8s for 10m | warning | Check `db_pool_waiting`/`db_pool_idle` (pool saturation is the top cause), deployment recency (migrations run on deploy), ALB/target health (#64 runbook) |
| `ApiErrorRateHigh` | 5xx > 1% of requests for 10m | critical | Group `error_events` by fingerprint for the dominant problem type; correlate request ids to logs; check DB health |
| `SyncFailureSpike` | sync error outcome > 5% for 10m | critical | Break down by endpoint + status (`http_requests_total` route_class=`/api/sync/*`); check recent deploys and consent gates; devices retry on their own queue — no data lost while diagnosing |
| `GateEvaluationAnomaly` | pass rate < 5% over 30m AND >0.01 eval/s | warning | One unit at 0% = that unit's gate content bug; all units = engine/scoring change. Roll back the offending release |
| `ErrorEventFlood` | captured unhandled 5xx > 0.5/s for 5m | critical | Fingerprint histogram in `error_events`; if flood-capped dominates, one hot bug is looping |
| `DbPoolSaturation` | `db_pool_waiting` > 5 for 5m | warning | `pg_stat_activity` longest queries; recent migration? traffic shift by route class |

Threshold rationale is carried IN the rule annotations (`rationale`)
so the file is self-documenting; summaries above are the abbreviated form.

## 5. Error tracking

First-party, server-side only (D5: no third-party error SDK on ANY
client surface). See §8 for the decision record vs GlitchTip.

- **Table**: migration `013_error_events` (existing Postgres; no new
  service). Columns: `captured_at`, `request_id` (UUID or NULL),
  `route_class`, `problem_type`, `status_code`, `message_redacted`,
  `stack_redacted` (both scrubbed per §3 before insert; length-capped),
  `fingerprint` (route class + problem type + top stack frame — the
  grouping key), `environment`. No FK by the 011 ops-ledger doctrine.
- **Capture point**: the Fastify error handler's unhandled-5xx branch
  (`server.mjs`). Validation/4xx problems are not error events (they
  are client errors, already visible in http metrics).
- **Flood cap**: max 10 events per fingerprint per 60s window; suppressed
  events still count on `error_events_total{outcome="flood-capped"}` so
  a hot loop is visible without flooding the table.
- **Retention**: 30 days (`ERROR_EVENT_RETENTION_DAYS`), purged by the
  existing retention sweep (`retention.mjs`) — a rolling window, not an
  archive.
- **Querying** (operator):
  ```sql
  -- top error groups in the last day
  SELECT fingerprint, problem_type, route_class, count(*) AS n,
         max(captured_at) AS last_seen
  FROM error_events
  WHERE captured_at > now() - interval '1 day'
  GROUP BY 1, 2, 3 ORDER BY n DESC LIMIT 20;
  -- one group's most recent redacted stack
  SELECT captured_at, request_id, message_redacted, stack_redacted
  FROM error_events WHERE fingerprint = '<fp>'
  ORDER BY captured_at DESC LIMIT 1;
  ```
  Cross-reference `request_id` against origin logs (`requestId` field)
  for the full request context.

## 6. Correlation IDs

- The origin ACCEPTS an inbound `X-Request-Id` header **only when it is
  a strictly well-formed UUID**; anything else (wrong shape, oversize,
  injection probes) is replaced with a fresh server UUID
  (`genReqId` in server.mjs — charset validation makes log injection
  impossible). The edge forwards request headers by default, so a
  client-generated UUID travels client -> edge -> origin.
- Every reply carries `X-Request-Id` (headers) and every problem+json
  envelope carries `requestId` (body member; additive RFC 9457
  extension — OpenAPI baseline updated per D11).
- The request log line's `requestId` and `error_events.request_id` close
  the loop: client report -> envelope -> log -> error group.
- Edge note (#65): Dwara's analytics block (gateway.md §8), when the
  operator enables it, keys its own request ids; the origin header
  contract above is unchanged either way.

## 7. Operator wiring (self-hosted OSS stack)

The origin ships the EXPOSITION + RULES + DASHBOARDS; running the
scraper/dashboard is operator-side (kept out of TF to stay
validate-only and cost-lean):

1. **Prometheus** (self-hosted, inside the VPC): scrape job against the
   API tasks' metrics port.
   - `infra/modules/api_service` already accepts `metrics_port`
     (default 9101) and `metrics_scrape_cidrs` (DEFAULT EMPTY — no
     ingress rule exists until you list your Prometheus hosts' CIDRs;
     never `0.0.0.0/0`).
   - In each environment root set e.g.:
     `metrics_scrape_cidrs = ["10.0.8.0/24"]` (your ops subnet).
   - Optionally set a shared scrape token in SSM -> task env
     `METRICS_TOKEN`, and pass the same token in the Prometheus job's
     `authorization.credentials`.
   - Scraping targets are the ECS tasks' private IPs (service discovery
     via your preferred mechanism — ECS service discovery or a static
     task-networking target list; the ALB does NOT forward the metrics
     port).
2. **Rules**: load `deploy/observability/alert-rules.yml` into
   Prometheus (`rule_files`). Verify anytime with
   `promtool test rules deploy/observability/alert-tests.yml` — this is
   the staging synthetic-trigger exercise for the acceptance criterion
   (fires every rule against synthetic series; also re-run after any
   threshold edit).
3. **Alertmanager** (self-hosted): route `critical` -> page, `warning`
   -> ticket channel; the annotations carry the first response inline.
4. **Grafana OSS** (self-hosted): import
   `deploy/observability/dashboards/api-overview.json` (uid
   `balashi-api-overview`) pointed at the Prometheus datasource.
5. **Logs**: first-party pino JSON in CloudWatch (the #64 log group);
   `LOG_LEVEL` per environment (tf `log_level` var). Query by
   `requestId` to correlate with alerts/error events.
6. **Edge analytics** (optional): enabling the Dwara analytics block
   (gateway.md §8) adds edge-side consumer-class/429 metrics on the
   gateway's own ops surface — operator decision, feeds the same
   Grafana via its own exporter.

containerInsights stays OFF (D5 cost doctrine; the first-party stack
above replaces it).

## 8. Decisions (ADR summary)

- **No OpenTelemetry SDK / prom-client; hand-rolled registry (~1 file)**.
  The origin is deliberately dependency-light; the needed surface
  (counter/gauge/histogram + text exposition + bounded labels) is small,
  and the OTel SDK's transitive tree is a large audit surface for a
  COPPA-scoped codebase. The registry is pure and unit-tested; upgrade
  path: swap the renderer for an OTel exporter behind the same
  declaration API if push-based collection is ever needed.
- **Error tracking in Postgres, not GlitchTip/Sentry-compatible OSS**.
  Issue scope is server-side error tracking; a first-party table adds
  zero services/dependencies/data flows for #68 to audit, and feeds the
  same alerting path. GlitchTip is the documented upgrade path if
  grouping/aggregation outgrows a table (then: self-hosted, still no
  client SDK).
- **Separate metrics listener, not an app route** — see §2.
- **Exposition on the origin, scraping operator-side** — keeps TF
  validate-only and the OSS stack (Prometheus/Grafana/Alertmanager)
  out of the child-product blast radius.

## 9. Cost & doctrine

- containerInsights OFF (D5); CloudWatch retains only first-party pino
  JSON (`log_retention_days` per env).
- The metrics listener is unref'd — it never holds the process open and
  costs nothing when `METRICS_PORT` is unset.
- All telemetry surfaces are internal; nothing in this stack increases
  the child-facing surface by one route.
