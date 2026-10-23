// Vitest specs for the 5-condition Mastery Gate Engine (issue #32).
//
// Ports every assertion of src/verify-engine.mjs and adds the independent
// per-condition coverage the issue requires: each of the five gate
// conditions is proven to fail ALONE (all others passing) and the
// all-pass path is proven end to end. Fixtures use a synthetic unit so
// each condition can be isolated exactly; registry-based cases (PK-M1)
// are ported verbatim from the aggregate verifier.

import { describe, test, expect } from "vitest";
import fs from "node:fs";
import {
  computeMotorBaselineSec,
  computeCognitiveTimeSec,
  evaluateMasteryGateAttempt,
  REMEDIATION_MODES
} from "../src/index.mjs";

const registry = JSON.parse(
  fs.readFileSync(new URL("../../../docs/us-curriculum-registry.json", import.meta.url), "utf8")
);

const registryUnit = (unitId) => {
  for (const g of registry.grades) {
    for (const s of Object.values(g.subjects)) {
      const u = s.units.find((x) => x.unitId === unitId);
      if (u) return u;
    }
  }
  throw new Error(`unit ${unitId} not found in registry`);
};

// Synthetic unit tuned so every fixture below isolates exactly one
// condition: accuracy bar 90%, median target 4s (tail cap 5.2s), streak 4.
const GATE_UNIT = {
  unitId: "T-M1",
  title: "Synthetic Mastery Unit",
  masteryGate: { minAccuracyPercent: 90, maxMedianResponseTimeSec: 4, challengeZoneStreak: 4 },
  skillTopics: [
    { code: "TA", name: "Topic A" },
    { code: "TB", name: "Topic B" }
  ]
};
const MOTOR = 0.45;

const resp = (topicCode, isCorrect, rawTimeSec) => ({ topicCode, isCorrect, rawTimeSec });

const evaluate = (responses, unit = GATE_UNIT, motorBaselineSec = MOTOR) =>
  evaluateMasteryGateAttempt({ unit, responses, motorBaselineSec });

describe("motor baseline and cognitive-time calibration", () => {
  test("motor baseline is the median of the warm-up taps", () => {
    expect(computeMotorBaselineSec([0.42, 0.45, 0.40])).toBe(0.42);
  });

  test("cognitive time subtracts the motor baseline (ported from verifier)", () => {
    expect(computeCognitiveTimeSec(3.42, 0.42, 0)).toBe(3.0);
  });

  test("cognitive time also subtracts the audio prompt duration", () => {
    expect(computeCognitiveTimeSec(3.0, 0.45, 1.0)).toBe(1.55);
  });

  test("cognitive time is floored at 0.5s (impossible negatives are clamped)", () => {
    expect(computeCognitiveTimeSec(0.5, 0.45, 0)).toBe(0.5);
    expect(computeCognitiveTimeSec(0.1, 0.9, 0.5)).toBe(0.5);
  });

  test("motor baseline is clamped to the [0.15, 1.5] band", () => {
    expect(computeMotorBaselineSec([0.05, 0.06, 0.07])).toBe(0.15);
    expect(computeMotorBaselineSec([2, 3, 4])).toBe(1.5);
  });
});

