// First-party self-hosted error tracking (issue #66, D5).
//
// DECISION (recorded in docs/observability.md): server-side error
// events are captured into the EXISTING PostgreSQL datastore — a
// first-party table with structured aggregation via the metrics
// registry — rather than deploying GlitchTip (or any Sentry-compatible
// OSS service). Rationale: the issue scopes error tracking
// "server-side, no third-party error SDK on any client surface"; a
// first-party table adds zero services, zero dependencies, zero new
// data flows for the #68 COPPA pack to audit, and feeds the same
// alerting path as every other metric. GlitchTip is the documented
// upgrade path if grouping/aggregation needs outgrow a table.
//
// Capture contract (the PII-scan test enforces it):
//   - Stored fields: request id (opaque UUID), route class, problem
//     type, status code, REDACTED message + stack, fingerprint,
//     environment. NOTHING from request or response bodies.
//   - Message/stack pass redactText/redactStack before persistence.
//   - Flood cap: at most FLOOD_CAP events per fingerprint per
//     FLOOD_WINDOW_MS; suppressed events still count on the
//     error_events_total metric (visibility without table flooding).
//   - Retention: rows older than ERROR_EVENT_RETENTION_DAYS (default
//     30) are purged by the existing retention sweep (retention.mjs).

import { redactText, redactStack, errorFingerprint, isUuid } from "./redact.mjs";

export const ERROR_EVENT_FLOOD_CAP = Number(process.env.ERROR_EVENT_FLOOD_CAP || 10);
export const ERROR_EVENT_FLOOD_WINDOW_MS = Number(process.env.ERROR_EVENT_FLOOD_WINDOW_MS || 60000);

// In-memory flood windows (per process; per-fingerprint).
const windows = new Map();

function floodAllows(fingerprint, now) {
  const entry = windows.get(fingerprint);
  if (!entry || now - entry.startedAt >= ERROR_EVENT_FLOOD_WINDOW_MS) {
    windows.set(fingerprint, { startedAt: now, count: 1 });
    return true;
  }
  if (entry.count >= ERROR_EVENT_FLOOD_CAP) return false;
  entry.count += 1;
  return true;
}

export async function captureErrorEvent(
  db,
  { requestId, routeClass, problemType, statusCode, message, stack, environment },
  { now = Date.now() } = {}
) {
  const fingerprint = errorFingerprint(routeClass, problemType, stack);
  if (!floodAllows(fingerprint, now)) {
    return { captured: false, reason: "flood-capped", fingerprint };
  }
  const row = {
    // Request ids are persisted only when well-formed UUIDs (the same
    // inbound-validation rule as the correlation seam) — no free text.
    request_id: isUuid(requestId) ? requestId : null,
    route_class: String(routeClass || "unmatched").slice(0, 64),
    problem_type: String(problemType || "unknown").slice(0, 256),
    status_code: Number.isInteger(statusCode) ? statusCode : null,
    message_redacted: redactText(message, { maxLen: 2048 }) ?? null,
    stack_redacted: redactStack(stack) ?? null,
    fingerprint,
    environment: String(environment || "development").slice(0, 32)
  };
  try {
    await db.run(
      `INSERT INTO error_events
         (request_id, route_class, problem_type, status_code,
          message_redacted, stack_redacted, fingerprint, environment)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.request_id,
        row.route_class,
        row.problem_type,
        row.status_code,
        row.message_redacted,
        row.stack_redacted,
        row.fingerprint,
        row.environment
      ]
    );
  } catch {
    // Telemetry must never fail the request path; a capture failure is
    // visible via the caller's error_events_total metric outcome.
    return { captured: false, reason: "insert-failed", fingerprint };
  }
  return { captured: true, fingerprint };
}

export function resetFloodWindows() {
  windows.clear();
}

export async function purgeErrorEvents(db, { now = new Date(), retentionDays = 30 } = {}) {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const result = await db.run("DELETE FROM error_events WHERE captured_at <= $1", [cutoff]);
  return result.rowCount || 0;
}
