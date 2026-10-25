/**
 * Game-session store reducer matrices (issue #52): phase machine,
 * stale-session guard (the #49 active-id doctrine), the re-queue fold
 * on response-recorded, and summary hand-off.
 */
import { describe, expect, it } from "vitest";
import type { GameSessionStart, GameSessionSummary } from "../src/practice/practiceEngine";
import {
  currentGameQuestion,
  currentGameStage,
  gameReducer,
  initialGameState,
  PROVENANCE_LABELS,
  type GameAction,
} from "../src/games/gameStore";

function startFixture(overrides: Partial<GameSessionStart> = {}): GameSessionStart {
  return {
    sessionId: "sess-1",
    unitId: "K-M2",
    unitTitle: "Numbers to 10",
    topicId: "K-M2-G",
    topicCode: "G",
    topicName: "Counting to 10",
    stage: "fluency",
    archetype: "block-builder",
    gameId: "game_fluency_K-M2-G",
    gameTitle: "Counting Blitz",
    targetResponseSpeedSec: 5.5,
    targetMasteryScore: 80,
    targetSpeedSec: 6,
    // #56: the fixture's K-M2 topic is a kindergarten pack row, so the
    // D6 predicate would NOT mount hearts for it — null mirrors that
    // (hearts tests override explicitly).
    heartsRemaining: null,
    questions: [
      {
        questionId: "K-M2-G-Q1",
        topicId: "K-M2-G",
        unitId: "K-M2",
        topicCode: "G",
        topicName: "Counting to 10",
        difficultyLevel: 1,
        interactionType: "multiple-choice",
        prompt: "Pick 3",
        visualAid: "assets/images/ten_frame_and_number_line.svg",
        choices: ["3", "2"],
        correctAnswer: "3",
        misconceptionTags: [],
        explanation: "",
      },
      {
        questionId: "K-M1-D-Q1",
        topicId: "K-M1-D",
        unitId: "K-M1",
        topicCode: "D",
        topicName: "Counting to 5",
        difficultyLevel: 1,
        interactionType: "multiple-choice",
        prompt: "Pick 2",
        visualAid: "assets/images/ten_frame_and_number_line.svg",
        choices: ["2", "5"],
        correctAnswer: "2",
        misconceptionTags: [],
        explanation: "",
      },
    ],
    provenanceByQuestionId: { "K-M2-G-Q1": "current", "K-M1-D-Q1": "contrastive" },
    ...overrides,
  };
}

