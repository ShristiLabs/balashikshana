/**
 * React-native practice bindings (issue #47).
 *
 * The ONLY module in the practice tree that imports native modules
 * (expo-sqlite); every other module stays node-testable. Platform
 * decisions:
 *
 * - The lifecycle database is the SAME balashikshana_content.db the
 *   content-pack service owns (expo-sqlite pools connections per file
 *   name); practice writes run through the schema-v2 migration.
 * - Pack artifacts open with PRAGMA query_only = ON and are cached per
 *   artifact file: a session reuses one reader; a pack swap (new
 *   content version) naturally opens the new file under a new key.
 * - attempt_log is written INSERT-only (append-only contract; the
 *   synced flag is #48's to flip).
 * - Progress upserts write the projector-computed FULL row (the
 *   projector owns the GREATEST/LEAST merge semantics; the app is a
 *   single JS-thread writer, so read-merge-write is sequential).
 */
import * as SQLite from "expo-sqlite";
import { reminderSettingsProblem } from "@balashikshana/core-engine";
import { CONTENT_DB_NAME, CONTENT_DB_MIGRATIONS } from "../content/schema";
import { contentPackDirectory } from "../content/nativeContent";
import type { AttemptLogRow, SyncStorage } from "../sync/types";
import type { GamificationState } from "../gamification/types";
import type { GamificationStorage } from "../gamification/storage";
import type { ReminderSettingsStorage } from "../notifications/reminderSettings";
import type {
  AttemptInput,
  GradeSrPolicy,
  PackContentReader,
  PackQuestionRow,
  PackTopicRow,
  PackUnitRow,
  PracticeDeps,
  PracticeStorage,
  SessionOutcomeInput,
  SessionOutcomeRecord,
  SessionType,
  TopicProgressRecord,
  UnitProgressRecord,
} from "./types";
import { DEFAULT_MOTOR_BASELINE_SEC } from "./practiceEngine";

// ----------------------------------------------------------------------
// Lifecycle database (attempt log + progress projection)
// ----------------------------------------------------------------------

type TopicProgressSqlRow = {
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
};

type UnitProgressSqlRow = {
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
};

const TOPIC_COLUMNS =
  "student_id, topic_id, unit_id, completed, crowns, mastery_score, best_accuracy_pct, best_median_speed_sec, attempts_count, updated_at, topic_code, fluency_grade, stability_days, next_review_at, last_reviewed_at, provisional";

const UNIT_COLUMNS =
  "student_id, unit_id, status, key_state, best_accuracy_pct, attempts_count, updated_at, best_median_speed_sec, stability_days, last_reviewed_at, cpa_stage, provisional, silver_awarded_at, gold_verified_at";

