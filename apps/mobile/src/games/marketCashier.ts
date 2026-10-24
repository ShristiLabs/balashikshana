/**
 * Market Cashier archetype module (issue #53) - PURE logic, no React
 * Native imports, node-testable in vitest.
 *
 * The checkout surface: the child taps US coins (and a dollar bill
 * when the item's own data spans dollars) into a tray, the tray totals
 * in integer cents, and the built total is matched back to the item's
 * EXACT choice label so the framework's string comparison grades it
 * (draft === correctAnswer). Money parsing is learned from the
 * question's own choices/answers - no curriculum data lives here; the
 * only domain knowledge is the US coin set itself (denomination values
 * and names), which is universal currency fact, not curriculum.
 *
 * Making change: changeDueCents is the checkout core (paid - price);
 * the guided variant surfaces price/paid/change live whenever the
 * item's own prompt carries a parseable price.
 *
 * Guided vs fluency variants: guided shows the tray, per-coin values,
 * and the hint chain; fluency suppresses hints and paces off
 * targetResponseSpeedSec (through GameRendererProps).
 */
import type { PracticeQuestion } from "../practice/types";

/** One money tile the child can tap into the tray. */
export interface CashDenomination {
  /** Stable key for React lists. */
  key: string;
  label: string;
  cents: number;
  /** Spoken accessibility label (value + name redundancy). */
  a11y: string;
}

/** The US coin set (universal currency facts, not curriculum data). */
export const COIN_DENOMINATIONS: readonly CashDenomination[] = [
  { key: "penny", label: "1\u00a2", cents: 1, a11y: "Penny, 1 cent" },
  { key: "nickel", label: "5\u00a2", cents: 5, a11y: "Nickel, 5 cents" },
  { key: "dime", label: "10\u00a2", cents: 10, a11y: "Dime, 10 cents" },
  { key: "quarter", label: "25\u00a2", cents: 25, a11y: "Quarter, 25 cents" },
];

export const DOLLAR_BILL: CashDenomination = {
  key: "dollar",
  label: "$1",
  cents: 100,
  a11y: "One dollar bill, 100 cents",
};

/** Coin names -> cents (whole-word, case-insensitive). */
const COIN_NAME_CENTS: Readonly<Record<string, number>> = {
  penny: 1,
  nickel: 5,
  dime: 10,
  quarter: 25,
};

/**
 * Parse a money-ish string to integer cents, or null when it carries
 * no money value. Accepted forms (the registry's answer vocabulary):
 *   "$1.25" "1.25"  -> dollars (a decimal point means dollars)
 *   "63\u00a2" "63"  "5\u00a2 (1 nickel)" -> cents (leading token wins)
 *   "Penny" "quarter" -> coin name values
 */
