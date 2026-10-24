/**
 * Offline practice test environment (issue #47).
 *
 * Builds, on REAL SQLite (node:sqlite — same DDL engine expo-sqlite
 * uses), everything the practice core needs to run a full offline
 * session with zero network and zero React Native:
 *
 * - a lifecycle database (schema.ts migrations v1+v2, attempt_log /
 *   topic_progress / unit_progress / pack_meta) with a
 *   PracticeStorage adapter speaking the exact SQL of
 *   nativePractice.ts;
 * - a #46-shaped pack fixture (compiler column contract) with a
 *   query_only PackContentReader adapter;
 * - a deterministic deps bundle (injected clock + session ids) for the
 *   PracticeSessionEngine.
 */
// eslint-disable-next-line import/no-unresolved
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONTENT_DB_MIGRATIONS, CONTENT_DB_NAME } from "../../src/content/schema";
import type {
  AttemptInput,
  GradeSrPolicy,
  PackContentReader,
  PackQuestionRow,
  PackTopicRow,
  PackUnitRow,
  PracticeDeps,
  PracticeStorage,
  TopicProgressRecord,
  UnitProgressRecord,
} from "../../src/practice/types";

export interface FakeClock {
  nowMs: number;
  advance(ms: number): void;
}

export const MS_HOUR = 3_600_000;

// ----------------------------------------------------------------------
// Lifecycle database + storage adapter (mirrors nativePractice.ts SQL)
// ----------------------------------------------------------------------

export function runMigrations(db: DatabaseSync): void {
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version;
  let at = current;
  for (const migration of CONTENT_DB_MIGRATIONS) {
    if (migration.version <= at) continue;
    for (const statement of migration.statements) db.exec(statement);
    db.exec(`PRAGMA user_version = ${migration.version}`);
    at = migration.version;
  }
}

const TOPIC_COLUMNS =
  "student_id, topic_id, unit_id, completed, crowns, mastery_score, best_accuracy_pct, best_median_speed_sec, attempts_count, updated_at, topic_code, fluency_grade, stability_days, next_review_at, last_reviewed_at, provisional";

const UNIT_COLUMNS =
  "student_id, unit_id, status, key_state, best_accuracy_pct, attempts_count, updated_at, best_median_speed_sec, stability_days, last_reviewed_at, cpa_stage, provisional, silver_awarded_at, gold_verified_at";

export class NodePracticeStorage implements PracticeStorage {
  readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async drainUnsynced(studentId: string, limit: number) {
    return this.db
      .prepare(
        `SELECT id, student_id, topic_id, question_id, interaction_type, is_correct,
                  cognitive_time_sec, audio_duration_sec, answered_at, synced,
                  unit_id, session_type, session_id, raw_time_sec, fluency_grade,
                  misconception_tags_json, chosen_answer, motor_baseline_sec
           FROM attempt_log WHERE student_id = ? AND synced = 0 ORDER BY id ASC LIMIT ?`,
      )
      .all(studentId, limit) as unknown as import("../../src/sync/types").AttemptLogRow[];
  }

  async drainUnsyncedAfter(studentId: string, afterId: number, limit: number) {
    return this.db
      .prepare(
        `SELECT id, student_id, topic_id, question_id, interaction_type, is_correct,
                  cognitive_time_sec, audio_duration_sec, answered_at, synced,
                  unit_id, session_type, session_id, raw_time_sec, fluency_grade,
                  misconception_tags_json, chosen_answer, motor_baseline_sec
           FROM attempt_log WHERE student_id = ? AND synced = 0 AND id > ?
           ORDER BY id ASC LIMIT ?`,
      )
      .all(studentId, afterId, limit) as unknown as import("../../src/sync/types").AttemptLogRow[];
  }

  async markSyncedUpTo(studentId: string, seq: number): Promise<number> {
    const result = this.db
      .prepare("UPDATE attempt_log SET synced = 1 WHERE student_id = ? AND id <= ? AND synced = 0")
      .run(studentId, seq);
    return Number(result.changes);
  }

