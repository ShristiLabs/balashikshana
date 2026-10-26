/**
 * Gate session integration (issue #51) — REAL SQLite (node:sqlite)
 * through the PracticeSessionEngine, mirroring the #47/#50 harness:
 *
 * - 70/20/10 spiral composition against a two-unit pack fixture
 *   (prerequisite unit installed + due-review topics seeded), with
 *   degradation parity to the pre-#51 round-robin;
 * - D3 verdict parity: the native completeGateSession verdict equals a
 *   DIRECT engine call over the SAME responses mapped by the #48
 *   server-replay rule (foreign topics namespaced to full ids);
 * - attempt rows carry GATE / GOLD_VERIFICATION session types + the
 *   session motor baseline (the #48 replay contract);
 * - error paths free sync liveness (abandon-on-error, attempts
 *   durable) — the #50 Proxy-over-storage fault injection;
 * - the Gold lifecycle across the 14-hour boundary with exactly-4 /
 *   exactly-3 verification verdicts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
 
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateMasteryGateAttempt } from "@balashikshana/core-engine";
import { PracticeSessionEngine } from "../src/practice/practiceEngine";
import { TWO_KEY_RULES } from "../src/practice/goldKey";
import type { PracticeDeps } from "../src/practice/types";
import {
  createPracticeEnv,
  FIXTURE_PREREQ_UNIT,
  FIXTURE_UNIT,
  MS_HOUR,
  type PracticeTestEnv,
} from "./helpers/practiceEnv";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const syncSource = readFileSync(`${repoRoot}/services/api/sync.mjs`, "utf-8");

const STUDENT = "s1";
const GRADE = "kindergarten";
const UNIT = FIXTURE_UNIT.unitId; // K-M2
const PREREQ = FIXTURE_PREREQ_UNIT.unitId; // K-M1

let env: PracticeTestEnv;

beforeEach(() => {
  env = createPracticeEnv({ prerequisiteUnit: true });
});

afterEach(() => {
  env.dispose();
});

function engineFor(deps: PracticeDeps = env.deps): PracticeSessionEngine {
  return new PracticeSessionEngine(deps);
}

/** Seeds a due-review topic row (stale next review => due, retrievability low). */
async function seedDueReview(
  topicId: string,
  stabilityDays = 2,
  unitId: string = PREREQ,
): Promise<void> {
  await env.storage.upsertTopicProgress({
    studentId: STUDENT,
    topicId,
    unitId,
    topicCode: topicId.slice(unitId.length + 1),
    completed: 1,
    crowns: 1,
    masteryScore: 80,
    bestAccuracyPct: 80,
    bestMedianSpeedSec: 3,
    attemptsCount: 1,
    fluencyGrade: 3,
    stabilityDays,
    nextReviewAt: env.clock.nowMs - 1,
    lastReviewedAt: env.clock.nowMs - 5 * 86_400_000,
    provisional: true,
    updatedAt: env.clock.nowMs,
  });
}

/** Rewires a unit's prerequisite list inside the pack file (call before any reader opens). */
function setPackPrereqs(target: PracticeTestEnv, unitId: string, json: string): void {
  const db = new DatabaseSync(`${target.dir}/pack-kindergarten-v1.0.0.sqlite`);
  try {
    db.prepare("UPDATE units SET prerequisite_unit_ids_json = ? WHERE unit_id = ?").run(
      json,
      unitId,
    );
  } finally {
    db.close();
  }
}

async function answerAll(
  engine: PracticeSessionEngine,
  sessionId: string,
  questions: { questionId: string; topicCode: string; correctAnswer: string }[],
  plan: ("correct" | "wrong" | "rapid-wrong")[],
  rawTimeSec = 2.5,
): Promise<void> {
  for (const [i, q] of questions.entries()) {
    const mode = plan[i % plan.length] ?? "correct";
    await engine.submitResponse(sessionId, {
      topicCode: q.topicCode,
      questionId: q.questionId,
      chosenAnswer: mode === "correct" ? q.correctAnswer : "definitely-wrong",
      isCorrect: mode === "correct",
      rawTimeSec: mode === "rapid-wrong" ? 0.4 : rawTimeSec,
      audioDurationSec: 0.5,
    });
  }
}

