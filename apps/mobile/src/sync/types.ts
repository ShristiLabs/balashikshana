/**
 * Sync protocol contracts (issue #48, roadmap D8).
 *
 * DI doctrine (same as audio/content/practice): every module in this
 * tree is pure TypeScript talking to the interfaces below; only
 * nativeSync.ts imports React Native modules (netinfo, secure-store
 * adapter, fetch). Tests run in vitest/node against in-memory
 * node:sqlite adapters and injected transports — no RN required.
 *
 * D8 doctrine: the local attempt log is client-authoritative and
 * append-only; the SERVER recomputes progress and is authoritative for
 * topic/unit state, gate verdicts, and key states. The engine's job is
 * the safe loop: drain (whole sessions, id order) -> upload -> adopt
 * the authoritative snapshot (confirm/rollback provisional states) ->
 * mark synced. Failures at ANY step lose nothing: rows are only marked
 * synced AFTER the snapshot is durably applied, and a crash before that
 * simply replays (the server dedupes by client sequence).
 */

import type { KeyState, PracticeStorage, SessionType } from "../practice/types";

/** One drained attempt_log row, in wire shape. Only FACTS travel: the
 *  server derives everything else through the core-engine itself. */
export interface SyncAttemptWire {
  seq: number;
  unitId: string;
  topicId: string;
  questionId: string;
  sessionType: SessionType;
  sessionId: string;
  chosenAnswer: string;
  isCorrect: boolean;
  rawTimeSec: number;
  audioDurationSec: number;
  misconceptionTags: string[];
  /** Device-clock epoch ms (server clock policy applies server-side). */
  answeredAtMs: number;
  motorBaselineSec: number;
}

/**
 * One drained session_outcomes row, in wire shape (#56 hearts
 * telemetry). ADDITIVE to the #48 wire: the upload body carries an
 * optional sessionOutcomes array, so pre-#56 servers/clients simply
 * never see it. Facts only (counts + enum reason; COPPA — no PII):
 * the server persists them into its gamification ledger context,
 * exactly-once per (student, session) by database constraint.
 */
export interface SessionOutcomeWire {
  /** Client row id — the ack mapping key (ackedOutcomeIds). */
  seq: number;
  sessionId: string;
  sessionType: SessionType;
  stage: "guided" | "fluency";
  heartsLost: number;
  heartsRemaining: number;
  endReason: "completed" | "hearts-empty";
  /** Device-clock epoch ms at session close. */
  endedAtMs: number;
}

/** Raw attempt_log row as read from the lifecycle DB. */
export interface AttemptLogRow {
  id: number;
  student_id: string;
  topic_id: string;
  question_id: string;
  interaction_type: string;
  is_correct: number;
  cognitive_time_sec: number;
  audio_duration_sec: number;
  answered_at: number;
  synced: number;
  unit_id: string;
  session_type: string;
  session_id: string;
  raw_time_sec: number;
  fluency_grade: number;
  misconception_tags_json: string;
  chosen_answer: string;
  motor_baseline_sec: number;
}

export interface SyncUploadStats {
  inserted: number;
  duplicates: number;
  sessionsReplayed: number;
  clockSkewAdjusted: number;
}

export interface PackVersionSignal {
  gradeId: string;
  installedVersion: string;
  currentVersion: string;
}

/** Authoritative unit row from the server snapshot (D8: server truth). */
export interface SnapshotUnitRow {
  unitId: string;
  status: string;
  keyState: string | null;
  bestAccuracyPct: number;
  bestMedianSpeedSec: number;
  attemptsCount: number;
  stabilityDays: number;
  lastReviewedAt: string | null;
  cpaStage: string;
  silverAwardedAt: string | null;
  goldVerifiedAt: string | null;
}

export interface SnapshotTopicRow {
  topicId: string;
  unitId: string;
  topicCode: string;
  completed: number;
  crowns: number;
  masteryScore: number;
  bestAccuracyPct: number;
  bestMedianSpeedSec: number;
  attemptsCount: number;
  fluencyGrade: number;
  stabilityDays: number;
  nextReviewAt: string | null;
  lastReviewedAt: string | null;
}

export interface ProgressSnapshot {
  units: SnapshotUnitRow[];
  topics: SnapshotTopicRow[];
}

export interface SyncUploadResponse {
  ackedSeqs: number[];
  /** #56: acknowledged session-outcome row ids (inserted now or already
   *  present — both are safely synced). Absent on pre-#56 servers. */
  ackedOutcomeIds?: number[];
  serverTime: string;
  stats: SyncUploadStats;
  packsOutdated: PackVersionSignal[];
  progress: ProgressSnapshot;
}

export interface SyncProgressResponse {
  serverTime: string;
  packsOutdated: PackVersionSignal[];
  progress: ProgressSnapshot;
}

export type SyncOutcome =
  "synced" | "idle" | "offline" | "failed-retryable" | "failed-fatal" | "no-session";

export interface SyncRunResult {
  outcome: SyncOutcome;
  /** Attempts uploaded this run (0 unless outcome === "synced"). */
  uploaded: number;
  /** Attempts still pending after this run. */
  pending: number;
  stats?: SyncUploadStats;
  packsOutdated?: PackVersionSignal[];
  /** Attempts made against the transport (retry accounting). */
  attempts: number;
  /** Last transport error message (structured log seam; never PII). */
  error?: string;
}

