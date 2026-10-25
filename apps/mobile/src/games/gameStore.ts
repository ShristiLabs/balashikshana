/**
 * Game-session store (issue #52) - PURE reducer module.
 *
 * Same doctrine as the #50 runner store: the UI state machine (resolve
 * -> stage pick -> warmup handoff -> question flow with the expanding
 * re-queue ladder -> summary), session-scoped actions carry the
 * sessionId and stale ones are IGNORED (the #49 active-id guard), the
 * store holds no clock and performs no I/O. The re-queue ladder is the
 * #50 scheduler reused verbatim (applyGradedResponse, Lag +2/+5/+10,
 * MAX_SESSION_ITEMS cap) - game sessions honor the same pedagogy as
 * practice.
 */
import type { GameSessionStart, GameSessionSummary } from "../practice/practiceEngine";
import type { PracticeQuestion } from "../practice/types";
import { applyGradedResponse, initialSchedule, type RequeueSchedule } from "../runner/requeue";

export type GamePhase =
  "loading" | "no-pack" | "error" | "stage-pick" | "warmup" | "question" | "feedback" | "summary";

export interface GameCheckedFeedback {
  isCorrect: boolean;
  correctAnswer: string;
  explanation: string;
  isRequeue: boolean;
  fluencyGrade: number;
  cognitiveTimeSec: number;
}

export interface GameRouteInfo {
  /** The resolved route decision (game or fallback), for the banner + telemetry. */
  kind: "game" | "practice-fallback";
  archetype: string | null;
  reason: string | null;
  gameTitle: string;
  stage: "guided" | "fluency" | null;
  targetResponseSpeedSec: number;
}

export interface GameState {
  phase: GamePhase;
  error: string | null;
  unitId: string | null;
  unitTitle: string | null;
  topicCode: string | null;
  topicName: string | null;
  /** The session topic's engine id (`${unitId}-${topicCode}`), used
   * to select THIS topic's row out of a spiral-heavy summary (the
   * stream can order a foreign topic first - #53 carry-over fix 2). */
  topicId: string | null;
  /** Stages the topic's registry games block offers (stage-pick phase). */
  offeredStages: ("guided" | "fluency")[];
  route: GameRouteInfo | null;
  /** Live session id; stale-action guard key. */
  sessionId: string | null;
  schedule: RequeueSchedule;
  index: number;
  questionById: Record<string, PracticeQuestion>;
  stageByQuestionId: Record<string, string>;
  provenanceByQuestionId: Record<string, "current" | "contrastive" | "spaced-review">;
  draft: string | null;
  checked: GameCheckedFeedback | null;
  streak: number;
  answeredCount: number;
  requeuedSeen: number;
  /** Fluency target (0 = untimed) for the in-session speed hint. */
  targetResponseSpeedSec: number | null;
  /**
   * #56 hearts mirror: the engine session's heart count when the D6
   * predicate mounted hearts (G2/G3 x fluency), null otherwise. Null
   * IS the no-fail guard — no hearts UI renders for Pre-K–G1 or guided
   * sessions because this stays null (the engine set it, not the UI).
   */
  heartsRemaining: number | null;
  summary: GameSessionSummary | null;
}

export function initialGameState(): GameState {
  return {
    phase: "loading",
    error: null,
    unitId: null,
    unitTitle: null,
    topicCode: null,
    topicName: null,
    topicId: null,
    offeredStages: [],
    route: null,
    sessionId: null,
    schedule: { items: [] },
    index: 0,
    questionById: {},
    stageByQuestionId: {},
    provenanceByQuestionId: {},
    draft: null,
    checked: null,
    streak: 0,
    answeredCount: 0,
    requeuedSeen: 0,
    targetResponseSpeedSec: null,
    heartsRemaining: null,
    summary: null,
  };
}

export type GameAction =
  | {
      type: "resolved";
      unitId: string;
      unitTitle: string;
      topicCode: string;
      topicName: string;
      offeredStages: ("guided" | "fluency")[];
    }
  | { type: "no-pack" }
  | { type: "load-failed"; error: string }
  | { type: "stage-selected"; stage: "guided" | "fluency" }
  | {
      type: "session-started";
      sessionId: string;
      start: GameSessionStart;
      stageByQuestionId: Record<string, string>;
    }
  | { type: "draft-changed"; sessionId: string; draft: string | null }
  | {
      type: "response-recorded";
      sessionId: string;
      isCorrect: boolean;
      correctAnswer: string;
      explanation: string;
      isRequeue: boolean;
      fluencyGrade: number;
      cognitiveTimeSec: number;
      origin: "initial" | "requeue";
      index: number;
      questionId: string;
      /** #56 engine hearts transition (absent in non-hearts sessions). */
      hearts?: { remaining: number; lost: boolean };
    }
  | { type: "continue-pressed"; sessionId: string }
  | { type: "summary-ready"; sessionId: string; summary: GameSessionSummary }
  | { type: "summary-failed"; sessionId: string; error: string };

function isLiveSession(state: GameState, sessionId: string | undefined): boolean {
  return sessionId === undefined || sessionId === state.sessionId;
}

