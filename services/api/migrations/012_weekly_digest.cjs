// V12 — weekly digest sent-ledger + parent opt-out (issue #63, M5).
//
// Two additive pieces for the weekly parent email summaries:
//
// 1. weekly_digest_sent — the (parent, ISO week) idempotency marker.
//    PRIMARY KEY (parent_id, iso_week) is exactly the issue's sent-ledger
//    contract: a run claims a parent's week with INSERT ... ON CONFLICT
//    DO NOTHING, so re-runs and restarts send no duplicates, and a
//    failed send (no row yet) retries on the next run.
//    - Plain-text parent_id with NO foreign key, by the 011 deletion_audit
//      doctrine: an operational ledger must outlive the rows it
//      describes (a future parent-account deletion must not cascade the
//      mail history away). Unlike deletion_audit this is NOT COPPA
//      evidence — it is delivery state — so there is no append-only
//      trigger; the digest job only ever INSERTs, and nothing else
//      touches it.
//    - iso_week is TEXT 'YYYY-Www' (ISO-8601, Monday-anchored UTC — the
//      portal-analytics convention) with a shape CHECK: human-readable
//      in ops queries, structurally guarded against junk.
//    - children_count + message_id are run diagnostics (what the email
//      summarized; the SMTP message id when the transport reports one).
//
// 2. parents.weekly_email_enabled — the parent-owned opt-out, default
//    TRUE (the issue body's "default on"). Per-parent, not per-child:
//    the digest is one email per parent. Flipping it takes effect on
//    the NEXT run (the job reads it at selection time) — immediate in
//    the sense the AC demands.
//
// `down` reverses additively: drop the table, drop the column.

exports.up = (pgm) => {
  pgm.createTable("weekly_digest_sent", {
    parent_id: { type: "text", notNull: true },
    // 'YYYY-Www' — ISO-8601 week key of the DIGESTED week (the completed
    // week the email describes), not the week the send happened in.
    iso_week: { type: "text", notNull: true },
    sent_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    // Diagnostics: how many children the email summarized.
    children_count: { type: "integer", notNull: true },
    // SMTP transport message id when available (null for capture/null).
    message_id: { type: "text" }
  });
  pgm.addConstraint("weekly_digest_sent", "weekly_digest_sent_pk", { primaryKey: ["parent_id", "iso_week"] });
  pgm.addConstraint("weekly_digest_sent", "weekly_digest_sent_iso_week_shape_ck", {
    check: "iso_week ~ '^[0-9]{4}-W[0-9]{2}$'"
  });
  pgm.addIndex("weekly_digest_sent", ["iso_week"], { ifNotExists: true, name: "idx_weekly_digest_sent_week" });

  pgm.addColumn("parents", {
    weekly_email_enabled: { type: "boolean", notNull: true, default: true }
  });
};

exports.down = (pgm) => {
  pgm.dropTable("weekly_digest_sent", { ifExists: true });
  pgm.dropColumn("parents", "weekly_email_enabled", { ifExists: true });
};
