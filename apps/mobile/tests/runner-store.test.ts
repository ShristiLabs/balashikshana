/**
 * Runner store tests (issue #50): the session state machine lifecycle,
 * re-queue integration through the reducer, and the stale-session
 * guard (the #49 race-class fix applied to the runner).
 */
import { describe, expect, it } from "vitest";
import { CPA_STAGES } from "@balashikshana/core-engine";
import {
  currentQuestion,
  currentStage,
  initialRunnerState,
  runnerReducer,
  topicPicksFrom,
} from "../src/runner/sessionStore";
import type { TopicProgressRecord } from "../src/practice/types";
import { counterQuestion, fixtureQuestion, tileQuestion } from "./helpers/runnerFixtures";

function startedState(sessionId = "sess-1") {
  const questions = [fixtureQuestion({ questionId: "q1" }), counterQuestion(), tileQuestion()];
  const stageByQuestionId: Record<string, string> = {};
  for (const question of questions) stageByQuestionId[question.questionId] = CPA_STAGES.CONCRETE;
  return runnerReducer(initialRunnerState(), {
    type: "session-started",
    sessionId,
    questions,
    stageByQuestionId,
    prevCrowns: 1,
    targetSpeedSec: 6,
  });
}

describe("lifecycle", () => {
  it("unit-loaded with topics opens the picker; without topics errors", () => {
    const withTopics = runnerReducer(initialRunnerState(), {
      type: "unit-loaded",
      unitId: "U",
      unitTitle: "Unit",
      topics: [
        {
          topicId: "U-T",
          topicCode: "T",
          topicName: "Topic",
          crowns: 0,
          cpaStage: "CONCRETE_INTERACTIVE",
        },
      ],
    });
    expect(withTopics.phase).toBe("picker");

    const empty = runnerReducer(initialRunnerState(), {
      type: "unit-loaded",
      unitId: "U",
      unitTitle: "Unit",
      topics: [],
    });
    expect(empty.phase).toBe("error");
  });

  it("topic-selected moves to warmup; warmup-completed stores the baseline", () => {
    let state = runnerReducer(initialRunnerState(), { type: "no-pack" });
    state = runnerReducer(state, {
      type: "unit-loaded",
      unitId: "U",
      unitTitle: "Unit",
      topics: [],
    });
    state = runnerReducer(initialRunnerState(), {
      type: "unit-loaded",
      unitId: "U",
      unitTitle: "Unit",
      topics: [
        {
          topicId: "U-T",
          topicCode: "T",
          topicName: "Topic",
          crowns: 0,
          cpaStage: "CONCRETE_INTERACTIVE",
        },
      ],
    });
    state = runnerReducer(state, { type: "topic-selected", topicCode: "T" });
    expect(state.phase).toBe("warmup");
    state = runnerReducer(state, { type: "warmup-completed", motorBaselineSec: 0.44 });
    expect(state.motorBaselineSec).toBe(0.44);
  });

  it("session-started mounts question 0 with progress counters reset", () => {
    const state = startedState();
    expect(state.phase).toBe("question");
    expect(state.index).toBe(0);
    expect(currentQuestion(state)?.questionId).toBe("q1");
    expect(state.prevCrowns).toBe(1);
    expect(state.answeredCount).toBe(0);
  });

  it("session-started threads targetSpeedSec for the in-session hint (review finding 4)", () => {
    // The feedback bar reads targetSpeedSec during question/feedback
    // phases - BEFORE any summary exists. Reading summary?.targetSpeedSec
    // there was always null (dead "(target Xs)" hint); the start payload
    // now carries the unit's target for the whole session.
    const state = startedState();
    expect(state.summary).toBeNull();
    expect(state.targetSpeedSec).toBe(6);

    // It survives into feedback (checked answers) and resets per session.
    const checked = runnerReducer(state, {
      type: "response-recorded",
      sessionId: "sess-1",
      isCorrect: true,
      correctAnswer: "3",
      explanation: "",
      isRequeue: false,
      fluencyGrade: 4,
      cognitiveTimeSec: 1.1,
      origin: "initial",
      index: 0,
      questionId: "q1",
    });
    expect(checked.phase).toBe("feedback");
    expect(checked.summary).toBeNull();
    expect(checked.targetSpeedSec).toBe(6);

    const restarted = runnerReducer(checked, {
      type: "session-started",
      sessionId: "sess-2",
      questions: [fixtureQuestion({ questionId: "q1" })],
      stageByQuestionId: { q1: CPA_STAGES.CONCRETE },
      prevCrowns: 0,
      targetSpeedSec: 4,
    });
    expect(restarted.targetSpeedSec).toBe(4);
  });
});

