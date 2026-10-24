/**
 * Practice-runner session store (issue #50) - PURE reducer module.
 *
 * Owns the runner's UI state machine: topic picker -> motor warm-up ->
 * question flow (answer draft -> check -> feedback -> continue) ->
 * summary, plus exit. Session-scoped actions carry the sessionId and
 * the reducer IGNORES stale ones - the same active-id guard doctrine
 * that fixed the #49 journey grade race (a late async callback for a
 * session the child already left must never poison the live view).
 *
 * The store holds no clock and performs no I/O: timing capture and
 * engine calls live in the screen; the reducer only folds results.
 */
import { CPA_STAGES } from "@balashikshana/core-engine";
import { stageForTopicProgress } from "./cpaStages";
import type { TopicSessionSummary } from "../practice/practiceEngine";
import type { PracticeQuestion, TopicProgressRecord } from "../practice/types";
import { applyGradedResponse, initialSchedule, type RequeueSchedule } from "./requeue";

/** A topic as the picker shows it (progress-derived, never hardcoded). */
export interface TopicPick {
  topicId: string;
  topicCode: string;
  topicName: string;
  crowns: number;
  cpaStage: string;
}

export type RunnerPhase =
  "loading" | "no-pack" | "error" | "picker" | "warmup" | "question" | "feedback" | "summary";

export interface CheckedFeedback {
  isCorrect: boolean;
  correctAnswer: string;
  explanation: string;
  isRequeue: boolean;
  fluencyGrade: number;
  cognitiveTimeSec: number;
}

export interface RunnerState {
  phase: RunnerPhase;
  error: string | null;
  unitId: string | null;
  unitTitle: string | null;
  topics: TopicPick[];
  activeTopicCode: string | null;
  /** Live session id; stale-action guard key. */
  sessionId: string | null;
  motorBaselineSec: number | null;
  schedule: RequeueSchedule;
  index: number;
  questionById: Record<string, PracticeQuestion>;
  stageByQuestionId: Record<string, string>;
  /** Draft answer for the current question (counter total / tile sequence / choice key+label). */
  draft: string | null;
  checked: CheckedFeedback | null;
  streak: number;
  answeredCount: number;
  requeuedSeen: number;
  /** Crowns before the session, for the summary's progress delta. */
  prevCrowns: number | null;
  /** Unit gate target speed from TopicSessionStart - lives for the whole
   *  session so the feedback bar can show the "(target Xs)" hint during
   *  question/feedback phases, before any summary exists (review
   *  finding 4: reading summary?.targetSpeedSec there was always null). */
  targetSpeedSec: number | null;
  summary: TopicSessionSummary | null;
}

export function initialRunnerState(): RunnerState {
  return {
    phase: "loading",
    error: null,
    unitId: null,
    unitTitle: null,
    topics: [],
    activeTopicCode: null,
    sessionId: null,
    motorBaselineSec: null,
    schedule: { items: [] },
    index: 0,
    questionById: {},
    stageByQuestionId: {},
    draft: null,
    checked: null,
    streak: 0,
    answeredCount: 0,
    requeuedSeen: 0,
    prevCrowns: null,
    targetSpeedSec: null,
    summary: null,
  };
}

export type RunnerAction =
  | { type: "unit-loaded"; unitId: string; unitTitle: string; topics: TopicPick[] }
  | { type: "no-pack" }
  | { type: "load-failed"; error: string }
  | { type: "topic-selected"; topicCode: string }
  | { type: "warmup-completed"; motorBaselineSec: number }
  | {
      type: "session-started";
      sessionId: string;
      questions: PracticeQuestion[];
      stageByQuestionId: Record<string, string>;
      prevCrowns: number;
      /** TopicSessionStart.targetSpeedSec, threaded for the in-session hint. */
      targetSpeedSec: number;
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
    }
  | { type: "continue-pressed"; sessionId: string }
  | { type: "summary-ready"; sessionId: string; summary: TopicSessionSummary }
  | { type: "summary-failed"; sessionId: string; error: string };

/** True when the action's session matches the live one (or is session-neutral). */
function isLiveSession(state: RunnerState, sessionId: string | undefined): boolean {
  return sessionId === undefined || sessionId === state.sessionId;
}

export function runnerReducer(state: RunnerState, action: RunnerAction): RunnerState {
  switch (action.type) {
    case "unit-loaded":
      return {
        ...state,
        phase: action.topics.length > 0 ? "picker" : "error",
        error: action.topics.length > 0 ? null : "This unit has no topics yet.",
        unitId: action.unitId,
        unitTitle: action.unitTitle,
        topics: action.topics,
      };
    case "no-pack":
      return { ...state, phase: "no-pack", error: null };
    case "load-failed":
      return { ...state, phase: "error", error: action.error };
    case "topic-selected":
      return { ...state, activeTopicCode: action.topicCode, phase: "warmup" };
    case "warmup-completed":
      return { ...state, motorBaselineSec: action.motorBaselineSec };
    case "session-started":
      return {
        ...state,
        phase: "question",
        sessionId: action.sessionId,
        schedule: initialSchedule(action.questions),
        index: 0,
        questionById: Object.fromEntries(action.questions.map((q) => [q.questionId, q])),
        stageByQuestionId: action.stageByQuestionId,
        draft: null,
        checked: null,
        streak: 0,
        answeredCount: 0,
        requeuedSeen: 0,
        prevCrowns: action.prevCrowns,
        targetSpeedSec: action.targetSpeedSec,
        summary: null,
      };
    case "draft-changed":
      if (!isLiveSession(state, action.sessionId)) return state;
      return { ...state, draft: action.draft };
    case "response-recorded": {
      if (!isLiveSession(state, action.sessionId)) return state;
      // Fold the expanding-retrieval ladder (pure) before recording
      // feedback so the progress denominator includes re-queues.
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
      };
    }
    case "continue-pressed": {
      if (!isLiveSession(state, action.sessionId)) return state;
      const next = state.index + 1;
      if (next >= state.schedule.items.length) {
        // Past the last item: the screen completes the session and
        // dispatches summary-ready; hold the feedback view until then.
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
export function currentQuestion(state: RunnerState): PracticeQuestion | null {
  const item = state.schedule.items[state.index];
  return item ? (state.questionById[item.questionId] ?? null) : null;
}

/** The engine-derived CPA stage for the current question's topic. */
export function currentStage(state: RunnerState): string {
  const question = currentQuestion(state);
  return question
    ? (state.stageByQuestionId[question.questionId] ?? CPA_STAGES.CONCRETE)
    : CPA_STAGES.CONCRETE;
}

/** Topic picks derived from pack rows + progress rows (pure projection). */
export function topicPicksFrom(
  topics: readonly { topic_id: string; topic_code: string; topic_name: string }[],
  progressByTopicId: Record<string, TopicProgressRecord>,
): TopicPick[] {
  return topics.map((topic) => {
    const progress = progressByTopicId[topic.topic_id];
    return {
      topicId: topic.topic_id,
      topicCode: topic.topic_code,
      topicName: topic.topic_name,
      crowns: progress?.crowns ?? 0,
      // Engine-derived stage from the topic's memory stability.
      cpaStage: stageForTopicProgress(progress ?? null),
    };
  });
}
