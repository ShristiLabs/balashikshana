/**
 * Gate-runner session store (issue #51) — pure reducer matrices:
 * phase machine, stale-session guard, anti-guess freeze, gold-check
 * budget boundaries (at / 1 ms before / 1 ms after), ceremony
 * transitions, and the entry-status view model incl. the 14-hour
 * countdown math.
 */
import { describe, expect, it } from "vitest";
import { fixtureQuestion } from "./helpers/runnerFixtures";
import {
  currentGateQuestion,
  gateReducer,
  goldRemainingMs,
  initialGateState,
  statusEntry,
} from "../src/gate/gateStore";

const GOLD = {
  keyState: null,
  provisional: false,
  silverAwardedAt: 0,
  goldEligibleAtMs: 0,
  eligible: false,
} as const;

function startedState(overrides?: Partial<ReturnType<typeof initialGateState>>) {
  const questions = [
    fixtureQuestion({ questionId: "K-M2-G-Q1", topicId: "K-M2-G" }),
    fixtureQuestion({ questionId: "K-M2-H-Q1", topicId: "K-M2-H" }),
  ];
  let state = gateReducer(initialGateState(), {
    type: "status-loaded",
    unitId: "K-M2",
    unitTitle: "Numbers to 10",
    gradeId: "kindergarten",
    gold: GOLD,
    nowMs: 1_000,
  });
  state = gateReducer(state, {
    type: "session-started",
    sessionId: "sess-1",
    questions,
    stageByQuestionId: {},
    mode: "gate",
    startedAtMs: 1_000,
    deadlineMs: 0,
  });
  return { state, questions };
}

describe("phase machine", () => {
  it("loads status, starts sessions, records responses, advances", () => {
    const { state } = startedState();
    expect(state.phase).toBe("question");
    expect(currentGateQuestion(state)?.questionId).toBe("K-M2-G-Q1");

    let next = gateReducer(state, {
      type: "response-recorded",
      sessionId: "sess-1",
      isCorrect: true,
      correctAnswer: "3",
      explanation: "",
      fluencyGrade: 3,
      cognitiveTimeSec: 2.2,
      freezeUntilMs: 0,
      wasRapidGuess: false,
    });
    expect(next.phase).toBe("feedback");
    expect(next.streak).toBe(1);
    expect(next.answeredCount).toBe(1);

    next = gateReducer(next, { type: "continue-pressed", sessionId: "sess-1" });
    expect(next.phase).toBe("question");
    expect(next.index).toBe(1);

    next = gateReducer(next, {
      type: "response-recorded",
      sessionId: "sess-1",
      isCorrect: false,
      correctAnswer: "3",
      explanation: "",
      fluencyGrade: 1,
      cognitiveTimeSec: 1.1,
      freezeUntilMs: 5_000,
      wasRapidGuess: true,
    });
    expect(next.streak).toBe(0);
    expect(next.checked?.wasRapidGuess).toBe(true);
    expect(next.checked?.freezeUntilMs).toBe(5_000);

    // Last item: continue holds the feedback view until the screen's
    // completion dispatches results.
    const held = gateReducer(next, { type: "continue-pressed", sessionId: "sess-1" });
    expect(held.phase).toBe("feedback");

    const done = gateReducer(next, {
      type: "gate-summary-ready",
      sessionId: "sess-1",
      summary: { sessionId: "sess-1", passed: true } as never,
    });
    expect(done.phase).toBe("results");
  });

  it("ignores stale-session actions (the #49/#50 active-id guard)", () => {
    const { state } = startedState();
    const stale = gateReducer(state, {
      type: "draft-changed",
      sessionId: "sess-OTHER",
      draft: "3",
    });
    expect(stale).toBe(state);
    const staleResponse = gateReducer(state, {
      type: "response-recorded",
      sessionId: "sess-OTHER",
      isCorrect: true,
      correctAnswer: "3",
      explanation: "",
      fluencyGrade: 3,
      cognitiveTimeSec: 2,
      freezeUntilMs: 0,
      wasRapidGuess: false,
    });
    expect(staleResponse).toBe(state);
  });

  it("tick only folds the clock (pure)", () => {
    const { state } = startedState();
    const ticked = gateReducer(state, { type: "tick", nowMs: 9_999 });
    expect(ticked.nowMs).toBe(9_999);
    expect(ticked.sessionId).toBe(state.sessionId);
  });
});

