/**
 * Placement session engine (issue #60) — a THIN client adapter over the
 * core-engine placement module (packages/core-engine/src/placement.mjs).
 *
 * All adaptive logic lives in the engine: this class only (1) builds the
 * engine's unit view from installed #46 pack rows, (2) maps
 * engine-generated items into the runner's PracticeQuestion shape,
 * (3) records each answer as an ordinary append-only PLACEMENT attempt
 * (the D8 stream the server replays identically), and (4) at close,
 * derives the outcome with the SAME engine function the server's sync
 * replay calls (derivePlacementOutcome) and applies PROVISIONAL credit
 * locally — stability-only rows that never complete a topic, never
 * crown it, and never touch a key (only a #51 Boss Gate does any of
 * that).
 *
 * Determinism: the probe seed defaults to a session-stable value; the
 * same seed + same answers => the same item sequence and outcome. The
 * seed rides the session (not the wire) — the server never needs it
 * because derivePlacementOutcome is a pure function of the response
 * tallies, not the selection path.
 */
import {
  initialPlacementState,
  placementNextItem,
  recordPlacementResponse,
  derivePlacementOutcome,
  DEFAULT_PLACEMENT_SEED,
  levelForXp,
  type PlacementOutcome,
  type PlacementProbeItem,
} from "@balashikshana/core-engine";
import { AttemptRecorder } from "../practice/attemptRecorder";
import {
  packTopicToEngineTopic,
  packUnitToEngineUnit,
  generatedToPracticeQuestion,
} from "../practice/packShapes";
import { deriveAttempt, mergeTopicProgress } from "../practice/progressProjector";
import { applyTopicLikeSession, initialGamificationState } from "../gamification/rewardsProjector";
import { buildCelebrationReport, type CelebrationReport } from "../mascot/celebrationEvents";
import type {
  AttemptInput,
  PracticeDeps,
  PracticeQuestion,
  TopicProgressRecord,
} from "../practice/types";
import type { GamificationState } from "../gamification/types";

export interface PlacementItemView {
  kind: "probe" | "confirm";
  strand: string;
  unitId: string;
  unitTitle: string;
  question: PracticeQuestion;
}

export interface PlacementSessionStart {
  sessionId: string;
  gradeId: string;
  firstItem: PlacementItemView | null;
}

export interface PlacementSessionSummary {
  sessionId: string;
  itemsAsked: number;
  outcome: PlacementOutcome;
  /** Provisional topic rows written (stability-only). */
  creditedTopics: { topicId: string; unitId: string; stabilityDays: number }[];
  xpAwarded: number;
  celebration: CelebrationReport;
}

interface LiveSession {
  sessionId: string;
  studentId: string;
  gradeId: string;
  motorBaselineSec: number;
  targetSpeedSec: number;
  seed: number;
  probeState: ReturnType<typeof initialPlacementState>;
  engineUnits: {
    unitId: string;
    strand: string;
    sequenceOrder: number;
    title: string;
    prerequisiteUnitIds: string[];
    masteryGate: { maxMedianResponseTimeSec: number };
    skillTopics: { code: string; name: string; assets: Record<string, unknown> }[];
  }[];
  titleByUnit: Map<string, string>;
  currentItem: PlacementItemView | null;
  responses: { unitId: string; topicId: string; isCorrect: boolean; rawTimeSec: number }[];
  responseMeta: {
    questionId: string;
    chosenAnswer: string;
    isCorrect: boolean;
    rawTimeSec: number;
    audioDurationSec: number;
    fluencyGrade: number;
    cognitiveTimeSec: number;
  }[];
}

