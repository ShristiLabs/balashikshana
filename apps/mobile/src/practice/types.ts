/**
 * Offline practice core contracts (issue #47).
 *
 * DI doctrine (same as audio/content): every module in this tree is pure
 * TypeScript talking to the interfaces below; only nativePractice.ts
 * imports expo-sqlite. Tests run in vitest/node against in-memory
 * node:sqlite adapters — no React Native required.
 *
 * D8 doctrine: the attempt log is client-authoritative and APPEND-ONLY;
 * progress rows are a local projection of that log via the same
 * core-engine calls the server runs, so both sides agree by construction
 * for an identical attempt stream (deliberate divergences are documented
 * on the projector). All gate outcomes are provisional until #48 sync
 * confirms them.
 */

/** Silver/Gold key lifecycle (registry globalMasteryRules.twoKeySleepConsolidationGate). */
export type KeyState = "SILVER_KEY" | "GOLD_KEY";

/**
 * Session types. GAME (issue #52) is a game-framework session: attempts
 * carry the same facts as topic practice and the server derives topic
 * progress from them exactly like a topic session (per-topic grouping —
 * a game's spiral stream mixes prerequisite/review items), so game play
 * always counts toward mastery. The union mirrors the server's sync
 * SESSION_TYPES enum and the OpenAPI baseline one-for-one.
 */
export type SessionType = "TOPIC_PRACTICE" | "GATE" | "GOLD_VERIFICATION" | "GAME";

/**
 * Per-attempt game telemetry (issue #52, attempt_log migration 4).
 * LOCAL-ONLY columns: the #48 sync wire carries facts only and is
 * UNCHANGED; the server derives progress from the same facts it always
 * had. These fields record the game provenance the wire deliberately
 * does not carry (spiral bucket, stage speed target, resolved
 * archetype, fallback marker). No PII (COPPA).
 */
export interface GameAttemptTelemetry {
  /** Spiral bucket the item came from ("" on the practice-fallback path). */
  spiralProvenance: "current" | "contrastive" | "spaced-review" | "";
  /** The stage's registry speed target in seconds (0 = untimed guided). */
  targetResponseSpeedSec: number;
  /** Archetype the framework resolved for this session. */
  archetype: string;
  /** True when the session fell back to the #50 practice runner. */
  fallback: boolean;
}

/** A single recorded response — the immutable unit of the attempt log. */
export interface AttemptInput {
  studentId: string;
  unitId: string;
  topicId: string;
  questionId: string;
  interactionType: string;
  chosenAnswer: string;
  isCorrect: boolean;
  rawTimeSec: number;
  audioDurationSec: number;
  /** Engine-computed at record time; rules per session type (see AttemptRecorder). */
  cognitiveTimeSec: number;
  fluencyGrade: number;
  misconceptionTags: string[];
  sessionType: SessionType;
  sessionId: string;
  /** The session's motor baseline (constant per session). #48's server
   *  replay needs it to reproduce the engine math exactly from facts. */
  motorBaselineSec: number;
  /** #52 game telemetry stamp; absent on non-game sessions (NULL columns). */
  gameTelemetry?: GameAttemptTelemetry;
}

export interface AttemptRecord extends AttemptInput {
  /** AUTOINCREMENT id — strictly monotonic across sessions; #48's sync cursor. */
  seq: number;
  answeredAt: number;
  synced: boolean;
}

/** Mirror of the server's student_topic_progress upsert targets. */
export interface TopicProgressRecord {
  studentId: string;
  topicId: string;
  unitId: string;
  topicCode: string;
  completed: number;
  crowns: number;
  masteryScore: number;
  bestAccuracyPct: number;
  /** 0 means "no measurement yet" (server: NOT NULL default 0). */
  bestMedianSpeedSec: number;
  attemptsCount: number;
  fluencyGrade: number;
  stabilityDays: number;
  nextReviewAt: number;
  lastReviewedAt: number;
  provisional: boolean;
  updatedAt: number;
}

/** Mirror of the server's student_unit_progress upsert targets + two-key state. */
export interface UnitProgressRecord {
  studentId: string;
  unitId: string;
  status: string;
  keyState: KeyState | null;
  bestAccuracyPct: number;
  bestMedianSpeedSec: number;
  attemptsCount: number;
  stabilityDays: number;
  lastReviewedAt: number;
  cpaStage: string;
  provisional: boolean;
  silverAwardedAt: number;
  goldVerifiedAt: number;
  updatedAt: number;
}

/** The render-facing question shape — field-for-field the server's mapQuestionRow. */
export interface PracticeQuestion {
  questionId: string;
  topicId: string;
  unitId: string;
  topicCode: string;
  topicName: string;
  difficultyLevel: number;
  interactionType: string;
  prompt: string;
  visualAid: string;
  visualObjects?: unknown;
  targetCount?: number;
  maxCounterCells?: number;
  counterEmoji?: string;
  tileBank?: unknown;
  choices: unknown[];
  correctAnswer: string;
  misconceptionTags: string[];
  explanation: string;
}

/** Pack row snapshots (snake_case, straight off the query_only pack reader). */
export interface PackUnitRow {
  unit_id: string;
  grade_id: string;
  subject: string;
  sequence_order: number;
  title: string;
  prerequisite_unit_ids_json: string;
  gate_question_count: number;
  gate_min_accuracy_pct: number;
  gate_max_speed_sec: number;
  gate_streak_req: number;
}

