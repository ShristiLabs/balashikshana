/**
 * Parameterized game-session model matrices (issue #52): the 70/20/10
 * composition honoring the registry mix as DATA (including a
 * non-default mix), degradation when pools are missing, interleave
 * determinism, the Lag +2/+5/+10 re-queue ladder over the composed
 * stream (AC), win/fail boundaries, and the telemetry roll-up.
 */
import { describe, expect, it } from "vitest";
import { SPIRAL_MIX } from "../src/gate/rules";
import { allocateSpiral } from "../src/gate/spiral";
import { applyGradedResponse, initialSchedule, MAX_SESSION_ITEMS } from "../src/runner/requeue";
import {
  composeGameItemPlan,
  mixPercentagesFromFractions,
  summarizeGameTelemetry,
  type GameItemTelemetry,
} from "../src/games/sessionModel";

const MIX_702_010 = mixPercentagesFromFractions({
  currentTopic: 0.7,
  contrastivePrerequisite: 0.2,
  spacedReview: 0.1,
});

describe("mixPercentagesFromFractions", () => {
  it("maps the registry fractions to percentages", () => {
    expect(MIX_702_010).toEqual({
      currentUnitPercent: 70,
      prerequisitePercent: 20,
      spacedReviewPercent: 10,
    });
  });

  it("normalizes a non-unit triple; all-zero falls back to the registry default", () => {
    expect(
      mixPercentagesFromFractions({ currentTopic: 2, contrastivePrerequisite: 1, spacedReview: 1 }),
    ).toEqual({ currentUnitPercent: 50, prerequisitePercent: 25, spacedReviewPercent: 25 });
    expect(
      mixPercentagesFromFractions({ currentTopic: 0, contrastivePrerequisite: 0, spacedReview: 0 }),
    ).toEqual(SPIRAL_MIX);
  });
});

describe("composeGameItemPlan", () => {
  it("composes count 8 as 6 current / 1 contrastive / 1 spaced-review (largest remainder)", () => {
    const plan = composeGameItemPlan(8, { current: 10, prerequisite: 5, review: 3 }, MIX_702_010);
    expect(plan.items).toHaveLength(8);
    const buckets = {
      current: plan.items.filter((i) => i.provenance === "current").length,
      contrastive: plan.items.filter((i) => i.provenance === "contrastive").length,
      "spaced-review": plan.items.filter((i) => i.provenance === "spaced-review").length,
    };
    expect(buckets).toEqual({ current: 6, contrastive: 1, "spaced-review": 1 });
    // Question-index ranges follow the concatenated pool order.
    for (const item of plan.items) {
      if (item.provenance === "current") expect(item.questionIndex).toBeLessThan(10);
      if (item.provenance === "contrastive") expect(item.questionIndex).toBeGreaterThanOrEqual(10);
      if (item.provenance === "spaced-review")
        expect(item.questionIndex).toBeGreaterThanOrEqual(15);
    }
    // The provenance map covers exactly the planned indices.
    expect(Object.keys(plan.provenanceByQuestionIndex)).toHaveLength(8);
  });

  it("honors a NON-default registry mix as data (60/30/10)", () => {
    const mix = mixPercentagesFromFractions({
      currentTopic: 0.6,
      contrastivePrerequisite: 0.3,
      spacedReview: 0.1,
    });
    const plan = composeGameItemPlan(10, { current: 10, prerequisite: 10, review: 10 }, mix);
    const counts = {
      current: plan.items.filter((i) => i.provenance === "current").length,
      contrastive: plan.items.filter((i) => i.provenance === "contrastive").length,
      review: plan.items.filter((i) => i.provenance === "spaced-review").length,
    };
    expect(counts).toEqual({ current: 6, contrastive: 3, review: 1 });
  });

  it("degrades deterministically: missing pools flow back to the current topic", () => {
    const plan = composeGameItemPlan(8, { current: 8, prerequisite: 0, review: 0 }, MIX_702_010);
    expect(plan.items).toHaveLength(8);
    expect(plan.items.every((i) => i.provenance === "current")).toBe(true);
  });

  it("guided (current-only) composition ignores the contrastive pools entirely", () => {
    const plan = composeGameItemPlan(8, { current: 4, prerequisite: 9, review: 9 }, null);
    expect(plan.items).toHaveLength(8);
    expect(plan.items.every((i) => i.provenance === "current")).toBe(true);
  });

  it("is deterministic: identical inputs compose identical plans", () => {
    const pools = { current: 9, prerequisite: 4, review: 2 };
    const a = composeGameItemPlan(9, pools, MIX_702_010);
    const b = composeGameItemPlan(9, pools, MIX_702_010);
    expect(a).toEqual(b);
    // Interleave spread: contrastive/review items are distributed, not
    // blocked at the tail (count-9 composes 6/2/1; a non-current item
    // appears within the first four).
    expect(a.items.slice(0, 4).some((i) => i.provenance !== "current")).toBe(true);
  });
});

