// Vitest specs for the child-calibrated FSRS spaced-repetition engine
// (issue #32): stability growth per fluency grade (including the
// slow-correct 1.20x cap from the pedagogical rules), the age-capped
// maximum review intervals (21/30/45/60 days by grade band), CPA fading
// stages, intra-session re-queue lags, fluency grading boundaries, and
// retrievability decay.

import { describe, test, expect } from "vitest";
import {
  computeFluencyGrade,
  updateTopicMemoryStability,
  computeRetrievabilityPct,
  CPA_STAGES
} from "../src/index.mjs";

describe("computeFluencyGrade (4-point scale)", () => {
  test("incorrect answers are grade 1 regardless of speed", () => {
    expect(computeFluencyGrade(false, 10, 4)).toBe(1);
    expect(computeFluencyGrade(false, 0.6, 4)).toBe(1);
  });

  test("slow correct answers beyond 1.25x target are grade 2", () => {
    expect(computeFluencyGrade(true, 5.2, 4)).toBe(2); // ratio 1.30
    expect(computeFluencyGrade(true, 5.01, 4)).toBe(2); // ratio 1.2525
  });

  test("the 1.25x boundary itself is still grade 3", () => {
    expect(computeFluencyGrade(true, 5.0, 4)).toBe(3); // ratio exactly 1.25
  });

  test("automatic answers at or under 0.75x target are grade 4", () => {
    expect(computeFluencyGrade(true, 3.0, 4)).toBe(4); // ratio 0.75
    expect(computeFluencyGrade(true, 2.0, 4)).toBe(4);
  });

  test("fluent answers between 0.75x and 1.25x are grade 3", () => {
    expect(computeFluencyGrade(true, 3.6, 4)).toBe(3); // ratio 0.90
  });
});

describe("updateTopicMemoryStability", () => {
  test("slow-correct (grade 2) growth is capped at 1.20x, not the full factor", () => {
    const r = updateTopicMemoryStability({
      currentStabilityDays: 10,
      fluencyGrade: 2,
      gradeGrowthFactor: 2.0,
      maxIntervalCapDays: 45
    });
    expect(r.stabilityDays).toBe(12); // 10 * 1.20, NOT 10 * 2.0
  });

  test("fluent recall (grade 3) grows by the full growth factor", () => {
    const r = updateTopicMemoryStability({
      currentStabilityDays: 10,
      fluencyGrade: 3,
      gradeGrowthFactor: 2.0,
      maxIntervalCapDays: 45
    });
    expect(r.stabilityDays).toBe(20);
  });

  test("automatic recall (grade 4) grows by factor + 0.35", () => {
    const r = updateTopicMemoryStability({
      currentStabilityDays: 10,
      fluencyGrade: 4,
      gradeGrowthFactor: 2.0,
      maxIntervalCapDays: 45
    });
    expect(r.stabilityDays).toBe(23.5); // 10 * 2.35
  });

  test("forgotten (grade 1) collapses stability to a quarter with a 0.5-day floor", () => {
    expect(
      updateTopicMemoryStability({ currentStabilityDays: 10, fluencyGrade: 1, maxIntervalCapDays: 45 }).stabilityDays
    ).toBe(2.5);
    expect(
      updateTopicMemoryStability({ currentStabilityDays: 1.0, fluencyGrade: 1, maxIntervalCapDays: 45 }).stabilityDays
    ).toBe(0.5); // floor
  });

  test("grade 2 growth has a 1.0-day floor", () => {
    const r = updateTopicMemoryStability({ currentStabilityDays: 0.5, fluencyGrade: 2, maxIntervalCapDays: 45 });
    expect(r.stabilityDays).toBe(1.0); // max(1.0, 0.6)
  });

  test("stability never exceeds the age-capped interval: 21 days (Pre-K)", () => {
    const r = updateTopicMemoryStability({ currentStabilityDays: 100, fluencyGrade: 3, gradeGrowthFactor: 2.0, maxIntervalCapDays: 21 });
    expect(r.stabilityDays).toBe(21);
  });

  test("age caps clamp at 30 (K), 45 (G1) and 60 days (G2-G3)", () => {
    for (const cap of [30, 45, 60]) {
      const r = updateTopicMemoryStability({ currentStabilityDays: 100, fluencyGrade: 3, gradeGrowthFactor: 2.0, maxIntervalCapDays: cap });
      expect(r.stabilityDays).toBe(cap);
    }
  });

  test("CPA scaffold fades with stability: concrete -> pictorial -> ghost flash -> abstract", () => {
    expect(
      updateTopicMemoryStability({ currentStabilityDays: 3.0, fluencyGrade: 1, maxIntervalCapDays: 45 }).cpaStage
    ).toBe(CPA_STAGES.CONCRETE); // 0.75 days
    expect(
      updateTopicMemoryStability({ currentStabilityDays: 0.6, fluencyGrade: 3, gradeGrowthFactor: 2.0, maxIntervalCapDays: 45 }).cpaStage
    ).toBe(CPA_STAGES.PICTORIAL); // 1.2 days
    expect(
      updateTopicMemoryStability({ currentStabilityDays: 3.0, fluencyGrade: 3, gradeGrowthFactor: 2.0, maxIntervalCapDays: 45 }).cpaStage
    ).toBe(CPA_STAGES.GHOST_FLASH); // 6.0 days
    expect(
      updateTopicMemoryStability({ currentStabilityDays: 5.0, fluencyGrade: 3, gradeGrowthFactor: 2.0, maxIntervalCapDays: 45 }).cpaStage
    ).toBe(CPA_STAGES.ABSTRACT); // 10.0 days
  });

  test("missed or slow topics are re-queued intra-session at lags +2, +5, +10", () => {
    expect(
      updateTopicMemoryStability({ currentStabilityDays: 10, fluencyGrade: 1, maxIntervalCapDays: 45 }).intraSessionExpandingLags
    ).toEqual([2, 5, 10]);
    expect(
      updateTopicMemoryStability({ currentStabilityDays: 10, fluencyGrade: 2, maxIntervalCapDays: 45 }).intraSessionExpandingLags
    ).toEqual([2, 5, 10]);
    expect(
      updateTopicMemoryStability({ currentStabilityDays: 10, fluencyGrade: 3, maxIntervalCapDays: 45 }).intraSessionExpandingLags
    ).toEqual([]);
    expect(
      updateTopicMemoryStability({ currentStabilityDays: 10, fluencyGrade: 4, maxIntervalCapDays: 45 }).intraSessionExpandingLags
    ).toEqual([]);
  });
});

describe("computeRetrievabilityPct (FSRS forgetting curve)", () => {
  test("retrievability at the stability half-life is exactly 80%", () => {
    expect(computeRetrievabilityPct(10, 10)).toBe(80.0);
  });

  test("a just-reviewed topic is at 100%", () => {
    expect(computeRetrievabilityPct(0, 10)).toBe(100.0);
  });

  test("retrievability decays monotonically and clamps to [0, 100]", () => {
    const day1 = computeRetrievabilityPct(1, 10);
    expect(day1).toBeLessThan(100);
    expect(day1).toBeGreaterThan(80);
    expect(computeRetrievabilityPct(1000, 10)).toBe(0.0);
    expect(computeRetrievabilityPct(5, 0)).toBe(0); // zero stability guards
  });
});
