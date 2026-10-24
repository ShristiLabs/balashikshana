/**
 * Gate-runner session store (issue #51) — PURE reducer module.
 *
 * Owns the boss-gate UI state machine: entry status (key state +
 * Gold-window countdown) -> 3-tap motor warm-up -> question flow
 * (answer draft -> check -> feedback, with the anti-guess freeze) ->
 * results (five-condition breakdown) -> key ceremony -> done. The Gold
 * verification check reuses the same phases under mode "goldCheck"
 * with a 60-second budget ticking down.
 *
 * Doctrine (same as #50's sessionStore): session-scoped actions carry
 * the sessionId and the reducer IGNORES stale ones; the store holds no
 * clock and performs no I/O — timing capture, engine calls, and the
 * completion/abandon side effects live in the screen. `nowMs` is only
 * ever folded in by tick actions the screen dispatches.
 */
import type { CeremonyKind, CeremonyState } from "./ceremony";
import { initialCeremony } from "./ceremony";
import type { GateSessionSummary, GoldVerificationSummary } from "../practice/practiceEngine";
import type { PracticeQuestion } from "../practice/types";

export type GateMode = "gate" | "goldCheck";

export type GatePhase =
  | "loading"
  | "no-pack"
  | "error"
  | "status"
  | "warmup"
  | "question"
  | "feedback"
  | "results"
  | "verification-result"
  | "ceremony"
  | "done";

export interface GateCheckedFeedback {
  isCorrect: boolean;
  correctAnswer: string;
  explanation: string;
  fluencyGrade: number;
  cognitiveTimeSec: number;
  /** Anti-guess freeze: epoch-ms until CHECK/CONTINUE unlocks (0 = none). */
  freezeUntilMs: number;
  /** True when this response was a rapid-guess violation (gentle copy). */
  wasRapidGuess: boolean;
}

export interface GateGoldStatus {
  keyState: "SILVER_KEY" | "GOLD_KEY" | null;
  provisional: boolean;
  silverAwardedAt: number;
  goldEligibleAtMs: number;
  eligible: boolean;
}

export interface GateState {
  phase: GatePhase;
  error: string | null;
  unitId: string | null;
  unitTitle: string | null;
  /** Effective grade (journey param or snapshot), resolved once at load. */
  gradeId: string | null;
  gold: GateGoldStatus;
  /** Folded by tick actions; drives countdown + freeze display. */
  nowMs: number;
  mode: GateMode;
  sessionId: string | null;
  motorBaselineSec: number | null;
  questions: PracticeQuestion[];
  index: number;
  questionById: Record<string, PracticeQuestion>;
  /** Engine-derived CPA stage per question id (computed at session start). */
  stageByQuestionId: Record<string, string>;
  draft: string | null;
  checked: GateCheckedFeedback | null;
  streak: number;
  answeredCount: number;
  /** Gold check budget (mode goldCheck): deadline epoch-ms, 0 otherwise. */
  goldCheckDeadlineMs: number;
  gateSummary: GateSessionSummary | null;
  verification: GoldVerificationSummary | null;
  ceremony: CeremonyState | null;
}

export function initialGateState(): GateState {
  return {
    phase: "loading",
    error: null,
    unitId: null,
    unitTitle: null,
    gradeId: null,
    gold: {
      keyState: null,
      provisional: false,
      silverAwardedAt: 0,
      goldEligibleAtMs: 0,
      eligible: false,
    },
    nowMs: 0,
    mode: "gate",
    sessionId: null,
    motorBaselineSec: null,
    questions: [],
    index: 0,
    questionById: {},
    stageByQuestionId: {},
    draft: null,
    checked: null,
    streak: 0,
    answeredCount: 0,
    goldCheckDeadlineMs: 0,
    gateSummary: null,
    verification: null,
    ceremony: null,
  };
}

