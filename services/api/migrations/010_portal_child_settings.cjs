// V10 — portal child settings (issue #61, roadmap D4/D5, M5).
//
// The parent-controlled configuration home for the parent portal: per
// (parent, child) usage limits, content controls, and the parent-owned
// defaults for the COPPA-safe local practice reminders (#57).
//
// Design notes:
// - ONE row per (parent_id, student_id). A student has at most one
//   claiming parent (uq_parent_children_claimed_student, migration 005),
//   so per-parent-child is effectively per-child; keying by the binding
//   (not student alone) keeps the ownership audit trail explicit and
//   makes an unclaimed/legacy student trivially "no settings".
// - Absent row = platform defaults on every field: no time limit, no
//   subject restrictions, no grade ceiling, reminders OFF (the #57
//   COPPA-safe default — reminders exist only after a parent enables
//   them). Code must read through DEFAULT_CHILD_SETTINGS
//   (enforcement.mjs), never assume a row exists.
// - daily_limit_minutes is NULL = unlimited (0 is rejected by the route
//   schema; the range CHECK mirrors it at the storage layer). Bounds:
//   5 minutes is the smallest meaningful cap, 8 hours is a generous
//   ceiling that still catches the "tablet all day" case.
// - restricted_subjects is a JSON text array validated at the route
//   layer against the fixed subject set (ela, math, science,
//   socialStudies — see units.subject); an empty array = nothing
//   restricted. Stored as text JSON, not text[], to match the repo's
//   existing JSON-in-text convention (prerequisite_unit_ids_json,
//   misconception_tags_json, assets_json).
// - grade_ceiling FKs grades(grade_id): content above the ceiling is
//   not served to that child. NULL = no ceiling (the registry's own
//   progression rules govern).
// - reminder_hour/reminder_minute mirror the core-engine
//   ReminderSettings contract (reminders.mjs: defaults 17:00) so the
//   portal writes exactly the shape the #57 device-local scheduler
//   consumes — one rule source, no fork. The REMINDER stays device-
//   local (D5): this row is the parent-owned default the portal manages
//   and the device may adopt via the sync progress snapshot; the device
//   never uploads its reminder state.
// - Enforcement doctrine: time limits bind on the child-device sync
//   surfaces; content controls bind on every child-authenticated
//   question-serving route. Neither EVER rewrites or deletes recorded
//   attempts — the attempt ledger is append-only COPPA evidence (D8);
//   controls gate what is SERVED and INGESTED going forward.
//
// `down` reverses additively: drop the table. No other table is touched.

exports.up = (pgm) => {
  pgm.createTable("portal_child_settings", {
    parent_id: {
      type: "text",
      notNull: true,
      references: "parents(parent_id)",
      onDelete: "CASCADE"
    },
    student_id: {
      type: "text",
      notNull: true,
      references: "students(student_id)",
      onDelete: "CASCADE"
    },
    // NULL = unlimited. When present: 5..480 minutes per UTC day.
    daily_limit_minutes: {
      type: "integer",
      check: "daily_limit_minutes IS NULL OR (daily_limit_minutes >= 5 AND daily_limit_minutes <= 480)"
    },
    // JSON text array of units.subject values; '[]' = nothing restricted.
    restricted_subjects: { type: "text", notNull: true, default: "[]" },
    // Grade whose content (and below) may be served; NULL = no ceiling.
    grade_ceiling: { type: "text", references: "grades(grade_id)" },
    // #57 mirror: reminders default OFF, 17:00 local when enabled.
    reminders_enabled: { type: "boolean", notNull: true, default: false },
    reminder_hour: { type: "integer", notNull: true, default: 17, check: "reminder_hour >= 0 AND reminder_hour <= 23" },
    reminder_minute: { type: "integer", notNull: true, default: 0, check: "reminder_minute >= 0 AND reminder_minute <= 59" },
    updated_at: { type: "timestamptz", notNull: true, default: "now()" }
  });
  pgm.addConstraint("portal_child_settings", "portal_child_settings_pk", "PRIMARY KEY (parent_id, student_id)");
};

exports.down = (pgm) => {
  pgm.dropTable("portal_child_settings", { ifExists: true });
};
