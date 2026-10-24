/**
 * Question-shape adapter tests (issue #50): per-interaction-type
 * normalization, deterministic shuffle contract, visual rows, anchor
 * labels, and the full type x CPA-stage render matrix.
 */
import { describe, expect, it } from "vitest";
import { CPA_STAGES } from "@balashikshana/core-engine";
import {
  anchorLabelForVisualAid,
  answerTextFor,
  choiceOptionsFor,
  counterSpecFor,
  deterministicShuffle,
  hashSeed,
  renderPlanFor,
  tileSpecFor,
  visualRowFor,
} from "../src/runner/questionShapes";
import { CPA_STAGE_VALUES } from "../src/runner/cpaStages";
import { counterQuestion, fixtureQuestion, tileQuestion } from "./helpers/runnerFixtures";

describe("choice options", () => {
  it("normalizes choices to keyed options", () => {
    const options = choiceOptionsFor(fixtureQuestion({}));
    expect(options.map((option) => option.label)).toEqual(
      expect.arrayContaining(["3", "2", "4", "5"]),
    );
    expect(new Set(options.map((option) => option.key)).size).toBe(4);
  });

  it("coerces numeric choices to strings", () => {
    const options = choiceOptionsFor(fixtureQuestion({ choices: [3, 2, 4] }));
    expect(options.every((option) => typeof option.label === "string")).toBe(true);
  });
});

describe("deterministic shuffle", () => {
  it("reproduces the same order for the same seed", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(deterministicShuffle(items, "seed-a")).toEqual(deterministicShuffle(items, "seed-a"));
  });

  it("is a permutation (no loss, no duplication)", () => {
    const items = ["a", "b", "c", "d", "e"];
    const shuffled = deterministicShuffle(items, "seed-b");
    expect([...shuffled].sort()).toEqual([...items].sort());
  });

  it("does not leave the first choice permanently first", () => {
    // The engine's uniqueChoices places the correct answer FIRST; the
    // runner must vary its position across questions.
    const firstPositions = new Set<number>();
    for (let i = 0; i < 50; i += 1) {
      const shuffled = deterministicShuffle(["correct", "x", "y", "z"], `q-${i}`);
      firstPositions.add(shuffled.indexOf("correct"));
    }
    expect(firstPositions.size).toBeGreaterThanOrEqual(2);
  });

  it("distributes the correct answer near-uniformly across positions (no degenerate bias)", () => {
    // Distribution sanity over the same fixed seed family the runner
    // derives (question ids). Deterministic seeds -> fixed counts, so
    // the bounds below are stable until the algorithm changes (which
    // is exactly what this test exists to catch). Measured: [29,23,26,22].
    const positions = [0, 0, 0, 0];
    let identity = 0;
    for (let i = 0; i < 100; i += 1) {
      const shuffled = deterministicShuffle(["correct", "x", "y", "z"], `q-${i}`);
      const slot = shuffled.indexOf("correct");
      positions[slot] = (positions[slot] ?? 0) + 1;
      if (shuffled.join(",") === "correct,x,y,z") identity += 1;
    }
    // Every position is reachable...
    expect(positions.every((count) => count > 0)).toBe(true);
    // ...and none dominates (uniform = 25%; 40% catches severe bias)...
    expect(Math.max(...positions)).toBeLessThan(40);
    // ...and the raw order is genuinely reshuffled, not passed through.
    expect(identity).toBeLessThan(25);
  });

  it("hashes stably (same string, same uint32)", () => {
    expect(hashSeed("question-1")).toBe(hashSeed("question-1"));
    expect(hashSeed("question-1")).not.toBe(hashSeed("question-2"));
  });
});

describe("counter spec", () => {
  it("reads the seeded counter fields", () => {
    const spec = counterSpecFor(counterQuestion());
    expect(spec).toEqual({ emoji: "X", maxCells: 10, targetCount: 4 });
  });

  it("clamps a missing/absurd cell count into the 5..20 band", () => {
    expect(counterSpecFor(counterQuestion({ maxCounterCells: undefined })).maxCells).toBe(10);
    expect(counterSpecFor(counterQuestion({ maxCounterCells: 2 })).maxCells).toBe(5);
    expect(counterSpecFor(counterQuestion({ maxCounterCells: 99 })).maxCells).toBe(20);
  });

  it("falls back to a neutral glyph when the row has no emoji", () => {
    expect(counterSpecFor(counterQuestion({ counterEmoji: undefined })).emoji).not.toBe("");
  });
});