describe("spiral composition (70/20/10 over a two-unit pack)", () => {
  it("blends current unit, prerequisite contrast, and due review per the mix", async () => {
    await seedDueReview(`${PREREQ}-D`);
    const engine = engineFor();
    const start = await engine.startGateSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
    });
    // K-M2 gate count 6 -> 4 current / 1 prerequisite / 1 review.
    expect(start.questions).toHaveLength(6);
    expect(start.sessionType).toBe("GATE");
    expect(start.questions.filter((q) => q.unitId === UNIT)).toHaveLength(4);
    expect(start.questions.filter((q) => q.unitId === PREREQ)).toHaveLength(2);
  });

  it("is deterministic (two starts compose identically)", async () => {
    await seedDueReview(`${PREREQ}-D`);
    const engine = engineFor();
    const a = await engine.startGateSession({ studentId: STUDENT, gradeId: GRADE, unitId: UNIT });
    const b = await engine.startGateSession({ studentId: STUDENT, gradeId: GRADE, unitId: UNIT });
    expect(a.questions.map((q) => q.questionId)).toEqual(b.questions.map((q) => q.questionId));
    engine.abandonSession(a.sessionId);
    engine.abandonSession(b.sessionId);
  });

  it("degrades to the pre-#51 round-robin when nothing is due and no prereqs exist", async () => {
    const plain = createPracticeEnv(); // single-unit pack, no prereqs
    try {
      const engine = new PracticeSessionEngine(plain.deps);
      const start = await engine.startGateSession({
        studentId: STUDENT,
        gradeId: GRADE,
        unitId: UNIT,
      });
      // 6 items, 3 topics, question_id ASC (lexicographic) pools:
      // exactly the #47 stratified selection, byte-for-byte.
      expect(start.questions.map((q) => q.questionId)).toEqual([
        "K-M2-G-Q1",
        "K-M2-H-Q1",
        "K-M2-I-Q1",
        "K-M2-G-Q10",
        "K-M2-H-Q10",
        "K-M2-I-Q10",
      ]);
      engine.abandonSession(start.sessionId);
    } finally {
      plain.dispose();
    }
  });

  it("the Gold check stays a pure current-unit 5-item probe", async () => {
    await seedDueReview(`${PREREQ}-D`);
    const engine = engineFor();
    const start = await engine.startGoldVerification({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
    });
    expect(start.sessionType).toBe("GOLD_VERIFICATION");
    expect(start.questions).toHaveLength(TWO_KEY_RULES.day2GoldKeyVerificationItems);
    expect(start.questions.every((q) => q.unitId === UNIT)).toBe(true);
    engine.abandonSession(start.sessionId);
  });
});

describe("D3 verdict parity (native vs server replay mapping)", () => {
  it("the #48 server replay mapping is pinned in sync.mjs (tripwire)", () => {
    expect(syncSource).toContain("topicId.startsWith(`${unitId}-`)");
    expect(syncSource).toContain("a.topicId.slice(unitId.length + 1) : a.topicId");
  });

  it("native verdict equals the direct engine call over server-mapped responses", async () => {
    await seedDueReview(`${PREREQ}-D`);
    const engine = engineFor();
    const start = await engine.startGateSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
      motorBaselineSec: 0.42,
    });
    // Mixed plan: the prerequisite/review share answers wrong once.
    const plan: ("correct" | "wrong")[] = [
      "correct",
      "correct",
      "wrong",
      "correct",
      "correct",
      "correct",
    ];
    const rawTimes = [2.0, 2.2, 2.4, 2.6, 2.1, 2.3];
    for (const [i, q] of start.questions.entries()) {
      await engine.submitResponse(start.sessionId, {
        topicCode: q.topicCode,
        questionId: q.questionId,
        chosenAnswer: plan[i] === "correct" ? q.correctAnswer : "wrong",
        isCorrect: plan[i] === "correct",
        rawTimeSec: rawTimes[i] ?? 2.5,
        audioDurationSec: 0.5,
      });
    }
    const summary = await engine.completeGateSession(start.sessionId);

    // Server-replay mapping rule (sync.mjs toResponses): same-unit ->
    // short code, foreign -> full topicId.
    const serverMappedResponses = start.questions.map((q, i) => ({
      topicCode: q.topicId.startsWith(`${UNIT}-`) ? q.topicCode : q.topicId,
      isCorrect: plan[i] === "correct",
      rawTimeSec: rawTimes[i] ?? 2.5,
      audioDurationSec: 0.5,
    }));
    const unitObj = {
      unitId: UNIT,
      title: start.unit.title,
      masteryGate: {
        questionCount: start.unit.masteryGate.questionCount,
        minAccuracyPercent: start.unit.masteryGate.minAccuracyPercent,
        maxMedianResponseTimeSec: start.unit.masteryGate.maxMedianResponseTimeSec,
        challengeZoneStreak: start.unit.masteryGate.challengeZoneStreak,
      },
      skillTopics: start.unit.skillTopics.map((t) => ({ code: t.code, name: t.name })),
    };
    const direct = evaluateMasteryGateAttempt({
      unit: unitObj,
      responses: serverMappedResponses,
      motorBaselineSec: 0.42,
    });

    expect(summary.passed).toBe(direct.passed);
    expect(summary.conditions).toEqual(direct.conditions);
    expect(summary.overallAccuracyPct).toBe(direct.overallAccuracyPct);
    expect(summary.medianCogSpeedSec).toBe(direct.medianCogSpeedSec);
    expect(summary.p80CogSpeedSec).toBe(direct.p80CogSpeedSec);
    expect(summary.rapidGuessViolations).toBe(direct.rapidGuessViolations);
    expect(direct.keyAwarded).toBe(summary.passed ? "SILVER_KEY" : null);
  });

  it("foreign spiral topics are floor-checked under their namespaced id", async () => {
    await seedDueReview(`${PREREQ}-D`);
    const engine = engineFor();
    const start = await engine.startGateSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
    });
    await answerAll(engine, start.sessionId, start.questions, ["correct"]);
    const summary = await engine.completeGateSession(start.sessionId);
    const foreign = summary.topicBreakdown.filter((t) => t.code.includes("-"));
    expect(foreign.length).toBeGreaterThan(0);
    // The full topic id (e.g. "K-M1-D") appears — never a bare short
    // code that would collide with the gate unit's own topics.
    expect(foreign.every((t) => t.code.startsWith(`${PREREQ}-`))).toBe(true);
    expect(summary.passed).toBe(true);
    expect(summary.challengeStreakRequired).toBe(FIXTURE_UNIT.gateStreakReq);
  });
});

