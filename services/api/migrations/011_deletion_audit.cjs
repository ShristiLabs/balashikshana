// V11 — deletion audit ledger (issue #62, M5 data rights).
//
// The append-only record of every sanctioned child-data deletion. Written
// ONLY inside the DELETE /api/portal/children/:studentId transaction, in
// the same commit as the cascade — never readable or writable through any
// other route (AC3), and never modifiable at all:
//
// - Plain-text parent_id / student_id with NO foreign keys, by design.
//   The ledger is the one table that must survive EVERYTHING, including
//   a future parent-account deletion (its evidence value is exactly that
//   it outlives the rows it describes). FKs would chain its lifetime to
//   the rows it audits.
// - The append-only guarantee is DATABASE-enforced, not route-enforced:
//   trigger deletion_audit_append_only raises on any UPDATE or DELETE.
//   Routes never expose the table anyway; the trigger is the backstop
//   against future code paths (the same doctrine as consent RESTRICT —
//   evidence is protected at the storage layer).
// - deleted_counts is a JSON text object of per-table deleted-row counts
//   (the repo's JSON-in-text convention). consent_records_detached is
//   called out separately: consent evidence rows are NEVER deleted — the
//   deletion transaction severs their child linkage (student_id -> NULL)
//   and this count records how many, so the audit row alone carries the
//   child <-> policy-version linkage after deletion (AC4's "audit
//   linkage").
//
// COPPA posture recorded here (the #62 decision, documented once at the
// storage layer): verifiable parental consent records are RETAINED past a
// child-data deletion request — FTC COPPA record-keeping expects the
// operator to be able to demonstrate consent for a retention period —
// while every child-specific data row is deleted. The child PII lives in
// students (nickname, username, avatar, age) and is removed with that
// row; consent_records carries no child PII beyond the opaque student_id
// linkage, which the sanctioned delete severs explicitly in the same
// transaction. consent_records.student_id stays ON DELETE RESTRICT
// (migration 002) so NO code path — this one included — can cascade
// evidence away: only the deliberate, audited linkage-severance UPDATE
// clears the way for the students row delete.
//
// `down` reverses additively: drop the table. No other table is touched.

exports.up = (pgm) => {
  pgm.createTable("deletion_audit", {
    audit_id: { type: "text", notNull: true, primaryKey: true },
    // Actor: the parent whose password re-authentication authorized the
    // deletion. Plain text — see header for why there is no FK.
    parent_id: { type: "text", notNull: true },
    student_id: { type: "text", notNull: true },
    // Consent policy version in force at deletion time (what the retained
    // consent_records rows reference).
    policy_version: { type: "text", notNull: true },
    // What was deleted. Vocabulary starts at 'child-data' (the full
    // per-child cascade); a closed CHECK so growth is a migration-time
    // decision, not a string free-for-all.
    scope: { type: "text", notNull: true, check: "scope IN ('child-data')" },
    // How many consent_records rows had their child linkage severed (the
    // rows themselves survive — COPPA record-keeping).
    consent_records_detached: { type: "integer", notNull: true, default: 0 },
    // JSON text object: { "student_question_attempts": 42, ... } per table.
    deleted_counts: { type: "text", notNull: true, default: "{}" },
    deleted_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  });
  pgm.createIndex("deletion_audit", ["parent_id", "deleted_at"], { ifNotExists: true, name: "idx_deletion_audit_parent_time" });
  pgm.createIndex("deletion_audit", ["student_id"], { ifNotExists: true, name: "idx_deletion_audit_student" });

  // Storage-layer append-only doctrine (AC3): any UPDATE or DELETE on the
  // ledger fails, no matter which code path attempts it. Raw SQL (not
  // pgm.createTrigger) so the function + trigger shapes are explicit.
  pgm.sql(`CREATE OR REPLACE FUNCTION deletion_audit_append_only() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'deletion_audit is append-only (COPPA evidence)';
END;
$fn$;`);
  pgm.sql(`DROP TRIGGER IF EXISTS deletion_audit_append_only ON deletion_audit;`);
  pgm.sql(`CREATE TRIGGER deletion_audit_append_only
BEFORE UPDATE OR DELETE ON deletion_audit
FOR EACH ROW EXECUTE FUNCTION deletion_audit_append_only();`);
};

exports.down = (pgm) => {
  pgm.dropTable("deletion_audit", { ifExists: true });
  pgm.sql(`DROP FUNCTION IF EXISTS deletion_audit_append_only();`);
};
