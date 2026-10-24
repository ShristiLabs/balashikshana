/**
 * Bubble Pop Blitz archetype module (issue #54, pack B) - PURE logic,
 * no React Native imports, node-testable in vitest.
 *
 * The reflex surface: one bubble per choice, laid out on a field the
 * child taps directly - tap-to-answer (the draft IS the choice label
 * verbatim, so the framework's draft === correctAnswer comparison
 * grades the tap). The field is seeded by the item's question id: the
 * same item (including every re-queued repeat) presents the identical
 * field on every device; no Math.random anywhere.
 *
 * Timer pressure (the fluency variant) derives from the registry's
 * targetResponseSpeedSec (through GameRendererProps). The module
 * carries NO clock: it maps (elapsed, target, tier) -> a quantized
 * pressure PHASE, and the renderer samples it from a tick. Age
 * tiering follows roadmap D6 - hearts/pressure exist only in the
 * Grade 2-3 fluency sprints, so the gentle tier (Pre-K/K/G1 and any
 * unrecognized grade id) can never present the urgent phase and the
 * elapsed time clamps at the target: pressure paces, it never
 * punishes. There is no per-item timeout anywhere in the framework;
 * the win rule is median-based (sessionModel).
 */
import type { PracticeQuestion } from "../practice/types";
import { deterministicShuffle } from "../runner/questionShapes";
import type { RunnerOption } from "../runner/questionShapes";

/** Field shapes rotated across bubbles (shape + tint + label text:
 * never color alone). */
export type BubbleShape = "circle" | "square" | "diamond" | "hexagon";

export const BUBBLE_SHAPES: readonly BubbleShape[] = ["circle", "square", "diamond", "hexagon"];

/** One tappable bubble. The label is the EXACT choice label. */
export interface BubbleSpec {
  /** Stable key for React lists. */
  key: string;
  /** The choice label verbatim - publishing it is the graded draft. */
  label: string;
  /** Field slot (deterministic layout order). */
  slot: number;
  /** Rotated shape token (visual scan redundancy, not semantics). */
  shape: BubbleShape;
  /** Stable tint rotation index (theme resolves the ink). */
  tintIndex: number;
}

/** Scan ceiling for one reflex field (the 3-9 age band; today's rows
 * carry 4 choices). Larger choice sets ride the substrate. */
export const MAX_FIELD_BUBBLES = 6;

/**
 * The bubble field for one question: every choice becomes exactly one
 * bubble, slot order seeded by the question id (deterministic replay).
 * Returns null when the row cannot field a reflex surface (fewer than
 * 2 choices, blank labels, or more than MAX_FIELD_BUBBLES) - the
 * renderer then mounts the shared substrate choice grid.
 */
export function bubbleFieldFor(question: PracticeQuestion): BubbleSpec[] | null {
  const labels = question.choices.map((choice) => String(choice));
  if (labels.length < 2 || labels.length > MAX_FIELD_BUBBLES) return null;
  if (labels.some((label) => label.trim() === "")) return null;
  const options: RunnerOption[] = labels.map((label, index) => ({
    key: `${question.questionId}-bubble-${index}`,
    label,
  }));
  const ordered = deterministicShuffle(options, question.questionId);
  return ordered.map((option, slot) => ({
    key: option.key,
    label: option.label,
    slot,
    shape: BUBBLE_SHAPES[slot % BUBBLE_SHAPES.length] as BubbleShape,
    tintIndex: slot % BUBBLE_SHAPES.length,
  }));
}

/** Deterministic guided hint (single step: the reflex surface has no
 * build state - guided simply untimes it and says what to do). */
export function guidedHintForField(): string {
  return "Tap the bubble that answers the question. Take your time.";
}

/** Quantized pressure phases for the fluency variant. */
export type PressurePhase = "steady" | "rising" | "urgent";

/** D6 age tier: sprint pressure is for Grade 2-3 only. */
export type PressureTier = "gentle" | "sprint";

/** Phase order rank (monotonicity is test-pinned). */
const PHASE_RANK: Readonly<Record<PressurePhase, number>> = {
  steady: 0,
  rising: 1,
  urgent: 2,
};

/** Phase boundary fractions of the target (bucket widths: 50% / 30% / 20%). */
const RISING_AT = 0.5;
const URGENT_AT = 0.8;
const SMALLEST_BUCKET = 1 - URGENT_AT;

/** The renderer's pressure tick (ms). Sampling the phase at this rate
 * bounds how far the VISUAL state can lag the child's real elapsed
 * time; it stays well under the smallest phase bucket for every
 * registry target (3.0s smallest -> 0.6s bucket vs 0.25s tick). */
export const PRESSURE_TICK_MS = 250;

/**
 * D6 tier for one topic id ("<grade>-..." structural prefix, never
 * curriculum content): G2/G3 fluency sprints are the only sprint
 * tier; Pre-K/K/G1 - and anything unrecognized - stay gentle (the
 * safe default for the no-fail young grades).
 */
export function pressureTierForTopicId(topicId: string): PressureTier {
  const grade = (topicId.split("-")[0] ?? "").toUpperCase();
  return grade === "G2" || grade === "G3" ? "sprint" : "gentle";
}

/**
 * The pressure phase for (elapsed, target, tier), or null when the
 * stage is untimed (guided, or targetResponseSpeedSec <= 0).
 *
 * Kid-safe by construction: elapsed CLAMPS at the target (nothing
 * visually explodes past 100%), the phase only ever quantizes upward
 * as time passes, and the gentle tier caps at "rising" (D6: the
 * young grades never see the urgent phase).
 */
export function pressurePhaseFor(
  elapsedSec: number,
  targetSec: number,
  tier: PressureTier,
): PressurePhase | null {
  if (!Number.isFinite(targetSec) || targetSec <= 0) return null;
  if (!Number.isFinite(elapsedSec) || elapsedSec < 0) return null;
  const fraction = Math.min(elapsedSec, targetSec) / targetSec;
  let phase: PressurePhase =
    fraction < RISING_AT ? "steady" : fraction < URGENT_AT ? "rising" : "urgent";
  if (tier === "gentle" && phase === "urgent") phase = "rising";
  return phase;
}

/**
 * The input-vs-visual drift bound (test-pinned): the visual phase is
 * sampled on the PRESSURE_TICK_MS tick and phase buckets are never
 * narrower than the smallest fraction of the target, so the presented
 * phase lags the true phase by strictly less than min(tick,
 * smallest bucket) AND no bucket can be skipped between ticks.
 * Returns null for untimed targets.
 */
export function pressureDriftBoundSec(targetSec: number): number | null {
  if (!Number.isFinite(targetSec) || targetSec <= 0) return null;
  return Math.min(PRESSURE_TICK_MS / 1000, targetSec * SMALLEST_BUCKET);
}

/** Phase monotonicity in elapsed time (drift never reorders phases). */
export function phaseRank(phase: PressurePhase): number {
  return PHASE_RANK[phase];
}

/**
 * Presenting copy per phase, tiered (text always accompanies the tint
 * so color never carries the state alone). Gentle copy stays
 * encouraging; sprint copy names the pace.
 */
const GENTLE_COPY: Readonly<Record<PressurePhase, string>> = {
  steady: "Take your time",
  rising: "Keep going",
  urgent: "Keep going",
};
const SPRINT_COPY: Readonly<Record<PressurePhase, string>> = {
  steady: "Steady",
  rising: "Faster",
  urgent: "Quick",
};

export function pressureLabelFor(phase: PressurePhase, tier: PressureTier): string {
  return (tier === "gentle" ? GENTLE_COPY : SPRINT_COPY)[phase];
}