describe("attempt rows (the #48 whole-session contract)", () => {
  it("GATE and GOLD_VERIFICATION attempts carry type, session, and motor baseline", async () => {
    const engine = engineFor();
    const gate = await engine.startGateSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
      motorBaselineSec: 0.55,
    });
    await answerAll(engine, gate.sessionId, gate.questions, ["correct"], 2.0);
    await engine.completeGateSession(gate.sessionId);

    env.clock.advance(15 * MS_HOUR);
    const verify = await engine.startGoldVerification({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
      motorBaselineSec: 0.6,
    });
    await answerAll(engine, verify.sessionId, verify.questions, ["correct"], 2.0);
    await engine.completeGoldVerification(verify.sessionId);

    const rows = env.storage.db
      .prepare(
        "SELECT session_type, session_id, motor_baseline_sec, raw_time_sec FROM attempt_log WHERE student_id = ? ORDER BY id ASC",
      )
      .all(STUDENT) as { session_type: string; session_id: string; motor_baseline_sec: number }[];
    const gateRows = rows.filter((r) => r.session_type === "GATE");
    const verifyRows = rows.filter((r) => r.session_type === "GOLD_VERIFICATION");
    expect(gateRows).toHaveLength(6);
    expect(verifyRows).toHaveLength(5);
    expect(
      gateRows.every((r) => r.motor_baseline_sec === 0.55 && r.session_id === gate.sessionId),
    ).toBe(true);
    expect(
      verifyRows.every((r) => r.motor_baseline_sec === 0.6 && r.session_id === verify.sessionId),
    ).toBe(true);
  });
});