describe("gold-check budget", () => {
  function goldCheckState(deadlineMs: number, nowMs: number) {
    const questions = [fixtureQuestion({ questionId: "K-M2-G-Q1" })];
    let state = gateReducer(initialGateState(), {
      type: "status-loaded",
      unitId: "K-M2",
      unitTitle: "u",
      gradeId: "kindergarten",
      gold: GOLD,
      nowMs,
    });
    state = gateReducer(state, {
      type: "session-started",
      sessionId: "sess-9",
      questions,
      stageByQuestionId: {},
      mode: "goldCheck",
      startedAtMs: deadlineMs - 60_000,
      deadlineMs,
    });
    return state;
  }

  it("remaining is exact at the boundaries", () => {
    expect(goldRemainingMs(goldCheckState(61_000, 1_000))).toBe(60_000);
    // 1 ms before the deadline: 1 ms remains.
    expect(goldRemainingMs(goldCheckState(61_000, 60_999))).toBe(1);
    // At the deadline: 0.
    expect(goldRemainingMs(goldCheckState(61_000, 61_000))).toBe(0);
    // Past it: clamped at 0, never negative.
    expect(goldRemainingMs(goldCheckState(61_000, 75_000))).toBe(0);
  });

  it("is 0 outside a gold check", () => {
    const { state } = startedState();
    expect(goldRemainingMs(state)).toBe(0);
  });

  it("verification results land in their own phase", () => {
    const state = goldCheckState(61_000, 1_000);
    const done = gateReducer(state, {
      type: "verification-ready",
      sessionId: "sess-9",
      summary: {
        sessionId: "sess-9",
        correctCount: 4,
        requiredCount: 4,
        upgraded: true,
        keyState: "GOLD_KEY",
        reason: "upgraded",
        xpAwarded: 20,
      },
    });
    expect(done.phase).toBe("verification-result");
    expect(done.verification?.upgraded).toBe(true);
  });
});

describe("ceremony transitions", () => {
  it("reveals instantly under reduced motion, builds then reveals otherwise", () => {
    const base = startedState().state;
    const reduced = gateReducer(base, {
      type: "ceremony-started",
      kind: "silver",
      animationsEnabled: false,
    });
    expect(reduced.phase).toBe("ceremony");
    expect(reduced.ceremony?.phase).toBe("revealed");

    const animated = gateReducer(base, {
      type: "ceremony-started",
      kind: "gold",
      animationsEnabled: true,
    });
    expect(animated.ceremony?.phase).toBe("building");
    const revealed = gateReducer(animated, { type: "ceremony-event", event: "built" });
    expect(revealed.ceremony?.phase).toBe("revealed");
    // 'built' is idempotent after the reveal.
    expect(gateReducer(revealed, { type: "ceremony-event", event: "built" }).ceremony?.phase).toBe(
      "revealed",
    );
    const done = gateReducer(revealed, { type: "ceremony-done" });
    expect(done.phase).toBe("done");
    expect(done.ceremony).toBeNull();
  });
});

describe("statusEntry (entry view model incl. countdown math)", () => {
  const silver = (eligibleAtMs: number) => ({
    keyState: "SILVER_KEY" as const,
    provisional: true,
    silverAwardedAt: 1_000,
    goldEligibleAtMs: eligibleAtMs,
    eligible: false,
  });

  it("offers the gate with no key", () => {
    const entry = statusEntry({ ...GOLD }, "Numbers to 10", 5_000);
    expect(entry.kind).toBe("offer-gate");
  });

  it("counts down while the 14-hour window is closed", () => {
    const eligibleAt = 14 * 3_600_000;
    // 1 ms before: still counting down with exactly 1 ms left.
    const before = statusEntry(silver(eligibleAt), null, eligibleAt - 1);
    expect(before.kind).toBe("countdown");
    expect(before.kind === "countdown" && before.remainingMs).toBe(1);
    // At the instant: the check is offered.
    const at = statusEntry(silver(eligibleAt), null, eligibleAt);
    expect(at.kind).toBe("offer-gold-check");
    // Past it: still offered (the window never closes again).
    const after = statusEntry(silver(eligibleAt), null, eligibleAt + 1);
    expect(after.kind).toBe("offer-gold-check");
  });

  it("celebrates a held Gold key", () => {
    const entry = statusEntry(
      {
        keyState: "GOLD_KEY",
        provisional: false,
        silverAwardedAt: 1,
        goldEligibleAtMs: 2,
        eligible: true,
      },
      "Numbers to 10",
      5_000,
    );
    expect(entry.kind).toBe("gold-earned");
  });

  it("a degenerate Silver row (no award timestamp) falls back to the plain gate offer", () => {
    // goldEligibleAtMs(0) is a positive constant, so without the
    // silverAwardedAt guard this row would advertise a Gold check that
    // can never upgrade (review finding 2).
    const entry = statusEntry(
      {
        keyState: "SILVER_KEY",
        provisional: true,
        silverAwardedAt: 0,
        goldEligibleAtMs: 14 * 3_600_000,
        eligible: false,
      },
      "Numbers to 10",
      1_700_000_000_000,
    );
    expect(entry.kind).toBe("offer-gate");
  });
});
