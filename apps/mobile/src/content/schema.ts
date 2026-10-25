/**
 * On-device content DB schema (issue #46) — versioned migrations.
 *
 * balashikshana_content.db is the LIFECYCLE database (pack registry +
 * storage budget) and also owns the append-only attempt log and the
 * topic/unit progress tables that issue #47 populates (the schemas land
 * now, per the issue body; nothing writes them yet).
 *
 * The CONTENT itself lives inside each signed pack artifact (its own
 * SQLite file written by the compiler) and is opened read-only — content
 * rows are never inserted on-device.
 */

export interface ContentDbMigration {
  version: number;
  statements: string[];
}

export const CONTENT_DB_MIGRATIONS: ContentDbMigration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS pack_meta (
         grade_id TEXT NOT NULL,
         content_version TEXT NOT NULL,
         format_version INTEGER NOT NULL,
         status TEXT NOT NULL CHECK (status = 'active'),
         artifact TEXT NOT NULL,
         size_bytes INTEGER NOT NULL,
         sha256 TEXT NOT NULL,
         key_id TEXT NOT NULL,
         installed_at INTEGER NOT NULL,
         PRIMARY KEY (grade_id, content_version)
       )`,
      `CREATE INDEX IF NOT EXISTS idx_pack_meta_grade ON pack_meta(grade_id)`,
      // Append-only attempt log (#47 writes; #48 syncs and flags rows).
      `CREATE TABLE IF NOT EXISTS attempt_log (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         student_id TEXT NOT NULL,
         topic_id TEXT NOT NULL,
         question_id TEXT NOT NULL,
         interaction_type TEXT NOT NULL,
         is_correct INTEGER NOT NULL,
         cognitive_time_sec REAL NOT NULL,
         audio_duration_sec REAL NOT NULL DEFAULT 0,
         answered_at INTEGER NOT NULL,
         synced INTEGER NOT NULL DEFAULT 0
       )`,
      `CREATE INDEX IF NOT EXISTS idx_attempt_log_student ON attempt_log(student_id, answered_at)`,
      `CREATE INDEX IF NOT EXISTS idx_attempt_log_unsynced ON attempt_log(synced) WHERE synced = 0`,
      // Topic-level progress (#47 populates via core-engine evaluation).
      `CREATE TABLE IF NOT EXISTS topic_progress (
         student_id TEXT NOT NULL,
         topic_id TEXT NOT NULL,
         unit_id TEXT NOT NULL,
         completed INTEGER NOT NULL DEFAULT 0,
         crowns INTEGER NOT NULL DEFAULT 0,
         mastery_score INTEGER NOT NULL DEFAULT 0,
         best_accuracy_pct REAL NOT NULL DEFAULT 0,
         best_median_speed_sec REAL NOT NULL DEFAULT 0,
         attempts_count INTEGER NOT NULL DEFAULT 0,
         updated_at INTEGER NOT NULL,
         PRIMARY KEY (student_id, topic_id)
       )`,
      // Unit-level progress incl. mastery-gate key state (#47).
      `CREATE TABLE IF NOT EXISTS unit_progress (
         student_id TEXT NOT NULL,
         unit_id TEXT NOT NULL,
         status TEXT NOT NULL DEFAULT 'in_progress',
         key_state TEXT,
         best_accuracy_pct REAL NOT NULL DEFAULT 0,
         attempts_count INTEGER NOT NULL DEFAULT 0,
         updated_at INTEGER NOT NULL,
         PRIMARY KEY (student_id, unit_id)
       )`,
    ],
  },
  {
    // Migration 2 (issue #47 — offline practice core) widens the #46
    // tables for the practice module. v1 statements are NEVER edited;
    // v2 only ADDS columns (SQLite ALTER ... ADD COLUMN with defaults
    // keeps v1 rows valid) plus one partial index, so a v1 database
    // upgrades in place with zero data movement. The `synced` flag
    // contract for #48 is untouched (still NOT NULL DEFAULT 0; only
    // #48's sync worker may flip it).
    version: 2,
    statements: [
      // attempt_log: the columns the server's student_question_attempts
      // row carries plus the offline session identity. `id`
      // (AUTOINCREMENT, v1) IS the strictly monotonic sequence number /
      // sync cursor for #48's ordered drain.
      `ALTER TABLE attempt_log ADD COLUMN unit_id TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE attempt_log ADD COLUMN session_type TEXT NOT NULL DEFAULT 'TOPIC_PRACTICE'`,
      `ALTER TABLE attempt_log ADD COLUMN session_id TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE attempt_log ADD COLUMN raw_time_sec REAL NOT NULL DEFAULT 0`,
      `ALTER TABLE attempt_log ADD COLUMN fluency_grade INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE attempt_log ADD COLUMN misconception_tags_json TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE attempt_log ADD COLUMN chosen_answer TEXT NOT NULL DEFAULT ''`,
      // Ordered drain cursor for #48: unsynced rows per student in id order.
      `CREATE INDEX IF NOT EXISTS idx_attempt_log_drain
         ON attempt_log(student_id, id) WHERE synced = 0`,
      // topic_progress: spaced-repetition projection columns mirroring
      // the server's student_topic_progress upsert targets.
      `ALTER TABLE topic_progress ADD COLUMN topic_code TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE topic_progress ADD COLUMN fluency_grade INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE topic_progress ADD COLUMN stability_days REAL NOT NULL DEFAULT 1.0`,
      `ALTER TABLE topic_progress ADD COLUMN next_review_at INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE topic_progress ADD COLUMN last_reviewed_at INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE topic_progress ADD COLUMN provisional INTEGER NOT NULL DEFAULT 0`,
      // unit_progress: gate projection columns mirroring the server's
      // student_unit_progress upsert targets, the provisional marker
      // (#48 confirms or rolls back local gate outcomes), and the
      // two-key timestamps (registry twoKeySleepConsolidationGate:
      // Silver on day-1 pass; Gold only after >= 14 h + 5-item
      // verification with >= 4 correct).
      `ALTER TABLE unit_progress ADD COLUMN best_median_speed_sec REAL NOT NULL DEFAULT 0`,
      `ALTER TABLE unit_progress ADD COLUMN stability_days REAL NOT NULL DEFAULT 1.0`,
      `ALTER TABLE unit_progress ADD COLUMN last_reviewed_at INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE unit_progress ADD COLUMN cpa_stage TEXT NOT NULL DEFAULT 'CONCRETE_INTERACTIVE'`,
      `ALTER TABLE unit_progress ADD COLUMN provisional INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE unit_progress ADD COLUMN silver_awarded_at INTEGER NOT NULL DEFAULT 0`,
      `ALTER TABLE unit_progress ADD COLUMN gold_verified_at INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    // Migration 3 (issue #48 — sync protocol) adds ONE column: the
    // session motor baseline on every attempt row. The sync upload
    // carries it so the server's reconciliation replays the exact
    // engine math (computeCognitiveTimeSec) from facts alone — no
    // client-computed derivations are trusted. v2 rows backfill to the
    // 0.42 default, which is the mobile PracticeDeps default baseline.
    version: 3,
    statements: [
      `ALTER TABLE attempt_log ADD COLUMN motor_baseline_sec REAL NOT NULL DEFAULT 0.42`,
    ],
  },
  {
    // Migration 4 (issue #52 — game framework) adds FOUR local-only
    // telemetry columns to attempt_log: the spiral bucket an item came
    // from, the stage's registry speed target, the resolved archetype,
    // and the fallback marker for sessions the framework routed to the
    // #50 practice runner. Same additive convention as v2/v3 (ALTER
    // ADD COLUMN with defaults keeps prior rows valid, zero data
    // movement). The #48 sync wire is UNCHANGED — these columns never
    // travel; the server derives progress from the same facts as topic
    // practice (GAME session rows ride the existing pipeline).
    version: 4,
    statements: [
      `ALTER TABLE attempt_log ADD COLUMN game_spiral_provenance TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE attempt_log ADD COLUMN game_target_speed_sec REAL NOT NULL DEFAULT 0`,
      `ALTER TABLE attempt_log ADD COLUMN game_archetype TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE attempt_log ADD COLUMN game_fallback INTEGER NOT NULL DEFAULT 0`,
    ],
  },
  {
    // Migration 5 (issue #55 — gamification ledger, roadmap D9) adds the
    // local OPTIMISTIC reward projection: one row per student carrying
    // the engine-derived XP total, coin + streak counters, the best
    // beat-the-target share (speed badge input), and the earned badge
    // ids. Every value is computed by the SAME @balashikshana/core-engine
    // reward functions the server's ledger materialization runs, so the
    // local state is provisional-until-sync by construction (D8/D9
    // doctrine; the #48 snapshot + the ledger endpoint confirm it). No
    // attempt_log or progress-table change; append-only contracts are
    // untouched.
    version: 5,
    statements: [
      `CREATE TABLE IF NOT EXISTS gamification_state (
         student_id TEXT PRIMARY KEY,
         total_xp INTEGER NOT NULL DEFAULT 0,
         star_coins INTEGER NOT NULL DEFAULT 50,
         streak_days INTEGER NOT NULL DEFAULT 1,
         last_active_day_key TEXT NOT NULL DEFAULT '',
         best_beat_target_pct REAL NOT NULL DEFAULT 0,
         sessions_completed INTEGER NOT NULL DEFAULT 0,
         earned_badges_json TEXT NOT NULL DEFAULT '[]',
         provisional INTEGER NOT NULL DEFAULT 1,
         updated_at INTEGER NOT NULL DEFAULT 0
       )`,
    ],
  },
];

export const CONTENT_DB_NAME = "balashikshana_content.db";