describe("answer flow with re-queue integration", () => {
  it("a wrong answer records feedback, breaks the streak, and grows the schedule", () => {
    const state = startedState();
    const checked = runnerReducer(state, {
      type: "response-recorded",
      sessionId: "sess-1",
      isCorrect: false,
      correctAnswer: "3",
      explanation: "Because",
      isRequeue: false,
      fluencyGrade: 1,
      cognitiveTimeSec: 2.5,
      origin: "initial",
      index: 0,
      questionId: "q1",
    });
    expect(checked.phase).toBe("feedback");
    expect(checked.checked?.isCorrect).toBe(false);
    expect(checked.streak).toBe(0);
    expect(checked.answeredCount).toBe(1);
    // Grade 1 on an initial item -> +3 re-queues (8-question cap aside,
    // the 3-question fixture grows by exactly 3).
    expect(checked.schedule.items.length).toBe(6);
  });

  it("a correct answer builds the streak and schedules nothing extra", () => {
    const state = startedState();
    const checked = runnerReducer(state, {
      type: "response-recorded",
      sessionId: "sess-1",
      isCorrect: true,
      correctAnswer: "3",
      explanation: "",
      isRequeue: false,
      fluencyGrade: 4,
      cognitiveTimeSec: 1.1,
      origin: "initial",
      index: 0,
      questionId: "q1",
    });
    expect(checked.streak).toBe(1);
    expect(checked.schedule.items.length).toBe(3);
  });

  it("continue advances; at the tail it holds for the summary", () => {
    let state = startedState();
    state = runnerReducer(state, {
      type: "response-recorded",
      sessionId: "sess-1",
      isCorrect: true,
      correctAnswer: "3",
      explanation: "",
      isRequeue: false,
      fluencyGrade: 3,
      cognitiveTimeSec: 2,
      origin: "initial",
      index: 0,
      questionId: "q1",
    });
    state = runnerReducer(state, { type: "continue-pressed", sessionId: "sess-1" });
    expect(state.index).toBe(1);
    expect(state.phase).toBe("question");

    // Answer the remaining two, then continue past the last item: the
    // reducer holds feedback until summary-ready arrives.
    state = runnerReducer(state, {
      type: "response-recorded",
      sessionId: "sess-1",
      isCorrect: true,
      correctAnswer: "4",
      explanation: "",
      isRequeue: false,
      fluencyGrade: 3,
      cognitiveTimeSec: 2,
      origin: "initial",
      index: 1,
      questionId: "U-T-Q2",
    });
    state = runnerReducer(state, { type: "continue-pressed", sessionId: "sess-1" });
    state = runnerReducer(state, {
      type: "response-recorded",
      sessionId: "sess-1",
      isCorrect: true,
      correctAnswer: "3 4 5",
      explanation: "",
      isRequeue: false,
      fluencyGrade: 3,
      cognitiveTimeSec: 2,
      origin: "initial",
      index: 2,
      questionId: "U-T-Q3",
    });
    const held = runnerReducer(state, { type: "continue-pressed", sessionId: "sess-1" });
    expect(held.phase).toBe("feedback");
  });

  it("summary-ready lands the summary phase", () => {
    let state = startedState();
    state = runnerReducer(state, {
      type: "response-recorded",
      sessionId: "sess-1",
      isCorrect: true,
      correctAnswer: "3",
      explanation: "",
      isRequeue: false,
      fluencyGrade: 3,
      cognitiveTimeSec: 2,
      origin: "initial",
      index: 0,
      questionId: "q1",
    });
    state = runnerReducer(state, {
      type: "summary-ready",
      sessionId: "sess-1",
      summary: {
        sessionId: "sess-1",
        passedTopic: true,
        crownsAwarded: 2,
        accuracyPct: 100,
        medianCogSpeedSec: 2,
        targetSpeedSec: 6,
        fluencyGrade: 4,
        stabilityDays: 2,
        cpaStage: "PICTORIAL_STATIC",
        nextReviewAt: 0,
        xpAwarded: 0,
        celebration: {
          badgesAwarded: [],
          leveledUp: false,
          level: 1,
          streakDays: 1,
          streakIncreased: false,
        },
        coinsAwarded: 0,
        topicProgress: {} as TopicProgressRecord,
      },
    });
    expect(state.phase).toBe("summary");
    expect(state.summary?.passedTopic).toBe(true);
  });
});