describe("gameReducer", () => {
  it("resolved -> stage-pick for BOTH one and two offered stages (#53 carry-over fix 3: single-stage never auto-advances past the explicit affordance)", () => {
    const both = gameReducer(initialGameState(), {
      type: "resolved",
      unitId: "K-M2",
      unitTitle: "T",
      topicCode: "G",
      topicName: "Counting",
      offeredStages: ["guided", "fluency"],
    });
    expect(both.phase).toBe("stage-pick");

    const one = gameReducer(initialGameState(), {
      type: "resolved",
      unitId: "K-M2",
      unitTitle: "T",
      topicCode: "G",
      topicName: "Counting",
      offeredStages: ["fluency"],
    });
    expect(one.phase).toBe("stage-pick");
  });

  it("stage-selected -> warmup AND clears the finished session's leftovers (#53 carry-over fix 1: no stale id, draft, or summary rides a restart)", () => {
    let state = gameReducer(initialGameState(), {
      type: "resolved",
      unitId: "K-M2",
      unitTitle: "T",
      topicCode: "G",
      topicName: "Counting",
      offeredStages: ["fluency"],
    });
    state = gameReducer(state, {
      type: "session-started",
      sessionId: "sess-1",
      start: startFixture(),
      stageByQuestionId: {},
    });
    state = gameReducer(state, {
      type: "summary-ready",
      sessionId: "sess-1",
      summary: {
        sessionId: "sess-1",
        stage: "fluency",
        archetype: "block-builder",
        metGoal: true,
        accuracyPct: 100,
        medianCogSpeedSec: 1,
        targetSpeedSec: 6,
        speed: { targetSec: 5.5, medianRawSec: 2, medianCognitiveSec: 1, beatTargetPct: 50 },
        provenanceCounts: { current: 1, contrastive: 1, "spaced-review": 0 },
        perTopic: [],
        xpAwarded: 0,
        coinsAwarded: 0,
        celebration: {
          badgesAwarded: [],
          leveledUp: false,
          level: 1,
          streakDays: 1,
          streakIncreased: false,
        },
      },
    });
    expect(state.phase).toBe("summary");

    const restarted = gameReducer(state, { type: "stage-selected", stage: "fluency" });
    expect(restarted.phase).toBe("warmup");
    expect(restarted.sessionId).toBeNull();
    expect(restarted.draft).toBeNull();
    expect(restarted.checked).toBeNull();
    expect(restarted.summary).toBeNull();
    expect(restarted.schedule.items).toHaveLength(0);
    expect(restarted.answeredCount).toBe(0);
  });

  it("session-started records the session topicId (summary selection keys on it, #53 fix 2)", () => {
    let state = gameReducer(initialGameState(), {
      type: "resolved",
      unitId: "K-M2",
      unitTitle: "T",
      topicCode: "G",
      topicName: "Counting",
      offeredStages: ["fluency"],
    });
    state = gameReducer(state, {
      type: "session-started",
      sessionId: "sess-1",
      start: startFixture(),
      stageByQuestionId: {},
    });
    expect(state.topicId).toBe("K-M2-G");
  });

  it("session-started builds the schedule, lookups, and route banner", () => {
    const start = startFixture();
    let state = gameReducer(initialGameState(), {
      type: "resolved",
      unitId: "K-M2",
      unitTitle: "T",
      topicCode: "G",
      topicName: "Counting",
      offeredStages: ["fluency"],
    });
    state = gameReducer(state, {
      type: "session-started",
      sessionId: start.sessionId,
      start,
      stageByQuestionId: { "K-M2-G-Q1": "PICTORIAL_STATIC", "K-M1-D-Q1": "CONCRETE_INTERACTIVE" },
    });
    expect(state.phase).toBe("question");
    expect(state.schedule.items).toHaveLength(2);
    expect(currentGameQuestion(state)?.questionId).toBe("K-M2-G-Q1");
    expect(currentGameStage(state)).toBe("PICTORIAL_STATIC");
    expect(state.route).toMatchObject({
      kind: "game",
      archetype: "block-builder",
      stage: "fluency",
      targetResponseSpeedSec: 5.5,
    });
  });

  it("response-recorded folds the ladder and streaks; stale sessions are ignored", () => {
    const start = startFixture();
    let state = gameReducer(initialGameState(), {
      type: "session-started",
      sessionId: start.sessionId,
      start,
      stageByQuestionId: {},
    });
    // A miss (fluency 1) on item 0 triggers the +2/+5/+10 ladder.
    state = gameReducer(state, {
      type: "response-recorded",
      sessionId: "sess-1",
      isCorrect: false,
      correctAnswer: "3",
      explanation: "",
      isRequeue: false,
      fluencyGrade: 1,
      cognitiveTimeSec: 1.5,
      origin: "initial",
      index: 0,
      questionId: "K-M2-G-Q1",
    });
    expect(state.phase).toBe("feedback");
    expect(state.schedule.items).toHaveLength(5); // 2 + 3 re-queues
    expect(state.streak).toBe(0);
    expect(state.checked?.isCorrect).toBe(false);

    // Stale session id: the action is dropped entirely.
    const stale = gameReducer(state, {
      type: "draft-changed",
      sessionId: "sess-old",
      draft: "3",
    });
    expect(stale).toBe(state);
  });

  it("continue-pressed advances; past the end it holds for the summary dispatch", () => {
    const start = startFixture();
    let state = gameReducer(initialGameState(), {
      type: "session-started",
      sessionId: start.sessionId,
      start,
      stageByQuestionId: {},
    });
    state = { ...state, phase: "feedback" };
    const advanced = gameReducer(state, { type: "continue-pressed", sessionId: "sess-1" });
    expect(advanced.phase).toBe("question");
    expect(advanced.index).toBe(1);

    const atEnd = { ...advanced, phase: "feedback" as const, index: 4 }; // past last item
    const held = gameReducer(atEnd, { type: "continue-pressed", sessionId: "sess-1" });
    expect(held).toBe(atEnd); // screen owns completion
  });

  it("summary-ready swaps to the summary phase", () => {
    const start = startFixture();
    let state = gameReducer(initialGameState(), {
      type: "session-started",
      sessionId: start.sessionId,
      start,
      stageByQuestionId: {},
    });
    const summary: GameSessionSummary = {
      sessionId: "sess-1",
      stage: "fluency",
      archetype: "block-builder",
      metGoal: true,
      accuracyPct: 100,
      medianCogSpeedSec: 1.5,
      targetSpeedSec: 6,
      speed: { targetSec: 5.5, medianRawSec: 2, medianCognitiveSec: 1.5, beatTargetPct: 100 },
      provenanceCounts: { current: 1, contrastive: 1, "spaced-review": 0 },
      perTopic: [
        {
          topicId: "K-M2-G",
          topicCode: "G",
          accuracyPct: 100,
          medianCogSpeedSec: 1.5,
          passedTopic: true,
          crowns: 2,
        },
      ],
      xpAwarded: 0,
      coinsAwarded: 0,
      celebration: {
        badgesAwarded: [],
        leveledUp: false,
        level: 1,
        streakDays: 1,
        streakIncreased: false,
      },
    };
    state = gameReducer(state, { type: "summary-ready", sessionId: "sess-1", summary });
    expect(state.phase).toBe("summary");
    expect(state.summary?.metGoal).toBe(true);
  });

  it("load-failed and no-pack cover the error surfaces", () => {
    expect(gameReducer(initialGameState(), { type: "no-pack" }).phase).toBe("no-pack");
    expect(gameReducer(initialGameState(), { type: "load-failed", error: "boom" })).toMatchObject({
      phase: "error",
      error: "boom",
    });
  });

  it("provenance labels are kid-facing and complete", () => {
    expect(PROVENANCE_LABELS.current).toBe("This topic");
    expect(PROVENANCE_LABELS.contrastive).toBe("Warm-up mix");
    expect(PROVENANCE_LABELS["spaced-review"]).toBe("Memory boost");
  });
});