describe("tile spec", () => {
  it("uses the row's tile bank when present", () => {
    const spec = tileSpecFor(tileQuestion());
    expect(spec.bank.map((option) => option.label)).toEqual(["5", "3", "4", "7"]);
    expect(spec.separator).toBe(" ");
  });

  it("degrades to the choices as tiles when the bank is missing", () => {
    const spec = tileSpecFor(tileQuestion({ tileBank: undefined }));
    expect(spec.bank.map((option) => option.label)).toEqual(["3 4 5", "5 4 3", "3 5 4", "4 3 5"]);
  });
});

describe("visual row and anchor label", () => {
  it("surfaces string visual_objects rows", () => {
    expect(visualRowFor(fixtureQuestion({ visualObjects: "O O O" }))).toBe("O O O");
  });

  it("joins array rows and drops empty visuals", () => {
    expect(visualRowFor(fixtureQuestion({ visualObjects: ["O", "O"] }))).toBe("O O");
    expect(visualRowFor(fixtureQuestion({ visualObjects: undefined }))).toBeNull();
    expect(visualRowFor(fixtureQuestion({ visualObjects: "  " }))).toBeNull();
  });

  it("derives a friendly anchor label from the visual_aid stem", () => {
    expect(anchorLabelForVisualAid("assets/images/ten_frame_and_number_line.svg")).toBe(
      "Ten frame and number line",
    );
    expect(anchorLabelForVisualAid("")).toBeNull();
  });
});

describe("render matrix (type x CPA stage)", () => {
  const types = ["multiple-choice", "tile-builder", "interactive-counter"] as const;

  it("concrete stage mounts the interactive manipulative for manipulative types", () => {
    expect(renderPlanFor("interactive-counter", CPA_STAGES.CONCRETE)).toEqual({
      widget: "interactive-counter",
      visualMode: "none",
      anchorVisible: true,
    });
    expect(renderPlanFor("tile-builder", CPA_STAGES.CONCRETE)).toEqual({
      widget: "tile-builder",
      visualMode: "none",
      anchorVisible: true,
    });
    expect(renderPlanFor("multiple-choice", CPA_STAGES.CONCRETE)).toEqual({
      widget: "choice",
      visualMode: "static",
      anchorVisible: true,
    });
  });

  it("pictorial stage: static visual with choice grid for every type", () => {
    for (const type of types) {
      expect(renderPlanFor(type, CPA_STAGES.PICTORIAL)).toEqual({
        widget: "choice",
        visualMode: "static",
        anchorVisible: false,
      });
    }
  });

  it("ghost-flash stage: one-second peek then choices", () => {
    for (const type of types) {
      expect(renderPlanFor(type, CPA_STAGES.GHOST_FLASH)).toEqual({
        widget: "choice",
        visualMode: "flash",
        anchorVisible: false,
      });
    }
  });

  it("abstract stage: choices with no scaffold for every type", () => {
    for (const type of types) {
      expect(renderPlanFor(type, CPA_STAGES.ABSTRACT)).toEqual({
        widget: "choice",
        visualMode: "none",
        anchorVisible: false,
      });
    }
  });

  it("all four stages produce distinct treatments for each type (fade is visible)", () => {
    for (const type of types) {
      const plans = CPA_STAGE_VALUES.map((stage) => JSON.stringify(renderPlanFor(type, stage)));
      expect(new Set(plans).size).toBe(CPA_STAGE_VALUES.length);
    }
  });

  it("unknown types degrade to the choice grid at every stage", () => {
    expect(renderPlanFor("mystery-future-type", CPA_STAGES.CONCRETE)).toEqual({
      widget: "choice",
      visualMode: "static",
      anchorVisible: true,
    });
  });
});

describe("answer text", () => {
  it("trims the correct answer for comparison", () => {
    expect(answerTextFor(fixtureQuestion({ correctAnswer: " 3 " }))).toBe("3");
  });
});
