/**
 * Runner + engine integration tests (issue #50): a full offline session
 * through the real PracticeSessionEngine against the practiceEnv pack
 * fixture - warm-up baseline, per-response durable recording (with
 * session_type + telemetry), re-queue integration with the engine's
 * per-attempt fluency grades, completion projection, and the
 * abandon-on-exit path (attempt integrity + sync liveness).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CPA_STAGES, computeMotorBaselineSec } from "@balashikshana/core-engine";
import { PracticeSessionEngine } from "../src/practice/practiceEngine";
import { stageForTopicProgress } from "../src/runner/cpaStages";
import { applyGradedResponse, initialSchedule, MAX_SESSION_ITEMS } from "../src/runner/requeue";
import type { PracticeDeps } from "../src/practice/types";
import { createPracticeEnv, type PracticeTestEnv } from "./helpers/practiceEnv";

let env: PracticeTestEnv;

beforeEach(() => {
  env = createPracticeEnv();
});

afterEach(() => {
  env.dispose();
});

const STUDENT = "student-1";
const GRADE = "kindergarten";
const UNIT = "K-M2";

async function startedSession(motorBaselineSec = 0.42) {
  const engine = new PracticeSessionEngine(env.deps);
  const start = await engine.startTopicSession({
    studentId: STUDENT,
    gradeId: GRADE,
    unitId: UNIT,
    topicCode: "G",
    motorBaselineSec,
  });
  return { engine, start };
}

describe("full offline session", () => {
  it("runs start -> responses -> completion entirely from the pack (airplane mode)", async () => {
    const { engine, start } = await startedSession();
    expect(start.questions.length).toBe(8);
    expect(start.unitTitle).toBe("Numbers to 10");

    let schedule = initialSchedule(start.questions);
    let index = 0;
    let misses = 0;
    while (index < schedule.items.length && index < MAX_SESSION_ITEMS) {
      const item = schedule.items[index];
      if (!item) break;
      const question = start.questions.find((q) => q.questionId === item.questionId);
      expect(question, `question ${item.questionId} must exist`).toBeDefined();
      // Answer correctly except the first presentation of question 3.
      const isCorrect = !(item.origin === "initial" && index === 2);
      const result = await engine.submitResponse(start.sessionId, {
        topicCode: question!.topicCode,
        questionId: question!.questionId,
        chosenAnswer: isCorrect ? question!.correctAnswer : "definitely-wrong",
        isCorrect,
        rawTimeSec: 2.5,
        audioDurationSec: 0,
      });
      expect(result.fluencyGrade).toBeGreaterThanOrEqual(1);
      expect(result.fluencyGrade).toBeLessThanOrEqual(4);
      schedule = applyGradedResponse(schedule, {
        questionId: question!.questionId,
        origin: item.origin,
        fluencyGrade: result.fluencyGrade,
        index,
      });
      if (!isCorrect) misses += 1;
      index += 1;
    }

    // The one miss scheduled exactly the 3-step ladder (8 -> 11).
    expect(misses).toBe(1);
    expect(schedule.items.length).toBe(11);

    const summary = await engine.completeTopicSession(start.sessionId);
    expect(summary.sessionId).toBe(start.sessionId);
    // 10 of 11 correct (>80%) passes the topic.
    expect(summary.passedTopic).toBe(true);

    // Every presentation is durably in the append-only log with the
    // topic telemetry contract (session_type, motor baseline, grades).
    const unsynced = await env.deps.storage.unsyncedAttemptCount(STUDENT);
    expect(unsynced).toBe(schedule.items.length);
    const topicRow = await env.deps.storage.getTopicProgress(STUDENT, `${UNIT}-G`);
    expect(topicRow).not.toBeNull();
    expect(topicRow?.attemptsCount).toBe(1);
  });

  it("carries the warm-up baseline into every attempt row (#48 replay math)", async () => {
    const baseline = computeMotorBaselineSec([0.6, 0.5, 0.7]);
    const { engine, start } = await startedSession(baseline);
    const question = start.questions[0]!;
    await engine.submitResponse(start.sessionId, {
      topicCode: question.topicCode,
      questionId: question.questionId,
      chosenAnswer: question.correctAnswer,
      isCorrect: true,
      rawTimeSec: 3.0,
      audioDurationSec: 0,
    });
    await engine.abandonSession(start.sessionId);
    const rows = await env.storage.drainUnsynced(STUDENT, 10);
    expect(rows.length).toBe(1);
    expect(rows[0]?.motor_baseline_sec).toBe(baseline);
    expect(rows[0]?.session_type).toBe("TOPIC_PRACTICE");
    expect(rows[0]?.session_id).toBe(start.sessionId);
    // Topic-practice cognitive time mirrors the server: audio 0, so
    // cog = max(0.5, 3.0 - baseline).
    expect(rows[0]?.cognitive_time_sec).toBeCloseTo(Math.max(0.5, 3.0 - baseline), 2);
  });

  it("audio-seam boundary: narration seconds ride the seam but topic practice pins audio-0 math (server parity)", async () => {
    // The runner passes measured narration seconds through
    // audioDurationSec; deriveAttempt intentionally applies audio 0 for
    // TOPIC_PRACTICE sessions (the server's topic-complete loop does the
    // same, so #48 reconciliation replays identically). Gate/verification
    // sessions are the audio-aware path. This test pins the boundary so a
    // change to that policy must consciously update it.
    const baseline = 0.4;
    const { engine, start } = await startedSession(baseline);
    const question = start.questions[0]!;
    await engine.submitResponse(start.sessionId, {
      topicCode: question.topicCode,
      questionId: question.questionId,
      chosenAnswer: question.correctAnswer,
      isCorrect: true,
      rawTimeSec: 3.0,
      audioDurationSec: 0.9,
    });
    await engine.abandonSession(start.sessionId);
    const rows = await env.storage.drainUnsynced(STUDENT, 10);
    expect(rows.length).toBe(1);
    // Audio NOT subtracted for topic practice: cog = max(0.5, 3.0 - 0.4),
    // never max(0.5, 3.0 - 0.4 - 0.9).
    expect(rows[0]?.cognitive_time_sec).toBeCloseTo(Math.max(0.5, 3.0 - baseline), 2);
  });
});

describe("exit safety (abandon)", () => {
  it("abandoned sessions keep attempts durable and leave the sync liveness map", async () => {
    const { engine, start } = await startedSession();
    const question = start.questions[0]!;
    await engine.submitResponse(start.sessionId, {
      topicCode: question.topicCode,
      questionId: question.questionId,
      chosenAnswer: question.correctAnswer,
      isCorrect: true,
      rawTimeSec: 2,
      audioDurationSec: 0,
    });
    expect(engine.activeSessionIds()).toContain(start.sessionId);

    const abandoned = engine.abandonSession(start.sessionId);
    expect(abandoned).toBe(true);
    expect(engine.activeSessionIds()).not.toContain(start.sessionId);

    // Attempt integrity: the response survived (append-only log).
    expect(await env.deps.storage.unsyncedAttemptCount(STUDENT)).toBe(1);
    // No projection row was written for the abandoned session.
    expect(await env.deps.storage.getTopicProgress(STUDENT, `${UNIT}-G`)).toBeNull();
    // Abandoning an unknown id is a clean no-op.
    expect(engine.abandonSession("never-existed")).toBe(false);
  });
});

/**
 * Review finding 1 (HIGH): the screen's submit/complete error paths
 * dispatch summary-failed and MUST abandon the session first - a
 * stranded id stays in the engine liveness map for the process
 * lifetime and syncEngine's upload walk stops at the first
 * active-session group, so that session AND every later one would
 * never sync until app restart. These tests reproduce the exact
 * sequence the (fixed) screen runs: engine call throws -> abandon ->
 * liveness empty, attempts durable.
 */