describe("five gate conditions fail and pass independently", () => {
  test("all conditions satisfied: passes and awards a SILVER_KEY", () => {
    const responses = Array.from({ length: 20 }, (_, i) =>
      resp(i % 2 ? "TA" : "TB", true, 3.95) // cog 3.5s, well inside every bound
    );
    const result = evaluate(responses);
    expect(result.passed).toBe(true);
    expect(result.keyAwarded).toBe("SILVER_KEY");
    expect(result.remediationMode).toBe(REMEDIATION_MODES.NONE);
    expect(result.overallAccuracyPct).toBe(100);
    expect(result.finalStreakPassed).toBe(true);
    expect(result.rapidGuessViolations).toBe(0);
    expect(result.conditions).toEqual({
      overallAccuracyPassed: true,
      perTopicFloorPassed: true,
      medianSpeedPassed: true,
      tailLatencyP80Passed: true,
      challengeStreakAndNoGuessingPassed: true
    });
  });

  test("condition 1 alone fails: overall accuracy below 90% (topics above the 75% floor)", () => {
    // TA 8/10 (80%), TB 9/10 (90%): every topic clears 75%, overall is 85%.
    const ta = Array.from({ length: 10 }, (_, i) => resp("TA", i !== 1 && i !== 8, 3.95));
    const tb = Array.from({ length: 10 }, (_, i) => resp("TB", i !== 4, 3.95));
    const result = evaluate([...ta, ...tb]);
    expect(result.overallAccuracyPct).toBe(85);
    expect(result.passed).toBe(false);
    expect(result.keyAwarded).toBe(null);
    expect(result.conditions).toEqual({
      overallAccuracyPassed: false,
      perTopicFloorPassed: true,
      medianSpeedPassed: true,
      tailLatencyP80Passed: true,
      challengeStreakAndNoGuessingPassed: true
    });
    expect(result.remediationMode).toBe(REMEDIATION_MODES.CONCEPT_GAP);
  });

  test("condition 2 alone fails: one topic below the 75% floor while overall is 90%", () => {
    // TA 2/4 (50%), TB 16/16: overall 18/20 = 90% clears the bar, TA does not.
    const ta = Array.from({ length: 4 }, (_, i) => resp("TA", i < 2, 3.95));
    const tb = Array.from({ length: 16 }, () => resp("TB", true, 3.95));
    const result = evaluate([...ta, ...tb]);
    expect(result.overallAccuracyPct).toBe(90);
    expect(result.passed).toBe(false);
    expect(result.failedTopics).toEqual(["TA"]);
    expect(result.conditions).toEqual({
      overallAccuracyPassed: true,
      perTopicFloorPassed: false,
      medianSpeedPassed: true,
      tailLatencyP80Passed: true,
      challengeStreakAndNoGuessingPassed: true
    });
    expect(result.remediationMode).toBe(REMEDIATION_MODES.SINGLE_TOPIC_BLINDSPOT);
    expect(result.remediationPrescription).toContain("TA");
  });

  test("condition 3 alone fails: median cognitive speed above target, tail still inside the 1.3x cap", () => {
    // All correct at cog 4.2s: median 4.2 > 4.0 target, but P80 4.2 <= 5.2 cap.
    const responses = Array.from({ length: 20 }, (_, i) => resp(i % 2 ? "TA" : "TB", true, 4.65));
    const result = evaluate(responses);
    expect(result.medianCogSpeedSec).toBe(4.2);
    expect(result.p80CogSpeedSec).toBe(4.2);
    expect(result.passed).toBe(false);
    expect(result.conditions).toEqual({
      overallAccuracyPassed: true,
      perTopicFloorPassed: true,
      medianSpeedPassed: false,
      tailLatencyP80Passed: true,
      challengeStreakAndNoGuessingPassed: true
    });
    expect(result.remediationMode).toBe(REMEDIATION_MODES.LOW_AUTOMATICITY);
  });

  test("condition 4 alone fails: P80 tail latency above the 1.3x cap while the median is on target", () => {
    // 14 fast responses (cog 3.5) and 6 slow ones (cog 6.0) in the middle:
    // median stays 3.5 <= 4.0, but P80 = 6.0 > 5.2.
    const responses = Array.from({ length: 20 }, (_, i) =>
      resp(i % 2 ? "TA" : "TB", true, i >= 3 && i <= 8 ? 6.45 : 3.95)
    );
    const result = evaluate(responses);
    expect(result.medianCogSpeedSec).toBe(3.5);
    expect(result.p80CogSpeedSec).toBe(6.0);
    expect(result.maxTailAllowedSec).toBe(5.2);
    expect(result.passed).toBe(false);
    expect(result.conditions).toEqual({
      overallAccuracyPassed: true,
      perTopicFloorPassed: true,
      medianSpeedPassed: true,
      tailLatencyP80Passed: false,
      challengeStreakAndNoGuessingPassed: true
    });
    expect(result.remediationMode).toBe(REMEDIATION_MODES.LOW_AUTOMATICITY);
  });

  test("condition 5 alone fails: final challenge-zone streak broken by a last-item miss", () => {
    const responses = Array.from({ length: 19 }, (_, i) => resp(i % 2 ? "TA" : "TB", true, 3.95));
    responses.push(resp("TA", false, 3.95)); // 95% overall, but the streak dies at item 20
    const result = evaluate(responses);
    expect(result.overallAccuracyPct).toBe(95);
    expect(result.finalStreakPassed).toBe(false);
    expect(result.passed).toBe(false);
    expect(result.conditions).toEqual({
      overallAccuracyPassed: true,
      perTopicFloorPassed: true,
      medianSpeedPassed: true,
      tailLatencyP80Passed: true,
      challengeStreakAndNoGuessingPassed: false
    });
  });

  test("condition 5 alone fails: a rapid-guess wrong answer (< 1.2s) violates anti-guessing", () => {
    const responses = Array.from({ length: 20 }, (_, i) => {
      if (i === 5) return resp("TA", false, 0.8); // fast wrong answer mid-run
      return resp(i % 2 ? "TA" : "TB", true, 3.95);
    });
    const result = evaluate(responses);
    expect(result.rapidGuessViolations).toBe(1);
    expect(result.finalStreakPassed).toBe(true); // streak itself is intact...
    expect(result.passed).toBe(false); // ...but anti-guessing still sinks it
    expect(result.conditions.challengeStreakAndNoGuessingPassed).toBe(false);
    expect(result.conditions.overallAccuracyPassed).toBe(true);
    expect(result.conditions.medianSpeedPassed).toBe(true);
    expect(result.conditions.tailLatencyP80Passed).toBe(true);
    expect(result.conditions.perTopicFloorPassed).toBe(true);
  });

  test("no responses at all fails safely with a concept-gap remediation", () => {
    const result = evaluate([]);
    expect(result.passed).toBe(false);
    expect(result.remediationMode).toBe(REMEDIATION_MODES.CONCEPT_GAP);
  });
});