export type GateAction =
  | {
      type: "status-loaded";
      unitId: string;
      unitTitle: string;
      gradeId: string;
      gold: GateGoldStatus;
      nowMs: number;
    }
  | { type: "no-pack" }
  | { type: "load-failed"; error: string }
  | { type: "tick"; nowMs: number }
  | { type: "gate-start-requested" }
  | { type: "gold-check-start-requested" }
  | { type: "warmup-completed"; motorBaselineSec: number }
  | {
      type: "session-started";
      sessionId: string;
      questions: PracticeQuestion[];
      stageByQuestionId: Record<string, string>;
      mode: GateMode;
      startedAtMs: number;
      /** Gold-check budget deadline (0 for the boss gate). */
      deadlineMs: number;
    }
  | { type: "draft-changed"; sessionId: string; draft: string | null }
  | {
      type: "response-recorded";
      sessionId: string;
      isCorrect: boolean;
      correctAnswer: string;
      explanation: string;
      fluencyGrade: number;
      cognitiveTimeSec: number;
      freezeUntilMs: number;
      wasRapidGuess: boolean;
    }
  | { type: "continue-pressed"; sessionId: string }
  | { type: "gate-summary-ready"; sessionId: string; summary: GateSessionSummary }
  | { type: "verification-ready"; sessionId: string; summary: GoldVerificationSummary }
  | { type: "session-failed"; sessionId: string; error: string }
  | { type: "ceremony-started"; kind: CeremonyKind; animationsEnabled: boolean }
  | { type: "ceremony-event"; event: "built" | "dismiss" }
  | { type: "ceremony-done" };

function isLiveSession(state: GateState, sessionId: string | undefined): boolean {
  return sessionId === undefined || sessionId === state.sessionId;
}

/** Remaining gold-check budget in ms (0 when not in a gold check). */
export function goldRemainingMs(state: GateState): number {
  if (state.mode !== "goldCheck" || state.goldCheckDeadlineMs <= 0) return 0;
  return Math.max(0, state.goldCheckDeadlineMs - state.nowMs);
}

export function gateReducer(state: GateState, action: GateAction): GateState {
  switch (action.type) {
    case "status-loaded":
      return {
        ...state,
        phase: "status",
        unitId: action.unitId,
        unitTitle: action.unitTitle,
        gradeId: action.gradeId,
        gold: action.gold,
        nowMs: action.nowMs,
      };
    case "no-pack":
      return { ...state, phase: "no-pack", error: null };
    case "load-failed":
      return { ...state, phase: "error", error: action.error };
    case "tick":
      // Pure fold: countdown/freeze/budget displays read the new nowMs.
      return { ...state, nowMs: action.nowMs };
    case "gate-start-requested":
      return { ...state, mode: "gate", phase: "warmup", ceremony: null };
    case "gold-check-start-requested":
      return { ...state, mode: "goldCheck", phase: "warmup", ceremony: null };
    case "warmup-completed":
      return { ...state, motorBaselineSec: action.motorBaselineSec };
    case "session-started":
      return {
        ...state,
        phase: "question",
        sessionId: action.sessionId,
        mode: action.mode,
        questions: action.questions,
        index: 0,
        questionById: Object.fromEntries(action.questions.map((q) => [q.questionId, q])),
        stageByQuestionId: action.stageByQuestionId,
        draft: null,
        checked: null,
        streak: 0,
        answeredCount: 0,
        goldCheckDeadlineMs: action.deadlineMs,
        gateSummary: null,
        verification: null,
        ceremony: null,
      };
    case "draft-changed":
      if (!isLiveSession(state, action.sessionId)) return state;
      return { ...state, draft: action.draft };
    case "response-recorded": {
      if (!isLiveSession(state, action.sessionId)) return state;
      return {
        ...state,
        phase: "feedback",
        draft: null,
        checked: {
          isCorrect: action.isCorrect,
          correctAnswer: action.correctAnswer,
          explanation: action.explanation,
          fluencyGrade: action.fluencyGrade,
          cognitiveTimeSec: action.cognitiveTimeSec,
          freezeUntilMs: action.freezeUntilMs,
          wasRapidGuess: action.wasRapidGuess,
        },
        streak: action.isCorrect ? state.streak + 1 : 0,
        answeredCount: state.answeredCount + 1,
      };
    }
    case "continue-pressed": {
      if (!isLiveSession(state, action.sessionId)) return state;
      const next = state.index + 1;
      if (next >= state.questions.length) {
        // Past the last item: the screen completes the session and
        // dispatches results; hold the feedback view until then.
        return state;
      }
      return { ...state, phase: "question", index: next, draft: null, checked: null };
    }
    case "gate-summary-ready":
      if (!isLiveSession(state, action.sessionId)) return state;
      return { ...state, phase: "results", gateSummary: action.summary, checked: null };
    case "verification-ready":
      if (!isLiveSession(state, action.sessionId)) return state;
      return {
        ...state,
        phase: "verification-result",
        verification: action.summary,
        checked: null,
      };
    case "session-failed":
      if (!isLiveSession(state, action.sessionId)) return state;
      return { ...state, phase: "error", error: action.error };
    case "ceremony-started":
      return {
        ...state,
        phase: "ceremony",
        ceremony: initialCeremony(action.kind, action.animationsEnabled),
      };
    case "ceremony-event":
      if (!state.ceremony) return state;
      return {
        ...state,
        ceremony:
          action.event === "built"
            ? state.ceremony.phase === "building"
              ? { ...state.ceremony, phase: "revealed" }
              : state.ceremony
            : { ...state.ceremony, phase: "dismissed" },
      };
    case "ceremony-done":
      return { ...state, phase: "done", ceremony: null };
    default:
      return state;
  }
}