describe("error paths free sync liveness (the #50 doctrine)", () => {
  function withFailingStorage(method: string) {
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

  it("a throwing submit leaves liveness clean after abandon; earlier attempts durable", async () => {
    const failing = withFailingStorage("insertAttempt");
    const engine = new PracticeSessionEngine(failing.deps);
    const start = await engine.startGateSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
    });
    const first = start.questions[0]!;
    await engine.submitResponse(start.sessionId, {
      topicCode: first.topicCode,
      questionId: first.questionId,
      chosenAnswer: first.correctAnswer,
      isCorrect: true,
      rawTimeSec: 2,
    });
    failing.arm();
    const second = start.questions[1]!;
    await expect(
      engine.submitResponse(start.sessionId, {
        topicCode: second.topicCode,
        questionId: second.questionId,
        chosenAnswer: second.correctAnswer,
        isCorrect: true,
        rawTimeSec: 2,
      }),
    ).rejects.toThrow(/insertAttempt failed/);
    expect(engine.activeSessionIds()).toContain(start.sessionId);
    engine.abandonSession(start.sessionId);
    expect(engine.activeSessionIds()).not.toContain(start.sessionId);
    // The first response survived (append-only log is the truth).
    expect(await env.storage.unsyncedAttemptCount(STUDENT)).toBe(1);
  });

  it("a throwing completion abandons without projection; attempts durable", async () => {
    const failing = withFailingStorage("upsertUnitProgress");
    const engine = new PracticeSessionEngine(failing.deps);
    const start = await engine.startGateSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
    });
    await answerAll(engine, start.sessionId, start.questions, ["correct"], 2.0);
    failing.arm();
    await expect(engine.completeGateSession(start.sessionId)).rejects.toThrow(
      /upsertUnitProgress failed/,
    );
    expect(engine.activeSessionIds()).toContain(start.sessionId);
    engine.abandonSession(start.sessionId);
    expect(engine.activeSessionIds()).toHaveLength(0);
    expect(await env.storage.unsyncedAttemptCount(STUDENT)).toBe(start.questions.length);
    expect(await env.storage.getUnitProgress(STUDENT, UNIT)).toBeNull();
  });
});

describe("two-key lifecycle through a spiral session (boundaries)", () => {
  it("Silver on pass; window opens exactly at 14 h; 4-of-5 upgrades, 3-of-5 does not", async () => {
    const engine = engineFor();
    const gate = await engine.startGateSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
    });
    await answerAll(engine, gate.sessionId, gate.questions, ["correct"], 2.0);
    const summary = await engine.completeGateSession(gate.sessionId);
    expect(summary.passed).toBe(true);
    expect(summary.keyState).toBe("SILVER_KEY");
    expect(summary.provisional).toBe(true);

    const silverAt = env.clock.nowMs;
    const eligibleAt = silverAt + TWO_KEY_RULES.minSleepConsolidationHours * MS_HOUR;
    // 1 ms before the window: a completed verification cannot upgrade.
    env.clock.advance(14 * MS_HOUR - 1);
    let status = await engine.goldStatus(STUDENT, UNIT);
    expect(status.eligible).toBe(false);
    expect(status.goldEligibleAtMs).toBe(eligibleAt);

    env.clock.advance(1); // exactly at the boundary -> eligible.
    status = await engine.goldStatus(STUDENT, UNIT);
    expect(status.eligible).toBe(true);

    // Exactly 3 correct of 5: below the >= 4 bar, Silver stays.
    const retry = await engine.startGoldVerification({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
    });
    for (const [i, q] of retry.questions.entries()) {
      await engine.submitResponse(retry.sessionId, {
        topicCode: q.topicCode,
        questionId: q.questionId,
        chosenAnswer: i < 3 ? q.correctAnswer : "wrong", // exactly 3 correct
        isCorrect: i < 3,
        rawTimeSec: 2.0,
      });
    }
    const three = await engine.completeGoldVerification(retry.sessionId);
    expect(three.upgraded).toBe(false);
    expect(three.correctCount).toBe(3);
    expect((await engine.goldStatus(STUDENT, UNIT)).keyState).toBe("SILVER_KEY");

    // Exactly 4 correct upgrades.
    const pass = await engine.startGoldVerification({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
    });
    for (const [i, q] of pass.questions.entries()) {
      await engine.submitResponse(pass.sessionId, {
        topicCode: q.topicCode,
        questionId: q.questionId,
        chosenAnswer: i < 4 ? q.correctAnswer : "wrong", // exactly 4 correct
        isCorrect: i < 4,
        rawTimeSec: 2.0,
      });
    }
    const four = await engine.completeGoldVerification(pass.sessionId);
    expect(four.upgraded).toBe(true);
    expect(four.correctCount).toBe(4);
    expect(four.keyState).toBe("GOLD_KEY");
  });

  it("an answer recorded 1 ms before the budget deadline counts in a completion that runs after it (review finding 1)", async () => {
    // The screen-level guard makes the deadline defer while a submit
    // is in flight; this pins the engine-side semantics it relies on:
    // completion ALWAYS folds every already-recorded response,
    // regardless of running past the 60 s budget instant.
    const engine = engineFor();
    const gate = await engine.startGateSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
    });
    await answerAll(engine, gate.sessionId, gate.questions, ["correct"], 2.0);
    await engine.completeGateSession(gate.sessionId);
    env.clock.advance(15 * MS_HOUR);

    const check = await engine.startGoldVerification({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
    });
    const deadlineMs = check.startedAtMs + 60_000;
    // Four answers inside the budget.
    for (const q of check.questions.slice(0, 4)) {
      await engine.submitResponse(check.sessionId, {
        topicCode: q.topicCode,
        questionId: q.questionId,
        chosenAnswer: q.correctAnswer,
        isCorrect: true,
        rawTimeSec: 2.0,
      });
    }
    // The buzzer-beater: recorded at deadline - 1 ms...
    env.clock.nowMs = deadlineMs - 1;
    const last = check.questions[4]!;
    await engine.submitResponse(check.sessionId, {
      topicCode: last.topicCode,
      questionId: last.questionId,
      chosenAnswer: last.correctAnswer,
      isCorrect: true,
      rawTimeSec: 2.0,
    });
    // ...and the (deferred) completion runs 2 ms past the deadline.
    env.clock.nowMs = deadlineMs + 2;
    const verdict = await engine.completeGoldVerification(check.sessionId);
    expect(verdict.correctCount).toBe(5);
    expect(verdict.upgraded).toBe(true);
    expect(verdict.keyState).toBe("GOLD_KEY");
  });
});