export function parseCentsValue(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const lower = trimmed.toLowerCase();
  const nameMatch = lower.match(/^(penny|nickel|dime|quarter)\b/);
  if (nameMatch) {
    const value = COIN_NAME_CENTS[nameMatch[1] as keyof typeof COIN_NAME_CENTS];
    return value ?? null;
  }
  const dollarMatch = trimmed.match(/^\$\s*([0-9]+(?:\.[0-9]{1,2})?)/);
  if (dollarMatch) {
    return Math.round(Number(dollarMatch[1]) * 100);
  }
  const plainMatch = trimmed.match(/^([0-9]+(?:\.[0-9]{1,2})?)(?:\s*\u00a2|\s+cent?s?\b|\s*\()?/);
  if (!plainMatch) return null;
  const raw = plainMatch[1] as string;
  const number = Number(raw);
  if (!Number.isFinite(number)) return null;
  return raw.includes(".") ? Math.round(number * 100) : Math.round(number);
}

/** Sum of the tapped denominations, in cents. */
export function sumCents(placed: readonly number[]): number {
  return placed.reduce((total, cents) => total + cents, 0);
}

/**
 * Making change (the checkout core): what comes back when paidCents
 * covers priceCents. Never negative; invalid inputs yield 0.
 */
export function changeDueCents(priceCents: number, paidCents: number): number {
  if (!Number.isFinite(priceCents) || !Number.isFinite(paidCents)) return 0;
  return Math.max(0, Math.round(paidCents) - Math.round(priceCents));
}

/** Which surface the renderer mounts for one question. */
export type MarketCashierPlanKind = "coin-value" | "substrate";

export interface MarketCashierPlan {
  kind: MarketCashierPlanKind;
  /** Choices parsed to cents, aligned with question.choices by index. */
  choiceCents: (number | null)[];
}

/**
 * The cashier surface plan: coin-value mounts the checkout pad when
 * EVERY choice parses to a cents value and the values are UNIQUE (a
 * built total then identifies exactly one label - the graded draft).
 * Anything else (non-money choices, ambiguous values) rides the shared
 * QuestionBody substrate; the choice grid stays the universal surface.
 */
export function cashierPlanFor(question: PracticeQuestion): MarketCashierPlan {
  const choiceCents = question.choices.map((choice) => parseCentsValue(String(choice)));
  const allParse = choiceCents.length > 0 && choiceCents.every((cents) => cents !== null);
  if (!allParse) return { kind: "substrate", choiceCents };
  const values = choiceCents.map((cents) => cents as number);
  const unique = new Set(values).size === values.length;
  return unique ? { kind: "coin-value", choiceCents } : { kind: "substrate", choiceCents };
}

/**
 * The exact choice label a built total selects, or null when no label
 * (or more than one) carries that value. Returning the label verbatim
 * is what makes the framework's draft === correctAnswer comparison
 * grade the manipulative correctly.
 */
export function choiceLabelForCents(
  builtCents: number,
  choices: readonly unknown[],
): string | null {
  const matches = choices
    .map((choice) => String(choice))
    .filter((label) => parseCentsValue(label) === builtCents);
  return matches.length === 1 ? (matches[0] as string) : null;
}

/**
 * The pad for one question: the coin set, plus the dollar bill when
 * the item's own data spans a dollar or more (any choice or the
 * answer parsing to >= 100 cents). Purely data-driven.
 */
export function denominationsFor(question: PracticeQuestion): CashDenomination[] {
  const spans = [
    parseCentsValue(String(question.correctAnswer ?? "")),
    ...question.choices.map((choice) => parseCentsValue(String(choice))),
  ].some((cents) => cents !== null && cents >= 100);
  return spans ? [...COIN_DENOMINATIONS, DOLLAR_BILL] : [...COIN_DENOMINATIONS];
}

/**
 * A price named in the item's own prompt ("costs 45\u00a2" / "costs
 * $1.25"), or null. Conservative on purpose: no match, no price chip.
 */
export function priceCentsFromQuestion(question: PracticeQuestion): number | null {
  const prompt = String(question.prompt ?? "");
  const match = prompt.match(
    /costs?\s+(\$[0-9]+(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?\s*\u00a2)/i,
  );
  if (!match) return null;
  const token = (match[1] as string).replace(/\s+/g, "");
  return parseCentsValue(token.startsWith("$") ? token : `${token.replace("\u00a2", "")}\u00a2`);
}

/** Display style learned from the item's own answer vocabulary. */
export type MoneyDisplayStyle = "cents" | "dollars";

export function moneyStyleFor(question: PracticeQuestion): MoneyDisplayStyle {
  return String(question.correctAnswer ?? "").includes("$") ? "dollars" : "cents";
}

/** Format cents in the item's own style ("63\u00a2" or "$1.25"). */
export function formatCents(cents: number, style: MoneyDisplayStyle): string {
  if (style === "dollars") {
    return `$${(cents / 100).toFixed(2)}`;
  }
  return `${cents}\u00a2`;
}

/**
 * Deterministic guided hint chain for the checkout surface:
 *   empty tray + price -> invite to pay
 *   price + underpaid  -> still needed
 *   price + covered    -> change due (the making-change beat)
 *   no price           -> match-a-card guidance
 */
export function guidedHintForCheckout(
  placed: readonly number[],
  question: PracticeQuestion,
): string {
  const total = sumCents(placed);
  const price = priceCentsFromQuestion(question);
  if (price !== null) {
    if (total === 0)
      return `The price is ${formatCents(price, moneyStyleFor(question))}. Tap coins to pay.`;
    if (total < price) {
      return `Paid ${formatCents(total, moneyStyleFor(question))}. Still need ${formatCents(price - total, moneyStyleFor(question))}.`;
    }
    const change = changeDueCents(price, total);
    return change === 0
      ? `Exact change! ${formatCents(total, moneyStyleFor(question))} paid.`
      : `Change due: ${formatCents(change, moneyStyleFor(question))}.`;
  }
  if (total === 0) return "Tap coins to count their value.";
  return `Tray holds ${formatCents(total, moneyStyleFor(question))}. Find the matching card.`;
}
