/**
 * Deterministic SQLite pack writer (issue #46).
 *
 * One artifact = one grade = one standalone SQLite database:
 *
 *   pack_info        single row: format/content versions, counts (no clocks)
 *   grades           the grade row + spaced-repetition policy
 *   units            unit rows incl. mastery-gate rules + prerequisites
 *   skill_topics     topic rows + the 9-asset contract (canonical JSON)
 *   practice_questions  ALL columns the #50 practice runner renders
 *                       (interaction_type, visual_objects, tile_bank_json,
 *                        choices_json, correct_answer, ...)
 *   topic_sounds     audio-manifest slice (lazy path refs; no audio bytes)
 *   topic_narration  voiceNarration slice (WPM + SSML refs)
 *
 * Byte-determinism rules: fixed page_size before first write, fixed
 * application_id/user_version, one write transaction with rows inserted in
 * pre-sorted order, VACUUM to a canonical page layout, and no timestamps
 * anywhere in the artifact. Same registry input -> identical file bytes ->
 * identical checksums (proven by tests that build twice).
 */
import { DatabaseSync } from "node:sqlite";
import {
  PACK_APPLICATION_ID,
  PACK_PAGE_SIZE,
  PACK_SCHEMA_VERSION,
} from "./constants.mjs";

function insertRows(db, table, columns, rows) {
  if (rows.length === 0) return;
  const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
  const stmt = db.prepare(sql);
  for (const row of rows) {
    stmt.run(...columns.map((c) => row[c]));
  }
}

