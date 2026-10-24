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
  it("resolved with two stages -> stage-pick; one stage -> warmup", () => {
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
    expect(one.phase).toBe("warmup");
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