  async insertAttempt(input: AttemptInput, answeredAt: number): Promise<number> {
    const result = this.db
      .prepare(
        `INSERT INTO attempt_log (
           student_id, topic_id, question_id, interaction_type, is_correct,
           cognitive_time_sec, audio_duration_sec, answered_at, synced,
           unit_id, session_type, session_id, raw_time_sec, fluency_grade,
           misconception_tags_json, chosen_answer, motor_baseline_sec
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.studentId,
        input.topicId,
        input.questionId,
        input.interactionType,
        input.isCorrect ? 1 : 0,
        input.cognitiveTimeSec,
        input.audioDurationSec,
        answeredAt,
        input.unitId,
        input.sessionType,
        input.sessionId,
        input.rawTimeSec,
        input.fluencyGrade,
        JSON.stringify(input.misconceptionTags || []),
        input.chosenAnswer,
        input.motorBaselineSec,
      );
    return Number(result.lastInsertRowid);
  }

  async getTopicProgress(studentId: string, topicId: string) {
    const row = this.db
      .prepare(`SELECT ${TOPIC_COLUMNS} FROM topic_progress WHERE student_id = ? AND topic_id = ?`)
      .get(studentId, topicId) as unknown as TopicRecordRow | undefined;
    return row ? this.topicRecord(row) : null;
  }

  async allTopicProgress(studentId: string) {
    return (
      this.db
        .prepare(`SELECT ${TOPIC_COLUMNS} FROM topic_progress WHERE student_id = ?`)
        .all(studentId) as unknown as TopicRecordRow[]
    ).map((r) => this.topicRecord(r));
  }

  async upsertTopicProgress(record: TopicProgressRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO topic_progress (${TOPIC_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(student_id, topic_id) DO UPDATE SET
           completed = excluded.completed, crowns = excluded.crowns,
           mastery_score = excluded.mastery_score, best_accuracy_pct = excluded.best_accuracy_pct,
           best_median_speed_sec = excluded.best_median_speed_sec, attempts_count = excluded.attempts_count,
           updated_at = excluded.updated_at, topic_code = excluded.topic_code,
           fluency_grade = excluded.fluency_grade, stability_days = excluded.stability_days,
           next_review_at = excluded.next_review_at, last_reviewed_at = excluded.last_reviewed_at,
           provisional = excluded.provisional`,
      )
      .run(
        record.studentId,
        record.topicId,
        record.unitId,
        record.completed,
        record.crowns,
        record.masteryScore,
        record.bestAccuracyPct,
        record.bestMedianSpeedSec,
        record.attemptsCount,
        record.updatedAt,
        record.topicCode,
        record.fluencyGrade,
        record.stabilityDays,
        record.nextReviewAt,
        record.lastReviewedAt,
        record.provisional ? 1 : 0,
      );
  }

  async getUnitProgress(studentId: string, unitId: string) {
    const row = this.db
      .prepare(`SELECT ${UNIT_COLUMNS} FROM unit_progress WHERE student_id = ? AND unit_id = ?`)
      .get(studentId, unitId) as unknown as UnitRecordRow | undefined;
    return row ? this.unitRecord(row) : null;
  }

  async allUnitProgress(studentId: string) {
    return (
      this.db
        .prepare(
          `SELECT ${UNIT_COLUMNS} FROM unit_progress WHERE student_id = ? ORDER BY unit_id ASC`,
        )
        .all(studentId) as unknown as UnitRecordRow[]
    ).map((r) => this.unitRecord(r));
  }

