/**
 * Block Builder pure-module tests (issue #53): plan derivation from
 * item data (never curriculum knowledge), the bundling arithmetic, the
 * deterministic guided hint chain, and the draft strings the framework
 * grades. All fixtures are synthetic rows in the engine's question
 * shape - no registry data is copied here.
 */
import { describe, expect, it } from "vitest";
import type { PracticeQuestion } from "../src/practice/types";
import {
  buildBankFor,
  buildPlanFor,
  buildTargetFor,
  bundleViewFor,
  draftForBuild,
  guidedHintFor,
  sumOfPlaced,
  validateBuild,
} from "../src/games/blockBuilder";

function row(overrides: Partial<PracticeQuestion>): PracticeQuestion {
  return {
    questionId: "q-test",
    topicId: "T-A",
    unitId: "T",
    topicCode: "A",
    topicName: "Test topic",
    difficultyLevel: 1,
    interactionType: "interactive-counter",
    prompt: "Build 7",
    visualAid: "",
    choices: ["7"],
    correctAnswer: "7",
    misconceptionTags: [],
    explanation: "",
    ...overrides,
  };
}

describe("buildPlanFor", () => {
  it("counter row with targetCount -> count-build carrying the target", () => {
    const plan = buildPlanFor(row({ targetCount: 7, correctAnswer: "7" }));
    expect(plan.kind).toBe("count-build");
    expect(plan.target).toBe(7);
  });

  it("counter row without targetCount derives it from a strict integer answer", () => {
    const plan = buildPlanFor(row({ targetCount: undefined, correctAnswer: "12" }));
    expect(plan.kind).toBe("count-build");
    expect(plan.target).toBe(12);
  });

  it("a tile bank on the row -> tile-sequence (the shared TileBuilder surface)", () => {
    const plan = buildPlanFor(
      row({
        interactionType: "tile-builder",
        tileBank: ["3", "+", "4", "=", "7"],
        correctAnswer: "3 + 4 = 7",
      }),
    );
    expect(plan.kind).toBe("tile-sequence");
    expect(plan.target).toBeNull();
  });

  it("non-integer or non-positive answers -> substrate (choice grid universal)", () => {
    expect(
      buildPlanFor(row({ correctAnswer: "63\u00a2", interactionType: "multiple-choice" })).kind,
    ).toBe("substrate");
    expect(
      buildPlanFor(row({ correctAnswer: "Penny", interactionType: "multiple-choice" })).kind,
    ).toBe("substrate");
    expect(buildPlanFor(row({ correctAnswer: "0" })).kind).toBe("substrate");
    expect(buildPlanFor(row({ correctAnswer: "21" })).kind).toBe("substrate");
  });
});

describe("buildTargetFor / buildBankFor", () => {
  it("targets clamp to [1, 20] (the build rail ceiling)", () => {
    expect(buildTargetFor(row({ targetCount: 0 }))).toBeNull();
    expect(buildTargetFor(row({ targetCount: 20, correctAnswer: "20" }))).toBe(20);
    expect(buildTargetFor(row({ targetCount: 21, correctAnswer: "21" }))).toBeNull();
  });

  it("bank carries only +1 cubes until a ten is reachable, then the +10 rod joins", () => {
    expect(buildBankFor(10).map((tile) => tile.value)).toEqual([1]);
    expect(buildBankFor(11).map((tile) => tile.value)).toEqual([1, 10]);
    expect(buildBankFor(20).map((tile) => tile.value)).toEqual([1, 10]);
  });
});

describe("bundle + validate arithmetic", () => {
  it("twelve built ones auto-bundle into one rod + two ones", () => {
    expect(bundleViewFor([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1])).toEqual({
      tens: 1,
      ones: 2,
      total: 12,
    });
  });

  it("rods placed by the child bundle with loose ones (mixed bank)", () => {
    expect(bundleViewFor([10, 1, 1])).toEqual({ tens: 1, ones: 2, total: 12 });
    expect(sumOfPlaced([10, 10, 5])).toBe(25);
  });

  it("validation reports complete / remaining / overbuilt without mutation", () => {
    expect(validateBuild(7, [1, 1, 1])).toEqual({
      complete: false,
      remaining: 4,
      overbuilt: false,
    });
    expect(validateBuild(7, [5, 1, 1])).toEqual({ complete: true, remaining: 0, overbuilt: false });
    expect(validateBuild(7, [10])).toEqual({ complete: false, remaining: 0, overbuilt: true });
  });
});

describe("guided hint chain (deterministic, step-by-step)", () => {
  it("empty build -> remaining count hint", () => {
    expect(guidedHintFor(7, [])).toBe("Add 7 more to reach 7.");
  });

  it("one away uses the singular phrasing", () => {
    expect(guidedHintFor(7, [1, 5])).toBe("Add 1 more cube to reach 7.");
  });

  it("exactly ten loose ones -> the bundling hint (the core mechanic)", () => {
    expect(guidedHintFor(12, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1])).toBe(
      "10 loose cubes can bundle into a ten rod.",
    );
  });

  it("complete -> celebrate + Check; overbuilt -> Remove one", () => {
    expect(guidedHintFor(7, [5, 2])).toBe("You built 7! Tap Check.");
    expect(guidedHintFor(7, [10])).toBe("That is 3 too many. Tap Remove one.");
  });
});

describe("draft strings (framework-graded)", () => {
  it("draft is the built count, null while nothing is placed", () => {
    expect(draftForBuild([])).toBeNull();
    expect(draftForBuild([10, 1, 1])).toBe("12");
  });

  it("the draft for a target matches the engine's numeric answer form", () => {
    const target = 7;
    const placed = [5, 1, 1];
    expect(draftForBuild(placed)).toBe(String(target));
    expect(validateBuild(target, placed).complete).toBe(true);
  });
});
