/**
 * Block Builder archetype module (issue #53) - PURE logic, no React
 * Native imports, node-testable in vitest.
 *
 * The renderer mounts three answer surfaces, chosen per question from
 * the item's OWN data (never from curriculum knowledge):
 *   count-build   - the child taps +1 unit cubes and +10 ten rods to
 *                   build a count target; loose ones auto-bundle into
 *                   rods on the display rail (the registry mechanics
 *                   "bundle-10-ones-to-ten-rod-and-unbundle"), and the
 *                   draft is the built count string.
 *   tile-sequence - the item carries a tile bank (equation building);
 *                   the shared TileBuilder widget owns the surface and
 *                   the draft is the placed sequence joined.
 *   substrate     - anything else renders through the shared
 *                   QuestionBody matrix (choice grid is the universal
 *                   answer surface - the #50 degraded-stage doctrine).
 *
 * Guided vs fluency variants: the pure functions expose a deterministic
 * hint chain (guided surfaces it step-by-step; fluency suppresses it
 * and paces off targetResponseSpeedSec, which the framework passes
 * through GameRendererProps).
 */
import type { PracticeQuestion } from "../practice/types";
import { tileSpecFor } from "../runner/questionShapes";

/** Which surface the renderer mounts for one question. */
export type BlockBuilderPlanKind = "count-build" | "tile-sequence" | "substrate";

export interface BlockBuilderPlan {
  kind: BlockBuilderPlanKind;
  /** Count target for count-build (null for the other kinds). */
  target: number | null;
}

/** Largest count the build rail renders (matches the counter ceiling). */
export const BUILD_TARGET_CEILING = 20;

function integerAnswerFor(question: PracticeQuestion): number | null {
  const text = String(question.correctAnswer ?? "").trim();
  return /^[0-9]{1,3}$/.test(text) ? Number(text) : null;
}

/**
 * The count target for one question: the explicit targetCount when the
 * row carries one, else a strict integer answer. Both come from the
 * item's own data - nothing here knows any topic or grade.
 */
export function buildTargetFor(question: PracticeQuestion): number | null {
  const explicit =
    typeof question.targetCount === "number" && Number.isInteger(question.targetCount)
      ? question.targetCount
      : null;
  const candidate = explicit ?? integerAnswerFor(question);
  if (candidate === null) return null;
  return candidate >= 1 && candidate <= BUILD_TARGET_CEILING ? candidate : null;
}

/**
 * The build surface plan for one question. A tile bank on the row
 * (equation building) wins; then a derivable count target; else the
 * shared substrate.
 */
export function buildPlanFor(question: PracticeQuestion): BlockBuilderPlan {
  const bank = tileSpecFor(question).bank;
  if (bank.length > 0 && Array.isArray(question.tileBank)) {
    return { kind: "tile-sequence", target: null };
  }
  const target = buildTargetFor(question);
  if (target !== null && question.interactionType !== "multiple-choice") {
    return { kind: "count-build", target };
  }
  return { kind: "substrate", target: null };
}

/** One build tile: a unit cube or a ten rod. */
export interface BuildTile {
  /** Stable key for React lists. */
  key: string;
  label: string;
  value: number;
}

/**
 * The build bank for a target: +1 cubes always, +10 rods once the
 * target reaches 11+ (bundling is part of the mechanics only when a
 * ten is reachable). Derived from the target alone.
 */
export function buildBankFor(target: number): BuildTile[] {
  const bank: BuildTile[] = [{ key: "unit", label: "+1", value: 1 }];
  if (target >= 11) bank.push({ key: "rod", label: "+10", value: 10 });
  return bank;
}

/** Sum of the placed tile values. */
export function sumOfPlaced(placed: readonly number[]): number {
  return placed.reduce((total, value) => total + value, 0);
}

/** Bundled view of a build: how many ten rods and loose ones it shows. */
export interface BundleView {
  tens: number;
  ones: number;
  total: number;
}

/**
 * Auto-bundle display: any ten loose-equivalent units render as one
 * rod (12 built = 1 rod + 2 ones). Pure arithmetic off the sum.
 */
export function bundleViewFor(placed: readonly number[]): BundleView {
  const total = sumOfPlaced(placed);
  return { tens: Math.floor(total / 10), ones: total % 10, total };
}

/** Build state validation for check-enablement and hints. */
export interface BuildValidation {
  complete: boolean;
  remaining: number;
  overbuilt: boolean;
}

export function validateBuild(target: number, placed: readonly number[]): BuildValidation {
  const total = sumOfPlaced(placed);
  return {
    complete: total === target,
    remaining: Math.max(0, target - total),
    overbuilt: total > target,
  };
}

/**
 * Deterministic guided hint chain (one hint per build state; the
 * renderer surfaces exactly one line, step-by-step):
 *   complete      -> celebrate + point at Check
 *   overbuilt     -> point at Remove one
 *   all-units ten -> the bundling hint (the core mechanic: the rail
 *                    just bundled 10 loose cubes into a rod)
 *   otherwise     -> the remaining count
 */
export function guidedHintFor(target: number, placed: readonly number[]): string {
  const { tens, total } = bundleViewFor(placed);
  if (total === target) return `You built ${target}! Tap Check.`;
  if (total > target) return `That is ${total - target} too many. Tap Remove one.`;
  if (tens > 0 && placed.every((value) => value === 1)) {
    return "10 loose cubes can bundle into a ten rod.";
  }
  const remaining = target - total;
  return remaining === 1
    ? `Add 1 more cube to reach ${target}.`
    : `Add ${remaining} more to reach ${target}.`;
}

/**
 * The draft string for a build (the built count), or null while
 * nothing is placed. Matches the engine's numeric answer strings.
 */
export function draftForBuild(placed: readonly number[]): string | null {
  const total = sumOfPlaced(placed);
  return total > 0 ? String(total) : null;
}
