/**
 * CPA stage tests (issue #50): the stage ladder mirrors the engine
 * exactly (pinned against updateTopicMemoryStability across a
 * stability sweep), topics without progress start concrete, and the
 * scaffold policy makes all four stages render distinctly.
 */
import { describe, expect, it } from "vitest";
import { CPA_STAGES, updateTopicMemoryStability } from "@balashikshana/core-engine";
import {
  CPA_FADE_ORDER,
  CPA_STAGE_LABELS,
  GHOST_FLASH_MS,
  scaffoldPolicyForStage,
  stageForStabilityDays,
  stageForTopicProgress,
  stageLabelFor,
} from "../src/runner/cpaStages";
import type { TopicProgressRecord } from "../src/practice/types";

describe("stage ladder mirrors the engine", () => {
  it("assigns every engine update output the same stage the engine labels it", () => {
    // The engine's cpaStage describes the POST-update stability; the
    // mirror maps ANY stability value to the same label the engine
    // would assign it. Pin across a grid of (current, grade) updates.
    const currents = [0.5, 1, 1.5, 2, 3, 5, 7, 10, 15, 30, 60];
    const grades = [1, 2, 3, 4];
    for (const current of currents) {
      for (const fluencyGrade of grades) {
        const update = updateTopicMemoryStability({
          currentStabilityDays: current,
          fluencyGrade,
          gradeGrowthFactor: 2.0,
          maxIntervalCapDays: 60,
        });
        expect(
          stageForStabilityDays(update.stabilityDays),
          `stability ${update.stabilityDays}`,
        ).toBe(update.cpaStage);
      }
    }
  });

  it("threshold boundaries land exactly (1 / 4 / 10 days)", () => {
    expect(stageForStabilityDays(0.99)).toBe(CPA_STAGES.CONCRETE);
    expect(stageForStabilityDays(1)).toBe(CPA_STAGES.PICTORIAL);
    expect(stageForStabilityDays(3.99)).toBe(CPA_STAGES.PICTORIAL);
    expect(stageForStabilityDays(4)).toBe(CPA_STAGES.GHOST_FLASH);
    expect(stageForStabilityDays(9.99)).toBe(CPA_STAGES.GHOST_FLASH);
    expect(stageForStabilityDays(10)).toBe(CPA_STAGES.ABSTRACT);
  });

  it("negative inputs degrade to concrete, never crash", () => {
    expect(stageForStabilityDays(-5)).toBe(CPA_STAGES.CONCRETE);
  });
});

describe("stage for topic progress", () => {
  const row = (stabilityDays: number): TopicProgressRecord => ({
    studentId: "s",
    topicId: "U-T",
    unitId: "U",
    topicCode: "T",
    completed: 1,
    crowns: 1,
    masteryScore: 80,
    bestAccuracyPct: 80,
    bestMedianSpeedSec: 3,
    attemptsCount: 1,
    fluencyGrade: 3,
    stabilityDays,
    nextReviewAt: 0,
    lastReviewedAt: 1,
    provisional: true,
    updatedAt: 1,
  });

  it("a topic with no progress row starts at the concrete stage", () => {
    expect(stageForTopicProgress(null)).toBe(CPA_STAGES.CONCRETE);
  });

  it("a reviewed topic renders at its stability-derived stage", () => {
    expect(stageForTopicProgress(row(12))).toBe(CPA_STAGES.ABSTRACT);
    expect(stageForTopicProgress(row(2))).toBe(CPA_STAGES.PICTORIAL);
  });
});

describe("scaffold policy (all four stages distinct)", () => {
  it("concrete: interactive manipulative", () => {
    expect(scaffoldPolicyForStage(CPA_STAGES.CONCRETE)).toEqual({
      interactiveManipulative: true,
      staticVisual: false,
      flashVisualMs: null,
    });
  });

  it("pictorial: static visual", () => {
    expect(scaffoldPolicyForStage(CPA_STAGES.PICTORIAL)).toEqual({
      interactiveManipulative: false,
      staticVisual: true,
      flashVisualMs: null,
    });
  });

  it("ghost-flash: one-second peek (the engine's 1S window)", () => {
    expect(scaffoldPolicyForStage(CPA_STAGES.GHOST_FLASH)).toEqual({
      interactiveManipulative: false,
      staticVisual: false,
      flashVisualMs: GHOST_FLASH_MS,
    });
    expect(GHOST_FLASH_MS).toBe(1000);
  });

  it("abstract: no scaffold; unknown stages degrade unscaffolded", () => {
    const none = { interactiveManipulative: false, staticVisual: false, flashVisualMs: null };
    expect(scaffoldPolicyForStage(CPA_STAGES.ABSTRACT)).toEqual(none);
    expect(scaffoldPolicyForStage("SOME_FUTURE_STAGE")).toEqual(none);
  });

  it("every stage has a distinct policy (the fade is visible)", () => {
    const policies = CPA_FADE_ORDER.map((stage) => JSON.stringify(scaffoldPolicyForStage(stage)));
    expect(new Set(policies).size).toBe(CPA_FADE_ORDER.length);
  });
});

describe("stage labels", () => {
  it("label every engine stage; unknown values pass through", () => {
    for (const stage of CPA_FADE_ORDER) {
      expect(stageLabelFor(stage)).not.toBe(stage);
    }
    expect(stageLabelFor("WEIRD")).toBe("WEIRD");
    expect(Object.keys(CPA_STAGE_LABELS).sort()).toEqual([...CPA_FADE_ORDER].sort());
  });
});
