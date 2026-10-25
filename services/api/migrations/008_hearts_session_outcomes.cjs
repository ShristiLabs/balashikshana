// V8 — hearts session outcomes (issue #56, roadmap D6).
//
// One row per Grade 2–3 FLUENCY-SPRINT game session that carried
// hearts: the heart-loss count and the session-end reason ("completed"
// | "hearts-empty"), recorded by the client at session close and
// carried on the #48 sync wire (additive optional sessionOutcomes
// array on POST /api/sync/attempts). This is the "#55 ledger context":
// the facts sit alongside the attempt stream the gamification ledger
// derives from, joinable by session_id — hearts themselves are
// session-scoped UI, never a currency and never progress (D6), so
// nothing here feeds reward math.
//
// Exactly-once by construction, not handler discipline (the 006/007
// doctrine): UNIQUE (student_id, session_id) + ON CONFLICT DO NOTHING
// in the reconciler — a replayed batch or a crash-before-ack re-upload
// inserts nothing. Validation (bounds, the lost+remaining == HEART_COUNT
// invariant, end-reason consistency) runs in the reconciler through the
// SAME core-engine hearts rules (src/hearts.mjs, heartsOutcomeProblem)
// the client applied — the wire contract cannot fork.
//
// COPPA note: counts and an enum reason only — no free text, no PII.
// CASCADE on student deletion: derived telemetry, not consent evidence
// (002's RESTRICT contrast); retention rides the students cascade.
//
// `down` drops additively (nothing else references the table).

exports.up = (pgm) => {
  pgm.createTable("student_session_outcomes", {
    id: { type: "id", primaryKey: true },
    student_id: { type: "text", notNull: true, references: "students(student_id)", onDelete: "cascade" },
    // Uploading device (mirrors 006's attempts posture: recorded, no FK).
    device_id: { type: "text", notNull: true },
    session_id: { type: "text", notNull: true },
    // Always GAME today; carried for explicitness + validation.
    session_type: { type: "text", notNull: true },
    // Always fluency (the D6 predicate mounts hearts on fluency alone).
    stage: { type: "text", notNull: true },
    hearts_lost: { type: "integer", notNull: true, check: "hearts_lost >= 0" },
    hearts_remaining: { type: "integer", notNull: true, check: "hearts_remaining >= 0" },
    // 'completed' | 'hearts-empty' (engine HEARTS_END_REASONS).
    end_reason: { type: "text", notNull: true },
    // Client clock at session close (telemetry, not progress math — no
    // skew adoption; the reconciler accepts it as recorded).
    ended_at: { type: "timestamptz", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  });
  // The exactly-once seam: one outcome row per (student, session).
  pgm.addIndex("student_session_outcomes", ["student_id", "session_id"], {
    ifNotExists: true,
    name: "uq_session_outcomes_session",
    unique: true
  });
  pgm.addIndex("student_session_outcomes", ["student_id", "ended_at"], {
    ifNotExists: true,
    name: "idx_session_outcomes_recent"
  });
};

exports.down = (pgm) => {
  pgm.dropIndex("student_session_outcomes", "idx_session_outcomes_recent", { ifExists: true });
  pgm.dropIndex("student_session_outcomes", "uq_session_outcomes_session", { ifExists: true });
  pgm.dropTable("student_session_outcomes", { ifExists: true });
};
