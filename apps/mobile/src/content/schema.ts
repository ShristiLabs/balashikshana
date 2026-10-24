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
];

export const CONTENT_DB_NAME = "balashikshana_content.db";