describe("0% and float-noise mix matrices (tester additions, #52 brief)", () => {
  const countByProv = (plan: ReturnType<typeof composeGameItemPlan>) => ({
    current: plan.items.filter((i) => i.provenance === "current").length,
    contrastive: plan.items.filter((i) => i.provenance === "contrastive").length,
    review: plan.items.filter((i) => i.provenance === "spaced-review").length,
  });
  const deepPools = { current: 20, prerequisite: 20, review: 20 };

  it("a 0% current mix is honored as data: every item is foreign", () => {
    const mix = mixPercentagesFromFractions({
      currentTopic: 0,
      contrastivePrerequisite: 0.5,
      spacedReview: 0.5,
    });
    expect(mix).toEqual({
      currentUnitPercent: 0,
      prerequisitePercent: 50,
      spacedReviewPercent: 50,
    });
    const plan = composeGameItemPlan(8, deepPools, mix);
    expect(countByProv(plan)).toEqual({ current: 0, contrastive: 4, review: 4 });
  });

  it("0% contrastive and 0% review mixes are honored (100/0/0 and 70/30/0)", () => {
    const allCurrent = mixPercentagesFromFractions({
      currentTopic: 1,
      contrastivePrerequisite: 0,
      spacedReview: 0,
    });
    expect(countByProv(composeGameItemPlan(6, deepPools, allCurrent))).toEqual({
      current: 6,
      contrastive: 0,
      review: 0,
    });
    const noReview = mixPercentagesFromFractions({
      currentTopic: 0.7,
      contrastivePrerequisite: 0.3,
      spacedReview: 0,
    });
    expect(countByProv(composeGameItemPlan(10, deepPools, noReview))).toEqual({
      current: 7,
      contrastive: 3,
      review: 0,
    });
  });

  it("awkward thirds survive float noise: counts sum exactly to count, deterministically", () => {
    const thirds = mixPercentagesFromFractions({
      currentTopic: 1 / 3,
      contrastivePrerequisite: 1 / 3,
      spacedReview: 1 / 3,
    });
    // 33.333...% each (sum 99.999...) — the allocator must still sum to
    // the requested count exactly via largest-remainder, never lose an
    // item to float noise.
    for (const count of [1, 3, 7, 10, 20]) {
      const plan = composeGameItemPlan(count, deepPools, thirds);
      expect(plan.items).toHaveLength(count);
      const { current, contrastive, review } = countByProv(plan);
      expect(current + contrastive + review).toBe(count);
      // Determinism: recomposition is identical.
      expect(composeGameItemPlan(count, deepPools, thirds)).toEqual(plan);
    }
    // count 10 over thirds: 3.33 targets -> floors 3/3/3, remainder 1
    // to the largest fractional part, tie broken current-first.
    expect(countByProv(composeGameItemPlan(10, deepPools, thirds))).toEqual({
      current: 4,
      contrastive: 3,
      review: 3,
    });
  });

  it("a 1/6-third-half mix allocates by largest remainder without drift", () => {
    const mix = mixPercentagesFromFractions({
      currentTopic: 1 / 6,
      contrastivePrerequisite: 1 / 3,
      spacedReview: 1 / 2,
    });
    const plan = composeGameItemPlan(12, deepPools, mix);
    expect(plan.items).toHaveLength(12);
    // Targets 2/4/6 are exact at count 12 — the awkward fractions
    // normalize cleanly through the percentage mapping.
    expect(countByProv(plan)).toEqual({ current: 2, contrastive: 4, review: 6 });
  });

  it("negative or NaN components degrade to the registry default, never to garbage", () => {
    expect(
      mixPercentagesFromFractions({
        currentTopic: -1,
        contrastivePrerequisite: 0.5,
        spacedReview: 0.5,
      }),
    ).toEqual(SPIRAL_MIX);
    expect(
      mixPercentagesFromFractions({
        currentTopic: Number.NaN,
        contrastivePrerequisite: 0.5,
        spacedReview: 0.5,
      }),
    ).toEqual(SPIRAL_MIX);
  });
});

describe("gate spiral parameterization (#52 refactor, gate behavior unchanged)", () => {
  it("allocateSpiral default still pins the #51 gate 70/20/10 allocations", () => {
    expect(allocateSpiral(6, { prerequisite: 10, review: 10 })).toEqual({
      current: 4,
      prerequisite: 1,
      review: 1,
    });
    expect(allocateSpiral(12, { prerequisite: 0, review: 0 })).toEqual({
      current: 12,
      prerequisite: 0,
      review: 0,
    });
  });
});

