/**
 * PracticeSessionEngine (issue #47) — the offline practice orchestrator.
 *
 * Wraps packages/core-engine (imported read-only, zero-diff) plus the
 * query_only #46 pack reader and the append-only attempt log. This
 * module performs NO network I/O and no UI: a full topic session, boss
 * gate, Gold verification, and review-queue build all run offline
 * against an installed pack (the airplane-mode acceptance test proves
 * the entire flow against an in-memory pack fixture).
 *
 * Session lifecycle: responses are durable the moment they arrive
 * (AttemptRecorder INSERT); projections run at session completion, so a
 * crash mid-session loses no attempt data — the log is the source of
 * truth and #48 re-derives progress server-side from it (D8).
 * In-memory session state lives only between start and complete.
 */
import { evaluateMasteryGateAttempt, generateTopicPracticeSet } from "@balashikshana/core-engine";
import { allocateSpiral, interleaveSpiral, type SpiralSource } from "../gate/spiral";
import { AttemptRecorder } from "./attemptRecorder";
import { TWO_KEY_RULES, goldEligibleAtMs } from "./goldKey";
import {
  deriveAttempt,
  deriveGateSession,
  deriveGoldVerification,
  deriveTopicSession,
  mergeTopicProgress,
  mergeUnitProgress,
  type SessionResponse,
} from "./progressProjector";
import {
  generatedToPracticeQuestion,
  packQuestionToPracticeQuestion,
  packTopicToEngineTopic,
  packUnitToEngineUnit,
} from "./packShapes";
import { buildReviewQueue, capNextReviewAt } from "./reviewQueue";
import {
  composeGameItemPlan,
  mixPercentagesFromFractions,
  summarizeGameTelemetry,
} from "../games/sessionModel";
import { gameSessionLength, parseGamesAssetBlock } from "../games/gamesAssets";
import type {
  AttemptInput,
  GameAttemptTelemetry,
  GradeSrPolicy,
  PackContentReader,
  PracticeDeps,
  PracticeQuestion,
  SessionType,
  TopicProgressRecord,
  UnitProgressRecord,
} from "./types";

/**
 * The documented default motor baseline (seconds). #53 carry-over fix
 * 5: exported so every default site shares ONE named constant (the
 * attempt_log schema migration's SQL DEFAULT is a fixed historical
 * value and stays as-is).
 */
export const DEFAULT_MOTOR_BASELINE_SEC = 0.42;
const DEFAULT_TOPIC_QUESTION_COUNT = 8;