describe("registry unit PK-M1 (ported from verify-engine.mjs)", () => {
  const pkM1 = registryUnit("PK-M1");

  test("all-correct on-target responses pass and award the SILVER_KEY", () => {
    const passing = pkM1.skillTopics.flatMap((t) => [
      resp(t.code, true, 3.5),
      resp(t.code, true, 3.8),
      resp(t.code, true, 4.0)
    ]);
    const result = evaluateMasteryGateAttempt({ unit: pkM1, responses: passing, motorBaselineSec: 0.42 });
    expect(result.passed).toBe(true);
    expect(result.keyAwarded).toBe("SILVER_KEY");
  });

  test("accurate but slow responses flag LOW_AUTOMATICITY (no masking by accuracy)", () => {
    const slow = pkM1.skillTopics.flatMap((t) => [
      resp(t.code, true, 12.0),
      resp(t.code, true, 14.0)
    ]);
    const result = evaluateMasteryGateAttempt({ unit: pkM1, responses: slow, motorBaselineSec: 0.42 });
    expect(result.passed).toBe(false);
    expect(result.keyAwarded).toBe(null);
    expect(result.remediationMode).toBe(REMEDIATION_MODES.LOW_AUTOMATICITY);
  });

  test("topic breakdown reports per-topic accuracy for every attempted topic", () => {
    const halfTopic = pkM1.skillTopics[0];
    const responses = [
      resp(halfTopic.code, true, 3.5),
      resp(halfTopic.code, false, 3.5)
    ];
    const result = evaluateMasteryGateAttempt({ unit: pkM1, responses, motorBaselineSec: 0.42 });
    const row = result.topicBreakdown.find((b) => b.code === halfTopic.code);
    expect(row.total).toBe(2);
    expect(row.correct).toBe(1);
    expect(row.accuracyPct).toBe(50);
  });
});