/**
 * Lifecycle-storage seam for sync. Extends the #47 PracticeStorage with
 * the two operations ONLY the sync worker may perform on attempt_log:
 * the ordered drain and the synced-flag flip (the append-only contract
 * otherwise forbids UPDATE/DELETE — the source-scan test whitelists
 * exactly this statement shape in this module's adapters).
 */
export interface SyncStorage extends PracticeStorage {
  /** Unsynced rows in id order (idx_attempt_log_drain), capped. */
  drainUnsynced(studentId: string, limit: number): Promise<AttemptLogRow[]>;
  /**
   * Unsynced rows STRICTLY AFTER afterId, in id order (the same
   * idx_attempt_log_drain index with an id range), capped. The
   * whole-session batching beyond-window probe: the front-window drain
   * above cannot see past its own LIMIT, so proving whether the
   * trailing session of a FULL window continues requires reading beyond
   * the window by cursor, never by re-reading the window itself
   * (issue #48 review finding 1: a cursor-less re-drain returns the
   * same front rows and an always-empty tail, silently uploading a
   * partial session the server replays as complete).
   */
  drainUnsyncedAfter(studentId: string, afterId: number, limit: number): Promise<AttemptLogRow[]>;
  /**
   * Flip the synced flag for all rows up to and including seq. THE only
   * mutation permitted on attempt_log, and only after the server's
   * snapshot is durably applied (no-loss ordering).
   */
  markSyncedUpTo(studentId: string, seq: number): Promise<number>;
  /**
   * #56: unsynced hearts session outcomes in id order
   * (idx_session_outcomes_drain), capped. Read-only drain.
   */
  drainUnsyncedOutcomes(
    studentId: string,
    limit: number,
  ): Promise<import("../practice/types").SessionOutcomeRecord[]>;
  /**
   * #56: THE only mutation permitted on session_outcomes — flip the
   * synced flag for exactly the server-acked row ids, after the
   * upload response is durably applied (no-loss ordering, same
   * doctrine as markSyncedUpTo).
   */
  markOutcomesSynced(studentId: string, ids: number[]): Promise<number>;
}

/** The child-device session credential source (onboarding TokenStore). */
export interface SyncCredentialSource {
  /** Returns null when no device session is stored (sync is a no-op). */
  getChildDeviceSession(): Promise<{
    token: string;
    sessionId: string;
    studentId: string;
    deviceId: string;
    expiresAt: string;
  } | null>;
}

export interface SyncTransport {
  /** Upload one drained batch. #56: hearts session outcomes ride the
   *  SAME request (additive optional body field); pre-#56 servers
   *  ignore them. Outcomes ride only alongside an attempts batch — the
   *  server requires attempts (minItems 1), and an outcome row exists
   *  only after its session's attempts were recorded. */
  uploadAttempts(
    attempts: SyncAttemptWire[],
    outcomes?: SessionOutcomeWire[],
  ): Promise<SyncUploadResponse>;
  fetchProgress(): Promise<SyncProgressResponse>;
}

/** Non-retryable HTTP statuses (problem+json per repo doctrine). */
export const FATAL_STATUS_CODES = new Set([400, 401, 403, 404, 413]);

export class SyncTransportError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(message: string, status: number) {
    super(message);
    this.name = "SyncTransportError";
    this.status = status;
    this.retryable = !FATAL_STATUS_CODES.has(status);
  }
}

/** Connectivity seam (netinfo in production; fakes in tests). */
export interface Connectivity {
  isOnline(): Promise<boolean>;
  /** Subscribe to reachability changes; returns the unsubscribe fn. */
  subscribe(listener: (online: boolean) => void): () => void;
}

/** Structured event (counts/latency/outcomes only — NO child PII). */
export type SyncLogEvent =
  | { kind: "sync-run"; outcome: SyncOutcome; uploaded: number; pending: number; latencyMs: number }
  | { kind: "sync-retry"; attempt: number; delayMs: number; error: string }
  | { kind: "sync-connectivity"; online: boolean }
  | { kind: "sync-content-outdated"; packs: number };

export interface SyncLogger {
  log(event: SyncLogEvent): void;
}

export interface SyncDeps {
  storage: SyncStorage;
  transport: SyncTransport;
  connectivity: Connectivity;
  logger?: SyncLogger;
  /** Max attempts per batch (server default cap: 200). */
  batchSize?: number;
  /** Backoff base ms (default 1000). */
  backoffBaseMs?: number;
  /** Backoff cap ms (default 60000). */
  backoffMaxMs?: number;
  /** Max transport attempts per run (default 5). */
  maxAttempts?: number;
  /** Injected RNG for jitter (default Math.random). */
  random?: () => number;
  /** Installed packs for the content handshake (pack_meta-derived). */
  clientPacks?(): Promise<{ gradeId: string; contentVersion: string }[]>;
  /**
   * Liveness probe for open practice sessions (whole-session batching:
   * a session the child is still answering is deferred). The native
   * wiring passes a view of the PracticeSessionEngine's live sessions.
   */
  isActiveSession?(sessionId: string): boolean;
  /** Signal for content refresh wiring (#46 seam). */
  onContentOutdated?(packs: PackVersionSignal[]): void;
  /** Injected clock for tests. */
  now?(): number;
  /** Injected sleep for tests. */
  sleep?(ms: number): Promise<void>;
}

/** Narrow re-export so the engine can speak key-state without cycles. */
export type { KeyState };
