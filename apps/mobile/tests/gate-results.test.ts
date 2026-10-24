/**
 * Gate results view-model derivation (issue #51): the five-condition
 * breakdown, per-topic rows against the 75% floor, and remediation
 * routing per the engine's REMEDIATION_MODE — pure matrices over
 * synthetic GateSessionSummary fixtures.
 */
import { describe, expect, it } from "vitest";
import type { GateSessionSummary } from "../src/practice/practiceEngine";
import { CONDITION_KEYS, remediationStep, resultsView } from "../src/gate/results";

function summaryFixture(overrides: Partial<GateSessionSummary> = {}): GateSessionSummary {
  return {
    sessionId: "s1",
    passed: true,
    keyState: "SILVER_KEY",
    provisional: true,
    overallAccuracyPct: 91.7,
    requiredAccuracyPct: 85,
    medianCogSpeedSec: 3.1,
    targetSpeedSec: 5.5,
    p80CogSpeedSec: 4.4,
    maxTailAllowedSec: 7.15,
    rapidGuessViolations: 0,
    finalStreakPassed: true,
    challengeStreakRequired: 4,
    failedTopics: ["H"],
    topicBreakdown: [
      {
        code: "G",
        name: "Counting to 10",
        total: 4,
        correct: 4,
        accuracyPct: 100,
        medianSpeedSec: 2.9,
      },
      { code: "H", name: "Comparing", total: 2, correct: 1, accuracyPct: 50, medianSpeedSec: 3.4 },
    ],
    remediationMode: "NONE",
    remediationPrescription: "Mastery Achieved!",
    conditions: {
      overallAccuracyPassed: true,
      perTopicFloorPassed: false,
      medianSpeedPassed: true,
      tailLatencyP80Passed: true,
      challengeStreakAndNoGuessingPassed: true,
    },
    unitProgress: {
      studentId: "s1",
      unitId: "K-M2",
      status: "MASTERED",
      keyState: "SILVER_KEY",
      bestAccuracyPct: 91.7,
      bestMedianSpeedSec: 3.1,
      attemptsCount: 1,
      stabilityDays: 2,
      lastReviewedAt: 1,
      cpaStage: "PICTORIAL_STATIC",
      provisional: true,
      silverAwardedAt: 1,
      goldVerifiedAt: 0,
      updatedAt: 1,
    },
    ...overrides,
  };
}

describe("resultsView", () => {
  it("always renders all five conditions with metrics and thresholds", () => {
    const view = resultsView(summaryFixture());
    expect(view.conditions).toHaveLength(5);
    expect(view.conditions.map((c) => c.key)).toEqual([...CONDITION_KEYS]);
    const accuracy = view.conditions[0]!;
    expect(accuracy.metric).toBe("Accuracy 91.7%");
    expect(accuracy.threshold).toBe("needs 85.0% or more");
    const floor = view.conditions[1]!;
    expect(floor.passed).toBe(false);
    expect(floor.glyph).toBe("retry");
    expect(floor.metric).toBe("1 topic below the floor");
    const median = view.conditions[2]!;
    expect(median.metric).toBe("Median speed 3.1s");
    expect(median.threshold).toBe("target 5.5s");
    const tail = view.conditions[3]!;
    expect(tail.metric).toBe("Slowest-tail speed 4.4s");
    expect(tail.threshold).toBe("up to 7.15s allowed");
    const streak = view.conditions[4]!;
    expect(streak.metric).toBe("No too-fast guesses");
    expect(streak.threshold).toBe("final 4 in a row, zero fast guesses");
  });

  it("counts plural failed topics and shows violation counts", () => {
    const view = resultsView(
      summaryFixture({
        failedTopics: ["G", "H"],
        rapidGuessViolations: 2,
        conditions: {
          overallAccuracyPassed: false,
          perTopicFloorPassed: false,
          medianSpeedPassed: true,
          tailLatencyP80Passed: true,
          challengeStreakAndNoGuessingPassed: false,
        },
      }),
    );
    expect(view.conditions[1]!.metric).toBe("2 topics below the floor");
    expect(view.conditions[4]!.metric).toBe("2 too-fast guesses");
    expect(view.conditions[4]!.passed).toBe(false);
  });

  it("derives topic rows against the 75% floor", () => {
    const view = resultsView(summaryFixture());
    expect(view.topics).toHaveLength(2);
    expect(view.topics[0]).toMatchObject({ code: "G", passed: true, accuracyPct: 100 });
    expect(view.topics[1]).toMatchObject({ code: "H", passed: false, accuracyPct: 50 });
  });

  it("a pass has no next step; the copy stays celebration-first", () => {
    const view = resultsView(
      summaryFixture({
        conditions: {
          overallAccuracyPassed: true,
          perTopicFloorPassed: true,
          medianSpeedPassed: true,
          tailLatencyP80Passed: true,
          challengeStreakAndNoGuessingPassed: true,
        },
      }),
    );
    expect(view.passed).toBe(true);
    expect(view.nextStep).toBeNull();
    expect(view.headline).toBe("Boss gate passed!");
  });

  it("a miss uses gentle copy and routes the engine's remediation mode", () => {
    const view = resultsView(
      summaryFixture({
        passed: false,
        keyState: null,
        remediationMode: "SINGLE_TOPIC_BLINDSPOT",
        remediationPrescription: "Focused topic practice on G.",
      }),
    );
    expect(view.headline).toBe("So close!");
    expect(view.nextStep?.route).toBe("/practice");
  });
});

describe("remediationStep", () => {
  it("routes every engine mode to practice with gentle labels", () => {
    for (const mode of ["CONCEPT_GAP", "IMPULSIVE_RUSHING", "LOW_AUTOMATICITY"] as const) {
      const step = remediationStep(mode);
      expect(step.route).toBe("/practice");
      expect(step.topicCode).toBeUndefined();
    }
  });

  it("deep-links the failed topic only for same-unit (short) codes", () => {
    expect(remediationStep("SINGLE_TOPIC_BLINDSPOT", "G").topicCode).toBe("G");
    // Spiral sessions attribute foreign topics to their FULL topic id;
    // those belong to another unit's practice surface, not a deep link.
    expect(remediationStep("SINGLE_TOPIC_BLINDSPOT", "K-M1-D").topicCode).toBeUndefined();
    expect(remediationStep("SINGLE_TOPIC_BLINDSPOT").topicCode).toBeUndefined();
  });
});