/** Prerequisite unit ids off the pack row's JSON column ([] on parse failure). */
function parsePrerequisiteUnitIds(json: string): string[] {
  try {
    const parsed = JSON.parse(json || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

interface SessionState {
  kind: SessionType;
  sessionId: string;
  studentId: string;
  gradeId: string;
  unitId: string;
  topicId: string | null;
  topicCode: string | null;
  questions: PracticeQuestion[];
  responses: SessionResponse[];
  motorBaselineSec: number;
  targetSpeedSec: number;
  startedAtMs: number;
  /** #52 stamp: every attempt row of the session carries it (game or fallback). */
  gameTelemetry?: GameAttemptTelemetry;
  /** #52 game sessions: spiral bucket per question id (re-queues inherit). */
  provenanceByQuestionId?: Record<string, "current" | "contrastive" | "spaced-review">;
  /** #52 game session stage + registry mastery goal (summary roll-up). */
  gameStage?: "guided" | "fluency";
  gameTargetMasteryScore?: number;
}

export interface TopicSessionStart {
  sessionId: string;
  unitId: string;
  unitTitle: string;
  topicId: string;
  topicCode: string;
  topicName: string;
  targetSpeedSec: number;
  minAccuracyPercent: number;
  questions: PracticeQuestion[];
}

export interface TopicSessionSummary {
  sessionId: string;
  passedTopic: boolean;
  crownsAwarded: number;
  accuracyPct: number;
  medianCogSpeedSec: number;
  targetSpeedSec: number;
  fluencyGrade: number;
  stabilityDays: number;
  cpaStage: string;
  nextReviewAt: number;
  topicProgress: TopicProgressRecord;
}

/** Game-session start payload (issue #52) — everything the host + renderer need. */
export interface GameSessionStart {
  sessionId: string;
  unitId: string;
  unitTitle: string;
  topicId: string;
  topicCode: string;
  topicName: string;
  /** Registry stage the session runs. */
  stage: "guided" | "fluency";
  archetype: string;
  gameId: string;
  gameTitle: string;
  /** Registry speed target (fluency); 0 for the untimed guided stage. */
  targetResponseSpeedSec: number;
  /** Registry mastery goal (game-facing win boundary; 80 in today's data). */
  targetMasteryScore: number;
  /** Derivation-parity target (unit gate speed) — see startGameSession. */
  targetSpeedSec: number;
  /** The spiral-mixed stream (guided: current-only). */
  questions: PracticeQuestion[];
  /** Spiral bucket per question id (telemetry provenance). */
  provenanceByQuestionId: Record<string, "current" | "contrastive" | "spaced-review">;
}

/** Game-session completion summary: per-topic progress + game telemetry. */
export interface GameSessionSummary {
  sessionId: string;
  stage: "guided" | "fluency";
  archetype: string;
  /** Game-facing goal evaluation (celebration), NOT the mastery pass rule. */
  metGoal: boolean;
  accuracyPct: number;
  medianCogSpeedSec: number;
  targetSpeedSec: number;
  /** Speed-vs-target telemetry (target 0 = untimed guided stage). */
  speed: {
    targetSec: number;
    medianRawSec: number;
    medianCognitiveSec: number;
    beatTargetPct: number;
  };
  provenanceCounts: { current: number; contrastive: number; "spaced-review": number };
  /** Per-topic projections written (current topic first). */
  perTopic: {
    topicId: string;
    topicCode: string;
    accuracyPct: number;
    medianCogSpeedSec: number;
    passedTopic: boolean;
    crowns: number;
  }[];
}

export interface GateSessionStart {
  sessionId: string;
  /** GATE (boss gate) or GOLD_VERIFICATION (5-item check). */
  sessionType: SessionType;
  /** Engine clock at session open — the Gold check's 60 s budget anchor. */
  startedAtMs: number;
  unit: {
    unitId: string;
    title: string;
    masteryGate: {
      questionCount: number;
      minAccuracyPercent: number;
      maxMedianResponseTimeSec: number;
      challengeZoneStreak: number;
    };
    skillTopics: { topicId: string; code: string; name: string }[];
  };
  questions: PracticeQuestion[];
  targetSpeedSec: number;
}

export interface GateSessionSummary {
  sessionId: string;
  passed: boolean;
  keyState: UnitProgressRecord["keyState"];
  provisional: boolean;
  overallAccuracyPct: number;
  requiredAccuracyPct: number;
  medianCogSpeedSec: number;
  targetSpeedSec: number;
  /** P80 cognitive speed vs the 1.3x-tail ceiling (condition 4 metrics). */
  p80CogSpeedSec: number;
  maxTailAllowedSec: number;
  /** Rapid-guess violations the engine counted (condition 5 metrics). */
  rapidGuessViolations: number;
  /** Final challenge-zone streak passed (condition 5 metrics). */
  finalStreakPassed: boolean;
  challengeStreakRequired: number;
  /** Topics below the 75% floor (engine topic codes / namespaced ids). */
  failedTopics: string[];
  /** Per-topic breakdown for the results screen (engine shape). */
  topicBreakdown: {
    code: string;
    name: string;
    total: number;
    correct: number;
    accuracyPct: number;
    medianSpeedSec: number;
  }[];
  remediationMode: string;
  remediationPrescription: string;
  conditions: Record<string, boolean>;
  unitProgress: UnitProgressRecord;
}

export interface GoldStatus {
  keyState: UnitProgressRecord["keyState"];
  provisional: boolean;
  silverAwardedAt: number;
  goldVerifiedAt: number;
  goldEligibleAtMs: number;
  eligible: boolean;
}

export interface GoldVerificationSummary {
  sessionId: string;
  correctCount: number;
  requiredCount: number;
  upgraded: boolean;
  keyState: UnitProgressRecord["keyState"];
  reason: string;
}

export class PracticeSessionEngine {
  private readonly deps: PracticeDeps;
  private readonly recorder: AttemptRecorder;
  private readonly sessions = new Map<string, SessionState>();

  constructor(deps: PracticeDeps) {
    this.deps = deps;
    this.recorder = new AttemptRecorder(deps);
  }

  // ------------------------------------------------------------------
  // Topic practice
  // ------------------------------------------------------------------

  /**
   * Opens a topic practice session. Question sourcing mirrors the
   * server: stored pack rows (difficulty ASC, question_id ASC, LIMIT
   * count); if the pack stored fewer than requested, the shortfall is
   * padded deterministically with engine-generated items (distinct
   * question-id space, `-G<n>`).
   */
  async startTopicSession(params: {
    studentId: string;
    gradeId: string;
    unitId: string;
    topicCode: string;
    count?: number;
    motorBaselineSec?: number;
    /**
     * #52 fallback telemetry stamp: when the game framework routes a
     * topic to the practice runner (no installed archetype renderer),
     * the session's attempt rows record the intended archetype and the
     * fallback marker. Absent for plain practice sessions.
     */
    gameTelemetry?: GameAttemptTelemetry;
  }): Promise<TopicSessionStart> {
    const reader = await this.requireReader(params.gradeId);
    const unit = await this.requireUnit(reader, params.unitId);
    const topicId = `${params.unitId}-${params.topicCode}`;
    const topicRow = await reader.topic(topicId);
    if (!topicRow) throw new Error(`Topic ${topicId} not found in installed pack`);
    const count = params.count ?? DEFAULT_TOPIC_QUESTION_COUNT;

    const storedRows = await reader.questionsForTopic(topicId, count);
    const questions = storedRows.map(packQuestionToPracticeQuestion);
    if (questions.length < count) {
      const shortfall = count - questions.length;
      const unitObj = packUnitToEngineUnit(unit, await reader.topicsForUnit(params.unitId));
      const topicObj = packTopicToEngineTopic(topicRow);
      const generated = generateTopicPracticeSet(unitObj, topicObj, shortfall);
      generated.forEach((item, index) => {
        questions.push(
          generatedToPracticeQuestion(
            params.unitId,
            topicId,
            params.topicCode,
            topicRow.topic_name,
            index,
            item,
          ),
        );
      });
    }

    const sessionId = this.deps.newSessionId(params.studentId);
    this.sessions.set(sessionId, {
      kind: "TOPIC_PRACTICE",
      sessionId,
      studentId: params.studentId,
      gradeId: params.gradeId,
      unitId: params.unitId,
      topicId,
      topicCode: params.topicCode,
      questions,
      responses: [],
      motorBaselineSec: this.motorBaseline(params.motorBaselineSec),
      targetSpeedSec: unit.gate_max_speed_sec,
      startedAtMs: this.deps.now(),
      gameTelemetry: params.gameTelemetry,
    });

    return {
      sessionId,
      unitId: params.unitId,
      unitTitle: unit.title,
      topicId,
      topicCode: params.topicCode,
      topicName: topicRow.topic_name,
      targetSpeedSec: unit.gate_max_speed_sec,
      minAccuracyPercent: 80,
      questions,
    };
  }

  /**
   * Records one response durably (append-only) and returns its sequence
   * id plus the per-attempt fluency grade (server insert math).
   */
  async submitResponse(
    sessionId: string,
    response: SessionResponse,
  ): Promise<{ seq: number; fluencyGrade: number; cognitiveTimeSec: number }> {
    const session = this.requireSession(sessionId);
    const question = session.questions.find((q) => q.questionId === response.questionId);
    if (!question)
      throw new Error(`Question ${String(response.questionId)} not in session ${sessionId}`);

    const attempt = deriveAttempt({
      response,
      sessionType: session.kind,
      motorBaselineSec: session.motorBaselineSec,
      targetSpeedSec: session.targetSpeedSec,
    });

    const input: AttemptInput = {
      studentId: session.studentId,
      unitId: session.unitId,
      topicId: question.topicId,
      questionId: question.questionId,
      interactionType: question.interactionType,
      chosenAnswer: String(response.chosenAnswer ?? ""),
      isCorrect: Boolean(response.isCorrect),
      rawTimeSec: response.rawTimeSec || 3.0,
      audioDurationSec: response.audioDurationSec || 0,
      cognitiveTimeSec: attempt.cognitiveTimeSec,
      fluencyGrade: attempt.fluencyGrade,
      misconceptionTags: response.misconceptionTags || question.misconceptionTags || [],
      sessionType: session.kind,
      sessionId,
      // The session's motor baseline rides every attempt row so #48's
      // server replay reproduces the engine math exactly.
      motorBaselineSec: session.motorBaselineSec,
      // #52: game sessions stamp per-row telemetry with the item's own
      // spiral bucket (a fallback session's constant stamp passes through
      // as-is - its stream is not spiral-composed).
      gameTelemetry: (() => {
        const stamp = session.gameTelemetry;
        if (!stamp) return undefined;
        const provenance = session.provenanceByQuestionId?.[question.questionId];
        return provenance ? { ...stamp, spiralProvenance: provenance } : stamp;
      })(),
    };
    const recorded = await this.recorder.record(input);
    session.responses.push(response);
    return {
      seq: recorded.seq,
      fluencyGrade: attempt.fluencyGrade,
      cognitiveTimeSec: attempt.cognitiveTimeSec,
    };
  }

  /**
   * Closes a topic session: derives the projection (server
   * topic-complete math), merges with the previous row, and persists.
   */
  async completeTopicSession(sessionId: string): Promise<TopicSessionSummary> {
    const session = this.requireSession(sessionId);
    if (session.kind !== "TOPIC_PRACTICE" || !session.topicId || !session.topicCode) {
      throw new Error(`Session ${sessionId} is not a topic practice session`);
    }
    const nowMs = this.deps.now();
    const reader = await this.requireReader(session.gradeId);
    const unit = await this.requireUnit(reader, session.unitId);
    const policy = await this.requirePolicy(reader, unit.grade_id);

    const prev = await this.deps.storage.getTopicProgress(session.studentId, session.topicId);
    const derivation = deriveTopicSession({
      studentId: session.studentId,
      unitId: session.unitId,
      topicId: session.topicId,
      topicCode: session.topicCode,
      responses: session.responses,
      motorBaselineSec: session.motorBaselineSec,
      targetSpeedSec: session.targetSpeedSec,
      srPolicy: {
        gradeGrowthFactor: policy.srGrowthFactor,
        maxIntervalCapDays: policy.srMaxIntervalDays,
      },
      prev,
      nowMs,
    });
    const merged = mergeTopicProgress(prev, derivation.fresh);
    merged.nextReviewAt = capNextReviewAt(merged.nextReviewAt, merged.lastReviewedAt, policy);
    await this.deps.storage.upsertTopicProgress(merged);
    this.sessions.delete(sessionId);

    return {
      sessionId,
      passedTopic: derivation.passedTopic,
      crownsAwarded: derivation.crowns,
      accuracyPct: derivation.accuracyPct,
      medianCogSpeedSec: derivation.medianCogSpeedSec,
      targetSpeedSec: derivation.targetSpeedSec,
      fluencyGrade: derivation.fluencyGrade,
      stabilityDays: derivation.stabilityDays,
      cpaStage: derivation.cpaStage,
      nextReviewAt: merged.nextReviewAt,
      topicProgress: merged,
    };
  }

  // ------------------------------------------------------------------
  // Game sessions (issue #52)
  // ------------------------------------------------------------------

  /**
   * Opens a game session for a topic's registry game config.
   *
   * Item-stream composition (issue #52 AC): the fluency stage composes
   * the topic's own assets.games spiralMix as a 70/20/10 blend —
   * current topic / contrastive prerequisite units / due spaced review
   * (most-forgotten first; the same claim order as the #51 gate:
   * review claims before prerequisites so a shared topic cannot starve
   * the 10% slice). The guided stage composes current-only (untimed
   * explorer; the registry carries spiralMix on the fluency config
   * alone). Missing pools degrade deterministically — their share flows
   * back to the current topic.
   *
   * DERIVATION PARITY: targetSpeedSec is the UNIT gate speed exactly
   * like a topic-practice session, on BOTH sides (mobile projector and
   * the server's GAME replay) — per-attempt fluency grades and session
   * medians can never fork between game and practice. The registry's
   * targetResponseSpeedSec is PACING + TELEMETRY only.
   */
  async startGameSession(params: {
    studentId: string;
    gradeId: string;
    unitId: string;
    topicCode: string;
    stage: "guided" | "fluency";
    motorBaselineSec?: number;
  }): Promise<GameSessionStart> {
    const reader = await this.requireReader(params.gradeId);
    const unit = await this.requireUnit(reader, params.unitId);
    const topicId = `${params.unitId}-${params.topicCode}`;
    const topicRow = await reader.topic(topicId);
    if (!topicRow) throw new Error(`Topic ${topicId} not found in installed pack`);

    const block = parseGamesAssetBlock(packTopicToEngineTopic(topicRow).assets);
    const config = params.stage === "guided" ? block.guidedPracticeGame : block.fluencySprintGame;
    if (!config) {
      throw new Error(`Topic ${topicId} has no ${params.stage} game config in its pack assets`);
    }
    const count = gameSessionLength(block);

    // Current pool: stored pack rows first, engine-generated padding on
    // shortfall — exactly the startTopicSession sourcing.
    const storedRows = await reader.questionsForTopic(topicId, count);
    const currentPool = storedRows.map(packQuestionToPracticeQuestion);
    if (currentPool.length < count) {
      const shortfall = count - currentPool.length;
      const unitObj = packUnitToEngineUnit(unit, await reader.topicsForUnit(params.unitId));
      const topicObj = packTopicToEngineTopic(topicRow);
      generateTopicPracticeSet(unitObj, topicObj, shortfall).forEach((item, index) => {
        currentPool.push(
          generatedToPracticeQuestion(
            params.unitId,
            topicId,
            params.topicCode,
            topicRow.topic_name,
            index,
            item,
          ),
        );
      });
    }

    // Fluency-only contrastive slices (gate claim order: review first).
    const prereqPool: PracticeQuestion[] = [];
    const reviewPool: PracticeQuestion[] = [];
    if (params.stage === "fluency") {
      const selected = new Set(currentPool.map((q) => q.questionId));
      const policy = await this.requirePolicy(reader, unit.grade_id);
      const progressRows = await this.deps.storage.allTopicProgress(params.studentId);
      const queue = buildReviewQueue({ nowMs: this.deps.now(), policy, rows: progressRows });
      for (const item of queue) {
        if (reviewPool.length >= count) break;
        if (item.unitId === params.unitId) continue;
        const rows = await reader.questionsForTopic(item.topicId, 1);
        const row = rows[0];
        if (!row) continue;
        const q = packQuestionToPracticeQuestion(row);
        if (selected.has(q.questionId)) continue;
        reviewPool.push(q);
        selected.add(q.questionId);
      }
      for (const prereqId of parsePrerequisiteUnitIds(unit.prerequisite_unit_ids_json)) {
        const prereqTopics = await reader.topicsForUnit(prereqId);
        for (const q of this.stratifiedQuestions(
          (await reader.questionsForUnit(prereqId)).map(packQuestionToPracticeQuestion),
          prereqTopics.map((t) => t.topic_code),
          count,
        )) {
          if (!selected.has(q.questionId)) {
            prereqPool.push(q);
            selected.add(q.questionId);
          }
        }
      }
    }

    const mix =
      params.stage === "fluency" && block.fluencySprintGame
        ? mixPercentagesFromFractions(block.fluencySprintGame.spiralMix)
        : null;
    const plan = composeGameItemPlan(
      count,
      { current: currentPool.length, prerequisite: prereqPool.length, review: reviewPool.length },
      mix,
    );
    // The combined pool is assembled in bucket order (current, then
    // prerequisite, then review) — the plan's question indices are
    // stable against exactly this concatenation.
    const combined = [...currentPool, ...prereqPool, ...reviewPool];
    const questions = plan.items
      .map((item) => combined[item.questionIndex])
      .filter((q): q is PracticeQuestion => q !== undefined);
    const provenanceByQuestionId: Record<string, "current" | "contrastive" | "spaced-review"> = {};
    for (const item of plan.items) {
      const question = combined[item.questionIndex];
      if (question) provenanceByQuestionId[question.questionId] = item.provenance;
    }

    const sessionId = this.deps.newSessionId(params.studentId);
    this.sessions.set(sessionId, {
      kind: "GAME",
      sessionId,
      studentId: params.studentId,
      gradeId: params.gradeId,
      unitId: params.unitId,
      topicId,
      topicCode: params.topicCode,
      questions,
      responses: [],
      motorBaselineSec: this.motorBaseline(params.motorBaselineSec),
      targetSpeedSec: unit.gate_max_speed_sec,
      startedAtMs: this.deps.now(),
      gameTelemetry: {
        spiralProvenance: "",
        targetResponseSpeedSec:
          params.stage === "fluency" && block.fluencySprintGame
            ? block.fluencySprintGame.targetResponseSpeedSec
            : 0,
        archetype: config.archetype,
        fallback: false,
      },
      provenanceByQuestionId,
      gameStage: params.stage,
      gameTargetMasteryScore: block.guidedPracticeGame?.targetMasteryScore ?? 80,
    });

    return {
      sessionId,
      unitId: params.unitId,
      unitTitle: unit.title,
      topicId,
      topicCode: params.topicCode,
      topicName: topicRow.topic_name,
      stage: params.stage,
      archetype: config.archetype,
      gameId: config.gameId,
      gameTitle: config.title,
      targetResponseSpeedSec:
        params.stage === "fluency" && block.fluencySprintGame
          ? block.fluencySprintGame.targetResponseSpeedSec
          : 0,
      targetMasteryScore: block.guidedPracticeGame?.targetMasteryScore ?? 80,
      targetSpeedSec: unit.gate_max_speed_sec,
      questions,
      provenanceByQuestionId,
    };
  }

  /**
   * Closes a game session: groups the spiral-mixed responses BY THEIR
   * OWN TOPIC and projects each topic with the SAME deriveTopicSession
   * call the server's GAME replay runs per topic group (parity by
   * construction — a game's prerequisite/review items credit their own
   * topics, never the session's current topic). The roll-up carries the
   * #52 telemetry: accuracy, raw + cognitive speed, speed-vs-target,
   * and spiral-mix provenance counts.
   */
  async completeGameSession(sessionId: string): Promise<GameSessionSummary> {
    const session = this.requireSession(sessionId);
    if (session.kind !== "GAME" || !session.topicId) {
      throw new Error(`Session ${sessionId} is not a game session`);
    }
    const nowMs = this.deps.now();
    const reader = await this.requireReader(session.gradeId);
    const unit = await this.requireUnit(reader, session.unitId);
    const policy = await this.requirePolicy(reader, unit.grade_id);

    // Group responses by their question's own topic (first-appearance
    // order); attribution comes from the session's pack rows — the same
    // trusted-source rule as completeGateSession.
    const byTopic = new Map<string, { responses: SessionResponse[]; unitId: string }>();
    for (const response of session.responses) {
      const question = session.questions.find((q) => q.questionId === response.questionId);
      const topicId = question ? question.topicId : session.topicId;
      const responseUnitId = question ? question.unitId : session.unitId;
      const group = byTopic.get(topicId) ?? { responses: [], unitId: responseUnitId };
      group.responses.push(response);
      byTopic.set(topicId, group);
    }

    const perTopic: GameSessionSummary["perTopic"] = [];
    for (const [topicId, group] of byTopic) {
      const topicCode = topicId.startsWith(`${session.unitId}-`)
        ? topicId.slice(session.unitId.length + 1)
        : topicId;
      const prev = await this.deps.storage.getTopicProgress(session.studentId, topicId);
      const derivation = deriveTopicSession({
        studentId: session.studentId,
        unitId: group.unitId,
        topicId,
        topicCode,
        responses: group.responses,
        motorBaselineSec: session.motorBaselineSec,
        targetSpeedSec: session.targetSpeedSec,
        srPolicy: {
          gradeGrowthFactor: policy.srGrowthFactor,
          maxIntervalCapDays: policy.srMaxIntervalDays,
        },
        prev,
        nowMs,
      });
      const merged = mergeTopicProgress(prev, derivation.fresh);
      merged.nextReviewAt = capNextReviewAt(merged.nextReviewAt, merged.lastReviewedAt, policy);
      await this.deps.storage.upsertTopicProgress(merged);
      perTopic.push({
        topicId,
        topicCode,
        accuracyPct: derivation.accuracyPct,
        medianCogSpeedSec: derivation.medianCogSpeedSec,
        passedTopic: derivation.passedTopic,
        crowns: derivation.crowns,
      });
    }

    // Telemetry roll-up: per-item facts with the engine's GAME audio
    // rule recomputed (identical to the rows submitResponse recorded).
    const stage = session.gameStage ?? "guided";
    const targetMasteryScore = session.gameTargetMasteryScore ?? 80;
    const targetResponseSpeedSec = session.gameTelemetry?.targetResponseSpeedSec ?? 0;
    const itemTelemetry = session.responses.map((response) => {
      const question = session.questions.find((q) => q.questionId === response.questionId);
      const attempt = deriveAttempt({
        response,
        sessionType: session.kind,
        motorBaselineSec: session.motorBaselineSec,
        targetSpeedSec: session.targetSpeedSec,
      });
      return {
        isCorrect: response.isCorrect,
        rawTimeSec: response.rawTimeSec || 3.0,
        cognitiveTimeSec: attempt.cognitiveTimeSec,
        provenance:
          (question && session.provenanceByQuestionId?.[question.questionId]) || "current",
      };
    });
    const rollup = summarizeGameTelemetry(
      itemTelemetry,
      stage,
      targetMasteryScore,
      targetResponseSpeedSec,
    );

    this.sessions.delete(sessionId);
    return {
      sessionId,
      stage,
      archetype: session.gameTelemetry?.archetype ?? "",
      metGoal: rollup.metGoal,
      accuracyPct: rollup.accuracyPct,
      medianCogSpeedSec: rollup.speed.medianCognitiveSec,
      targetSpeedSec: session.targetSpeedSec,
      speed: rollup.speed,
      provenanceCounts: rollup.provenanceCounts,
      perTopic,
    };
  }

  // ------------------------------------------------------------------
  // Boss gate
  // ------------------------------------------------------------------

  /**
   * Opens a boss-gate session (issue #51 spiral composition).
   *
   * The session blends three sources per the registry's
   * interleavedSpiralMix (AGENTS.md binding on Stage 4 gates):
   * 70% current unit (the server's stratified round-robin builder,
   * unchanged — /api/curriculum/unit parity for this share), 20%
   * contrastive prerequisite units (each prerequisite unit's questions,
   * same stratified builder, prerequisite order), 10% due spaced review
   * (#47 review queue, most-forgotten first, one question per due
   * topic). Missing sources degrade deterministically: their share
   * flows back to the current unit, so a pack with no prerequisites and
   * nothing due composes EXACTLY the pre-#51 round-robin selection.
   *
   * spiral: false (the Gold verification path) keeps the pure
   * current-unit retention probe — the 5-item check tests THIS unit's
   * consolidation, not interference.
   */
  async startGateSession(params: {
    studentId: string;
    gradeId: string;
    unitId: string;
    count?: number;
    motorBaselineSec?: number;
    /** Blend 70/20/10 (default) or pure current-unit selection. */
    spiral?: boolean;
  }): Promise<GateSessionStart> {
    const reader = await this.requireReader(params.gradeId);
    const unit = await this.requireUnit(reader, params.unitId);
    const topicRows = await reader.topicsForUnit(params.unitId);
    const count = params.count ?? unit.gate_question_count ?? 12;

    const currentPool = this.stratifiedQuestions(
      (await reader.questionsForUnit(params.unitId)).map(packQuestionToPracticeQuestion),
      topicRows.map((t) => t.topic_code),
      count,
    );

    const prereqPool: PracticeQuestion[] = [];
    const reviewPool: PracticeQuestion[] = [];
    if (params.spiral !== false) {
      const selected = new Set(currentPool.map((q) => q.questionId));
      // Due spaced review claims its questions FIRST (most-forgotten
      // order): a topic that is both a prerequisite and due would
      // otherwise have its only picked question consumed by the
      // prerequisite share, starving the 10% review slice.
      const policy = await this.requirePolicy(reader, unit.grade_id);
      const progressRows = await this.deps.storage.allTopicProgress(params.studentId);
      const queue = buildReviewQueue({ nowMs: this.deps.now(), policy, rows: progressRows });
      for (const item of queue) {
        if (reviewPool.length >= count) break;
        if (item.unitId === params.unitId) continue;
        const rows = await reader.questionsForTopic(item.topicId, 1);
        const row = rows[0];
        if (!row) continue;
        const q = packQuestionToPracticeQuestion(row);
        if (selected.has(q.questionId)) continue;
        reviewPool.push(q);
        selected.add(q.questionId);
      }
      for (const prereqId of parsePrerequisiteUnitIds(unit.prerequisite_unit_ids_json)) {
        const prereqTopics = await reader.topicsForUnit(prereqId);
        for (const q of this.stratifiedQuestions(
          (await reader.questionsForUnit(prereqId)).map(packQuestionToPracticeQuestion),
          prereqTopics.map((t) => t.topic_code),
          count,
        )) {
          if (!selected.has(q.questionId)) {
            prereqPool.push(q);
            selected.add(q.questionId);
          }
        }
      }
    }

    const allocation = allocateSpiral(count, {
      prerequisite: prereqPool.length,
      review: reviewPool.length,
    });
    const buckets: Record<SpiralSource, PracticeQuestion[]> = {
      current: currentPool.slice(0, allocation.current),
      prerequisite: prereqPool.slice(0, allocation.prerequisite),
      review: reviewPool.slice(0, allocation.review),
    };
    const questions: PracticeQuestion[] = [];
    const cursors: Record<SpiralSource, number> = { current: 0, prerequisite: 0, review: 0 };
    for (const source of interleaveSpiral(allocation)) {
      const question = buckets[source][cursors[source]];
      if (question) {
        questions.push(question);
        cursors[source] += 1;
      }
    }

    const sessionId = this.deps.newSessionId(params.studentId);
    const startedAtMs = this.deps.now();
    this.sessions.set(sessionId, {
      kind: "GATE",
      sessionId,
      studentId: params.studentId,
      gradeId: params.gradeId,
      unitId: params.unitId,
      topicId: null,
      topicCode: null,
      questions,
      responses: [],
      motorBaselineSec: this.motorBaseline(params.motorBaselineSec),
      targetSpeedSec: unit.gate_max_speed_sec,
      startedAtMs,
    });

    return {
      sessionId,
      sessionType: "GATE",
      startedAtMs,
      unit: {
        unitId: unit.unit_id,
        title: unit.title,
        masteryGate: {
          questionCount: unit.gate_question_count,
          minAccuracyPercent: unit.gate_min_accuracy_pct,
          maxMedianResponseTimeSec: unit.gate_max_speed_sec,
          challengeZoneStreak: unit.gate_streak_req,
        },
        skillTopics: topicRows.map((t) => ({
          topicId: t.topic_id,
          code: t.topic_code,
          name: t.topic_name,
        })),
      },
      questions,
      targetSpeedSec: unit.gate_max_speed_sec,
    };
  }

  /**
   * Closes a gate session: runs the SAME engine call the server runs
   * (evaluateMasteryGateAttempt on the pack-reconstructed unit), merges
   * the unit projection, and applies the local two-key machine (Silver
   * on pass; Gold stays pending the 14 h + verification route).
   */
  async completeGateSession(sessionId: string): Promise<GateSessionSummary> {
    const session = this.requireSession(sessionId);
    if (session.kind !== "GATE") throw new Error(`Session ${sessionId} is not a gate session`);
    const nowMs = this.deps.now();
    const reader = await this.requireReader(session.gradeId);
    const unit = await this.requireUnit(reader, session.unitId);
    const topicRows = await reader.topicsForUnit(session.unitId);
    const policy = await this.requirePolicy(reader, unit.grade_id);

    const unitObj = packUnitToEngineUnit(unit, topicRows);
    const verdict = evaluateMasteryGateAttempt({
      unit: unitObj,
      // Topic attribution comes from the PACK rows the session's
      // questions were built from — the trusted source — with the
      // caller-supplied code only as a fallback for responses whose
      // question left the session set. #51 spiral sessions mix in
      // prerequisite/review questions from OTHER units; their short
      // topic codes would collide with the gate unit's own codes, so
      // foreign attribution is namespaced to the FULL topic id — the
      // exact rule the #48 server replay applies
      // (services/api/sync.mjs: same-unit -> short code, foreign ->
      // full topicId). The gate-parity test pins both sides.
      responses: session.responses.map((r) => {
        const question = session.questions.find((q) => q.questionId === r.questionId);
        return {
          topicCode: question
            ? question.topicId.startsWith(`${session.unitId}-`)
              ? question.topicCode
              : question.topicId
            : r.topicCode,
          isCorrect: r.isCorrect,
          rawTimeSec: r.rawTimeSec,
          audioDurationSec: r.audioDurationSec || 0,
        };
      }),
      motorBaselineSec: session.motorBaselineSec,
    });

    const prev = await this.deps.storage.getUnitProgress(session.studentId, session.unitId);
    const derivation = deriveGateSession({
      studentId: session.studentId,
      unitId: session.unitId,
      verdict,
      targetSpeedSec: unit.gate_max_speed_sec,
      srPolicy: {
        gradeGrowthFactor: policy.srGrowthFactor,
        maxIntervalCapDays: policy.srMaxIntervalDays,
      },
      prev,
      nowMs,
    });
    const merged = mergeUnitProgress(prev, derivation.fresh);
    await this.deps.storage.upsertUnitProgress(merged);
    this.sessions.delete(sessionId);

    return {
      sessionId,
      passed: verdict.passed,
      keyState: merged.keyState,
      provisional: merged.provisional,
      overallAccuracyPct: verdict.overallAccuracyPct ?? 0,
      requiredAccuracyPct: verdict.requiredAccuracyPct ?? 0,
      medianCogSpeedSec: verdict.medianCogSpeedSec ?? 0,
      targetSpeedSec: unit.gate_max_speed_sec,
      p80CogSpeedSec: verdict.p80CogSpeedSec ?? 0,
      maxTailAllowedSec: verdict.maxTailAllowedSec ?? 0,
      rapidGuessViolations: verdict.rapidGuessViolations ?? 0,
      finalStreakPassed: verdict.finalStreakPassed ?? false,
      challengeStreakRequired: unit.gate_streak_req,
      failedTopics: verdict.failedTopics ?? [],
      topicBreakdown: verdict.topicBreakdown ?? [],
      // The engine's empty-responses early return omits these; coerce at
      // the boundary (typed-seam advisory, #47 review finding 2).
      remediationMode: verdict.remediationMode ?? "",
      remediationPrescription: verdict.remediationPrescription ?? "",
      conditions: verdict.conditions ?? {},
      unitProgress: merged,
    };
  }

  // ------------------------------------------------------------------
  // Gold verification (two-key sleep consolidation)
  // ------------------------------------------------------------------

  /** Current two-key status for a unit (read-only). */
  async goldStatus(studentId: string, unitId: string): Promise<GoldStatus> {
    const row = await this.deps.storage.getUnitProgress(studentId, unitId);
    const silverAwardedAt = row?.silverAwardedAt ?? 0;
    const keyState = row?.keyState ?? null;
    return {
      keyState,
      provisional: row?.provisional ?? false,
      silverAwardedAt,
      goldVerifiedAt: row?.goldVerifiedAt ?? 0,
      goldEligibleAtMs: goldEligibleAtMs(silverAwardedAt),
      eligible: keyState === "SILVER_KEY" && this.deps.now() >= goldEligibleAtMs(silverAwardedAt),
    };
  }

  /**
   * Opens the 5-item Gold verification session (only meaningful once
   * goldStatus().eligible; completion re-checks the window). The check
   * is a pure current-unit retention probe — spiral composition stays
   * OFF (issue #51: the 5-item/60-second/>=4-of-5 check tests THIS
   * unit's sleep consolidation, not interference).
   */
  async startGoldVerification(params: {
    studentId: string;
    gradeId: string;
    unitId: string;
    motorBaselineSec?: number;
  }): Promise<GateSessionStart> {
    const start = await this.startGateSession({
      ...params,
      count: TWO_KEY_RULES.day2GoldKeyVerificationItems,
      spiral: false,
    });
    const session = this.requireSession(start.sessionId);
    session.kind = "GOLD_VERIFICATION";
    return { ...start, sessionType: "GOLD_VERIFICATION" };
  }

  async completeGoldVerification(sessionId: string): Promise<GoldVerificationSummary> {
    const session = this.requireSession(sessionId);
    if (session.kind !== "GOLD_VERIFICATION") {
      throw new Error(`Session ${sessionId} is not a Gold verification session`);
    }
    const nowMs = this.deps.now();
    const correctCount = session.responses.filter((r) => r.isCorrect).length;
    const prev = await this.deps.storage.getUnitProgress(session.studentId, session.unitId);
    const derivation = deriveGoldVerification({
      studentId: session.studentId,
      unitId: session.unitId,
      correctCount,
      prev,
      nowMs,
    });
    this.sessions.delete(sessionId);
    if (derivation.upgraded && derivation.record) {
      await this.deps.storage.upsertUnitProgress(derivation.record);
      return {
        sessionId,
        correctCount,
        requiredCount: TWO_KEY_RULES.day2MinPassCount,
        upgraded: true,
        keyState: derivation.record.keyState,
        reason: "GOLD_KEY awarded after sleep-consolidation verification",
      };
    }
    const status = prev?.keyState;
    const reason = !prev
      ? "no unit progress yet"
      : status !== "SILVER_KEY"
        ? `key state is ${String(status)}`
        : nowMs < goldEligibleAtMs(prev.silverAwardedAt)
          ? "14-hour consolidation window not yet elapsed"
          : `verification below ${TWO_KEY_RULES.day2MinPassCount} correct`;
    return {
      sessionId,
      correctCount,
      requiredCount: TWO_KEY_RULES.day2MinPassCount,
      upgraded: false,
      keyState: prev?.keyState ?? null,
      reason,
    };
  }

  // ------------------------------------------------------------------
  // Review queue + reads (seams for #49/#50)
  // ------------------------------------------------------------------

  /** Due review items for the student's active grade (most-forgotten first). */
  async reviewQueue(studentId: string, gradeId: string) {
    const reader = await this.requireReader(gradeId);
    const policy = await this.requirePolicy(reader, gradeId);
    const rows = await this.deps.storage.allTopicProgress(studentId);
    return buildReviewQueue({ nowMs: this.deps.now(), policy, rows });
  }

  async unitProgress(studentId: string, unitId: string): Promise<UnitProgressRecord | null> {
    return this.deps.storage.getUnitProgress(studentId, unitId);
  }

  /** #48 seam: pending unsynced attempts. */
  async unsyncedAttemptCount(studentId: string): Promise<number> {
    return this.recorder.unsyncedCount(studentId);
  }

  /** #48 seam: live session ids (the sync liveness probe — open
   *  sessions are deferred so batches carry only whole sessions). */
  activeSessionIds(): string[] {
    return [...this.sessions.keys()];
  }

  /**
   * Drops an open session WITHOUT projecting it (issue #50 exit path).
   * Every already-recorded attempt stays durable in the append-only log
   * (responses are INSERTed the moment they arrive — the log is the
   * source of truth and #48 reconciliation re-derives progress from
   * it), but no topic/unit projection row is written and the session
   * leaves the liveness map so sync batching is never wedged by an
   * abandoned session. Returns false when the session id was unknown.
   */
  abandonSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  // ------------------------------------------------------------------
  // Internals
  // ------------------------------------------------------------------

  /**
   * The server's stratified builder (/api/curriculum/unit and the #47
   * pre-spiral gate composition): questions grouped by topic, one per
   * topic round-robin in topic-sequence order, wrapping within a
   * topic's pool. Prefix-stable, so slicing the result composes
   * identically to running the builder for the smaller count.
   */
  private stratifiedQuestions(
    allQuestions: PracticeQuestion[],
    topicCodes: string[],
    count: number,
  ): PracticeQuestion[] {
    const byTopic = new Map<string, PracticeQuestion[]>();
    for (const q of allQuestions) {
      const bucket = byTopic.get(q.topicCode) ?? [];
      bucket.push(q);
      byTopic.set(q.topicCode, bucket);
    }
    const selected: PracticeQuestion[] = [];
    for (let i = 0; i < count; i += 1) {
      const tCode = topicCodes[i % topicCodes.length];
      if (tCode === undefined) break;
      const pool = byTopic.get(tCode) ?? allQuestions;
      const picked = pool[Math.floor(i / topicCodes.length) % pool.length];
      if (picked) selected.push(picked);
    }
    return selected;
  }

  private motorBaseline(provided?: number): number {
    return provided || this.deps.motorBaselineSec || DEFAULT_MOTOR_BASELINE_SEC;
  }

  private requireSession(sessionId: string): SessionState {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown or completed session ${sessionId}`);
    return session;
  }

  private async requireReader(gradeId: string): Promise<PackContentReader> {
    const reader = await this.deps.openContent(gradeId);
    if (!reader) throw new Error(`No installed content pack for grade ${gradeId}`);
    return reader;
  }

  private async requireUnit(reader: PackContentReader, unitId: string) {
    const unit = await reader.unit(unitId);
    if (!unit) throw new Error(`Unit ${unitId} not found in installed pack`);
    return unit;
  }

  private async requirePolicy(reader: PackContentReader, gradeId: string): Promise<GradeSrPolicy> {
    const policy = await reader.gradePolicy(gradeId);
    if (!policy) throw new Error(`No SR policy for grade ${gradeId} in installed pack`);
    return policy;
  }
}