describe("stale-session guard (#49 race class)", () => {
  it("ignores actions from a session that is no longer live", () => {
    const state = startedState("sess-old");
    const stale = runnerReducer(state, {
      type: "response-recorded",
      sessionId: "sess-new",
      isCorrect: true,
      correctAnswer: "3",
      explanation: "",
      isRequeue: false,
      fluencyGrade: 3,
      cognitiveTimeSec: 1,
      origin: "initial",
      index: 0,
      questionId: "q1",
    });
    expect(stale).toBe(state);

    const staleContinue = runnerReducer(stale, {
      type: "continue-pressed",
      sessionId: "sess-new",
    });
    expect(staleContinue).toBe(state);
  });

  it("ignores a stale summary (the completion callback of a dead session)", () => {
    const state = startedState("sess-live");
    const stale = runnerReducer(state, {
      type: "summary-ready",
      sessionId: "sess-dead",
      summary: {
        sessionId: "sess-dead",
        passedTopic: true,
        crownsAwarded: 3,
        accuracyPct: 100,
        medianCogSpeedSec: 1,
        targetSpeedSec: 6,
        fluencyGrade: 4,
        stabilityDays: 3,
        cpaStage: "PICTORIAL_STATIC",
        nextReviewAt: 0,
        xpAwarded: 0,
        celebration: {
          badgesAwarded: [],
          leveledUp: false,
          level: 1,
          streakDays: 1,
          streakIncreased: false,
        },
        coinsAwarded: 0,
        topicProgress: {} as TopicProgressRecord,
      },
    });
    expect(stale).toBe(state);

    const staleFail = runnerReducer(state, {
      type: "summary-failed",
      sessionId: "sess-dead",
      error: "late failure",
    });
    expect(staleFail).toBe(state);
  });

  it("draft updates from a stale session never clobber the live draft", () => {
    const state = startedState("sess-live");
    const updated = runnerReducer(state, {
      type: "draft-changed",
      sessionId: "sess-live",
      draft: "4",
    });
    expect(updated.draft).toBe("4");
    const stale = runnerReducer(updated, {
      type: "draft-changed",
      sessionId: "sess-old",
      draft: "9",
    });
    expect(stale.draft).toBe("4");
  });
});