describe("condition boundaries through the delivered path (issue #51 acceptance)", () => {
  /**
   * Each session runs on the plain single-unit pack (no spiral foreign
   * items — boundaries need exact topic attribution). Cognitive time =
   * raw - 0.42 (motor) - 0.5 (audio), floored at 0.5 and rounded to
   * 2 decimals; the gate wants accuracy >= 80, every topic >= 75,
   * median <= 6 s, P80 <= 7.8 s (1.3x), final 4-streak + zero
   * rapid-guess violations (incorrect raw < 1.2).
   */
  async function boundarySession(
    count: number,
    rawTimes: number[],
    correct: boolean[],
  ): Promise<{
    conditions: Record<string, boolean>;
    summary: Awaited<ReturnType<PracticeSessionEngine["completeGateSession"]>>;
  }> {
    const plain = createPracticeEnv();
    try {
      const engine = new PracticeSessionEngine(plain.deps);
      const start = await engine.startGateSession({
        studentId: STUDENT,
        gradeId: GRADE,
        unitId: UNIT,
        count,
        motorBaselineSec: 0.42,
      });
      for (const [i, q] of start.questions.entries()) {
        await engine.submitResponse(start.sessionId, {
          topicCode: q.topicCode,
          questionId: q.questionId,
          chosenAnswer: correct[i] ? q.correctAnswer : "wrong",
          isCorrect: correct[i] === true,
          rawTimeSec: rawTimes[i] ?? 2.5,
          audioDurationSec: 0.5,
        });
      }
      const summary = await engine.completeGateSession(start.sessionId);
      return { conditions: summary.conditions, summary };
    } finally {
      plain.dispose();
    }
  }

  it("overall accuracy exactly at the required percent passes; one below fails", async () => {
    const raws = [2.5, 2.5, 2.5, 2.5, 2.5];
    const at = await boundarySession(5, raws, [false, true, true, true, true]);
    expect(at.summary.overallAccuracyPct).toBe(80);
    expect(at.conditions.overallAccuracyPassed).toBe(true);
    const below = await boundarySession(5, raws, [false, false, true, true, true]);
    expect(below.summary.overallAccuracyPct).toBe(60);
    expect(below.conditions.overallAccuracyPassed).toBe(false);
  });

  it("a topic at exactly the 75% floor stays above it; 50% fails the floor", async () => {
    // 12 items -> exactly 4 per topic (G at indexes 0, 3, 6, 9).
    const raws = Array.from({ length: 12 }, () => 2.5);
    const at = await boundarySession(
      12,
      raws,
      [false, ...Array(11).fill(true)], // G: 3 of 4 = 75.0
    );
    expect(at.conditions.perTopicFloorPassed).toBe(true);
    expect(at.summary.failedTopics).not.toContain("G");
    const below = await boundarySession(12, raws, [
      false,
      true,
      true,
      false, // G: 2 of 4 = 50
      ...Array(8).fill(true),
    ]);
    expect(below.conditions.perTopicFloorPassed).toBe(false);
    expect(below.summary.failedTopics).toContain("G");
  });

  it("median cognitive speed exactly at the target passes; 0.1 s above fails", async () => {
    // cog(6.92) = 6.00 exactly (the engine rounds to 2 decimals).
    const at = await boundarySession(5, Array(5).fill(6.92), Array(5).fill(true));
    expect(at.summary.medianCogSpeedSec).toBe(6);
    expect(at.conditions.medianSpeedPassed).toBe(true);
    const above = await boundarySession(5, Array(5).fill(7.02), Array(5).fill(true));
    expect(above.summary.medianCogSpeedSec).toBe(6.1);
    expect(above.conditions.medianSpeedPassed).toBe(false);
  });

  it("P80 tail exactly at the 1.3x ceiling passes; 0.1 s above fails", async () => {
    const at = await boundarySession(5, Array(5).fill(8.72), Array(5).fill(true));
    expect(at.summary.p80CogSpeedSec).toBe(7.8);
    expect(at.summary.maxTailAllowedSec).toBe(7.8);
    expect(at.conditions.tailLatencyP80Passed).toBe(true);
    const above = await boundarySession(5, Array(5).fill(8.82), Array(5).fill(true));
    expect(above.conditions.tailLatencyP80Passed).toBe(false);
  });

  it("final 4-streak holds but one rapid-guess violation fails condition 5; raw exactly 1.2 s is NOT a violation", async () => {
    const raws = [0.5, 2.5, 2.5, 2.5, 2.5];
    const violated = await boundarySession(5, raws, [false, true, true, true, true]);
    expect(violated.summary.finalStreakPassed).toBe(true);
    expect(violated.summary.rapidGuessViolations).toBe(1);
    expect(violated.conditions.challengeStreakAndNoGuessingPassed).toBe(false);
    // Boundary: an incorrect answer at exactly 1.2 s raw is legal.
    const atBoundary = await boundarySession(
      5,
      [1.2, 2.5, 2.5, 2.5, 2.5],
      [false, true, true, true, true],
    );
    expect(atBoundary.summary.rapidGuessViolations).toBe(0);
    expect(atBoundary.conditions.challengeStreakAndNoGuessingPassed).toBe(true);
  });

  it("a session shorter than the challenge streak cannot pass condition 5", async () => {
    const short = await boundarySession(3, Array(3).fill(2.5), Array(3).fill(true));
    expect(short.summary.finalStreakPassed).toBe(false);
    expect(short.conditions.challengeStreakAndNoGuessingPassed).toBe(false);
  });
});

