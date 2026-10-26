// V13 — first-party error-event store (issue #66, M6).
//
// Server-side self-hosted error tracking per D5: NO third-party error
// SDK or SaaS; unhandled 5xx errors are captured into the existing
// PostgreSQL datastore with redaction-at-capture (message/stack are
// scrubbed of direct identifiers before insert; request/response
// bodies are NEVER stored — there is no body column at all).
//
// By the 011 deletion_audit doctrine this is an OPERATIONAL LEDGER:
// plain text request_id with NO foreign key — it must outlive the
// sessions/students it describes (an ops table that cascade-deletes on
// account deletion would lose the incident history precisely when it
// matters). It contains no COPPA-regulated child data by construction
// (opaque request id + route class + problem type + redacted stack).
//
// Retention: rows are purged after ERROR_EVENT_RETENTION_DAYS
// (default 30) by the shared retention sweep (retention.mjs) — the
// table is a rolling window, not an archive.
//
// `down` drops the table (pure ops data, nothing to preserve).

exports.up = (pgm) => {
  pgm.createTable("error_events", {
    id: { type: "bigserial", notNull: true, primaryKey: true },
    captured_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    // Opaque correlation UUID (correlation seam, issue #66) — NOT a
    // child/parent identifier; null when absent or not UUID-shaped.
    request_id: { type: "uuid", notNull: false },
    route_class: { type: "text", notNull: true },
    problem_type: { type: "text", notNull: true },
    status_code: { type: "integer", notNull: false },
    // Redacted BEFORE insert (observability/redact.mjs); capped lengths.
    message_redacted: { type: "text", notNull: false },
    stack_redacted: { type: "text", notNull: false },
    // Grouping key: route class + problem type + top stack frame.
    fingerprint: { type: "text", notNull: true },
    environment: { type: "text", notNull: true }
  });
  // Retention sweep purge path + ops "recent errors" queries.
  pgm.createIndex("error_events", "captured_at");
  // Grouped aggregation (per-fingerprint counts over a window).
  pgm.createIndex("error_events", ["fingerprint", "captured_at"]);
};

exports.down = (pgm) => {
  pgm.dropTable("error_events");
};