function parsePrereqs(json: string): string[] {
  try {
    const parsed = JSON.parse(json || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

export class PlacementSessionEngine {
  private readonly deps: PracticeDeps;
  private readonly recorder: AttemptRecorder;
  private readonly sessions = new Map<string, LiveSession>();

  constructor(deps: PracticeDeps) {
    this.deps = deps;
    this.recorder = new AttemptRecorder(deps);
  }

  /**
   * Opens a placement session over the installed pack's units. The
   * engine units carry real skillTopics so items come from the engine's
   * generateProceduralQuestion (the #60 AC), rendered through the
   * runner's established generated-question mapping.
   */
  async start(params: {
    studentId: string;
    gradeId: string;
    motorBaselineSec?: number;
    seed?: number;
  }): Promise<PlacementSessionStart> {
    const reader = await this.deps.openContent(params.gradeId);
    if (!reader) throw new Error(`No content pack installed for grade ${params.gradeId}`);
    const unitRows = await reader.unitsForGrade(params.gradeId);
    if (unitRows.length === 0) throw new Error(`Grade ${params.gradeId} has no units`);

    const topicRows = await reader.topicsForGrade(params.gradeId);
    const topicsByUnit = new Map<string, typeof topicRows>();
    for (const row of topicRows) {
      const list = topicsByUnit.get(row.unit_id) ?? [];
      list.push(row);
      topicsByUnit.set(row.unit_id, list);
    }

    const engineUnits = unitRows.map((unit) => {
      const built = packUnitToEngineUnit(unit, topicsByUnit.get(unit.unit_id) ?? []);
      return {
        unitId: built.unitId,
        strand: unit.subject,
        sequenceOrder: unit.sequence_order,
        title: built.title,
        prerequisiteUnitIds: parsePrereqs(unit.prerequisite_unit_ids_json),
        masteryGate: built.masteryGate,
        skillTopics: (topicsByUnit.get(unit.unit_id) ?? []).map((t) => packTopicToEngineTopic(t)),
      };
    });
    const titleByUnit = new Map(engineUnits.map((u) => [u.unitId, u.title]));
    const unitsBy = new Map(engineUnits.map((u) => [u.unitId, u]));

    const seed = params.seed ?? DEFAULT_PLACEMENT_SEED;
    const motorBaselineSec = this.deps.motorBaselineSec ?? params.motorBaselineSec ?? 0.42;
    const sessionId = this.deps.newSessionId(params.studentId);
    let probeState = initialPlacementState({ units: engineUnits, seed });
    let currentItem: PlacementItemView | null = null;
    const first = placementNextItem(probeState, { unitsBy });
    probeState = first.state;
    if (!first.done && first.item) {
      currentItem = this.toItemView(first.item, titleByUnit, unitsBy);
    }

    this.sessions.set(sessionId, {
      sessionId,
      studentId: params.studentId,
      gradeId: params.gradeId,
      motorBaselineSec,
      targetSpeedSec: unitRows[0]?.gate_max_speed_sec ?? 4.0,
      seed,
      probeState,
      engineUnits,
      titleByUnit,
      currentItem,
      responses: [],
      responseMeta: [],
    });

    return { sessionId, gradeId: params.gradeId, firstItem: currentItem };
  }

  private toItemView(
    item: PlacementProbeItem,
    titleByUnit: Map<string, string>,
    unitsBy: Map<string, { skillTopics: { code: string; name: string }[] }>,
  ): PlacementItemView {
    const topicName =
      unitsBy.get(item.unitId)?.skillTopics.find((t) => t.code === item.topicCode)?.name ??
      item.topicCode;
    const question = generatedToPracticeQuestion(
      item.unitId,
      item.topicId,
      item.topicCode,
      topicName,
      0,
      {
        prompt: item.question.prompt,
        visualAid: item.question.visualAid,
        visualObjects: item.question.visualObjects,
        targetCount: item.question.targetCount,
        maxCounterCells: item.question.maxCounterCells,
        counterEmoji: item.question.counterEmoji,
        tileBank: item.question.tileBank,
        choices: item.question.choices ?? [],
        correctAnswer: item.question.correctAnswer,
        misconceptionTags: item.question.misconceptionTags ?? [],
        explanation: item.question.explanation,
        interactionType: item.question.interactionType || "multiple-choice",
      },
    );
    // The attempt wire carries the ENGINE's deterministic question id
    // (seed-derived), not the generic mapping's -G1 suffix.
    question.questionId = item.question.questionId;
    return {
      kind: item.kind,
      strand: item.strand,
      unitId: item.unitId,
      unitTitle: titleByUnit.get(item.unitId) ?? item.unitId,
      question,
    };
  }

  /** The session's currently open item (null between items / unknown session). */
  current(sessionId: string): PlacementItemView | null {
    return this.sessions.get(sessionId)?.currentItem ?? null;
  }

  /**
   * Records one answer (append-only PLACEMENT attempt on the #48
   * stream) and advances the probe. Returns the next item or null when
   * the stopping rule fired.
   */
  async submit(
    sessionId: string,
    response: {
      questionId: string;
      chosenAnswer: string;
      isCorrect: boolean;
      rawTimeSec: number;
      audioDurationSec?: number;
    },
  ): Promise<PlacementItemView | null> {
    const session = this.require(sessionId);
    const item = session.currentItem;
    if (!item) throw new Error(`Placement session ${sessionId} has no open item`);

    const attempt = deriveAttempt({
      response: {
        topicCode: item.question.topicCode,
        questionId: response.questionId,
        chosenAnswer: response.chosenAnswer,
        isCorrect: response.isCorrect,
        rawTimeSec: response.rawTimeSec,
        audioDurationSec: response.audioDurationSec ?? 0,
        misconceptionTags: item.question.misconceptionTags ?? [],
      },
      sessionType: "PLACEMENT",
      motorBaselineSec: session.motorBaselineSec,
      targetSpeedSec: session.targetSpeedSec,
    });

    const input: AttemptInput = {
      studentId: session.studentId,
      unitId: item.unitId,
      topicId: item.question.topicId,
      questionId: item.question.questionId,
      interactionType: item.question.interactionType,
      chosenAnswer: String(response.chosenAnswer ?? ""),
      isCorrect: Boolean(response.isCorrect),
      rawTimeSec: response.rawTimeSec || 3.0,
      audioDurationSec: response.audioDurationSec ?? 0,
      cognitiveTimeSec: attempt.cognitiveTimeSec,
      fluencyGrade: attempt.fluencyGrade,
      misconceptionTags: item.question.misconceptionTags ?? [],
      sessionType: "PLACEMENT",
      sessionId,
      motorBaselineSec: session.motorBaselineSec,
    };
    await this.recorder.record(input);

    session.probeState = recordPlacementResponse(session.probeState, {
      unitId: item.unitId,
      isCorrect: Boolean(response.isCorrect),
    });
    session.responses.push({
      unitId: item.unitId,
      topicId: item.question.topicId,
      isCorrect: Boolean(response.isCorrect),
      rawTimeSec: response.rawTimeSec || 3.0,
    });
    session.responseMeta.push({
      questionId: response.questionId,
      chosenAnswer: response.chosenAnswer,
      isCorrect: Boolean(response.isCorrect),
      rawTimeSec: response.rawTimeSec || 3.0,
      audioDurationSec: response.audioDurationSec ?? 0,
      fluencyGrade: attempt.fluencyGrade,
      cognitiveTimeSec: attempt.cognitiveTimeSec,
    });

    const unitsBy = new Map(session.engineUnits.map((u) => [u.unitId, u]));
    const next = placementNextItem(session.probeState, { unitsBy });
    session.probeState = next.state;
    session.currentItem =
      next.done || !next.item ? null : this.toItemView(next.item, session.titleByUnit, unitsBy);
    return session.currentItem;
  }

  /**
   * Closes the session: derives the outcome with the SAME engine
   * function the server's sync replay calls, applies provisional
   * topic-credit rows locally (stability-only), and projects per-attempt
   * XP through the shared engine rules (no outcome rewards — nothing
   * was passed).
   */
  async complete(sessionId: string): Promise<PlacementSessionSummary> {
    const session = this.require(sessionId);
    const nowMs = this.deps.now();

    const outcome = derivePlacementOutcome({
      responses: session.responses,
      units: session.engineUnits,
    });

    const creditedTopics: PlacementSessionSummary["creditedTopics"] = [];
    for (const unit of outcome.creditedUnits) {
      for (const topic of unit.topics) {
        if (topic.correctItems <= 0 || topic.provisionalStabilityDays <= 0) continue;
        const topicId = topic.topicId || `${unit.unitId}-${topic.topicCode}`;
        const prev = await this.deps.storage.getTopicProgress(session.studentId, topicId);
        const provisionalRow = this.provisionalRow({
          studentId: session.studentId,
          unitId: unit.unitId,
          topicId,
          topicCode: topic.topicCode,
          stabilityDays: topic.provisionalStabilityDays,
          nowMs,
        });
        const merged = prev ? this.mergeProvisional(prev, provisionalRow) : provisionalRow;
        await this.deps.storage.upsertTopicProgress(merged);
        creditedTopics.push({ topicId, unitId: unit.unitId, stabilityDays: merged.stabilityDays });
      }
    }

    // Optimistic per-attempt XP (D9): the same engine rule the server's
    // replay applies (awardXpForAttempts via applyTopicLikeSession with
    // passed=false — the outcome branch never runs for placement).
    const rewards = await this.projectRewards(session, nowMs);
    this.sessions.delete(sessionId);

    return {
      sessionId,
      itemsAsked: outcome.itemsAsked,
      outcome,
      creditedTopics,
      xpAwarded: rewards.xp,
      celebration: rewards.celebration,
    };
  }

  private provisionalRow(params: {
    studentId: string;
    unitId: string;
    topicId: string;
    topicCode: string;
    stabilityDays: number;
    nowMs: number;
  }): TopicProgressRecord {
    return {
      studentId: params.studentId,
      topicId: params.topicId,
      unitId: params.unitId,
      topicCode: params.topicCode,
      completed: 0,
      crowns: 0,
      masteryScore: 0,
      bestAccuracyPct: 100,
      bestMedianSpeedSec: 0,
      attemptsCount: 1,
      fluencyGrade: 3,
      stabilityDays: params.stabilityDays,
      nextReviewAt: params.nowMs + params.stabilityDays * 86400000,
      lastReviewedAt: params.nowMs,
      provisional: true,
      updatedAt: params.nowMs,
    };
  }

  /**
   * Stability-only merge (mirrors the server's PLACEMENT_TOPIC_CREDIT_SQL
   * semantics): stability grows to at most the provisional band, never
   * regresses a practice-earned value, and completion/crowns/mastery are
   * NEVER granted by placement.
   */
  private mergeProvisional(
    prev: TopicProgressRecord,
    provisional: TopicProgressRecord,
  ): TopicProgressRecord {
    const merged = mergeTopicProgress(prev, provisional);
    merged.completed = prev.completed;
    merged.crowns = prev.crowns;
    merged.masteryScore = prev.masteryScore;
    merged.stabilityDays = Math.max(prev.stabilityDays, provisional.stabilityDays);
    merged.provisional = true;
    return merged;
  }

  private async projectRewards(
    session: LiveSession,
    nowMs: number,
  ): Promise<{ xp: number; coins: number; celebration: CelebrationReport }> {
    const attempts = session.responseMeta.map((meta) => ({
      isCorrect: meta.isCorrect,
      fluencyGrade: meta.fluencyGrade,
      rawTimeSec: meta.rawTimeSec,
    }));
    const gamification = this.deps.gamificationStorage;
    const apply = (state: GamificationState) =>
      applyTopicLikeSession(state, {
        sessionType: "PLACEMENT",
        attempts,
        passed: false,
        crowns: 0,
        sessionMs: nowMs,
        nowMs,
      });
    if (!gamification) {
      const scratch = initialGamificationState(session.studentId, nowMs);
      const levelBefore = levelForXp(scratch.totalXp).level;
      const outcome = apply(scratch);
      return {
        ...outcome,
        celebration: buildCelebrationReport({
          badgesAwarded: [],
          levelBefore,
          levelAfter: levelForXp(scratch.totalXp).level,
          streakBefore: scratch.streakDays,
          streakAfter: scratch.streakDays,
        }),
      };
    }
    const state =
      (await gamification.getGamificationState(session.studentId)) ??
      initialGamificationState(session.studentId, nowMs);
    const levelBefore = levelForXp(state.totalXp).level;
    const streakBefore = state.streakDays;
    const outcome = apply(state);
    await gamification.upsertGamificationState(state);
    return {
      ...outcome,
      celebration: buildCelebrationReport({
        badgesAwarded: [],
        levelBefore,
        levelAfter: levelForXp(state.totalXp).level,
        streakBefore,
        streakAfter: state.streakDays,
      }),
    };
  }

  private require(sessionId: string): LiveSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown placement session ${sessionId}`);
    return session;
  }
}
