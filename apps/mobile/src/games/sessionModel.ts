/**
 * Parameterized game-session model (issue #52) - PURE module.
 *
 * The generic engine that runs ANY game archetype: composition (the
 * 70/20/10 spiral item stream from the topic's own assets.games mix),
 * timing policy (guided untimed / fluency speed target), win-fail
 * boundaries (registry targetMasteryScore + speed), and the telemetry
 * roll-up. The #50 practice-runner pieces it composes are reused, never
 * forked: the re-queue ladder (src/runner/requeue.ts, Lag +2/+5/+10)
 * and the spiral allocator (src/gate/spiral.ts, parameterized by #52).
 *
 * PROGRESS PARITY DOCTRINE: every win/fail value computed here is
 * GAME-FACING (celebration copy, stars). Topic mastery truth stays in
 * deriveTopicSession's >= 80 pass rule on BOTH sides (mobile projector
 * and services/api replayGameSession), so game sessions can never fork
 * progress semantics from practice sessions.
 */
import { allocateSpiral, interleaveSpiral, type SpiralMixPercentages } from "../gate/spiral";
import { SPIRAL_MIX } from "../gate/rules";
import type { SpiralProvenance } from "./types";

/** One composed item with its spiral provenance. */
export interface GameItem {
  /** Index into the combined question list the host assembled. */
  questionIndex: number;
  provenance: Exclude<SpiralProvenance, "">;
}

/** The composed item plan: ordered items + provenance per question index. */
export interface GameItemPlan {
  items: GameItem[];
  /** Per-question provenance lookup (re-queues inherit their original's bucket). */
  provenanceByQuestionIndex: Record<number, Exclude<SpiralProvenance, "">>;
}

/** The pools the host fills from the pack (pure function of the reader). */
export interface GameItemPools {
  /** Current-topic questions (stored pack rows, then engine-generated padding). */
  current: number;
  /** Contrastive-prerequisite questions available (prereq units of the topic's unit). */
  prerequisite: number;
  /** Due spaced-review questions available (most-forgotten first, current unit excluded). */
  review: number;
}

/** Map a registry assets.games spiralMix (fractions) to allocator percentages. */
export function mixPercentagesFromFractions(mix: {
  currentTopic: number;
  contrastivePrerequisite: number;
  spacedReview: number;
}): SpiralMixPercentages {
  // Normalize against the actual sum so a malformed triple (sum != 1)
  // still yields a valid percentage triple; an all-zero triple falls
  // back to the registry default mix (the gate's globalMasteryRules).
  // Rounded at 1e-9 so 0.7/1.0*100 stays exactly 70 (float noise would
  // otherwise beat the allocator's own tie order).
  const sum = mix.currentTopic + mix.contrastivePrerequisite + mix.spacedReview;
  if (!Number.isFinite(sum) || sum <= 0) return SPIRAL_MIX;
  const round = (value: number): number => Math.round(value * 1e9) / 1e9;
  return {
    currentUnitPercent: round((mix.currentTopic / sum) * 100),
    prerequisitePercent: round((mix.contrastivePrerequisite / sum) * 100),
    spacedReviewPercent: round((mix.spacedReview / sum) * 100),
  };
}

const PROVENANCE_BY_SOURCE: Record<
  "current" | "prerequisite" | "review",
  Exclude<SpiralProvenance, "">
> = {
  current: "current",
  prerequisite: "contrastive",
  review: "spaced-review",
};

/**
 * Compose the game's item plan: allocate `count` across the three pools
 * with the topic's mix (largest-remainder, clamped to availability, a
 * missing pool's share flowing back to the current topic), then
 * interleave deterministically (most-under-represented bucket first).
 * The guided stage composes current-only (untimed explorer; the
 * registry carries spiralMix on the fluency config alone).
 */