describe("remaining phases and counters", () => {
  it("no-pack and load-failed land their dedicated phases", () => {
    const noPack = runnerReducer(initialRunnerState(), { type: "no-pack" });
    expect(noPack.phase).toBe("no-pack");
    expect(noPack.error).toBeNull();

    const failed = runnerReducer(initialRunnerState(), {
      type: "load-failed",
      error: "pack read exploded",
    });
    expect(failed.phase).toBe("error");
    expect(failed.error).toBe("pack read exploded");
  });

  it("summary-failed on the live session surfaces the error phase", () => {
    const state = startedState();
    const failed = runnerReducer(state, {
      type: "summary-failed",
      sessionId: "sess-1",
      error: "projection write failed",
    });
    expect(failed.phase).toBe("error");
    expect(failed.error).toBe("projection write failed");
  });

  it("requeuedSeen counts only re-queue presentations", () => {
    let state = startedState();
    state = runnerReducer(state, {
      type: "response-recorded",
      sessionId: "sess-1",
      isCorrect: false,
      correctAnswer: "3",
      explanation: "",
      isRequeue: false,
      fluencyGrade: 1,
      cognitiveTimeSec: 2,
      origin: "initial",
      index: 0,
      questionId: "q1",
    });
    expect(state.requeuedSeen).toBe(0);
    state = runnerReducer(state, {
      type: "response-recorded",
      sessionId: "sess-1",
      isCorrect: true,
      correctAnswer: "3",
      explanation: "",
      isRequeue: true,
      fluencyGrade: 4,
      cognitiveTimeSec: 1,
      origin: "requeue",
      index: 3,
      questionId: "q1",
    });
    expect(state.requeuedSeen).toBe(1);
    expect(state.answeredCount).toBe(2);
  });

  it("a new session over a finished one resets counters; old-session actions stay dead (interruption/resume)", () => {
    let state = startedState("sess-first");
    state = runnerReducer(state, {
      type: "response-recorded",
      sessionId: "sess-first",
      isCorrect: true,
      correctAnswer: "3",
      explanation: "",
      isRequeue: false,
      fluencyGrade: 3,
      cognitiveTimeSec: 2,
      origin: "initial",
      index: 0,
      questionId: "q1",
    });
    expect(state.answeredCount).toBe(1);

    // Child exits (abandon) and re-enters: a fresh session mounts over
    // the old state and every counter resets.
    const restarted = runnerReducer(state, {
      type: "session-started",
      sessionId: "sess-second",
      questions: [fixtureQuestion({ questionId: "q1" })],
      stageByQuestionId: { q1: CPA_STAGES.CONCRETE },
      prevCrowns: 0,
      targetSpeedSec: 6,
    });
    expect(restarted.sessionId).toBe("sess-second");
    expect(restarted.answeredCount).toBe(0);
    expect(restarted.streak).toBe(0);
    expect(restarted.requeuedSeen).toBe(0);
    expect(restarted.schedule.items.length).toBe(1);
    expect(restarted.summary).toBeNull();

    // A late callback from the first session must not resurrect it.
    const late = runnerReducer(restarted, {
      type: "continue-pressed",
      sessionId: "sess-first",
    });
    expect(late).toBe(restarted);
  });
});

describe("stage + picker projections", () => {
  it("currentStage reads the engine-derived stage per question", () => {
    const questions = [fixtureQuestion({ questionId: "q1" })];
    const state = runnerReducer(initialRunnerState(), {
      type: "session-started",
      sessionId: "s",
      questions,
      stageByQuestionId: { q1: CPA_STAGES.ABSTRACT },
      prevCrowns: 0,
      targetSpeedSec: 6,
    });
    expect(currentStage(state)).toBe(CPA_STAGES.ABSTRACT);
  });

  it("topicPicksFrom derives crowns and stage from progress rows", () => {
    const progress: Record<string, TopicProgressRecord> = {
      "U-A": {
        studentId: "s",
        topicId: "U-A",
        unitId: "U",
        topicCode: "A",
        completed: 1,
        crowns: 2,
        masteryScore: 90,
        bestAccuracyPct: 90,
        bestMedianSpeedSec: 3,
        attemptsCount: 3,
        fluencyGrade: 3,
        stabilityDays: 12,
        nextReviewAt: 0,
        lastReviewedAt: 1,
        provisional: true,
        updatedAt: 1,
      },
    };
    const picks = topicPicksFrom(
      [
        { topic_id: "U-A", topic_code: "A", topic_name: "Seen" },
        { topic_id: "U-B", topic_code: "B", topic_name: "New" },
      ],
      progress,
    );
    expect(picks[0]).toMatchObject({ crowns: 2, cpaStage: "PURE_ABSTRACT_SYMBOLIC" });
    expect(picks[1]).toMatchObject({ crowns: 0, cpaStage: "CONCRETE_INTERACTIVE" });
  });
});
