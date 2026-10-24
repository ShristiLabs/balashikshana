// V6 — sync attempt ledger (issue #48, roadmap D8).
//
// The offline sync protocol uploads the client's append-only attempt log
// in batches. Idempotency is enforced by the DATABASE: a client attempt
// is uniquely identified by (student_id, device_id, client_seq) — the
// device-local AUTOINCREMENT id of its attempt_log row plus the device
// binding of the uploading child-device token. A replayed or duplicated
// batch conflicts on that key and inserts nothing (ON CONFLICT DO
// NOTHING in the shared insert), so "same batch twice = same server
// state" holds by construction, not by handler discipline.
//
// Uniqueness domain notes:
// - device_id comes from the child-device TOKEN's binding (never from
//   the request body), so a device cannot write into another device's
//   id space, and a device reinstall that resets its local AUTOINCREMENT
//   sequence gets a fresh device_id (new id space) rather than silent
//   dedupe-as-data-loss.
// - The index is PARTIAL (WHERE client_seq IS NOT NULL): rows written by
//   the online server-side handlers (practice/complete, gate/evaluate)
//   carry no client sequence and never participate in the constraint.
// - device_id deliberately has NO foreign key into devices(): attempts
//   are immutable COPPA evidence, not live credential state — deleting a
//   device row must never cascade away its attempt history (the #42
//   live-credential doctrine; retention is #62's explicit business).
//
// Also lands the server-side two-key timestamp columns on
// student_unit_progress: silver_awarded_at (the frozen 14-hour window
// start) and gold_verified_at, mirroring the #47 mobile schema. The
// two-key machine itself lives in derivations.mjs; these columns persist
// its state. Nullable TEXT (ISO-8601) matching the table's existing
// timestamp convention; NULL = never awarded, which keeps the
// COALESCE-style forward-only upsert semantics expressible.
//
// `down` reverses additively: drop the index/columns added here. No
// table is dropped; no row is rewritten.

exports.up = (pgm) => {
  pgm.addColumn("student_question_attempts", {
    // Engine gate-path cognitive time is audio-aware; the online topic
    // path writes 0 (its historical behavior — no audio on that route).
    audio_duration_sec: { type: "real", notNull: true, default: 0 }
  });
  pgm.addColumn("student_question_attempts", {
    // Offline session identity ('' for online-handler rows written
    // before/at this migration; new online completions get a per-call
    // session id so every attempt belongs to exactly one session).
    session_id: { type: "text", notNull: true, default: "" }
  });
  pgm.addColumn("student_question_attempts", {
    // Device binding of the uploading token (NULL for online rows).
    device_id: { type: "text" }
  });
  pgm.addColumn("student_question_attempts", {
    // Device-local sequence number (NULL for online rows).
    client_seq: { type: "bigint" }
  });

  // Idempotency backstop: replaying a batch inserts nothing.
  pgm.createIndex("student_question_attempts", ["student_id", "device_id", "client_seq"], {
    ifNotExists: true,
    name: "uq_attempts_client_seq",
    unique: true,
    where: "client_seq IS NOT NULL"
  });
  // Session-granular replay lookup for the reconciler: the sync
  // reconciler replays every gained session over the UNION of its batch
  // group and previously persisted rows of the same
  // (student_id, session_id, session_type) — split sessions converge to
  // exactly-once counting instead of double-counting a client contract
  // violation (#48 defense-in-depth).
  pgm.createIndex("student_question_attempts", ["student_id", "session_id"], {
    ifNotExists: true,
    name: "idx_attempts_session",
    where: "session_id <> ''"
  });

  pgm.addColumn("student_unit_progress", {
    silver_awarded_at: { type: "text" }
  });
  pgm.addColumn("student_unit_progress", {
    gold_verified_at: { type: "text" }
  });
};

exports.down = (pgm) => {
  pgm.dropColumn("student_unit_progress", "gold_verified_at", { ifExists: true });
  pgm.dropColumn("student_unit_progress", "silver_awarded_at", { ifExists: true });
  pgm.dropIndex("student_question_attempts", "idx_attempts_session", { ifExists: true });
  pgm.dropIndex("student_question_attempts", "uq_attempts_client_seq", { ifExists: true });
  pgm.dropColumn("student_question_attempts", "client_seq", { ifExists: true });
  pgm.dropColumn("student_question_attempts", "device_id", { ifExists: true });
  pgm.dropColumn("student_question_attempts", "session_id", { ifExists: true });
  pgm.dropColumn("student_question_attempts", "audio_duration_sec", { ifExists: true });
};
