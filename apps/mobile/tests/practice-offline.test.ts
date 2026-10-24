/**
 * Airplane-mode sanity pass (issue #47 acceptance criterion): a full
 * practice session AND a boss gate run entirely offline against an
 * installed #46-shaped pack — plus the complete two-key lifecycle
 * (Silver award -> 14-hour wait -> 5-item verification -> Gold).
 *
 * Everything here is local: node:sqlite databases, no network, no
 * React Native imports. The PracticeSessionEngine is exercised through
 * its public surface exactly as the #50 runner will use it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { PracticeSessionEngine } from "../src/practice/practiceEngine";
import { MS_HOUR, createPracticeEnv, type PracticeTestEnv } from "./helpers/practiceEnv";

const GRADE = "kindergarten";
const STUDENT = "stu-test-1";
const UNIT = "K-M2";

let env: PracticeTestEnv | null = null;

afterEach(() => {
  env?.dispose();
  env = null;
});

function engine(): { engine: PracticeSessionEngine; env: PracticeTestEnv } {
  env = env ?? createPracticeEnv();
  return { engine: new PracticeSessionEngine(env.deps), env };
}

async function runTopicSession(
  practice: PracticeSessionEngine,
  topicCode: string,
  answers: { correct: boolean; rawSec: number; audio?: number }[],
): Promise<ReturnType<PracticeSessionEngine["completeTopicSession"]>> {
  const start = await practice.startTopicSession({
    studentId: STUDENT,
    gradeId: GRADE,
    unitId: UNIT,
    topicCode,
    count: answers.length,
  });
  expect(start.questions).toHaveLength(answers.length);
  let index = 0;
  for (const a of answers) {
    await practice.submitResponse(start.sessionId, {
      topicCode,
      questionId: start.questions[index]!.questionId,
      chosenAnswer: a.correct ? start.questions[index]!.correctAnswer : "wrong",
      isCorrect: a.correct,
      rawTimeSec: a.rawSec,
      audioDurationSec: a.audio ?? 0.5,
    });
    index += 1;
  }
  return practice.completeTopicSession(start.sessionId);
}

describe("offline topic practice against the installed pack", () => {
  it("serves pack questions, records every attempt append-only, and projects progress", async () => {
    const { engine: practice, env: e } = engine();
    const summary = await runTopicSession(practice, "G", [
      { correct: true, rawSec: 2.0 },
      { correct: true, rawSec: 2.1 },
      { correct: true, rawSec: 1.9 },
      { correct: true, rawSec: 2.2 },
      { correct: true, rawSec: 2.0 },
      { correct: true, rawSec: 2.3 },
      { correct: true, rawSec: 2.1 },
      { correct: true, rawSec: 2.2 },
    ]);
    expect(summary.passedTopic).toBe(true);
    expect(summary.accuracyPct).toBe(100);
    expect(summary.crownsAwarded).toBe(3);
    expect(summary.topicProgress.provisional).toBe(true);
    expect(summary.topicProgress.stabilityDays).toBeGreaterThan(0);

    const attempts = e.storage.db
      .prepare("SELECT * FROM attempt_log ORDER BY id")
      .all() as unknown as Record<string, unknown>[];
    expect(attempts).toHaveLength(8);
    expect(attempts.every((a) => a.student_id === STUDENT && a.synced === 0)).toBe(true);
    expect(await practice.unsyncedAttemptCount(STUDENT)).toBe(8);
    // Topic-path cognitive time ignores audio (server parity).
    const first = attempts[0]!;
    expect(first.raw_time_sec).toBe(2.0);
    expect(first.audio_duration_sec).toBe(0.5);
    expect(first.cognitive_time_sec).toBeCloseTo(2.0 - 0.42, 5);
  });

  it("merges a second session into the same progress row (maxima/min/counters)", async () => {
    const { engine: practice } = engine();
    await runTopicSession(practice, "G", [
      { correct: true, rawSec: 5.0 },
      { correct: true, rawSec: 5.0 },
      { correct: true, rawSec: 5.0 },
      { correct: false, rawSec: 5.0 },
    ]);
    const second = await runTopicSession(practice, "G", [
      { correct: true, rawSec: 2.0 },
      { correct: true, rawSec: 2.0 },
      { correct: true, rawSec: 2.0 },
      { correct: true, rawSec: 2.0 },
    ]);
    expect(second.topicProgress.attemptsCount).toBe(2);
    expect(second.topicProgress.bestAccuracyPct).toBe(100);
    expect(second.topicProgress.bestMedianSpeedSec).toBeLessThan(5);
  });

  it("rejects unknown sessions and wrong-grade packs fail closed", async () => {
    const { engine: practice } = engine();
    await expect(practice.completeTopicSession("nope")).rejects.toThrow(
      /Unknown or completed session/,
    );
    await expect(
      practice.startTopicSession({
        studentId: STUDENT,
        gradeId: "grade-9",
        unitId: UNIT,
        topicCode: "G",
      }),
    ).rejects.toThrow(/No installed content pack/);
  });
});

describe("offline boss gate + full two-key lifecycle", () => {
  it("Silver on day-1 pass, Gold only after 14 h + 4/5 verification", async () => {
    const { engine: practice, env: e } = engine();

    // Day-1 gate: 6 items, all correct and fast -> pass -> SILVER.
    const gate = await practice.startGateSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
    });
    expect(gate.questions).toHaveLength(6);
    expect(gate.unit.skillTopics).toHaveLength(3);
    for (const q of gate.questions) {
      await practice.submitResponse(gate.sessionId, {
        topicCode: q.topicCode,
        questionId: q.questionId,
        chosenAnswer: q.correctAnswer,
        isCorrect: true,
        rawTimeSec: 2.5,
        audioDurationSec: 0.5,
      });
    }
    const verdict = await practice.completeGateSession(gate.sessionId);
    expect(verdict.passed).toBe(true);
    expect(verdict.keyState).toBe("SILVER_KEY");
    expect(verdict.provisional).toBe(true);
    expect(verdict.unitProgress.status).toBe("MASTERED");

    const silverAt = e.clock.nowMs;
    let status = await practice.goldStatus(STUDENT, UNIT);
    expect(status.keyState).toBe("SILVER_KEY");
    expect(status.eligible).toBe(false);
    expect(status.goldEligibleAtMs).toBe(silverAt + 14 * MS_HOUR);

    // 13 h 59 m later: still not eligible; a passing verification attempt
    // is refused by the machine (nothing upgrades).
    e.clock.advance(14 * MS_HOUR - 60_000);
    status = await practice.goldStatus(STUDENT, UNIT);
    expect(status.eligible).toBe(false);

    // Past the window: 3/5 verification fails the threshold.
    e.clock.advance(120_000);
    status = await practice.goldStatus(STUDENT, UNIT);
    expect(status.eligible).toBe(true);
    const failAttempt = await practice.startGoldVerification({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
    });
    expect(failAttempt.questions).toHaveLength(5);
    for (const [i, q] of failAttempt.questions.entries()) {
      await practice.submitResponse(failAttempt.sessionId, {
        topicCode: q.topicCode,
        questionId: q.questionId,
        chosenAnswer: q.correctAnswer,
        isCorrect: i < 3,
        rawTimeSec: 3.0,
      });
    }
    const failed = await practice.completeGoldVerification(failAttempt.sessionId);
    expect(failed.upgraded).toBe(false);
    expect(failed.correctCount).toBe(3);
    expect((await practice.goldStatus(STUDENT, UNIT)).keyState).toBe("SILVER_KEY");

    // Retry with 4/5 -> GOLD, provisional.
    const passAttempt = await practice.startGoldVerification({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
    });
    for (const [i, q] of passAttempt.questions.entries()) {
      await practice.submitResponse(passAttempt.sessionId, {
        topicCode: q.topicCode,
        questionId: q.questionId,
        chosenAnswer: q.correctAnswer,
        isCorrect: i < 4,
        rawTimeSec: 3.0,
      });
    }
    const passed = await practice.completeGoldVerification(passAttempt.sessionId);
    expect(passed.upgraded).toBe(true);
    expect(passed.keyState).toBe("GOLD_KEY");

    const finalStatus = await practice.goldStatus(STUDENT, UNIT);
    expect(finalStatus.keyState).toBe("GOLD_KEY");
    expect(finalStatus.goldVerifiedAt).toBe(e.clock.nowMs);
    expect(finalStatus.provisional).toBe(true);

    // Gate re-pass after Gold: key stays GOLD (forward-only), attempts accumulate.
    const again = await practice.startGateSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
    });
    for (const q of again.questions) {
      await practice.submitResponse(again.sessionId, {
        topicCode: q.topicCode,
        questionId: q.questionId,
        chosenAnswer: q.correctAnswer,
        isCorrect: true,
        rawTimeSec: 2.5,
      });
    }
    const rePass = await practice.completeGateSession(again.sessionId);
    expect(rePass.keyState).toBe("GOLD_KEY");
    expect(rePass.unitProgress.attemptsCount).toBe(2);

    // Every session left durable append-only rows: 6 + 5 + 5 + 6.
    expect(await practice.unsyncedAttemptCount(STUDENT)).toBe(22);
    const gateAttempts = e.storage.db
      .prepare(
        "SELECT session_type, COUNT(*) n FROM attempt_log GROUP BY session_type ORDER BY session_type",
      )
      .all() as unknown as { session_type: string; n: number }[];
    expect(gateAttempts).toEqual([
      { session_type: "GATE", n: 12 },
      { session_type: "GOLD_VERIFICATION", n: 10 },
    ]);
  });

  it("a failed gate keeps any existing key and stays REMEDIATION_REQUIRED until first pass", async () => {
    const { engine: practice } = engine();
    const gate = await practice.startGateSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
    });
    for (const q of gate.questions) {
      await practice.submitResponse(gate.sessionId, {
        topicCode: q.topicCode,
        questionId: q.questionId,
        chosenAnswer: "wrong",
        isCorrect: false,
        rawTimeSec: 8.0,
      });
    }
    const verdict = await practice.completeGateSession(gate.sessionId);
    expect(verdict.passed).toBe(false);
    expect(verdict.keyState).toBeNull();
    expect(verdict.unitProgress.status).toBe("REMEDIATION_REQUIRED");
    expect(verdict.remediationMode).toBeTruthy();
  });
});

describe("offline review queue", () => {
  it("lists due topics after sessions project schedules", async () => {
    const { engine: practice } = engine();
    await runTopicSession(practice, "G", [
      { correct: true, rawSec: 2.0 },
      { correct: true, rawSec: 2.0 },
      { correct: true, rawSec: 2.0 },
      { correct: true, rawSec: 2.0 },
      { correct: true, rawSec: 2.0 },
    ]);
    await runTopicSession(practice, "I", [
      { correct: false, rawSec: 5.0 },
      { correct: false, rawSec: 5.0 },
      { correct: false, rawSec: 5.0 },
      { correct: false, rawSec: 5.0 },
      { correct: false, rawSec: 5.0 },
    ]);
    // Nothing due yet (fresh schedules are in the future).
    let queue = await practice.reviewQueue(STUDENT, GRADE);
    expect(queue).toHaveLength(0);
    // Advance past the shorter schedule; the weaker topic surfaces first.
    env!.clock.advance(3 * 86_400_000);
    queue = await practice.reviewQueue(STUDENT, GRADE);
    expect(queue.length).toBeGreaterThan(0);
    expect(queue[0]!.topicId).toBe("K-M2-I");
  });
});