  async upsertUnitProgress(record: UnitProgressRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO unit_progress (${UNIT_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(student_id, unit_id) DO UPDATE SET
           status = excluded.status, key_state = excluded.key_state,
           best_accuracy_pct = excluded.best_accuracy_pct, attempts_count = excluded.attempts_count,
           updated_at = excluded.updated_at, best_median_speed_sec = excluded.best_median_speed_sec,
           stability_days = excluded.stability_days, last_reviewed_at = excluded.last_reviewed_at,
           cpa_stage = excluded.cpa_stage, provisional = excluded.provisional,
           silver_awarded_at = excluded.silver_awarded_at, gold_verified_at = excluded.gold_verified_at`,
      )
      .run(
        record.studentId,
        record.unitId,
        record.status,
        record.keyState,
        record.bestAccuracyPct,
        record.attemptsCount,
        record.updatedAt,
        record.bestMedianSpeedSec,
        record.stabilityDays,
        record.lastReviewedAt,
        record.cpaStage,
        record.provisional ? 1 : 0,
        record.silverAwardedAt,
        record.goldVerifiedAt,
      );
  }

  async unsyncedAttemptCount(studentId: string) {
    const row = this.db
      .prepare("SELECT COUNT(*) AS cnt FROM attempt_log WHERE student_id = ? AND synced = 0")
      .get(studentId) as unknown as { cnt: number };
    return row.cnt;
  }

  async activePackArtifact(gradeId: string) {
    const row = this.db
      .prepare(
        "SELECT artifact FROM pack_meta WHERE grade_id = ? AND status = 'active' ORDER BY installed_at DESC LIMIT 1",
      )
      .get(gradeId) as unknown as { artifact: string } | undefined;
    return row?.artifact ?? null;
  }

  async activePackVersions() {
    const rows = this.db
      .prepare(
        "SELECT grade_id, content_version FROM pack_meta WHERE status = 'active' ORDER BY grade_id ASC",
      )
      .all() as unknown as { grade_id: string; content_version: string }[];
    return rows.map((row) => ({ gradeId: row.grade_id, contentVersion: row.content_version }));
  }

  private topicRecord(row: TopicRecordRow): TopicProgressRecord {
    return {
      studentId: row.student_id,
      topicId: row.topic_id,
      unitId: row.unit_id,
      topicCode: row.topic_code,
      completed: row.completed,
      crowns: row.crowns,
      masteryScore: row.mastery_score,
      bestAccuracyPct: row.best_accuracy_pct,
      bestMedianSpeedSec: row.best_median_speed_sec,
      attemptsCount: row.attempts_count,
      fluencyGrade: row.fluency_grade,
      stabilityDays: row.stability_days,
      nextReviewAt: row.next_review_at,
      lastReviewedAt: row.last_reviewed_at,
      provisional: row.provisional === 1,
      updatedAt: row.updated_at,
    };
  }

  private unitRecord(row: UnitRecordRow): UnitProgressRecord {
    return {
      studentId: row.student_id,
      unitId: row.unit_id,
      status: row.status,
      keyState:
        row.key_state === "SILVER_KEY" || row.key_state === "GOLD_KEY" ? row.key_state : null,
      bestAccuracyPct: row.best_accuracy_pct,
      bestMedianSpeedSec: row.best_median_speed_sec,
      attemptsCount: row.attempts_count,
      stabilityDays: row.stability_days,
      lastReviewedAt: row.last_reviewed_at,
      cpaStage: row.cpa_stage,
      provisional: row.provisional === 1,
      silverAwardedAt: row.silver_awarded_at,
      goldVerifiedAt: row.gold_verified_at,
      updatedAt: row.updated_at,
    };
  }
}

interface TopicRecordRow {
  student_id: string;
  topic_id: string;
  unit_id: string;
  completed: number;
  crowns: number;
  mastery_score: number;
  best_accuracy_pct: number;
  best_median_speed_sec: number;
  attempts_count: number;
  updated_at: number;
  topic_code: string;
  fluency_grade: number;
  stability_days: number;
  next_review_at: number;
  last_reviewed_at: number;
  provisional: number;
}

interface UnitRecordRow {
  student_id: string;
  unit_id: string;
  status: string;
  key_state: string | null;
  best_accuracy_pct: number;
  attempts_count: number;
  updated_at: number;
  best_median_speed_sec: number;
  stability_days: number;
  last_reviewed_at: number;
  cpa_stage: string;
  provisional: number;
  silver_awarded_at: number;
  gold_verified_at: number;
}

// ----------------------------------------------------------------------
// Pack fixture (compiler column contract, tools/content-pipeline packDb)
// ----------------------------------------------------------------------

export const FIXTURE_GRADE: GradeSrPolicy = {
  gradeId: "kindergarten",
  srGrowthFactor: 1.85,
  srMaxIntervalDays: 30,
  baseScheduleDays: [1, 2, 4, 8, 15, 30],
};

export const FIXTURE_UNIT = {
  unitId: "K-M2",
  gradeId: "kindergarten",
  subject: "math",
  title: "Numbers to 10",
  gateQuestionCount: 6,
  gateMinAccuracyPct: 80,
  gateMaxSpeedSec: 6,
  gateStreakReq: 4,
};

export const FIXTURE_TOPICS = [
  { code: "G", name: "Counting to 10" },
  { code: "H", name: "Comparing Numbers" },
  { code: "I", name: "Number Order" },
] as const;

const PACK_DDL = `
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
    grade_id TEXT NOT NULL,
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
  CREATE TABLE skill_topics (
    topic_id TEXT PRIMARY KEY,
    unit_id TEXT NOT NULL,
    grade_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    topic_code TEXT NOT NULL,
    topic_name TEXT NOT NULL,
    sequence_order INTEGER NOT NULL,
    assets_json TEXT NOT NULL
  );
  CREATE TABLE practice_questions (
    question_id TEXT PRIMARY KEY,
    topic_id TEXT NOT NULL,
    unit_id TEXT NOT NULL,
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
`;

/** Builds a pack fixture file with 10 questions per topic (compiler difficulty spread). */
export function buildPackFixture(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(PACK_DDL);
  db.prepare(
    "INSERT INTO pack_info (id, pack_format_version, pack_schema_version, grade_id, grade_name, content_version, registry_version, unit_count, topic_count, question_count) VALUES (1, 1, 1, ?, 'Kindergarten', '1.0.0', '1.0.0', 1, ?, ?)",
  ).run(FIXTURE_GRADE.gradeId, FIXTURE_TOPICS.length, FIXTURE_TOPICS.length * 10);
  db.prepare("INSERT INTO grades VALUES (?, 'Kindergarten', '5', 2, ?, ?, ?)").run(
    FIXTURE_GRADE.gradeId,
    FIXTURE_GRADE.srGrowthFactor,
    FIXTURE_GRADE.srMaxIntervalDays,
    JSON.stringify(FIXTURE_GRADE.baseScheduleDays),
  );
  db.prepare("INSERT INTO units VALUES (?, ?, 'math', 1, ?, '[]', ?, ?, ?, ?, '[]', '[]')").run(
    FIXTURE_UNIT.unitId,
    FIXTURE_UNIT.gradeId,
    FIXTURE_UNIT.title,
    FIXTURE_UNIT.gateQuestionCount,
    FIXTURE_UNIT.gateMinAccuracyPct,
    FIXTURE_UNIT.gateMaxSpeedSec,
    FIXTURE_UNIT.gateStreakReq,
  );
  let questionCount = 0;
  FIXTURE_TOPICS.forEach((topic, tIdx) => {
    const topicId = `${FIXTURE_UNIT.unitId}-${topic.code}`;
    db.prepare("INSERT INTO skill_topics VALUES (?, ?, ?, 'math', ?, ?, ?, '[]')").run(
      topicId,
      FIXTURE_UNIT.unitId,
      FIXTURE_GRADE.gradeId,
      topic.code,
      topic.name,
      tIdx + 1,
    );
    for (let n = 1; n <= 10; n += 1) {
      const difficulty = n <= 3 ? 1 : n <= 7 ? 2 : 3;
      db.prepare(
        `INSERT INTO practice_questions VALUES (?, ?, ?, ?, ?, ?, 'multiple-choice', ?, 'assets/images/ten_frame_and_number_line.svg', NULL, NULL, NULL, NULL, NULL, ?, ?, '[]', '')`,
      ).run(
        `${topicId}-Q${n}`,
        topicId,
        FIXTURE_UNIT.unitId,
        topic.code,
        topic.name,
        difficulty,
        `Fixture prompt ${topic.code} ${n}`,
        JSON.stringify(["1", "2", "3"]),
        String(n),
      );
      questionCount += 1;
    }
  });
  void questionCount;
  db.close();
}

/** query_only reader adapter over the fixture pack (mirrors nativePractice.ts). */
export function openPackReader(file: string): PackContentReader & { close(): void } {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA query_only = ON");
  return {
    async gradePolicy(gradeId: string) {
      const row = db
        .prepare(
          "SELECT grade_id, sr_growth_factor, sr_max_interval_days, sr_schedule_json FROM grades WHERE grade_id = ?",
        )
        .get(gradeId) as unknown as
        | {
            grade_id: string;
            sr_growth_factor: number;
            sr_max_interval_days: number;
            sr_schedule_json: string;
          }
        | undefined;
      return row
        ? {
            gradeId: row.grade_id,
            srGrowthFactor: row.sr_growth_factor,
            srMaxIntervalDays: row.sr_max_interval_days,
            baseScheduleDays: JSON.parse(row.sr_schedule_json || "[]") as number[],
          }
        : null;
    },
    async unit(unitId: string) {
      return (
        (db
          .prepare(
            `SELECT unit_id, grade_id, subject, sequence_order, title, prerequisite_unit_ids_json, gate_question_count, gate_min_accuracy_pct, gate_max_speed_sec, gate_streak_req FROM units WHERE unit_id = ?`,
          )
          .get(unitId) as unknown as PackUnitRow | undefined) ?? null
      );
    },
    async unitsForGrade(gradeId: string) {
      return db
        .prepare(
          `SELECT unit_id, grade_id, subject, sequence_order, title, prerequisite_unit_ids_json, gate_question_count, gate_min_accuracy_pct, gate_max_speed_sec, gate_streak_req FROM units WHERE grade_id = ? ORDER BY subject ASC, sequence_order ASC, unit_id ASC`,
        )
        .all(gradeId) as unknown as PackUnitRow[];
    },
    async topicsForUnit(unitId: string) {
      return db
        .prepare(
          `SELECT topic_id, unit_id, grade_id, subject, topic_code, topic_name, sequence_order, assets_json FROM skill_topics WHERE unit_id = ? ORDER BY sequence_order ASC`,
        )
        .all(unitId) as unknown as PackTopicRow[];
    },
    async topicsForGrade(gradeId: string) {
      return db
        .prepare(
          `SELECT topic_id, unit_id, grade_id, subject, topic_code, topic_name, sequence_order, assets_json FROM skill_topics WHERE grade_id = ? ORDER BY subject ASC, unit_id ASC, sequence_order ASC`,
        )
        .all(gradeId) as unknown as PackTopicRow[];
    },
    async topic(topicId: string) {
      return (
        (db
          .prepare(
            `SELECT topic_id, unit_id, grade_id, subject, topic_code, topic_name, sequence_order, assets_json FROM skill_topics WHERE topic_id = ?`,
          )
          .get(topicId) as unknown as PackTopicRow | undefined) ?? null
      );
    },
    async questionsForTopic(topicId: string, count: number) {
      return db
        .prepare(
          `SELECT question_id, topic_id, unit_id, topic_code, topic_name, difficulty_level, interaction_type, prompt, visual_aid_svg, visual_objects, target_count, max_counter_cells, counter_emoji, tile_bank_json, choices_json, correct_answer, misconception_tags_json, explanation FROM practice_questions WHERE topic_id = ? ORDER BY difficulty_level ASC, question_id ASC LIMIT ?`,
        )
        .all(topicId, count) as unknown as PackQuestionRow[];
    },
    async questionsForUnit(unitId: string) {
      return db
        .prepare(
          `SELECT question_id, topic_id, unit_id, topic_code, topic_name, difficulty_level, interaction_type, prompt, visual_aid_svg, visual_objects, target_count, max_counter_cells, counter_emoji, tile_bank_json, choices_json, correct_answer, misconception_tags_json, explanation FROM practice_questions WHERE unit_id = ? ORDER BY question_id ASC`,
        )
        .all(unitId) as unknown as PackQuestionRow[];
    },
    close() {
      db.close();
    },
  };
}

// ----------------------------------------------------------------------
// Assembled environment
// ----------------------------------------------------------------------

export interface PracticeTestEnv {
  storage: NodePracticeStorage;
  deps: PracticeDeps;
  clock: FakeClock;
  dir: string;
  dispose(): void;
}

export function createPracticeEnv(options?: { packFileName?: string }): PracticeTestEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "practice-env-"));
  const lifecycle = new DatabaseSync(path.join(dir, CONTENT_DB_NAME));
  runMigrations(lifecycle);
  const storage = new NodePracticeStorage(lifecycle);

  const packFile = path.join(dir, options?.packFileName ?? "pack-kindergarten-v1.0.0.sqlite");
  buildPackFixture(packFile);
  // Register the pack as installed+active, as the #46 service would.
  lifecycle
    .prepare(
      "INSERT INTO pack_meta (grade_id, content_version, format_version, status, artifact, size_bytes, sha256, key_id, installed_at) VALUES (?, '1.0.0', 1, 'active', ?, 1024, ?, 'test', 1)",
    )
    .run(FIXTURE_GRADE.gradeId, path.basename(packFile), "b".repeat(64));

  const clock: FakeClock = {
    nowMs: 1_700_000_000_000,
    advance(ms: number) {
      this.nowMs += ms;
    },
  };
  let sessionCounter = 0;
  const readers = new Map<string, ReturnType<typeof openPackReader>>();
  const deps: PracticeDeps = {
    storage,
    async openContent(gradeId) {
      const artifact = await storage.activePackArtifact(gradeId);
      if (!artifact) return null;
      let reader = readers.get(artifact);
      if (!reader) {
        reader = openPackReader(path.join(dir, artifact));
        readers.set(artifact, reader);
      }
      return reader;
    },
    now: () => clock.nowMs,
    newSessionId: () => `sess-${(sessionCounter += 1)}`,
    motorBaselineSec: 0.42,
  };

  return {
    storage,
    deps,
    clock,
    dir,
    dispose() {
      lifecycle.close();
      for (const reader of readers.values()) reader.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
