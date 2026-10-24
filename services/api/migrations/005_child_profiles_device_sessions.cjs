// V5 — child profiles under parents (issue #42, roadmap D4: the M2 capstone).
//
// Four pieces:
// - child_device_sessions: the third token kind of the dual-token doctrine
//   (#40's resolveBearerAuth seam gains 'child-device'). A child device
//   token is minted by an authenticated parent, scoped to exactly one
//   student + one device, and SOFT-revocable (revoked_at keeps lifecycle
//   evidence for the COPPA audit trail, the parent_sessions pattern). Like
//   every #40+ parent-side token it is stored as the SHA-256 hex of the
//   32-byte base64url value — hashed at rest, shown to the client exactly
//   once (M1 student_sessions store raw tokens; that legacy shape is not
//   repeated here). A dedicated table rather than a parent_tokens kind:
//   parent_tokens rows are single-use (consumed_at) verification/reset
//   tokens, a different lifecycle from long-lived device sessions bound to
//   (parent, student, device).
// - students.status: 'active' | 'legacy' | 'archived'. The back-fill flags
//   every student without a parent_children row as 'legacy' — the issue's
//   "flags pre-existing standalone students as legacy (status only — no
//   rows moved, no consent fabricated, no parent auto-assigned)". 'legacy'
//   is exactly the claim-eligible population: post-#42 every creation path
//   binds its student, so no NEW standalone students can appear. 'archived'
//   is set by the parent archive route (excluded from the login-screen
//   listing, cannot mint device sessions, live sessions revoked).
// - The 002-deferred value-set CHECKs: parent_children.status IN
//   ('claimed','archived') and devices.platform IN ('ios','android','web').
//   Both tables are empty in every environment pre-#42 (nothing wrote
//   them), so the constraints validate trivially. parent_children also
//   gains archived_at (the archive-side audit timestamp; claimed_at already
//   exists).
// - uq_parent_children_claimed_student: PARTIAL UNIQUE index on
//   (student_id) WHERE status = 'claimed' — the database itself enforces
//   exactly-one-claimant-per-student. The claim route additionally uses the
//   students-row status flip as its mutex; this index is the DB backstop
//   under it (defense in depth on the anti-hijack core).
//
// Incidental corrective (found while adding students.status): migration
// 004's consent_policy_versions.locale column DEFAULT is the seven-character
// string "'en-US'" (quotes included) — 004 passed default: "'en-US'" and
// node-pg-migrate v7 literalizes string defaults (dollar-quoting), so the
// extra quotes became part of the value. Latent only: every existing insert
// names locale explicitly. This migration resets the DEFAULT to the correct
// 'en-US' (applied migrations are never edited per the ledger rules).
//
// Default-value convention NOTE for future migrations: string column
// defaults are passed UNQUOTED (default: "active") — node-pg-migrate v7
// adds the quoting itself; 002 did this correctly, 004 did not.
//
// FK delete rules: child_device_sessions cascades from parents, students,
// AND devices — a device session is live credential state (003 doctrine),
// never evidence; #62 data-rights handles retention explicitly first.
//
// `down` reverses everything additively: drop the session table, the
// constraints/index, and the two added columns. Dropping students.status
// discards the legacy/archived flags (schema-only reversal — no evidence
// rows are touched); re-running `up` re-derives 'legacy' from the
// parent_children population, which is exactly how it was first computed.

exports.up = (pgm) => {
  pgm.createTable("child_device_sessions", {
    // 'cds-' + 20 hex chars, minted by the app layer.
    session_id: { type: "text", notNull: true, primaryKey: true },
    // SHA-256 hex of the base64url token; the raw token is returned to the
    // parent exactly once and never stored or logged.
    token_hash: { type: "text", notNull: true },
    parent_id: { type: "text", notNull: true, references: "parents(parent_id)", onDelete: "cascade" },
    student_id: { type: "text", notNull: true, references: "students(student_id)", onDelete: "cascade" },
    device_id: { type: "text", notNull: true, references: "devices(device_id)", onDelete: "cascade" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    // Absolute validity (30-day TTL, set by the mint route); expired rows
    // fail auth and are lazily deleted on lookup.
    expires_at: { type: "timestamptz", notNull: true },
    // NULL = active; set by parent revocation ('parent-revoked') and child
    // archive ('child-archived'). Soft revoke keeps the lifecycle evidence.
    revoked_at: { type: "timestamptz" },
    revocation_reason: { type: "text" },
    last_seen_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  }, { ifNotExists: true });
  pgm.createIndex("child_device_sessions", ["token_hash"], { ifNotExists: true, name: "uq_child_device_sessions_token", unique: true });
  pgm.createIndex("child_device_sessions", ["student_id"], { ifNotExists: true, name: "idx_child_device_sessions_student" });
  pgm.createIndex("child_device_sessions", ["parent_id"], { ifNotExists: true, name: "idx_child_device_sessions_parent" });

  // Legacy flag (status only — see header). Default 'active' so every
  // post-005 created student is active unless a route says otherwise; the
  // back-fill below marks the pre-#42 standalone population. (String
  // defaults UNQUOTED — node-pg-migrate v7 literalizes them itself.)
  pgm.addColumn("students", { status: { type: "text", notNull: true, default: "active" } });
  pgm.addConstraint("students", "students_status_ck", `CHECK (status IN ('active', 'legacy', 'archived'))`);
  pgm.sql(`
    UPDATE students SET status = 'legacy'
    WHERE NOT EXISTS (SELECT 1 FROM parent_children pc WHERE pc.student_id = students.student_id)
  `);

  pgm.addConstraint("parent_children", "parent_children_status_ck", `CHECK (status IN ('claimed', 'archived'))`);
  pgm.addColumn("parent_children", { archived_at: { type: "timestamptz" } });
  pgm.createIndex("parent_children", ["student_id"], {
    ifNotExists: true,
    name: "uq_parent_children_claimed_student",
    unique: true,
    where: "status = 'claimed'"
  });

  pgm.addConstraint("devices", "devices_platform_ck", `CHECK (platform IN ('ios', 'android', 'web'))`);

  // Corrective (see header): 004 shipped locale DEFAULT as the literal
  // string "'en-US'" (quotes included) — reset it to the intended value.
  pgm.alterColumn("consent_policy_versions", "locale", { default: "en-US" });
};

exports.down = (pgm) => {
  // Restore 004's (buggy but original) default so down is a faithful
  // reversal of exactly what this migration changed.
  pgm.alterColumn("consent_policy_versions", "locale", { default: "'en-US'" });
  pgm.dropTable("child_device_sessions", { ifExists: true });
  pgm.dropConstraint("devices", "devices_platform_ck", { ifExists: true });
  pgm.dropIndex("parent_children", "uq_parent_children_claimed_student", { ifExists: true });
  pgm.dropColumn("parent_children", "archived_at", { ifExists: true });
  pgm.dropConstraint("parent_children", "parent_children_status_ck", { ifExists: true });
  pgm.dropConstraint("students", "students_status_ck", { ifExists: true });
  pgm.dropColumn("students", "status", { ifExists: true });
};