// ---------------------------------------------------------------------------
// #56 hearts mirror: the store REFLECTS engine transitions verbatim and
// computes nothing (no hearts math, no tier rule — the engine owns both).
// ---------------------------------------------------------------------------

describe("hearts mirror (#56: reflect-only, never computed)", () => {
  function heartsSession(): ReturnType<typeof gameReducer> {
    let state = gameReducer(initialGameState(), {
      type: "resolved",
      unitId: "K-M2",
      unitTitle: "T",
      topicCode: "G",
      topicName: "Counting",
      offeredStages: ["fluency"],
    });
    state = gameReducer(state, { type: "stage-selected", stage: "fluency" });
    return gameReducer(state, {
      type: "session-started",
      sessionId: "sess-h",
      // The engine mounted hearts (a G2/G3 fluency sprint): HEART_COUNT.
      start: startFixture({ heartsRemaining: 5 }),
      stageByQuestionId: {},
    });
  }

  function response(
    overrides: Partial<Extract<GameAction, { type: "response-recorded" }>> = {},
  ): Extract<GameAction, { type: "response-recorded" }> {
    return {
      type: "response-recorded",
      sessionId: "sess-h",
      isCorrect: false,
      correctAnswer: "3",
      explanation: "",
      isRequeue: false,
      fluencyGrade: 1,
      cognitiveTimeSec: 4,
      origin: "initial",
      index: 0,
      questionId: "K-M2-G-Q1",
      ...overrides,
    };
  }

  it("mirrors the engine's start count and per-response transitions verbatim", () => {
    let state = heartsSession();
    expect(state.heartsRemaining).toBe(5);

    // First-answer miss: engine transition says 4 — the store copies it.
    state = gameReducer(state, response({ hearts: { remaining: 4, lost: true } }));
    expect(state.heartsRemaining).toBe(4);

    // Re-queued repeat (the ladder re-presentation): the engine lost
    // nothing — the mirror must not move either.
    state = gameReducer(
      state,
      response({
        isRequeue: true,
        origin: "requeue",
        index: 2,
        hearts: { remaining: 4, lost: false },
      }),
    );
    expect(state.heartsRemaining).toBe(4);
  });

  it("a non-hearts session (null) can NEVER gain hearts, even from a stray transition", () => {
    let state = gameReducer(initialGameState(), {
      type: "resolved",
      unitId: "K-M2",
      unitTitle: "T",
      topicCode: "G",
      topicName: "Counting",
      offeredStages: ["fluency"],
    });
    state = gameReducer(state, { type: "stage-selected", stage: "fluency" });
    // Kindergarten fixture: the D6 predicate did NOT mount hearts.
    state = gameReducer(state, {
      type: "session-started",
      sessionId: "sess-nh",
      start: startFixture(),
      stageByQuestionId: {},
    });
    expect(state.heartsRemaining).toBeNull();

    // Defensive impossibility (a buggy action carrying hearts into a
    // non-hearts session): the null guard must swallow it.
    state = gameReducer(state, {
      type: "response-recorded",
      sessionId: "sess-nh",
      isCorrect: false,
      correctAnswer: "3",
      explanation: "",
      isRequeue: false,
      fluencyGrade: 1,
      cognitiveTimeSec: 4,
      origin: "initial",
      index: 0,
      questionId: "K-M2-G-Q1",
      hearts: { remaining: 4, lost: true },
    });
    expect(state.heartsRemaining).toBeNull();
  });

  it("play-again resets the mirror to null until the next engine start payload", () => {
    let state = heartsSession();
    state = gameReducer(state, response({ hearts: { remaining: 4, lost: true } }));
    expect(state.heartsRemaining).toBe(4);

    const restarted = gameReducer(state, { type: "stage-selected", stage: "fluency" });
    expect(restarted.heartsRemaining).toBeNull();
  });
});