export function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case "resolved":
      // #53 carry-over fix 3: a single offered stage no longer
      // auto-advances to warmup - EVERY resolution routes through the
      // explicit stage affordance (the child sees and taps the stage
      // card, exactly like the two-stage case).
      return {
        ...state,
        phase: "stage-pick",
        error: null,
        unitId: action.unitId,
        unitTitle: action.unitTitle,
        topicCode: action.topicCode,
        topicName: action.topicName,
        offeredStages: action.offeredStages,
      };
    case "no-pack":
      return { ...state, phase: "no-pack", error: null };
    case "load-failed":
      return { ...state, phase: "error", error: action.error };
    case "stage-selected":
      // #53 carry-over fix 1: a restart must not carry the finished
      // session's id or leftovers (a stale id would make exit abandon
      // an already-completed session and leave a stray draft).
      return {
        ...state,
        phase: "warmup",
        sessionId: null,
        schedule: { items: [] },
        index: 0,
        draft: null,
        checked: null,
        streak: 0,
        answeredCount: 0,
        requeuedSeen: 0,
        heartsRemaining: null,
        summary: null,
      };
    case "session-started":
      return {
        ...state,
        phase: "question",
        sessionId: action.sessionId,
        topicId: action.start.topicId,
        schedule: initialSchedule(action.start.questions),
        index: 0,
        questionById: Object.fromEntries(action.start.questions.map((q) => [q.questionId, q])),
        stageByQuestionId: action.stageByQuestionId,
        provenanceByQuestionId: action.start.provenanceByQuestionId,
        draft: null,
        checked: null,
        streak: 0,
        answeredCount: 0,
        requeuedSeen: 0,
        targetResponseSpeedSec: action.start.targetResponseSpeedSec,
        // #56: straight off the engine's start payload — the D6
        // predicate already decided (G2/G3 x fluency => HEART_COUNT,
        // everything else null). The UI never re-derives the tier.
        heartsRemaining: action.start.heartsRemaining,
        summary: null,
        route: {
          kind: "game",
          archetype: action.start.archetype,
          reason: null,
          gameTitle: action.start.gameTitle,
          stage: action.start.stage,
          targetResponseSpeedSec: action.start.targetResponseSpeedSec,
        },
      };
    case "draft-changed":
      if (!isLiveSession(state, action.sessionId)) return state;
      return { ...state, draft: action.draft };
    case "response-recorded": {
      if (!isLiveSession(state, action.sessionId)) return state;
      // Fold the expanding-retrieval ladder (the #50 scheduler, reused)
      // before recording feedback so the progress denominator counts
      // re-queues.
      const schedule = applyGradedResponse(state.schedule, {
        questionId: action.questionId,
        origin: action.origin,
        fluencyGrade: action.fluencyGrade,
        index: action.index,
      });
      return {
        ...state,
        phase: "feedback",
        schedule,
        draft: null,
        checked: {
          isCorrect: action.isCorrect,
          correctAnswer: action.correctAnswer,
          explanation: action.explanation,
          isRequeue: action.isRequeue,
          fluencyGrade: action.fluencyGrade,
          cognitiveTimeSec: action.cognitiveTimeSec,
        },
        streak: action.isCorrect ? state.streak + 1 : 0,
        answeredCount: state.answeredCount + 1,
        requeuedSeen: state.requeuedSeen + (action.isRequeue ? 1 : 0),
        // #56: mirror the engine's authoritative transition (hearts
        // sessions only — the action carries hearts otherwise nothing
        // moves; a non-hearts session can never gain hearts here).
        ...(state.heartsRemaining !== null && action.hearts
          ? { heartsRemaining: action.hearts.remaining }
          : {}),
      };
    }
    case "continue-pressed": {
      if (!isLiveSession(state, action.sessionId)) return state;
      const next = state.index + 1;
      if (next >= state.schedule.items.length) {
        // The screen completes the session and dispatches summary-ready;
        // hold the feedback view until then.
        return state;
      }
      return { ...state, phase: "question", index: next, draft: null, checked: null };
    }
    case "summary-ready":
      if (!isLiveSession(state, action.sessionId)) return state;
      return { ...state, phase: "summary", summary: action.summary, checked: null };
    case "summary-failed":
      if (!isLiveSession(state, action.sessionId)) return state;
      return { ...state, phase: "error", error: action.error };
    default:
      return state;
  }
}

/** The question the schedule points at (or null past the end). */
export function currentGameQuestion(state: GameState): PracticeQuestion | null {
  const item = state.schedule.items[state.index];
  return item ? (state.questionById[item.questionId] ?? null) : null;
}

/** The engine-derived CPA stage for the current question's topic. */
export function currentGameStage(state: GameState): string {
  const question = currentGameQuestion(state);
  return question
    ? (state.stageByQuestionId[question.questionId] ?? "CONCRETE_INTERACTIVE")
    : "CONCRETE_INTERACTIVE";
}

/** Provenance chip label for a bucket (kid-facing, shape+color redundant). */
export const PROVENANCE_LABELS: Readonly<Record<string, string>> = {
  current: "This topic",
  contrastive: "Warm-up mix",
  "spaced-review": "Memory boost",
};