export function writeGradePack(dbPath, extracted, meta) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`PRAGMA page_size = ${PACK_PAGE_SIZE}`);
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec(`PRAGMA application_id = ${PACK_APPLICATION_ID}`);
    db.exec(`PRAGMA user_version = ${PACK_SCHEMA_VERSION}`);

    db.exec("BEGIN");
    db.exec(`
      CREATE TABLE pack_info (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        pack_format_version INTEGER NOT NULL,
        pack_schema_version INTEGER NOT NULL,
        grade_id TEXT NOT NULL,
        grade_name TEXT NOT NULL,
        content_version TEXT NOT NULL,
        registry_version TEXT NOT NULL,
        unit_count INTEGER NOT NULL,
        topic_count INTEGER NOT NULL,
        question_count INTEGER NOT NULL
      );
      CREATE TABLE grades (
        grade_id TEXT PRIMARY KEY,
        grade_name TEXT NOT NULL,
        target_age_years TEXT NOT NULL,
        sequence_order INTEGER NOT NULL,
        sr_growth_factor REAL NOT NULL,
        sr_max_interval_days INTEGER NOT NULL,
        sr_schedule_json TEXT NOT NULL
      );
      CREATE TABLE units (
        unit_id TEXT PRIMARY KEY,
        grade_id TEXT NOT NULL REFERENCES grades(grade_id),
        subject TEXT NOT NULL,
        sequence_order INTEGER NOT NULL,
        title TEXT NOT NULL,
        prerequisite_unit_ids_json TEXT NOT NULL,
        gate_question_count INTEGER NOT NULL,
        gate_min_accuracy_pct REAL NOT NULL,
        gate_max_speed_sec REAL NOT NULL,
        gate_streak_req INTEGER NOT NULL,
        study_materials_json TEXT NOT NULL,
        games_json TEXT NOT NULL
      );
      CREATE INDEX idx_units_order ON units(subject, sequence_order, unit_id);
      CREATE TABLE skill_topics (
        topic_id TEXT PRIMARY KEY,
        unit_id TEXT NOT NULL REFERENCES units(unit_id),
        grade_id TEXT NOT NULL REFERENCES grades(grade_id),
        subject TEXT NOT NULL,
        topic_code TEXT NOT NULL,
        topic_name TEXT NOT NULL,
        sequence_order INTEGER NOT NULL,
        assets_json TEXT NOT NULL
      );
      CREATE INDEX idx_topics_unit ON skill_topics(unit_id, sequence_order);
      CREATE TABLE practice_questions (
        question_id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL REFERENCES skill_topics(topic_id),
        unit_id TEXT NOT NULL REFERENCES units(unit_id),
        topic_code TEXT NOT NULL,
        topic_name TEXT NOT NULL,
        difficulty_level INTEGER NOT NULL DEFAULT 1,
        interaction_type TEXT NOT NULL,
        prompt TEXT NOT NULL,
        visual_aid_svg TEXT NOT NULL,
        visual_objects TEXT,
        target_count INTEGER,
        max_counter_cells INTEGER,
        counter_emoji TEXT,
        tile_bank_json TEXT,
        choices_json TEXT NOT NULL,
        correct_answer TEXT NOT NULL,
        misconception_tags_json TEXT NOT NULL,
        explanation TEXT NOT NULL
      );
      CREATE INDEX idx_questions_topic ON practice_questions(topic_id);
      CREATE INDEX idx_questions_unit ON practice_questions(unit_id);
      CREATE TABLE topic_sounds (
        topic_id TEXT PRIMARY KEY REFERENCES skill_topics(topic_id),
        sound_pack_id TEXT,
        primary_sfx TEXT,
        on_interact TEXT,
        on_correct TEXT,
        on_gentle_retry TEXT,
        on_streak_combo TEXT,
        on_speed_target_beat TEXT
      );
      CREATE TABLE topic_narration (
        topic_id TEXT PRIMARY KEY REFERENCES skill_topics(topic_id),
        narration_json TEXT NOT NULL
      );
    `);

    db.prepare(
      "INSERT INTO pack_info (id, pack_format_version, pack_schema_version, grade_id, grade_name, content_version, registry_version, unit_count, topic_count, question_count) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      meta.packFormatVersion,
      PACK_SCHEMA_VERSION,
      extracted.grade.grade_id,
      extracted.grade.grade_name,
      meta.contentVersion,
      meta.registryVersion,
      extracted.counts.unitCount,
      extracted.counts.topicCount,
      extracted.counts.questionCount,
    );
    insertRows(db, "grades", ["grade_id", "grade_name", "target_age_years", "sequence_order", "sr_growth_factor", "sr_max_interval_days", "sr_schedule_json"], [extracted.grade]);
    insertRows(db, "units", ["unit_id", "grade_id", "subject", "sequence_order", "title", "prerequisite_unit_ids_json", "gate_question_count", "gate_min_accuracy_pct", "gate_max_speed_sec", "gate_streak_req", "study_materials_json", "games_json"], extracted.units);
    insertRows(db, "skill_topics", ["topic_id", "unit_id", "grade_id", "subject", "topic_code", "topic_name", "sequence_order", "assets_json"], extracted.topics);
    insertRows(db, "practice_questions", ["question_id", "topic_id", "unit_id", "topic_code", "topic_name", "difficulty_level", "interaction_type", "prompt", "visual_aid_svg", "visual_objects", "target_count", "max_counter_cells", "counter_emoji", "tile_bank_json", "choices_json", "correct_answer", "misconception_tags_json", "explanation"], extracted.questions);
    insertRows(db, "topic_sounds", ["topic_id", "sound_pack_id", "primary_sfx", "on_interact", "on_correct", "on_gentle_retry", "on_streak_combo", "on_speed_target_beat"], extracted.sounds);
    insertRows(db, "topic_narration", ["topic_id", "narration_json"], extracted.narration);
    db.exec("COMMIT");

    // Canonical page layout: identical logical content always compacts to
    // identical bytes regardless of any intermediate freelist state.
    db.exec("VACUUM");
  } finally {
    db.close();
  }
}

/** Read pack_info back from a written artifact (used by build self-check). */
export function readPackInfo(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT pack_format_version, pack_schema_version, grade_id, content_version, registry_version, unit_count, topic_count, question_count FROM pack_info WHERE id = 1").get();
    const counts = {
      units: db.prepare("SELECT COUNT(*) AS n FROM units").get().n,
      topics: db.prepare("SELECT COUNT(*) AS n FROM skill_topics").get().n,
      questions: db.prepare("SELECT COUNT(*) AS n FROM practice_questions").get().n,
    };
    return { ...row, counts };
  } finally {
    db.close();
  }
}