export function composeGameItemPlan(
  count: number,
  pools: GameItemPools,
  mix: SpiralMixPercentages | null,
): GameItemPlan {
  const allocation = mix
    ? allocateSpiral(count, { prerequisite: pools.prerequisite, review: pools.review }, mix)
    : // Current-only composition (guided stage): the full count from the
      // current topic (the allocator with a 100/0/0 mix).
      allocateSpiral(
        count,
        { prerequisite: pools.prerequisite, review: pools.review },
        { currentUnitPercent: 100, prerequisitePercent: 0, spacedReviewPercent: 0 },
      );

  const items: GameItem[] = [];
  const provenanceByQuestionIndex: Record<number, Exclude<SpiralProvenance, "">> = {};
  // Question-index cursors per bucket: the host assembles the pools in
  // the SAME bucket order (current questions, then prerequisite, then
  // review) so index ranges are stable and deterministic.
  const starts: Record<"current" | "prerequisite" | "review", number> = {
    current: 0,
    prerequisite: pools.current,
    review: pools.current + pools.prerequisite,
  };
  const cursors: Record<"current" | "prerequisite" | "review", number> = {
    current: 0,
    prerequisite: 0,
    review: 0,
  };
  for (const source of interleaveSpiral(allocation)) {
    const questionIndex = starts[source] + cursors[source];
    cursors[source] += 1;
    const provenance = PROVENANCE_BY_SOURCE[source];
    items.push({ questionIndex, provenance });
    provenanceByQuestionIndex[questionIndex] = provenance;
  }
  return { items, provenanceByQuestionIndex };
}

/** One item's recorded telemetry facts (raw + engine-derived timing). */
export interface GameItemTelemetry {
  isCorrect: boolean;
  rawTimeSec: number;
  /** Engine cognitive time (audio-aware for GAME rows; per-attempt rule). */
  cognitiveTimeSec: number;
  provenance: Exclude<SpiralProvenance, "">;
}

export interface GameSpeedVsTarget {
  /** Registry target (0 = untimed guided stage; no speed stat then). */
  targetSec: number;
  medianRawSec: number;
  medianCognitiveSec: number;
  /** Share of items answered at-or-below the raw-time target (0-100). */
  beatTargetPct: number;
}

export interface GameSessionTelemetrySummary {
  totalItems: number;
  correctItems: number;
  accuracyPct: number;
  speed: GameSpeedVsTarget;
  /** Items per spiral bucket (the 70/20/10 the session actually served). */
  provenanceCounts: { current: number; contrastive: number; "spaced-review": number };
  /** Game-facing win evaluation (celebration), NOT the mastery pass rule. */
  metGoal: boolean;
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * Roll up per-item telemetry into the session summary. Win boundaries
 * (issue #52 framework semantics, registry-data-driven):
 *   - guided: accuracy >= targetMasteryScore over the served items;
 *   - fluency: accuracy >= targetMasteryScore AND the median raw answer
 *     time at-or-below the stage's targetResponseSpeedSec.
 * Speed uses RAW time (the registry target paces the sprint as the
 * child experiences it); mastery/fluency GRADES elsewhere stay on the
 * engine's cognitive-time rule.
 */
export function summarizeGameTelemetry(
  items: readonly GameItemTelemetry[],
  stage: "guided" | "fluency",
  targetMasteryScore: number,
  targetResponseSpeedSec: number,
): GameSessionTelemetrySummary {
  const total = items.length;
  const correct = items.filter((item) => item.isCorrect).length;
  const accuracyPct = total > 0 ? Number(((correct / total) * 100).toFixed(1)) : 0;
  const rawTimes = items.map((item) => item.rawTimeSec);
  const cogTimes = items.map((item) => item.cognitiveTimeSec);
  const target = stage === "fluency" ? targetResponseSpeedSec : 0;
  const beat = target > 0 ? items.filter((item) => item.rawTimeSec <= target).length : 0;
  const metGoal =
    stage === "guided"
      ? accuracyPct >= targetMasteryScore
      : accuracyPct >= targetMasteryScore &&
        target > 0 &&
        rawTimes.length > 0 &&
        medianOf(rawTimes) <= target;
  return {
    totalItems: total,
    correctItems: correct,
    accuracyPct,
    speed: {
      targetSec: target,
      medianRawSec: Number(medianOf(rawTimes).toFixed(2)),
      medianCognitiveSec: Number(medianOf(cogTimes).toFixed(2)),
      beatTargetPct: total > 0 && target > 0 ? Number(((beat / total) * 100).toFixed(1)) : 0,
    },
    provenanceCounts: {
      current: items.filter((item) => item.provenance === "current").length,
      contrastive: items.filter((item) => item.provenance === "contrastive").length,
      "spaced-review": items.filter((item) => item.provenance === "spaced-review").length,
    },
    metGoal,
  };
}
