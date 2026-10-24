// V2 — parent accounts and COPPA consent groundwork (issue #39, roadmap D4).
// Schema-only: parents, parent_children, consent_records, devices, plus the
// audit_students_without_consent view. No route touches these tables yet —
// #40 (parent auth), #41 (consent middleware), #42 (child device sessions)
// build behavior on top. Nothing here is seeded: parents exist only via #40
// signup and no code back-fills parent_children.
//
// Conventions:
// - IDs follow the 001 convention: TEXT primary keys minted by the app
//   layer (#40+ will generate "par-...", "con-...", "dev-..." ids).
// - Timestamps are timestamptz. 001 stored TEXT ISO-8601 as a verbatim
//   SQLite-port artifact; these tables are Postgres-native with no
//   on-device counterpart, and COPPA consent evidence needs real
//   timestamp semantics (index-ordered comparisons, DST-safe arithmetic,
//   DEFAULT now()).
//
// FK delete rules are deliberate — they shape the #62 data-rights flows:
// - consent_records uses ON DELETE RESTRICT on both parent_id and
//   student_id: consent evidence must never vanish as a side effect of a
//   row delete. #62 must handle retention/anonymization explicitly before
//   deleting any referenced parent or student row.
// - parent_children and devices use ON DELETE CASCADE from parents, and
//   parent_children also cascades from students: bindings and devices are
//   live relationship data, not evidence, and are removed with their row.

exports.up = (pgm) => {
  pgm.createTable("parents", {
    parent_id: { type: "text", notNull: true, primaryKey: true },
    email: { type: "text", notNull: true },
    // Stored in the existing scrypt$<N>$<r>$<p>$<salt hex>$<key hex> format
    // produced by hashPinScrypt() in db.mjs (#40 reuses those helpers).
    password_hash: { type: "text", notNull: true },
    // NULL until #40's verification flow sets it.
    email_verified_at: { type: "timestamptz" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  }, { ifNotExists: true });
  // Case-insensitive email uniqueness without a citext extension dependency.
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS uq_parents_email_lower ON parents (LOWER(email))`);
  // Shape guard only (defense in depth for a COPPA table); full email
  // validation stays in #40's API layer.
  pgm.addConstraint("parents", "parents_email_shape_ck", `CHECK (email LIKE '%@%.%')`);

  pgm.createTable("parent_children", {
    parent_id: { type: "text", notNull: true, references: "parents(parent_id)", onDelete: "cascade" },
    student_id: { type: "text", notNull: true, references: "students(student_id)", onDelete: "cascade" },
    // Relation label, e.g. "mother"/"father"/"guardian" (#40 UI chooses).
    relation: { type: "text", notNull: true },
    // #42 extends the value set (claim/archive lifecycle); starts at claimed.
    status: { type: "text", notNull: true, default: "claimed" },
    claimed_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  }, { ifNotExists: true });
  // The (parent_id, student_id) uniqueness the issue requires, as the
  // composite PK (parent_id is then FK-indexed by the PK itself).
  pgm.addConstraint("parent_children", "parent_children_pk", "PRIMARY KEY (parent_id, student_id)");
  pgm.createIndex("parent_children", ["student_id"], { ifNotExists: true, name: "idx_parent_children_student" });

  pgm.createTable("consent_records", {
    consent_id: { type: "text", notNull: true, primaryKey: true },
    parent_id: { type: "text", notNull: true, references: "parents(parent_id)", onDelete: "restrict" },
    // Nullable until #42 binds a child at capture time; #41's invariant
    // middleware reads this table once consent capture exists.
    student_id: { type: "text", references: "students(student_id)", onDelete: "restrict" },
    policy_version: { type: "text", notNull: true },
    captured_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    // Capture method, e.g. signup-form acceptance (#41 fixes the value set).
    method: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  }, { ifNotExists: true });
  pgm.createIndex("consent_records", ["parent_id"], { ifNotExists: true, name: "idx_consent_records_parent" });
  pgm.createIndex("consent_records", ["student_id"], { ifNotExists: true, name: "idx_consent_records_student" });

  pgm.createTable("devices", {
    device_id: { type: "text", notNull: true, primaryKey: true },
    parent_id: { type: "text", notNull: true, references: "parents(parent_id)", onDelete: "cascade" },
    // Stable client-provided identifier; unique per parent (a re-seen device
    // upserts rather than duplicating).
    client_device_id: { type: "text", notNull: true },
    platform: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    last_seen_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  }, { ifNotExists: true });
  pgm.createIndex("devices", ["parent_id", "client_device_id"], { ifNotExists: true, name: "uq_devices_parent_client", unique: true });

  // Pre-#41 baseline: with no consent capture path yet, this view lists
  // every standalone (dev-data) student. #41's hard-invariant test grows
  // out of it: any student row without a matching consent_records row.
  pgm.createView(
    "audit_students_without_consent",
    { ifNotExists: true },
    `SELECT s.student_id, s.username, s.nickname, s.created_at
     FROM students s
     WHERE NOT EXISTS (
       SELECT 1 FROM consent_records cr WHERE cr.student_id = s.student_id
     )`
  );
};

exports.down = (pgm) => {
  pgm.dropView("audit_students_without_consent", { ifExists: true });
  pgm.dropTable("devices", { ifExists: true });
  pgm.dropTable("consent_records", { ifExists: true });
  pgm.dropTable("parent_children", { ifExists: true });
  pgm.dropTable("parents", { ifExists: true });
};