function topicRowToRecord(row: TopicProgressSqlRow): TopicProgressRecord {
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

function unitRowToRecord(row: UnitProgressSqlRow): UnitProgressRecord {
  return {
    studentId: row.student_id,
    unitId: row.unit_id,
    status: row.status,
    keyState: row.key_state === "SILVER_KEY" || row.key_state === "GOLD_KEY" ? row.key_state : null,
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

async function migrateContentDb(db: SQLite.SQLiteDatabase): Promise<void> {
  const rows = await db.getAllAsync<{ user_version: number }>("PRAGMA user_version");
  let current = rows[0]?.user_version ?? 0;
  for (const migration of CONTENT_DB_MIGRATIONS) {
    if (migration.version <= current) continue;
    for (const statement of migration.statements) {
      await db.execAsync(statement);
    }
    await db.execAsync(`PRAGMA user_version = ${migration.version}`);
    current = migration.version;
  }
}

let contentDbStore: Promise<SQLite.SQLiteDatabase> | null = null;

function lifecycleDb(): Promise<SQLite.SQLiteDatabase> {
  contentDbStore ??= (async () => {
    const db = await SQLite.openDatabaseAsync(CONTENT_DB_NAME);
    await migrateContentDb(db);
    return db;
  })();
  return contentDbStore;
}

function createStorage(): SyncStorage {
  return {
    async insertAttempt(input: AttemptInput, answeredAt: number): Promise<number> {
      const db = await lifecycleDb();
      const result = await db.runAsync(
        `INSERT INTO attempt_log (
           student_id, topic_id, question_id, interaction_type, is_correct,
           cognitive_time_sec, audio_duration_sec, answered_at, synced,
           unit_id, session_type, session_id, raw_time_sec, fluency_grade,
           misconception_tags_json, chosen_answer, motor_baseline_sec,
           game_spiral_provenance, game_target_speed_sec, game_archetype, game_fallback
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
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
          input.gameTelemetry?.spiralProvenance ?? "",
          input.gameTelemetry?.targetResponseSpeedSec ?? 0,
          input.gameTelemetry?.archetype ?? "",
          input.gameTelemetry?.fallback ? 1 : 0,
        ],
      );
      return Number(result.lastInsertRowId);
    },

    async insertSessionOutcome(input: SessionOutcomeInput): Promise<number> {
      const db = await lifecycleDb();
      // #56 append-only hearts session outcome (one row per hearts
      // session; synced stays 0 — only the #48 sync worker flips it,
      // the same documented exception as attempt_log).
      const result = await db.runAsync(
        `INSERT INTO session_outcomes (
           student_id, session_id, session_type, stage,
           hearts_lost, hearts_remaining, end_reason, ended_at, synced
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [
          input.studentId,
          input.sessionId,
          input.sessionType,
          input.stage,
          input.heartsLost,
          input.heartsRemaining,
          input.endReason,
          input.endedAt,
        ],
      );
      return Number(result.lastInsertRowId);
    },

    async drainUnsynced(studentId, limit): Promise<AttemptLogRow[]> {
      const db = await lifecycleDb();
      // The ONLY read the sync worker needs: unsynced rows in id order
      // (idx_attempt_log_drain), capped at the batch size.
      return db.getAllAsync<AttemptLogRow>(
        `SELECT id, student_id, topic_id, question_id, interaction_type, is_correct,
                cognitive_time_sec, audio_duration_sec, answered_at, synced,
                unit_id, session_type, session_id, raw_time_sec, fluency_grade,
                misconception_tags_json, chosen_answer, motor_baseline_sec
         FROM attempt_log WHERE student_id = ? AND synced = 0 ORDER BY id ASC LIMIT ?`,
        [studentId, limit],
      );
    },

    async drainUnsyncedAfter(studentId, afterId, limit): Promise<AttemptLogRow[]> {
      const db = await lifecycleDb();
      // Beyond-window probe for whole-session batching: unsynced rows
      // strictly past the drain window's last id, on the same
      // idx_attempt_log_drain(student_id, id) index. A cursor, never a
      // re-read of the window (#48 review finding 1).
      return db.getAllAsync<AttemptLogRow>(
        `SELECT id, student_id, topic_id, question_id, interaction_type, is_correct,
                cognitive_time_sec, audio_duration_sec, answered_at, synced,
                unit_id, session_type, session_id, raw_time_sec, fluency_grade,
                misconception_tags_json, chosen_answer, motor_baseline_sec
         FROM attempt_log WHERE student_id = ? AND synced = 0 AND id > ?
         ORDER BY id ASC LIMIT ?`,
        [studentId, afterId, limit],
      );
    },

    async markSyncedUpTo(studentId, seq): Promise<number> {
      const db = await lifecycleDb();
      // THE ONLY mutation permitted on attempt_log anywhere in the app:
      // the synced-flag flip, after the server snapshot is durably
      // applied (append-only contract's documented #48 exception; the
      // source-scan test pins this exact statement shape).
      const result = await db.runAsync(
        "UPDATE attempt_log SET synced = 1 WHERE student_id = ? AND id <= ? AND synced = 0",
        [studentId, seq],
      );
      return Number(result.changes ?? 0);
    },

    async drainUnsyncedOutcomes(studentId, limit): Promise<SessionOutcomeRecord[]> {
      const db = await lifecycleDb();
      // #56 sync-worker read: unsynced hearts session outcomes in id
      // order (idx_session_outcomes_drain), capped. Outcomes are only
      // written at session close, so whole-session batching never
      // applies — an outcome row exists exactly when its session ended.
      const rows = await db.getAllAsync<{
        id: number;
        student_id: string;
        session_id: string;
        session_type: string;
        stage: string;
        hearts_lost: number;
        hearts_remaining: number;
        end_reason: string;
        ended_at: number;
        synced: number;
      }>(
        `SELECT id, student_id, session_id, session_type, stage,
                hearts_lost, hearts_remaining, end_reason, ended_at, synced
         FROM session_outcomes WHERE student_id = ? AND synced = 0 ORDER BY id ASC LIMIT ?`,
        [studentId, limit],
      );
      return rows.map((row) => ({
        id: row.id,
        studentId: row.student_id,
        sessionId: row.session_id,
        sessionType: row.session_type as SessionOutcomeRecord["sessionType"],
        stage: row.stage as SessionOutcomeRecord["stage"],
        heartsLost: row.hearts_lost,
        heartsRemaining: row.hearts_remaining,
        endReason: row.end_reason as SessionOutcomeRecord["endReason"],
        endedAt: row.ended_at,
        synced: row.synced === 1 ? 1 : 0,
      }));
    },

    async markOutcomesSynced(studentId, ids): Promise<number> {
      const db = await lifecycleDb();
      if (ids.length === 0) return 0;
      // THE ONLY mutation permitted on session_outcomes anywhere in the
      // app: the synced-flag flip by explicit acked ids, after the
      // server response is durably applied (the same documented #48
      // exception as attempt_log; the source-scan test pins this exact
      // statement shape).
      const placeholders = ids.map(() => "?").join(", ");
      const result = await db.runAsync(
        `UPDATE session_outcomes SET synced = 1 WHERE student_id = ? AND id IN (${placeholders}) AND synced = 0`,
        [studentId, ...ids],
      );
      return Number(result.changes ?? 0);
    },

    async getTopicProgress(studentId, topicId) {
      const db = await lifecycleDb();
      const rows = await db.getAllAsync<TopicProgressSqlRow>(
        `SELECT ${TOPIC_COLUMNS} FROM topic_progress WHERE student_id = ? AND topic_id = ?`,
        [studentId, topicId],
      );
      return rows[0] ? topicRowToRecord(rows[0]) : null;
    },

    async upsertTopicProgress(record: TopicProgressRecord): Promise<void> {
      const db = await lifecycleDb();
      await db.runAsync(
        `INSERT INTO topic_progress (${TOPIC_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(student_id, topic_id) DO UPDATE SET
           completed = excluded.completed,
           crowns = excluded.crowns,
           mastery_score = excluded.mastery_score,
           best_accuracy_pct = excluded.best_accuracy_pct,
           best_median_speed_sec = excluded.best_median_speed_sec,
           attempts_count = excluded.attempts_count,
           updated_at = excluded.updated_at,
           topic_code = excluded.topic_code,
           fluency_grade = excluded.fluency_grade,
           stability_days = excluded.stability_days,
           next_review_at = excluded.next_review_at,
           last_reviewed_at = excluded.last_reviewed_at,
           provisional = excluded.provisional`,
        [
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
        ],
      );
    },

    async allTopicProgress(studentId) {
      const db = await lifecycleDb();
      const rows = await db.getAllAsync<TopicProgressSqlRow>(
        `SELECT ${TOPIC_COLUMNS} FROM topic_progress WHERE student_id = ?`,
        [studentId],
      );
      return rows.map(topicRowToRecord);
    },

    async getUnitProgress(studentId, unitId) {
      const db = await lifecycleDb();
      const rows = await db.getAllAsync<UnitProgressSqlRow>(
        `SELECT ${UNIT_COLUMNS} FROM unit_progress WHERE student_id = ? AND unit_id = ?`,
        [studentId, unitId],
      );
      return rows[0] ? unitRowToRecord(rows[0]) : null;
    },

    async allUnitProgress(studentId) {
      const db = await lifecycleDb();
      const rows = await db.getAllAsync<UnitProgressSqlRow>(
        `SELECT ${UNIT_COLUMNS} FROM unit_progress WHERE student_id = ? ORDER BY unit_id ASC`,
        [studentId],
      );
      return rows.map(unitRowToRecord);
    },

    async upsertUnitProgress(record: UnitProgressRecord): Promise<void> {
      const db = await lifecycleDb();
      await db.runAsync(
        `INSERT INTO unit_progress (${UNIT_COLUMNS})
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(student_id, unit_id) DO UPDATE SET
           status = excluded.status,
           key_state = excluded.key_state,
           best_accuracy_pct = excluded.best_accuracy_pct,
           attempts_count = excluded.attempts_count,
           updated_at = excluded.updated_at,
           best_median_speed_sec = excluded.best_median_speed_sec,
           stability_days = excluded.stability_days,
           last_reviewed_at = excluded.last_reviewed_at,
           cpa_stage = excluded.cpa_stage,
           provisional = excluded.provisional,
           silver_awarded_at = excluded.silver_awarded_at,
           gold_verified_at = excluded.gold_verified_at`,
        [
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
        ],
      );
    },

    async unsyncedAttemptCount(studentId) {
      const db = await lifecycleDb();
      const rows = await db.getAllAsync<{ cnt: number }>(
        "SELECT COUNT(*) AS cnt FROM attempt_log WHERE student_id = ? AND synced = 0",
        [studentId],
      );
      return rows[0]?.cnt ?? 0;
    },

    async activePackArtifact(gradeId) {
      const db = await lifecycleDb();
      const rows = await db.getAllAsync<{ artifact: string }>(
        "SELECT artifact FROM pack_meta WHERE grade_id = ? AND status = 'active' ORDER BY installed_at DESC LIMIT 1",
        [gradeId],
      );
      return rows[0]?.artifact ?? null;
    },

    async activePackVersions() {
      const db = await lifecycleDb();
      const rows = await db.getAllAsync<{ grade_id: string; content_version: string }>(
        "SELECT grade_id, content_version FROM pack_meta WHERE status = 'active' ORDER BY grade_id ASC",
      );
      return rows.map((row) => ({ gradeId: row.grade_id, contentVersion: row.content_version }));
    },
  };
}

// ----------------------------------------------------------------------
// Gamification storage (issue #55, schema v5) — same lifecycle database,
// same single-writer model. The row is the OPTIMISTIC local projection
// (provisional until the #48 snapshot / ledger endpoint confirms).
// ----------------------------------------------------------------------

type GamificationSqlRow = {
  student_id: string;
  total_xp: number;
  star_coins: number;
  streak_days: number;
  last_active_day_key: string;
  best_beat_target_pct: number;
  sessions_completed: number;
  earned_badges_json: string;
  provisional: number;
  updated_at: number;
};

function gamificationRowToState(row: GamificationSqlRow): GamificationState {
  let earnedBadges: string[] = [];
  try {
    const parsed = JSON.parse(row.earned_badges_json || "[]") as unknown;
    if (Array.isArray(parsed))
      earnedBadges = parsed.filter((b): b is string => typeof b === "string");
  } catch {
    earnedBadges = [];
  }
  return {
    studentId: row.student_id,
    totalXp: row.total_xp,
    starCoins: row.star_coins,
    streakDays: row.streak_days,
    lastActiveDayKey: row.last_active_day_key,
    bestBeatTargetPct: row.best_beat_target_pct,
    sessionsCompleted: row.sessions_completed,
    earnedBadges,
    provisional: row.provisional === 1,
    updatedAt: row.updated_at,
  };
}

function createGamificationStorage(): GamificationStorage {
  return {
    async getGamificationState(studentId) {
      const db = await lifecycleDb();
      const rows = await db.getAllAsync<GamificationSqlRow>(
        `SELECT student_id, total_xp, star_coins, streak_days, last_active_day_key,
                best_beat_target_pct, sessions_completed, earned_badges_json, provisional, updated_at
         FROM gamification_state WHERE student_id = ?`,
        [studentId],
      );
      return rows[0] ? gamificationRowToState(rows[0]) : null;
    },

    async upsertGamificationState(state) {
      const db = await lifecycleDb();
      await db.runAsync(
        `INSERT INTO gamification_state (
           student_id, total_xp, star_coins, streak_days, last_active_day_key,
           best_beat_target_pct, sessions_completed, earned_badges_json, provisional, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(student_id) DO UPDATE SET
           total_xp = excluded.total_xp,
           star_coins = excluded.star_coins,
           streak_days = excluded.streak_days,
           last_active_day_key = excluded.last_active_day_key,
           best_beat_target_pct = excluded.best_beat_target_pct,
           sessions_completed = excluded.sessions_completed,
           earned_badges_json = excluded.earned_badges_json,
           provisional = excluded.provisional,
           updated_at = excluded.updated_at`,
        [
          state.studentId,
          state.totalXp,
          state.starCoins,
          state.streakDays,
          state.lastActiveDayKey,
          state.bestBeatTargetPct,
          state.sessionsCompleted,
          JSON.stringify(state.earnedBadges),
          state.provisional ? 1 : 0,
          state.updatedAt,
        ],
      );
    },

    async playedUnitIds(studentId, sessionType: SessionType) {
      const db = await lifecycleDb();
      const rows = await db.getAllAsync<{ unit_id: string }>(
        "SELECT DISTINCT unit_id FROM attempt_log WHERE student_id = ? AND session_type = ? AND unit_id <> ''",
        [studentId, sessionType],
      );
      return rows.map((row) => row.unit_id);
    },
  };
}

// ----------------------------------------------------------------------
// Reminder settings storage (#57 — device-local parent settings, v7)
// ----------------------------------------------------------------------

interface ReminderSqlRow {
  enabled: number;
  hour: number;
  minute: number;
  updated_at: number;
}

function createReminderSettingsStorage(): ReminderSettingsStorage {
  return {
    async getReminderSettings() {
      const db = await lifecycleDb();
      const rows = await db.getAllAsync<ReminderSqlRow>(
        "SELECT enabled, hour, minute, updated_at FROM reminder_settings WHERE id = 1",
      );
      const row = rows[0];
      if (!row) return null;
      return {
        enabled: row.enabled === 1,
        hour: row.hour,
        minute: row.minute,
        updatedAt: row.updated_at,
      };
    },

    async upsertReminderSettings(settings, nowMs) {
      // The engine rule gate: a corrupt row can never reach the DB.
      if (reminderSettingsProblem(settings)) {
        throw new Error(`invalid reminder settings: ${String(reminderSettingsProblem(settings))}`);
      }
      const db = await lifecycleDb();
      await db.runAsync(
        `INSERT INTO reminder_settings (id, enabled, hour, minute, updated_at)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           enabled = excluded.enabled,
           hour = excluded.hour,
           minute = excluded.minute,
           updated_at = excluded.updated_at`,
        [settings.enabled ? 1 : 0, settings.hour, settings.minute, nowMs],
      );
    },
  };
}

/** #57 seam: the device-local reminder settings storage (parent surface + bootstrap). */
export function getNativeReminderSettingsStorage(): ReminderSettingsStorage {
  return createReminderSettingsStorage();
}

// ----------------------------------------------------------------------
// Query-only pack reader
// ----------------------------------------------------------------------

const readerCache = new Map<string, Promise<PackContentReader>>();

async function openPackReader(artifact: string): Promise<PackContentReader> {
  const dir = contentPackDirectory();
  const db = await SQLite.openDatabaseAsync(artifact, { useNewConnection: true }, dir.uri);
  await db.execAsync("PRAGMA query_only = ON");
  return {
    async gradePolicy(gradeId): Promise<GradeSrPolicy | null> {
      const rows = await db.getAllAsync<{
        grade_id: string;
        sr_growth_factor: number;
        sr_max_interval_days: number;
        sr_schedule_json: string;
      }>(
        "SELECT grade_id, sr_growth_factor, sr_max_interval_days, sr_schedule_json FROM grades WHERE grade_id = ?",
        [gradeId],
      );
      const row = rows[0];
      if (!row) return null;
      let baseScheduleDays: number[] = [];
      try {
        const parsed = JSON.parse(row.sr_schedule_json || "[]") as unknown;
        if (Array.isArray(parsed)) baseScheduleDays = parsed as number[];
      } catch {
        baseScheduleDays = [];
      }
      return {
        gradeId: row.grade_id,
        srGrowthFactor: row.sr_growth_factor,
        srMaxIntervalDays: row.sr_max_interval_days,
        baseScheduleDays,
      };
    },
    async unit(unitId): Promise<PackUnitRow | null> {
      const rows = await db.getAllAsync<PackUnitRow>(
        `SELECT unit_id, grade_id, subject, sequence_order, title, prerequisite_unit_ids_json,
                gate_question_count, gate_min_accuracy_pct, gate_max_speed_sec, gate_streak_req
         FROM units WHERE unit_id = ?`,
        [unitId],
      );
      return rows[0] ?? null;
    },
    async unitsForGrade(gradeId): Promise<PackUnitRow[]> {
      return db.getAllAsync<PackUnitRow>(
        `SELECT unit_id, grade_id, subject, sequence_order, title, prerequisite_unit_ids_json,
                gate_question_count, gate_min_accuracy_pct, gate_max_speed_sec, gate_streak_req
         FROM units WHERE grade_id = ? ORDER BY subject ASC, sequence_order ASC, unit_id ASC`,
        [gradeId],
      );
    },
    async topicsForUnit(unitId): Promise<PackTopicRow[]> {
      return db.getAllAsync<PackTopicRow>(
        `SELECT topic_id, unit_id, grade_id, subject, topic_code, topic_name, sequence_order, assets_json
         FROM skill_topics WHERE unit_id = ? ORDER BY sequence_order ASC`,
        [unitId],
      );
    },
    async topicsForGrade(gradeId): Promise<PackTopicRow[]> {
      return db.getAllAsync<PackTopicRow>(
        `SELECT topic_id, unit_id, grade_id, subject, topic_code, topic_name, sequence_order, assets_json
         FROM skill_topics WHERE grade_id = ?
         ORDER BY subject ASC, unit_id ASC, sequence_order ASC`,
        [gradeId],
      );
    },
    async topic(topicId): Promise<PackTopicRow | null> {
      const rows = await db.getAllAsync<PackTopicRow>(
        `SELECT topic_id, unit_id, grade_id, subject, topic_code, topic_name, sequence_order, assets_json
         FROM skill_topics WHERE topic_id = ?`,
        [topicId],
      );
      return rows[0] ?? null;
    },
    async questionsForTopic(topicId, count): Promise<PackQuestionRow[]> {
      return db.getAllAsync<PackQuestionRow>(
        `SELECT question_id, topic_id, unit_id, topic_code, topic_name, difficulty_level, interaction_type,
                prompt, visual_aid_svg, visual_objects, target_count, max_counter_cells, counter_emoji,
                tile_bank_json, choices_json, correct_answer, misconception_tags_json, explanation
         FROM practice_questions WHERE topic_id = ? ORDER BY difficulty_level ASC, question_id ASC LIMIT ?`,
        [topicId, count],
      );
    },
    async questionsForUnit(unitId): Promise<PackQuestionRow[]> {
      return db.getAllAsync<PackQuestionRow>(
        `SELECT question_id, topic_id, unit_id, topic_code, topic_name, difficulty_level, interaction_type,
                prompt, visual_aid_svg, visual_objects, target_count, max_counter_cells, counter_emoji,
                tile_bank_json, choices_json, correct_answer, misconception_tags_json, explanation
         FROM practice_questions WHERE unit_id = ? ORDER BY question_id ASC`,
        [unitId],
      );
    },
  };
}

function createOpenContent(storage: PracticeStorage): PracticeDeps["openContent"] {
  return async (gradeId: string): Promise<PackContentReader | null> => {
    const artifact = await storage.activePackArtifact(gradeId);
    if (!artifact) return null;
    let reader = readerCache.get(artifact);
    if (!reader) {
      reader = openPackReader(artifact);
      readerCache.set(artifact, reader);
      // Advisory (d) from the #47 review: when a grade's active artifact
      // changes (supersede) or its pack is pruned, drop this grade's
      // other cached readers so no query_only handle outlives its
      // artifact. Artifact names encode the grade (#46 compiler
      // contract: pack-<gradeId>-v<version>.sqlite).
      const prefix = `pack-${gradeId}-v`;
      for (const key of readerCache.keys()) {
        if (key.startsWith(prefix) && key !== artifact) readerCache.delete(key);
      }
    }
    return reader;
  };
}

export function createNativePracticeDeps(): PracticeDeps {
  const storage = createStorage();
  return {
    storage,
    openContent: createOpenContent(storage),
    now: () => Date.now(),
    newSessionId: (studentId: string) =>
      `${studentId}-s${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    motorBaselineSec: DEFAULT_MOTOR_BASELINE_SEC,
    // #55: the optimistic local reward ledger rides the same lifecycle DB.
    gamificationStorage: createGamificationStorage(),
  };
}

/** #55 seam: the gamification storage alone (screens + sync adoption). */
export function getNativeGamificationStorage(): GamificationStorage {
  return createGamificationStorage();
}

let engineSingleton: PracticeDeps | null = null;

/** Lazy singleton factory for the #50 practice runner. */
export function getNativePracticeDeps(): PracticeDeps {
  engineSingleton ??= createNativePracticeDeps();
  return engineSingleton;
}
