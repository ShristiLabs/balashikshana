// V7 — gamification ledger (issue #55, roadmap D9).
//
// The reward ledger is server-owned and MATERIALIZED FROM THE APPEND-ONLY
// ATTEMPT STREAM: every XP event, badge award, streak transition, and
// coin award is derived at replay time (online handler or #48 sync
// reconciler) by the SAME pure functions in packages/core-engine
// (src/rewards.mjs) the RN client runs for its optimistic local state —
// D9's "rules must not fork". Nothing here invents reward state; the
// tables below are the durable, idempotent projection of those rules.
//
// Tables:
// - student_xp_events: append-only XP ledger rows. One row per award
//   (per attempt, or per session outcome). `dedupe_key` is the exactly-
//   once seam: the sync path keys attempt XP by the uploading device id
//   + client sequence (`att:<deviceId>:<seq>`) and outcome XP by the
//   session identity (`out:<sessionType>:<sessionId>:<topic|unit>`); the
//   online handlers key by their per-call session UUID. A replayed or
//   duplicated batch inserts nothing (UNIQUE (student_id, dedupe_key) +
//   ON CONFLICT DO NOTHING in the shared writer), so "same attempts
//   twice = same ledger twice" holds by construction, not handler
//   discipline — the same doctrine as 006's uq_attempts_client_seq.
// - student_badge_awards: badge awards keyed (student_id, badge_id,
//   scope). Award rules live in the engine's BADGE_CATALOG; a row exists
//   iff evaluateBadges met the threshold at some replay. Idempotent by
//   the composite PK.
// - student_gamification_state: the O(1) read row — cumulative XP,
//   the best beat-the-target share (the speed badge's monotone input),
//   and the streak's last-active day key. `students.streak_days` and
//   `students.star_coins` (001 columns) remain the kid-facing counters
//   and are updated in the SAME transactions; this row carries what they
//   cannot (the day key and the monotone best-share). total_xp is
//   maintained inside every awarding transaction; the ledger-vs-state
//   invariant (SUM(xp_events) = total_xp) is asserted by tests.
//
// COPPA note: reward rows carry student ids and curriculum ids only —
// no free text, no PII, no device fingerprints beyond what 006 already
// records. All three tables CASCADE on student deletion: they are
// derived data, not consent evidence (002's RESTRICT contrast); #62/#56
// handle retention explicitly.
//
// `down` drops additively (no row is rewritten; the ledger is
// re-derivable from the attempt stream by design).

exports.up = (pgm) => {
  pgm.createTable("student_xp_events", {
    id: { type: "id", primaryKey: true },
    student_id: { type: "text", notNull: true, references: "students(student_id)", onDelete: "cascade" },
    session_type: { type: "text", notNull: true },
    session_id: { type: "text", notNull: true },
    unit_id: { type: "text" },
    topic_id: { type: "text" },
    // XP is never negative (kid-facing rule; the engine cannot emit it).
    xp_amount: { type: "integer", notNull: true, check: "xp_amount > 0" },
    // Stable classification: 'attempt' | 'topic-pass' | 'gate-pass' | 'gold-upgrade'.
    reason: { type: "text", notNull: true },
    awarded_at: { type: "timestamptz", notNull: true },
    dedupe_key: { type: "text", notNull: true }
  });
  pgm.addIndex("student_xp_events", ["student_id", "dedupe_key"], {
    ifNotExists: true,
    name: "uq_xp_events_dedupe",
    unique: true
  });
  pgm.addIndex("student_xp_events", ["student_id", "awarded_at"], {
    ifNotExists: true,
    name: "idx_xp_events_recent"
  });

  pgm.createTable("student_badge_awards", {
    student_id: { type: "text", notNull: true, references: "students(student_id)", onDelete: "cascade" },
    // Engine BADGE_CATALOG id (catalog as engine data — no local copy).
    badge_id: { type: "text", notNull: true },
    // Reserved for future per-unit/per-topic badges; every #55 badge is global.
    scope: { type: "text", notNull: true, default: "global" },
    awarded_at: { type: "timestamptz", notNull: true }
  });
  // Explicit composite PK (node-pg-migrate v7 ignores the table-level
  // primaryKey array on createTable — found by the gamification suite:
  // the badge upsert's ON CONFLICT (student_id, badge_id, scope) needs
  // the constraint to exist).
  pgm.addConstraint("student_badge_awards", "student_badge_awards_pkey", {
    primaryKey: ["student_id", "badge_id", "scope"]
  });

  pgm.createTable("student_gamification_state", {
    student_id: { type: "text", primaryKey: true, references: "students(student_id)", onDelete: "cascade" },
    total_xp: { type: "integer", notNull: true, default: 0, check: "total_xp >= 0" },
    // Max beatTargetSharePct over the student's game topic-groups.
    best_beat_target_pct: { type: "real", notNull: true, default: 0 },
    // UTC day key of the last session that touched the streak.
    last_active_day_key: { type: "text" },
    updated_at: { type: "timestamptz", notNull: true }
  });
};

exports.down = (pgm) => {
  pgm.dropTable("student_gamification_state", { ifExists: true });
  pgm.dropConstraint("student_badge_awards", "student_badge_awards_pkey", { ifExists: true });
  pgm.dropTable("student_badge_awards", { ifExists: true });
  pgm.dropIndex("student_xp_events", "idx_xp_events_recent", { ifExists: true });
  pgm.dropIndex("student_xp_events", "uq_xp_events_dedupe", { ifExists: true });
  pgm.dropTable("student_xp_events", { ifExists: true });
};