describe("spiral edge cases (composition robustness)", () => {
  it("a prerequisite unit missing from the pack degrades its share without error", async () => {
    setPackPrereqs(env, UNIT, '["K-M9"]'); // not installed (cross-grade)
    await seedDueReview(`${PREREQ}-D`);
    const engine = engineFor();
    const start = await engine.startGateSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
    });
    expect(start.questions).toHaveLength(6);
    const foreign = start.questions.filter((q) => q.unitId !== UNIT);
    // The missing prerequisite's share flowed to the current unit; the
    // due review still contributes its one item.
    expect(foreign).toHaveLength(1);
    expect(foreign[0]!.questionId).toBe("K-M1-D-Q1");
    engine.abandonSession(start.sessionId);
  });

  it("due-review topics of the CURRENT unit are excluded from the review share", async () => {
    await seedDueReview(`${UNIT}-G`, 2, UNIT); // same unit -> excluded
    const engine = engineFor();
    const start = await engine.startGateSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
    });
    expect(start.questions).toHaveLength(6);
    const foreign = start.questions.filter((q) => q.unitId !== UNIT);
    // Only the prerequisite contributes; no review share, no duplicate
    // of a current-unit question.
    expect(foreign).toHaveLength(1);
    expect(foreign.every((q) => q.unitId === PREREQ)).toBe(true);
    expect(new Set(start.questions.map((q) => q.questionId)).size).toBe(6);
    engine.abandonSession(start.sessionId);
  });

  it("more due topics than review slots: the most-forgotten topic is picked", async () => {
    setPackPrereqs(env, UNIT, "[]"); // isolate the review share
    await seedDueReview(`${PREREQ}-D`, 2); // low stability -> lowest retrievability
    await seedDueReview(`${PREREQ}-E`, 10); // high stability -> less due
    const engine = engineFor();
    const start = await engine.startGateSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
    });
    const foreign = start.questions.filter((q) => q.unitId !== UNIT);
    expect(foreign).toHaveLength(1);
    expect(foreign[0]!.questionId).toBe("K-M1-D-Q1");
    engine.abandonSession(start.sessionId);
  });
});
