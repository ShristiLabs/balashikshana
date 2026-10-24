/**
 * Boss-gate spiral composition + rule pins (issue #51).
 *
 * Pure-module matrices for allocateSpiral/interleaveSpiral, the
 * anti-guess rule, and the registry/engine tripwires: the client's
 * pinned constants must match the registry's globalMasteryRules and
 * the engine's own defaults (the engine is never forked; these pins
 * make a silent engine change fail consciously).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ANTI_GUESS,
  GOLD_CHECK_BUDGET_SEC,
  SPIRAL_MIX,
  isRapidGuessViolation,
} from "../src/gate/rules";
import { allocateSpiral, interleaveSpiral } from "../src/gate/spiral";
import { TWO_KEY_RULES } from "../src/practice/goldKey";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const engineSource = readFileSync(`${repoRoot}/packages/core-engine/src/index.mjs`, "utf-8");
const registry = JSON.parse(
  readFileSync(`${repoRoot}/docs/us-curriculum-registry.json`, "utf-8"),
) as {
  globalMasteryRules: {
    antiGuessingMinResponseTimeSec: number;
    antiGuessingFreezePenaltySec: number;
    maxTailLatencyMultiplier: number;
    minSubSkillAccuracyPercent: number;
    twoKeySleepConsolidationGate: {
      minSleepConsolidationHours: number;
      day2GoldKeyVerificationItems: number;
      day2MinPassCount: number;
    };
    scientificSpacedRepetition: {
      interleavedSpiralMix: {
        currentUnitPercent: number;
        recentPrerequisiteContrastPercent: number;
        longTermSpacedReviewPercent: number;
      };
    };
  };
};

describe("allocateSpiral", () => {
  it("allocates exact 70/20/10 with largest-remainder rounding, summing to count", () => {
    expect(allocateSpiral(6, { prerequisite: 10, review: 10 })).toEqual({
      current: 4,
      prerequisite: 1,
      review: 1,
    });
    expect(allocateSpiral(12, { prerequisite: 10, review: 10 })).toEqual({
      current: 9,
      prerequisite: 2,
      review: 1,
    });
    expect(allocateSpiral(18, { prerequisite: 10, review: 10 })).toEqual({
      current: 13,
      prerequisite: 3,
      review: 2,
    });
    expect(allocateSpiral(10, { prerequisite: 10, review: 10 })).toEqual({
      current: 7,
      prerequisite: 2,
      review: 1,
    });
  });

  it("sums exactly to count for every count and availability", () => {
    for (let count = 1; count <= 30; count += 1) {
      for (const prerequisite of [0, 1, 3, 40]) {
        for (const review of [0, 1, 2, 40]) {
          const alloc = allocateSpiral(count, { prerequisite, review });
          expect(alloc.current + alloc.prerequisite + alloc.review).toBe(count);
          expect(alloc.prerequisite).toBeLessThanOrEqual(prerequisite);
          expect(alloc.review).toBeLessThanOrEqual(review);
        }
      }
    }
  });

  it("degrades to 100% current when nothing exists (pre-#51 round-robin parity)", () => {
    expect(allocateSpiral(12, { prerequisite: 0, review: 0 })).toEqual({
      current: 12,
      prerequisite: 0,
      review: 0,
    });
    expect(allocateSpiral(6, { prerequisite: 0, review: 0 })).toEqual({
      current: 6,
      prerequisite: 0,
      review: 0,
    });
  });

  it("flows a clamped share back to the current unit", () => {
    // 6 wants 4/1/1; only 1 review exists and no prerequisites.
    expect(allocateSpiral(6, { prerequisite: 0, review: 1 })).toEqual({
      current: 5,
      prerequisite: 0,
      review: 1,
    });
    expect(allocateSpiral(6, { prerequisite: 1, review: 0 })).toEqual({
      current: 5,
      prerequisite: 1,
      review: 0,
    });
  });
});

describe("interleaveSpiral", () => {
  it("spreads sources deterministically (pinned sequence)", () => {
    expect(interleaveSpiral({ current: 4, prerequisite: 2, review: 1 })).toEqual([
      "current",
      "current",
      "prerequisite",
      "current",
      "current",
      "prerequisite",
      "review",
    ]);
  });

  it("emits exactly the allocated counts in stable order", () => {
    const order = interleaveSpiral({ current: 13, prerequisite: 3, review: 2 });
    expect(order).toHaveLength(18);
    expect(order.filter((s) => s === "current")).toHaveLength(13);
    expect(order.filter((s) => s === "prerequisite")).toHaveLength(3);
    expect(order.filter((s) => s === "review")).toHaveLength(2);
    // No two review items adjacent (the spread property).
    const reviewIndexes = order.map((s, i) => (s === "review" ? i : -1)).filter((i) => i >= 0);
    for (let i = 1; i < reviewIndexes.length; i += 1) {
      expect(reviewIndexes[i]! - reviewIndexes[i - 1]!).toBeGreaterThan(1);
    }
    // Byte-stable across calls.
    expect(interleaveSpiral({ current: 13, prerequisite: 3, review: 2 })).toEqual(order);
  });

  it("never emits from an empty bucket", () => {
    expect(interleaveSpiral({ current: 3, prerequisite: 0, review: 0 })).toEqual([
      "current",
      "current",
      "current",
    ]);
  });
});

describe("anti-guess rule (registry globalMasteryRules)", () => {
  it("mirrors the engine's counting rule exactly", () => {
    expect(isRapidGuessViolation(false, 0.5)).toBe(true);
    expect(isRapidGuessViolation(true, 0.5)).toBe(false);
    expect(isRapidGuessViolation(false, 1.19)).toBe(true);
    expect(isRapidGuessViolation(false, 1.2)).toBe(false); // boundary: strict <
    expect(isRapidGuessViolation(false, 3.0)).toBe(false);
  });

  it("pins the registry values and the engine's own defaults", () => {
    expect(ANTI_GUESS.minRawSec).toBe(registry.globalMasteryRules.antiGuessingMinResponseTimeSec);
    expect(ANTI_GUESS.minRawSec).toBe(1.2);
    expect(ANTI_GUESS.freezePenaltySec).toBe(
      registry.globalMasteryRules.antiGuessingFreezePenaltySec,
    );
    expect(ANTI_GUESS.freezePenaltySec).toBe(2.0);
    // Engine source tripwire: the default parameter must stay 1.2 and
    // the violation must remain "incorrect AND raw < min".
    expect(engineSource).toContain("antiGuessingMinRawSec = 1.2");
    expect(engineSource).toContain("} else if (r.rawTimeSec < antiGuessingMinRawSec) {");
  });
});

describe("registry tripwires (client pins never fork the sources)", () => {
  it("spiral mix weights match the registry's global interleavedSpiralMix", () => {
    expect(SPIRAL_MIX.currentUnitPercent).toBe(
      registry.globalMasteryRules.scientificSpacedRepetition.interleavedSpiralMix
        .currentUnitPercent,
    );
    expect(SPIRAL_MIX.prerequisitePercent).toBe(
      registry.globalMasteryRules.scientificSpacedRepetition.interleavedSpiralMix
        .recentPrerequisiteContrastPercent,
    );
    expect(SPIRAL_MIX.spacedReviewPercent).toBe(
      registry.globalMasteryRules.scientificSpacedRepetition.interleavedSpiralMix
        .longTermSpacedReviewPercent,
    );
  });

  it("two-key rules match the GLOBAL registry rules (not the per-unit debt value)", () => {
    const globalRules = registry.globalMasteryRules.twoKeySleepConsolidationGate;
    expect(TWO_KEY_RULES.minSleepConsolidationHours).toBe(globalRules.minSleepConsolidationHours);
    expect(TWO_KEY_RULES.day2GoldKeyVerificationItems).toBe(
      globalRules.day2GoldKeyVerificationItems,
    );
    expect(TWO_KEY_RULES.day2MinPassCount).toBe(globalRules.day2MinPassCount);
    expect(TWO_KEY_RULES.day2GoldKeyVerificationItems).toBe(5);
    expect(TWO_KEY_RULES.day2MinPassCount).toBe(4);
    // Documented registry debt: per-unit assessments carry
    // day2VerificationItems=2, which CONFLICTS with the global 5 — the
    // global value is authoritative everywhere (goldKey.ts, derivations.mjs).
    expect(TWO_KEY_RULES.day2GoldKeyVerificationItems).not.toBe(2);
  });

  it("engine gate internals stay pinned (tail multiplier, floor, streak default)", () => {
    expect(registry.globalMasteryRules.maxTailLatencyMultiplier).toBe(1.3);
    expect(engineSource).toContain("gate.maxMedianResponseTimeSec * 1.3");
    expect(registry.globalMasteryRules.minSubSkillAccuracyPercent).toBe(75);
    expect(engineSource).toContain("if (acc < 75) failedTopics.push(b.code);");
    expect(engineSource).toContain("const streakReq = gate.challengeZoneStreak || 4;");
  });

  it("gold-check budget is the spec's 60 seconds", () => {
    expect(GOLD_CHECK_BUDGET_SEC).toBe(60);
  });
});
