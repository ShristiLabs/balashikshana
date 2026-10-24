/**
 * Market Cashier pure-module tests (issue #53): money parsing across
 * the registry answer vocabulary, integer-cent arithmetic (sums +
 * making change per the grade money ranges), the choice-label matcher
 * that makes the manipulative framework-gradable, and the guided
 * checkout hint chain. All fixtures are synthetic rows in the engine's
 * question shape - no registry data is copied here.
 */
import { describe, expect, it } from "vitest";
import type { PracticeQuestion } from "../src/practice/types";
import {
  cashierPlanFor,
  changeDueCents,
  choiceLabelForCents,
  COIN_DENOMINATIONS,
  denominationsFor,
  DOLLAR_BILL,
  formatCents,
  guidedHintForCheckout,
  moneyStyleFor,
  parseCentsValue,
  priceCentsFromQuestion,
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
    prompt: "Count the mixed coins",
    visualAid: "",
    choices: ["63\u00a2", "53\u00a2", "38\u00a2", "68\u00a2"],
    correctAnswer: "63\u00a2",
    misconceptionTags: [],
    explanation: "",
    ...overrides,
  };
}

describe("parseCentsValue (the registry answer vocabulary)", () => {
  it("cents forms", () => {
    expect(parseCentsValue("63\u00a2")).toBe(63);
    expect(parseCentsValue("63")).toBe(63);
    expect(parseCentsValue("5\u00a2 (1 nickel)")).toBe(5);
  });

  it("dollar forms (a decimal point means dollars)", () => {
    expect(parseCentsValue("$1.25")).toBe(125);
    expect(parseCentsValue("$1")).toBe(100);
    expect(parseCentsValue("0.85")).toBe(85);
  });

  it("coin names map to their values (whole-word, case-insensitive)", () => {
    expect(parseCentsValue("Penny")).toBe(1);
    expect(parseCentsValue("quarter")).toBe(25);
    expect(parseCentsValue("Nickel")).toBe(5);
    expect(parseCentsValue("Dime")).toBe(10);
  });

  it("non-money strings parse to null", () => {
    expect(parseCentsValue("Both are equal")).toBeNull();
    expect(parseCentsValue("")).toBeNull();
    expect(parseCentsValue("Correct Model")).toBeNull();
  });
});

describe("integer-cent arithmetic", () => {
  it("sums a mixed-coin tray (the classic 2 quarters + 1 dime + 3 pennies)", () => {
    expect(sumCents([25, 25, 10, 1, 1, 1])).toBe(63);
  });

  it("sums dollar-bill trays", () => {
    expect(sumCents([100, 25, 25])).toBe(150);
  });

  it("making change across the grade money ranges", () => {
    expect(changeDueCents(45, 50)).toBe(5);
    expect(changeDueCents(63, 100)).toBe(37);
    expect(changeDueCents(125, 125)).toBe(0);
    expect(changeDueCents(80, 75)).toBe(0);
    expect(changeDueCents(Number.NaN, 50)).toBe(0);
  });
});

describe("cashierPlanFor (surface selection from item data)", () => {
  it("all-unique money choices -> coin-value (the checkout pad)", () => {
    const plan = cashierPlanFor(row({}));
    expect(plan.kind).toBe("coin-value");
    expect(plan.choiceCents).toEqual([63, 53, 38, 68]);
  });

  it("coin-identification choices (names) also ride the pad", () => {
    const plan = cashierPlanFor(
      row({ choices: ["Penny", "Nickel", "Dime", "Quarter"], correctAnswer: "Penny" }),
    );
    expect(plan.kind).toBe("coin-value");
    expect(plan.choiceCents).toEqual([1, 5, 10, 25]);
  });

  it("dollar-style choices ride the pad with dollar values", () => {
    const plan = cashierPlanFor(
      row({ choices: ["$1.25", "$1.00", "$0.75"], correctAnswer: "$1.25" }),
    );
    expect(plan.kind).toBe("coin-value");
    expect(plan.choiceCents).toEqual([125, 100, 75]);
  });

  it("non-money or ambiguous-value choices -> the shared substrate", () => {
    expect(
      cashierPlanFor(
        row({ choices: ["Correct Model", "Distractor A"], correctAnswer: "Correct Model" }),
      ).kind,
    ).toBe("substrate");
    expect(
      cashierPlanFor(row({ choices: ["5\u00a2", "5\u00a2", "10\u00a2"], correctAnswer: "5\u00a2" }))
        .kind,
    ).toBe("substrate");
  });
});