function withFailingStorage(env: PracticeTestEnv, method: "insertAttempt" | "upsertTopicProgress") {
  let armed = false;
  const storage = new Proxy(env.deps.storage, {
    get(target, prop, receiver) {
      if (prop === method && armed) {
        return async () => {
          throw new Error(`sqlite: ${method} failed (simulated disk fault)`);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return {
    deps: { ...env.deps, storage } as PracticeDeps,
    arm() {
      armed = true;
    },
  };
}

describe("error paths free sync liveness (review finding 1)", () => {
  it("a throwing submitResponse strands liveness until the runner abandons (attempts durable)", async () => {
    const failing = withFailingStorage(env, "insertAttempt");
    const engine = new PracticeSessionEngine(failing.deps);
    const start = await engine.startTopicSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
      topicCode: "G",
      motorBaselineSec: 0.42,
    });

    const first = start.questions[0]!;
    await engine.submitResponse(start.sessionId, {
      topicCode: first.topicCode,
      questionId: first.questionId,
      chosenAnswer: first.correctAnswer,
      isCorrect: true,
      rawTimeSec: 2,
      audioDurationSec: 0,
    });

    // The disk faults on the next durable write: submitResponse throws
    // (the screen's handleCheck catch).
    failing.arm();
    const second = start.questions[1]!;
    await expect(
      engine.submitResponse(start.sessionId, {
        topicCode: second.topicCode,
        questionId: second.questionId,
        chosenAnswer: second.correctAnswer,
        isCorrect: true,
        rawTimeSec: 2,
        audioDurationSec: 0,
      }),
    ).rejects.toThrow("insertAttempt failed");

    // THE STRAND: the failed session is still live in the engine.
    expect(engine.activeSessionIds()).toContain(start.sessionId);

    // The fixed screen abandons before dispatching summary-failed.
    expect(engine.abandonSession(start.sessionId)).toBe(true);
    expect(engine.activeSessionIds()).toEqual([]);

    // Attempt integrity: the pre-fault response stayed durable.
    expect(await env.deps.storage.unsyncedAttemptCount(STUDENT)).toBe(1);
    // No projection row was written.
    expect(await env.deps.storage.getTopicProgress(STUDENT, `${UNIT}-G`)).toBeNull();
  });

  it("a throwing completeTopicSession strands liveness until the runner abandons", async () => {
    const failing = withFailingStorage(env, "upsertTopicProgress");
    const engine = new PracticeSessionEngine(failing.deps);
    const start = await engine.startTopicSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
      topicCode: "G",
      motorBaselineSec: 0.42,
    });
    for (const question of start.questions) {
      await engine.submitResponse(start.sessionId, {
        topicCode: question.topicCode,
        questionId: question.questionId,
        chosenAnswer: question.correctAnswer,
        isCorrect: true,
        rawTimeSec: 1.2,
        audioDurationSec: 0,
      });
    }

    // Projection write faults: completeTopicSession throws BEFORE its
    // sessions.delete (the screen's handleContinue catch).
    failing.arm();
    await expect(engine.completeTopicSession(start.sessionId)).rejects.toThrow(
      "upsertTopicProgress failed",
    );

    // THE STRAND: completion failed, so the engine still holds the id.
    expect(engine.activeSessionIds()).toContain(start.sessionId);

    // The fixed screen abandons before dispatching summary-failed.
    expect(engine.abandonSession(start.sessionId)).toBe(true);
    expect(engine.activeSessionIds()).toEqual([]);

    // All 8 attempts durable; no projection row.
    expect(await env.deps.storage.unsyncedAttemptCount(STUDENT)).toBe(8);
    expect(await env.deps.storage.getTopicProgress(STUDENT, `${UNIT}-G`)).toBeNull();
  });
});

/**
 * Review finding 2 (MEDIUM): the progress snapshot read at mount goes
 * stale after the first session completes its projection; the fixed
 * screen re-reads allTopicProgress in startSession/backToPicker so a
 * back-to-back second session derives its CPA stages from the FRESH
 * row. This test pins the data path: session 1 crosses the
 * concrete -> pictorial boundary, and the fresh read maps every
 * session-2 question to PICTORIAL while the mount-time snapshot (no
 * row) would have kept it CONCRETE - the one-stage-too-concrete bug.
 */
describe("back-to-back sessions use fresh progress (review finding 2)", () => {
  it("session 2 derives PICTORIAL from the fresh row, not CONCRETE from the mount snapshot", async () => {
    const engine = new PracticeSessionEngine(env.deps);
    const mountTimeRows = await env.deps.storage.allTopicProgress(STUDENT);
    expect(mountTimeRows).toEqual([]);

    // Session 1: brand-new topic, all correct and fast.
    const first = await engine.startTopicSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
      topicCode: "G",
      motorBaselineSec: 0.42,
    });
    for (const question of first.questions) {
      await engine.submitResponse(first.sessionId, {
        topicCode: question.topicCode,
        questionId: question.questionId,
        chosenAnswer: question.correctAnswer,
        isCorrect: true,
        rawTimeSec: 1.2,
        audioDurationSec: 0,
      });
    }
    const summary = await engine.completeTopicSession(first.sessionId);

    // The boundary really was crossed: stability >= 1 day now maps to
    // PICTORIAL, and the (stale) mount-time snapshot still maps to
    // CONCRETE - the two disagree, so reading the wrong one is visible.
    const freshRow = await env.deps.storage.getTopicProgress(STUDENT, `${UNIT}-G`);
    expect(freshRow).not.toBeNull();
    expect(freshRow!.stabilityDays).toBeGreaterThanOrEqual(1);
    expect(summary.cpaStage).toBe(CPA_STAGES.PICTORIAL);
    expect(stageForTopicProgress(freshRow)).toBe(CPA_STAGES.PICTORIAL);
    expect(stageForTopicProgress(null)).toBe(CPA_STAGES.CONCRETE);

    // Session 2 (the fixed startSession): fresh read, then stage map.
    const freshRows = await env.deps.storage.allTopicProgress(STUDENT);
    const progressByTopic: Record<string, (typeof freshRows)[number]> = {};
    for (const row of freshRows) progressByTopic[row.topicId] = row;
    const second = await engine.startTopicSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
      topicCode: "G",
      motorBaselineSec: 0.42,
    });
    const stageByQuestionId: Record<string, string> = {};
    for (const item of second.questions) {
      stageByQuestionId[item.questionId] = stageForTopicProgress(
        progressByTopic[item.topicId] ?? null,
      );
    }
    // Every session-2 stage is the FRESH PICTORIAL - had the screen
    // kept the mount-time snapshot, every one would be CONCRETE.
    expect(new Set(Object.values(stageByQuestionId))).toEqual(new Set([CPA_STAGES.PICTORIAL]));
    // Crowns for the picker come from the same fresh row.
    expect(progressByTopic[`${UNIT}-G`]?.crowns).toBe(summary.crownsAwarded);
    await engine.abandonSession(second.sessionId);
  });
});