describe("re-queue ladder over the composed stream (AC: Lag +2/+5/+10)", () => {
  it("a miss on the first planned item re-queues at +2/+5/+10 intervening items", () => {
    const plan = composeGameItemPlan(8, { current: 6, prerequisite: 1, review: 1 }, MIX_702_010);
    const questions = plan.items.map((item, i) => ({ questionId: `q-${item.questionIndex}-${i}` }));
    let schedule = initialSchedule(questions);
    expect(schedule.items).toHaveLength(8);

    // Fluency grade 1 (missed) on the FIRST presentation triggers the ladder.
    schedule = applyGradedResponse(schedule, {
      questionId: schedule.items[0]!.questionId,
      origin: "initial",
      fluencyGrade: 1,
      index: 0,
    });
    expect(schedule.items).toHaveLength(11);
    // The three re-queue entries sit at +2/+5/+10 (positions 3, 6, 11 ->
    // indices 3, 6, 10 after splice-in) with the +10 clamped at the tail.
    const requeues = schedule.items
      .map((item, index) => ({ item, index }))
      .filter((entry) => entry.item.origin === "requeue");
    expect(requeues.map((r) => r.item.lagStep)).toEqual([1, 2, 3]);
    expect(requeues[0]!.index - 0).toBe(3); // graded idx 0 + lag 2 + 1
    expect(requeues[1]!.index - 0).toBe(6); // graded idx 0 + lag 5 + 1
    expect(requeues[2]!.index).toBe(10); // graded idx 0 + lag 10 + 1 clamped to tail
    // A miss on an ALREADY re-queued item never extends the ladder.
    const before = schedule.items.length;
    schedule = applyGradedResponse(schedule, {
      questionId: requeues[0]!.item.questionId,
      origin: "requeue",
      fluencyGrade: 1,
      index: requeues[0]!.index,
    });
    expect(schedule.items).toHaveLength(before);
  });

  it("a correct, fast answer (fluency 4) never re-queues", () => {
    const plan = composeGameItemPlan(4, { current: 4, prerequisite: 0, review: 0 }, null);
    let schedule = initialSchedule(plan.items.map((item, i) => ({ questionId: `q${i}` })));
    const before = schedule.items.length;
    schedule = applyGradedResponse(schedule, {
      questionId: schedule.items[0]!.questionId,
      origin: "initial",
      fluencyGrade: 4,
      index: 0,
    });
    expect(schedule.items).toHaveLength(before);
    expect(MAX_SESSION_ITEMS).toBe(16);
  });
});

describe("summarizeGameTelemetry (win/fail boundaries + speed vs target)", () => {
  const items = (
    correct: boolean[],
    rawTimes: number[],
    provenance: GameItemTelemetry["provenance"] = "current",
  ): GameItemTelemetry[] =>
    correct.map((isCorrect, i) => ({
      isCorrect,
      rawTimeSec: rawTimes[i] ?? 2,
      cognitiveTimeSec: Math.max(0.1, (rawTimes[i] ?? 2) - 0.42),
      provenance,
    }));

  it("guided win boundary: accuracy exactly at targetMasteryScore wins; one below loses", () => {
    const at = items([true, true, true, false], [2, 2, 2, 2]); // 75%... use 4/5
    const five = [
      ...at,
      { isCorrect: true, rawTimeSec: 2, cognitiveTimeSec: 1.58, provenance: "current" as const },
    ];
    expect(summarizeGameTelemetry(five, "guided", 80, 0).metGoal).toBe(true); // 4/5 = 80
    expect(summarizeGameTelemetry(at, "guided", 80, 0).metGoal).toBe(false); // 3/4 = 75
  });

  it("fluency adds the speed condition: median raw at target wins, above loses", () => {
    const atTarget = items([true, true, true, true], [5.5, 5.5, 5.5, 5.5]);
    const above = items([true, true, true, true], [5.6, 5.6, 5.6, 5.5]);
    expect(summarizeGameTelemetry(atTarget, "fluency", 80, 5.5).metGoal).toBe(true);
    expect(summarizeGameTelemetry(above, "fluency", 80, 5.5).metGoal).toBe(false);
    expect(summarizeGameTelemetry(atTarget, "fluency", 80, 5.5).speed.beatTargetPct).toBe(100);
    expect(summarizeGameTelemetry(atTarget, "fluency", 80, 5.5).speed.medianRawSec).toBe(5.5);
    expect(summarizeGameTelemetry(above, "fluency", 80, 5.5).speed.beatTargetPct).toBe(25);
  });

  it("empty session reports zeros, never throws, never wins", () => {
    const summary = summarizeGameTelemetry([], "guided", 80, 0);
    expect(summary.totalItems).toBe(0);
    expect(summary.accuracyPct).toBe(0);
    expect(summary.metGoal).toBe(false);
    expect(summary.speed.targetSec).toBe(0);
  });

  it("counts provenance buckets for the summary's mix line", () => {
    const mixed: GameItemTelemetry[] = [
      { isCorrect: true, rawTimeSec: 2, cognitiveTimeSec: 1.5, provenance: "current" },
      { isCorrect: true, rawTimeSec: 2, cognitiveTimeSec: 1.5, provenance: "current" },
      { isCorrect: false, rawTimeSec: 2, cognitiveTimeSec: 1.5, provenance: "contrastive" },
      { isCorrect: true, rawTimeSec: 2, cognitiveTimeSec: 1.5, provenance: "spaced-review" },
    ];
    const summary = summarizeGameTelemetry(mixed, "guided", 80, 0);
    expect(summary.provenanceCounts).toEqual({ current: 2, contrastive: 1, "spaced-review": 1 });
    expect(summary.accuracyPct).toBe(75);
  });
});