describe("choiceLabelForCents (framework-graded drafts)", () => {
  it("returns the item's EXACT label for a built total", () => {
    expect(choiceLabelForCents(63, ["63\u00a2", "53\u00a2", "38\u00a2", "68\u00a2"])).toBe(
      "63\u00a2",
    );
    expect(
      choiceLabelForCents(5, ["5\u00a2 (1 nickel)", "10\u00a2 (1 dime)", "15\u00a2", "25\u00a2"]),
    ).toBe("5\u00a2 (1 nickel)");
    expect(choiceLabelForCents(1, ["Penny", "Nickel", "Dime", "Quarter"])).toBe("Penny");
  });

  it("no match or ambiguous match -> null (the child keeps counting)", () => {
    expect(choiceLabelForCents(62, ["63\u00a2", "53\u00a2"])).toBeNull();
    expect(choiceLabelForCents(5, ["5\u00a2", "5\u00a2", "10\u00a2"])).toBeNull();
    expect(choiceLabelForCents(5, [])).toBeNull();
  });

  it("the 2q+1d+3p tray drafts the exact graded answer end-to-end", () => {
    const question = row({});
    const tray = [25, 25, 10, 1, 1, 1];
    const draft = choiceLabelForCents(sumCents(tray), question.choices);
    expect(draft).toBe(question.correctAnswer);
  });
});

describe("denominationsFor (data-driven pad)", () => {
  it("coin-only items get the four-coin pad", () => {
    const pad = denominationsFor(row({}));
    expect(pad).toHaveLength(4);
    expect(pad.map((d) => d.cents)).toEqual([1, 5, 10, 25]);
  });

  it("dollar-spanning items add the $1 bill", () => {
    const pad = denominationsFor(
      row({ choices: ["$1.25", "$1.00", "$0.75"], correctAnswer: "$1.25" }),
    );
    expect(pad).toHaveLength(5);
    expect(pad[4]).toEqual(DOLLAR_BILL);
    expect(COIN_DENOMINATIONS).toHaveLength(4);
  });
});

describe("price + hint chain (guided checkout)", () => {
  it("a named price parses out of the prompt (both money styles)", () => {
    expect(
      priceCentsFromQuestion(row({ prompt: "An apple costs 45\u00a2. You pay with 2 quarters." })),
    ).toBe(45);
    expect(priceCentsFromQuestion(row({ prompt: "A book costs $1.25 at the store." }))).toBe(125);
    expect(priceCentsFromQuestion(row({ prompt: "Count the coins." }))).toBeNull();
  });

  it("empty tray with a price invites paying; underpaid names the remainder; covered names the change", () => {
    const q = row({ prompt: "An apple costs 45\u00a2. How much change?" });
    expect(guidedHintForCheckout([], q)).toBe("The price is 45\u00a2. Tap coins to pay.");
    expect(guidedHintForCheckout([25], q)).toBe("Paid 25\u00a2. Still need 20\u00a2.");
    expect(guidedHintForCheckout([25, 25], q)).toBe("Change due: 5\u00a2.");
    expect(guidedHintForCheckout([25, 10, 10], q)).toBe("Exact change! 45\u00a2 paid.");
  });

  it("no price -> match-a-card guidance in the item's own money style", () => {
    const q = row({});
    expect(guidedHintForCheckout([], q)).toBe("Tap coins to count their value.");
    expect(guidedHintForCheckout([25, 25, 10, 1, 1, 1], q)).toBe(
      "Tray holds 63\u00a2. Find the matching card.",
    );
  });
});

describe("money style + formatting (learned from the item)", () => {
  it("cents-style items format as N\u00a2, dollar-style as $N.NN", () => {
    const centsRow = row({});
    expect(moneyStyleFor(centsRow)).toBe("cents");
    expect(formatCents(63, moneyStyleFor(centsRow))).toBe("63\u00a2");
    const dollarRow = row({ choices: ["$1.25", "$1.00"], correctAnswer: "$1.25" });
    expect(moneyStyleFor(dollarRow)).toBe("dollars");
    expect(formatCents(125, moneyStyleFor(dollarRow))).toBe("$1.25");
  });
});