/**
 * RN wiring pins for the review findings: the screen cannot mount in
 * the node vitest environment (repo doctrine: source scans for the RN
 * layer), so the fix-loop mutations are pinned on the screen source.
 */
describe("screen wiring pins (review findings 1-4)", () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const screenSource = readFileSync(
    join(here, "..", "src", "runner", "PracticeRunnerScreen.tsx"),
    "utf8",
  );

  it("every summary-failed dispatch is preceded by an abandonSession call (finding 1)", () => {
    const dispatchSites = [...screenSource.matchAll(/dispatch\(\{\s*\n\s*type: "summary-failed"/g)];
    // handleCheck + handleContinue catch blocks.
    expect(dispatchSites.length).toBe(2);
    for (const match of dispatchSites) {
      const catchBlock = screenSource.slice(Math.max(0, match.index - 600), match.index);
      expect(
        catchBlock.includes("abandonSession(state.sessionId)"),
        "the catch block must free sync liveness before dispatching summary-failed",
      ).toBe(true);
    }
  });

  it("progress is re-read before each session start and picker rebuild (finding 2)", () => {
    const calls = screenSource.match(/await refreshProgressByTopic\(/g) ?? [];
    // One in startSession, one in backToPicker.
    expect(calls.length).toBe(2);
  });

  it("narration resolves the grade once at mount (finding 3)", () => {
    expect(screenSource).not.toContain("asGradeId(gradeParam ?? null)");
    const narration = screenSource.match(/asGradeId\(effectiveGradeRef\.current\)/g) ?? [];
    // Seven sites (#59): session-start intro, question prompt narration,
    // replay, guided hint, remediation on gentle retry, the #58
    // mastery-bloom celebration line, and the completion summary — all
    // thread the mount-resolved grade.
    expect(narration.length).toBe(7);
    expect(screenSource).toContain("effectiveGradeRef.current = gradeId ?? null");
  });

  it("the feedback hint reads the session-threaded target, not the summary (finding 4)", () => {
    expect(screenSource).not.toContain("state.summary?.targetSpeedSec ?? 0");
    expect(screenSource).toContain("targetSpeedSec: start.targetSpeedSec");
    expect(screenSource).toContain("state.targetSpeedSec ?? 0");
  });
});
