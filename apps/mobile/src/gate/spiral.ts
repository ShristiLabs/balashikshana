/**
 * 70/20/10 interleaved spiral mix (issue #51) — PURE composition math.
 *
 * The boss-gate session blends three question sources per the registry's
 * globalMasteryRules.scientificSpacedRepetition.interleavedSpiralMix
 * (70% current unit, 20% contrastive prerequisite units, 10% due spaced
 * review). Both functions here are deterministic and side-effect free:
 * the engine (PracticeSessionEngine.startGateSession) feeds them pool
 * sizes and consumes the source plan; tests pin every allocation and
 * ordering decision.
 *
 * Issue #52 parameterized the allocation: the game framework passes the
 * per-topic spiralMix from assets.games as DATA (same 70/20/10 across
 * today's registry, but carried per topic). The boss gate keeps the
 * default (registry globalMasteryRules), so #51 behavior is unchanged —
 * ONE allocation algorithm, never a forked copy.
 */
import { SPIRAL_MIX } from "./rules";

export type SpiralSource = "current" | "prerequisite" | "review";

export interface SpiralCounts {
  current: number;
  prerequisite: number;
  review: number;
}

export interface SpiralAvailability {
  /** Questions available from prerequisite units (0 when none installed). */
  prerequisite: number;
  /** Due-review questions available (0 when nothing is due). */
  review: number;
}

/** Percent weights for the three spiral buckets (sum should be 100). */
export interface SpiralMixPercentages {
  currentUnitPercent: number;
  prerequisitePercent: number;
  spacedReviewPercent: number;
}

const BUCKET_ORDER: readonly SpiralSource[] = ["current", "prerequisite", "review"];

function rawTargets(count: number, mix: SpiralMixPercentages): SpiralCounts {
  return {
    current: (count * mix.currentUnitPercent) / 100,
    prerequisite: (count * mix.prerequisitePercent) / 100,
    review: (count * mix.spacedReviewPercent) / 100,
  };
}

/**
 * Deterministic largest-remainder allocation of `count` items across the
 * three sources, clamped to availability (a missing source's share flows
 * back to the current unit), summing EXACTLY to count:
 *
 * 1. floor each mix target (70/20/10 by default; #52 games pass the
 *    topic's own assets.games spiralMix as data);
 * 2. hand the remainder to the largest fractional parts, ties broken in
 *    the fixed order current > prerequisite > review;
 * 3. clamp prerequisite/review to what actually exists and give the
 *    clamped overflow back to the current unit (the only unbounded
 *    pool — the unit's own questions, round-robinned like the server's
 *    stratified builder).
 */
export function allocateSpiral(
  count: number,
  available: SpiralAvailability,
  mix: SpiralMixPercentages = SPIRAL_MIX,
): SpiralCounts {
  const total = Math.max(0, Math.floor(count));
  const targets = rawTargets(total, mix);
  const floors: SpiralCounts = {
    current: Math.floor(targets.current),
    prerequisite: Math.floor(targets.prerequisite),
    review: Math.floor(targets.review),
  };
  let remainder = total - (floors.current + floors.prerequisite + floors.review);
  // Round the fractional parts so a 12.6/3.6 split does not let float
  // noise (0.5999... vs 0.6000...) beat the documented tie order.
  const fracs = BUCKET_ORDER.map((bucket) => ({
    bucket,
    frac: Math.round((targets[bucket] - floors[bucket]) * 1e9) / 1e9,
  })).sort((a, b) =>
    b.frac !== a.frac
      ? b.frac - a.frac
      : BUCKET_ORDER.indexOf(a.bucket) - BUCKET_ORDER.indexOf(b.bucket),
  );
  for (const entry of fracs) {
    if (remainder <= 0) break;
    floors[entry.bucket] += 1;
    remainder -= 1;
  }

  const prerequisite = Math.min(floors.prerequisite, Math.max(0, available.prerequisite));
  const review = Math.min(floors.review, Math.max(0, available.review));
  return {
    current: total - prerequisite - review,
    prerequisite,
    review,
  };
}

/**
 * Deterministic interleaving of the three sources into one question
 * order: repeatedly emit from the bucket that is MOST under-represented
 * so far relative to its target (largest deficit = taken/target ratio
 * smallest; zero-target buckets never emit), ties broken current >
 * prerequisite > review. This spreads prerequisite and review items
 * across the whole session instead of appending them in a block, with
 * zero randomness.
 */
export function interleaveSpiral(counts: SpiralCounts): SpiralSource[] {
  const taken: Record<SpiralSource, number> = { current: 0, prerequisite: 0, review: 0 };
  const total = counts.current + counts.prerequisite + counts.review;
  const order: SpiralSource[] = [];
  for (let i = 0; i < total; i += 1) {
    let pick: SpiralSource | null = null;
    let pickRatio = Number.POSITIVE_INFINITY;
    for (const bucket of BUCKET_ORDER) {
      if (counts[bucket] <= 0 || taken[bucket] >= counts[bucket]) continue;
      const ratio = (taken[bucket] + 1) / counts[bucket];
      if (ratio < pickRatio) {
        pick = bucket;
        pickRatio = ratio;
      }
    }
    if (!pick) break;
    taken[pick] += 1;
    order.push(pick);
  }
  return order;
}