export interface PackTopicRow {
  topic_id: string;
  unit_id: string;
  grade_id: string;
  subject: string;
  topic_code: string;
  topic_name: string;
  sequence_order: number;
  assets_json: string;
}

export interface PackQuestionRow {
  question_id: string;
  topic_id: string;
  unit_id: string;
  topic_code: string;
  topic_name: string;
  difficulty_level: number;
  interaction_type: string;
  prompt: string;
  visual_aid_svg: string;
  visual_objects: string | null;
  target_count: number | null;
  max_counter_cells: number | null;
  counter_emoji: string | null;
  tile_bank_json: string | null;
  choices_json: string;
  correct_answer: string;
  misconception_tags_json: string;
  explanation: string;
}

export interface GradeSrPolicy {
  gradeId: string;
  srGrowthFactor: number;
  srMaxIntervalDays: number;
  baseScheduleDays: number[];
}

/**
 * Read-only view over an installed #46 pack artifact. Implementations
 * MUST open the pack with PRAGMA query_only = ON (content rows are never
 * written on-device).
 */
export interface PackContentReader {
  gradePolicy(gradeId: string): Promise<GradeSrPolicy | null>;
  unit(unitId: string): Promise<PackUnitRow | null>;
  /**
   * All units of the grade in journey order (subject ASC, then registry
   * sequence, then unit id as the tiebreaker — deterministic). The #49
   * journey map renders exactly this list.
   */
  unitsForGrade(gradeId: string): Promise<PackUnitRow[]>;
  /** Topics of a unit in registry sequence order (same as the server's ORDER BY). */
  topicsForUnit(unitId: string): Promise<PackTopicRow[]>;
  /**
   * All topics of the grade in journey order (subject ASC, unit sequence
   * ASC, topic sequence ASC) — the #49 model derives per-unit completion
   * fractions from this single read.
   */
  topicsForGrade(gradeId: string): Promise<PackTopicRow[]>;
  topic(topicId: string): Promise<PackTopicRow | null>;
  /** Stored questions for a topic: difficulty ASC, question_id ASC, LIMIT count (server order). */
  questionsForTopic(topicId: string, count: number): Promise<PackQuestionRow[]>;
  /** All stored questions of a unit, question_id ASC. */
  questionsForUnit(unitId: string): Promise<PackQuestionRow[]>;
}

/**
 * Lifecycle-database seam (balashikshana_content.db, schema v2). The
 * attempt-log surface is INSERT + SELECT only — no update/delete path
 * exists anywhere in the mobile tree (append-only is enforced by review
 * and by a source-scan test).
 */
export interface PracticeStorage {
  /** Append one attempt; returns the monotonic sequence id. */
  insertAttempt(input: AttemptInput, answeredAt: number): Promise<number>;
  getTopicProgress(studentId: string, topicId: string): Promise<TopicProgressRecord | null>;
  /**
   * Write the projector-computed row. The projector owns the
   * GREATEST/LEAST merge semantics (mirroring the server's upsert SQL);
   * the adapter persists the full row under the app's single-writer
   * model (one JS thread, sequential awaits).
   */
  upsertTopicProgress(record: TopicProgressRecord): Promise<void>;
  getUnitProgress(studentId: string, unitId: string): Promise<UnitProgressRecord | null>;
  upsertUnitProgress(record: UnitProgressRecord): Promise<void>;
  /** All unit-progress rows of a student (#49 journey-model input). */
  allUnitProgress(studentId: string): Promise<UnitProgressRecord[]>;
  /** Read-only #48 seam: how many attempts are still unsynced. */
  unsyncedAttemptCount(studentId: string): Promise<number>;
  /** All topic-progress rows of a student (review-queue input). */
  allTopicProgress(studentId: string): Promise<TopicProgressRecord[]>;
  /** Active pack artifact file name for a grade (pack_meta), or null. */
  activePackArtifact(gradeId: string): Promise<string | null>;
  /**
   * Every grade's ACTIVE pack row (grade + content version) straight off
   * pack_meta — the #48/#49 clientPacks handshake input. Read-only.
   */
  activePackVersions(): Promise<{ gradeId: string; contentVersion: string }[]>;
}

export interface PracticeDeps {
  storage: PracticeStorage;
  /**
   * Opens the installed pack for a grade as a query_only reader. Offline
   * by construction — no implementation of this contract performs I/O
   * beyond the local file system.
   */
  openContent(gradeId: string): Promise<PackContentReader | null>;
  /** Injected clock (epoch ms) — deterministic tests, device clock in production. */
  now(): number;
  /** Injected session-id policy (deterministic in tests). */
  newSessionId(studentId: string): string;
  /**
   * Motor baseline seconds; fallback chain mirrors the server:
   * caller-provided -> this value -> 0.42 default.
   */
  motorBaselineSec?: number;
  /**
   * #55 (D9) gamification seam — OPTIONAL so pre-#55 wiring keeps
   * working: when present, session completions project the optimistic
   * local reward ledger through the shared engine rules (rewards are
   * still computed and returned in every summary either way; only the
   * persisted local state needs this seam).
   */
  gamificationStorage?: import("../gamification/storage").GamificationStorage;
}