/** The question the flow points at (null past the end). */
export function currentGateQuestion(state: GateState): PracticeQuestion | null {
  const question = state.questions[state.index];
  return question ? (state.questionById[question.questionId] ?? question) : null;
}

export type StatusEntry =
  | { kind: "offer-gate"; headline: string; subline: string }
  | { kind: "countdown"; headline: string; subline: string; remainingMs: number }
  | { kind: "offer-gold-check"; headline: string; subline: string }
  | { kind: "gold-earned"; headline: string; subline: string };

/**
 * Entry-screen view model from the current two-key status (pure).
 * Copy stays gentle per D6 — no loss framing anywhere.
 */
export function statusEntry(
  gold: GateGoldStatus,
  unitTitle: string | null,
  nowMs: number,
): StatusEntry {
  if (gold.keyState === "GOLD_KEY") {
    return {
      kind: "gold-earned",
      headline: "Gold key earned!",
      subline: `${unitTitle ?? "This unit"} is mastered for good. Keep exploring!`,
    };
  }
  // silverAwardedAt > 0 mirrors the journey model's guard: a
  // degenerate row (SILVER without an award timestamp) can never open
  // a real window (goldEligibleAtMs(0) is a constant, so the countdown
  // math is meaningless) — fall through to the plain gate offer
  // instead of advertising a check that cannot upgrade.
  if (gold.keyState === "SILVER_KEY" && gold.silverAwardedAt > 0 && gold.goldEligibleAtMs > 0) {
    const remainingMs = Math.max(0, gold.goldEligibleAtMs - nowMs);
    if (remainingMs > 0) {
      return {
        kind: "countdown",
        headline: "Silver key earned!",
        subline:
          "A Gold key check unlocks after a good night's sleep. Practice more or come back tomorrow!",
        remainingMs,
      };
    }
    return {
      kind: "offer-gold-check",
      headline: "Gold check ready!",
      subline: "Five quick questions, one minute. Pass 4 to turn Silver into Gold.",
    };
  }
  return {
    kind: "offer-gate",
    headline: "Boss gate",
    subline: `${unitTitle ?? "This unit"}'s five-condition boss gate. Pass all five to earn the Silver key.`,
  };
}
