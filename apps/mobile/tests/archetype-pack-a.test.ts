/**
 * Archetype pack A tester matrices (issue #53): grade money-range
 * change computation, block-builder boundary validation, stage-variant
 * module behaviors, draft-correctness end-to-end for the three item
 * families, and source-scan pins for the #52 carry-over fixes (the
 * repo has no RN component harness - screens are pinned by source per
 * the standing pattern).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PracticeQuestion } from "../src/practice/types";
import {
  buildBankFor,
  buildTargetFor,
  bundleViewFor,
  draftForBuild,
  guidedHintFor,
  validateBuild,
} from "../src/games/blockBuilder";
import {
  cashierPlanFor,
  changeDueCents,
  choiceLabelForCents,
  denominationsFor,
  guidedHintForCheckout,
  parseCentsValue,
  sumCents,
} from "../src/games/marketCashier";

function row(overrides: Partial<PracticeQuestion>): PracticeQuestion {
  return {
    questionId: "q-test",
    topicId: "T-A",
    unitId: "T",
    topicCode: "A",
    topicName: "Test topic",
    difficultyLevel: 1,
    interactionType: "multiple-choice",
    prompt: "Count the coins",
    visualAid: "",
    choices: [],
    correctAnswer: "",
    misconceptionTags: [],
    explanation: "",
    ...overrides,
  };
}

describe("market-cashier change computation across the grade money ranges", () => {
  it("PK coin-identification values: each single coin is its own cent value", () => {
    // The PK surface asks which coin; the pad key IS the value.
    for (const [label, cents] of [
      ["Penny", 1],
      ["Nickel", 5],
      ["Dime", 10],
      ["Quarter", 25],
    ] as const) {
      expect(parseCentsValue(label)).toBe(cents);
      expect(sumCents([cents])).toBe(cents);
    }
  });

  it("K penny/nickel/dime trays: sums and change from a quarter", () => {
    expect(sumCents([5, 5, 1])).toBe(11);
    expect(sumCents([10, 1, 1, 1])).toBe(13);
    // Pay 13 with a quarter -> 12 back.
    expect(changeDueCents(13, 25)).toBe(12);
  });

  it("G1 mixed coins incl. quarters: the classic trays", () => {
    expect(sumCents([25, 10, 10, 5])).toBe(50);
    expect(sumCents([25, 25, 10, 1, 1, 1])).toBe(63);
    expect(changeDueCents(50, 63)).toBe(13);
  });

  it("G2 money up to $1: make change from a dollar bill", () => {
    expect(sumCents([100])).toBe(100);
    expect(changeDueCents(63, 100)).toBe(37);
    expect(changeDueCents(99, 100)).toBe(1);
    expect(changeDueCents(100, 100)).toBe(0);
  });

  it("dollar-spanning trays (>100 cents)", () => {
    expect(sumCents([100, 25, 25])).toBe(150);
    expect(changeDueCents(125, 150)).toBe(25);
    expect(parseCentsValue("$1.25")).toBe(125);
  });

  it("edge cases: exact pay, overpay clamp, zero, invalid inputs", () => {
    expect(changeDueCents(45, 45)).toBe(0);
    expect(changeDueCents(45, 50)).toBe(5);
    expect(changeDueCents(80, 75)).toBe(0);
    expect(changeDueCents(0, 0)).toBe(0);
    expect(changeDueCents(Number.POSITIVE_INFINITY, 100)).toBe(0);
    expect(changeDueCents(Number.NaN, 100)).toBe(0);
    expect(sumCents([])).toBe(0);
  });
});

describe("block-builder boundary matrix", () => {
  it("target clamp edges: 1 and 20 build, 0 and 21 do not", () => {
    expect(buildTargetFor(row({ targetCount: 1 }))).toBe(1);
    expect(buildTargetFor(row({ targetCount: 20 }))).toBe(20);
    expect(buildTargetFor(row({ targetCount: 0 }))).toBeNull();
    expect(buildTargetFor(row({ targetCount: 21 }))).toBeNull();
    expect(buildTargetFor(row({ targetCount: -5 }))).toBeNull();
  });

  it("bank edges: rod joins exactly at 11 (10 is all-unit territory)", () => {
    expect(buildBankFor(1).map((t) => t.value)).toEqual([1]);
    expect(buildBankFor(10).map((t) => t.value)).toEqual([1]);
    expect(buildBankFor(11).map((t) => t.value)).toEqual([1, 10]);
    expect(buildBankFor(20).map((t) => t.value)).toEqual([1, 10]);
  });

  it("overbuild and mixed rod+unit sums validate correctly at both edges", () => {
    expect(validateBuild(20, [10, 10])).toEqual({ complete: true, remaining: 0, overbuilt: false });
    expect(validateBuild(20, [10, 10, 1])).toEqual({
      complete: false,
      remaining: 0,
      overbuilt: true,
    });
    expect(validateBuild(1, [10])).toEqual({ complete: false, remaining: 0, overbuilt: true });
    // 19 = rod + 9 ones, the hardest in-range composition.
    expect(validateBuild(19, [10, 1, 1, 1, 1, 1, 1, 1, 1, 1])).toEqual({
      complete: true,
      remaining: 0,
      overbuilt: false,
    });
    expect(bundleViewFor([10, 1, 1, 1, 1, 1, 1, 1, 1, 1])).toEqual({
      tens: 1,
      ones: 9,
      total: 19,
    });
  });
});

describe("stage-variant parameter consumption (module hooks the variants rely on)", () => {
  it("guided walkthrough: the full deterministic hint sequence for target 12", () => {
    expect(guidedHintFor(12, [])).toBe("Add 12 more to reach 12.");
    expect(guidedHintFor(12, [1, 1, 1])).toBe("Add 9 more to reach 12.");
    expect(guidedHintFor(12, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1])).toBe(
      "10 loose cubes can bundle into a ten rod.",
    );
    expect(guidedHintFor(12, [10, 1])).toBe("Add 1 more cube to reach 12.");
    expect(guidedHintFor(12, [10, 1, 1])).toBe("You built 12! Tap Check.");
  });

  it("guided checkout walkthrough: price -> underpaid -> exact -> overpaid change", () => {
    const q = row({ prompt: "A toy costs 63\u00a2. Pay and make change." });
    expect(guidedHintForCheckout([], q)).toBe("The price is 63\u00a2. Tap coins to pay.");
    expect(guidedHintForCheckout([25, 25], q)).toBe("Paid 50\u00a2. Still need 13\u00a2.");
    expect(guidedHintForCheckout([25, 25, 10, 1, 1, 1], q)).toBe("Exact change! 63\u00a2 paid.");
    expect(guidedHintForCheckout([100], q)).toBe("Change due: 37\u00a2.");
  });

  it("fluency variant: the modules carry no clock - pacing rides the framework's targetResponseSpeedSec prop (banner chip) while hints are renderer-suppressed", () => {
    // The only stage-dependent surface is the hint chain; the fluency
    // renderer suppresses it. Pin that the modules stay pure: same
    // inputs, same outputs, no time dependence.
    const first = guidedHintFor(7, [5, 1, 1]);
    const second = guidedHintFor(7, [5, 1, 1]);
    expect(first).toBe(second);
    expect(first).toBe("You built 7! Tap Check.");
    expect(guidedHintForCheckout([25], row({ prompt: "costs 30\u00a2" }))).toBe(
      "Paid 25\u00a2. Still need 5\u00a2.",
    );
  });
});

describe("draft-correctness end-to-end (tray/build -> exact graded answer)", () => {
  it("mixed-coin count row: the 2q+1d+3p tray drafts the exact answer", () => {
    const q = row({
      prompt: "Count the mixed coins: 2 quarters, 1 dime, and 3 pennies.",
      choices: ["63\u00a2", "53\u00a2", "38\u00a2", "68\u00a2"],
      correctAnswer: "63\u00a2",
    });
    expect(cashierPlanFor(q).kind).toBe("coin-value");
    const tray = [25, 25, 10, 1, 1, 1];
    expect(choiceLabelForCents(sumCents(tray), q.choices)).toBe(q.correctAnswer);
  });

  it("coin-name identification row: one Penny tap drafts the exact answer", () => {
    const q = row({
      prompt: "Which coin is worth 1\u00a2?",
      choices: ["Penny", "Nickel", "Dime", "Quarter"],
      correctAnswer: "Penny",
    });
    expect(cashierPlanFor(q).kind).toBe("coin-value");
    expect(choiceLabelForCents(sumCents([1]), q.choices)).toBe(q.correctAnswer);
    // A wrong coin drafts a wrong-or-null answer, never a lucky match.
    expect(choiceLabelForCents(sumCents([5]), q.choices)).toBe("Nickel");
  });

  it("make-change row: pay 2 quarters for 45\u00a2, change drafts the exact composite label", () => {
    const q = row({
      prompt: "An apple costs 45\u00a2. You pay with 2 quarters. How much change?",
      choices: ["5\u00a2 (1 nickel)", "10\u00a2 (1 dime)", "15\u00a2", "25\u00a2"],
      correctAnswer: "5\u00a2 (1 nickel)",
    });
    expect(cashierPlanFor(q).kind).toBe("coin-value");
    expect(changeDueCents(45, 50)).toBe(5);
    expect(choiceLabelForCents(5, q.choices)).toBe(q.correctAnswer);
  });

  it("block-builder count row: the built rail drafts the engine's numeric answer", () => {
    const q = row({
      interactionType: "interactive-counter",
      targetCount: 12,
      choices: ["12"],
      correctAnswer: "12",
    });
    const build = [10, 1, 1];
    expect(draftForBuild(build)).toBe(q.correctAnswer);
    expect(validateBuild(12, build).complete).toBe(true);
  });
});

describe("data-driven pad spans (no curriculum hardcode)", () => {
  it("pad composition is a pure function of the item's own choice/answer values", () => {
    const centsRow = row({ choices: ["63\u00a2", "53\u00a2"], correctAnswer: "63\u00a2" });
    const dollarRow = row({ choices: ["$1.25", "$0.75"], correctAnswer: "$1.25" });
    expect(denominationsFor(centsRow).map((d) => d.key)).toEqual([
      "penny",
      "nickel",
      "dime",
      "quarter",
    ]);
    expect(denominationsFor(dollarRow).map((d) => d.key)).toEqual([
      "penny",
      "nickel",
      "dime",
      "quarter",
      "dollar",
    ]);
  });
});

describe("#52 carry-over fix pins (source scans - no RN harness)", () => {
  const sessionSource = readFileSync(
    fileURLToPath(new URL("../src/games/GameSessionScreen.tsx", import.meta.url)),
    "utf-8",
  );
  const hostSource = readFileSync(
    fileURLToPath(new URL("../src/games/GameHostScreen.tsx", import.meta.url)),
    "utf-8",
  );

  it("fix 1: play-again has the double-start guard and NO hardcoded-baseline direct start", () => {
    expect(sessionSource).toContain("if (restarting) return;");
    expect(sessionSource).toContain('dispatch({ type: "stage-selected", stage: summary.stage });');
    // The hardcoded-baseline direct start CALL is gone (pin the code
    // form - the comment prose intentionally names the old bug); the
    // only session start is the warm-up's calibrated callback.
    expect(sessionSource).not.toContain("void startSession(0.42);");
    expect(sessionSource).toContain("onComplete={(baseline) => void startSession(baseline)}");
  });

  it("fix 2: summary topic row selected BY TOPIC ID, never the first array slot", () => {
    expect(sessionSource).toContain(
      "summary.perTopic.find((row) => row.topicId === state.topicId)",
    );
    // Pin the code form of the old assumption (assignment from slot 0).
    expect(sessionSource).not.toContain("= summary.perTopic[0]");
  });

  it("fix 3: the session screen renders the explicit stage affordance (stage-pick cards)", () => {
    expect(sessionSource).toContain('state.phase === "stage-pick"');
    expect(sessionSource).toContain("testID={`game-stage-${offered}`}");
  });

  it("fix 4: both dead ternaries are gone", () => {
    expect(sessionSource).not.toContain('summary.archetype ? "" : ""');
    expect(hostSource).not.toContain('decision.kind === "game" ? decision.stage : decision.stage');
  });

  it("renderer mount is keyed by item id (per-item pristine renderer state)", () => {
    expect(sessionSource).toContain("key={question.questionId}");
  });
});
