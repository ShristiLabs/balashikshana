/**
 * CPA scaffold-stage logic (issue #50) - PURE module.
 *
 * MIRROR, DO NOT FORK (DI doctrine): the stage ladder below reproduces
 * the thresholds of the engine's updateTopicMemoryStability cpaStage
 * mapping exactly; tests/runner-cpa.test.ts pins the equality across a
 * stability sweep so the mirror can never drift from
 * packages/core-engine. The stage is ALWAYS derived from engine state
 * (the topic's stabilityDays in the #47 progress projection) - never
 * from UI heuristics.
 *
 * Rendering contract per stage (the fade):
 * - CONCRETE_INTERACTIVE:      the interactive manipulative widget
 * - PICTORIAL_STATIC:          a static visual, choices only
 * - PICTORIAL_GHOST_FLASH_1S:  the visual shows for 1 s, then hides
 * - PURE_ABSTRACT_SYMBOLIC:    no visual scaffold at all
 */
import { CPA_STAGES } from "@balashikshana/core-engine";
import type { TopicProgressRecord } from "../practice/types";

/** The engine's four CPA stage values (imported, never re-declared). */
export const CPA_STAGE_VALUES = [
  CPA_STAGES.CONCRETE,
  CPA_STAGES.PICTORIAL,
  CPA_STAGES.GHOST_FLASH,
  CPA_STAGES.ABSTRACT,
] as const;

/** Fade order, concrete-first (display/curiosity only; state is engine-owned). */
export const CPA_FADE_ORDER: readonly string[] = CPA_STAGE_VALUES;

/** The ghost-flash window implied by the engine stage name (..._1S). */
export const GHOST_FLASH_MS = 1000;

/**
 * Stage for a topic's CURRENT memory stability. Line-for-line the
 * engine's ladder (updateTopicMemoryStability): <1 concrete, >=1
 * pictorial, >=4 ghost-flash, >=10 abstract.
 */
export function stageForStabilityDays(stabilityDays: number): string {
  if (stabilityDays >= 10) return CPA_STAGES.ABSTRACT;
  if (stabilityDays >= 4) return CPA_STAGES.GHOST_FLASH;
  if (stabilityDays >= 1) return CPA_STAGES.PICTORIAL;
  return CPA_STAGES.CONCRETE;
}

/**
 * Stage for a topic the runner is about to present. A topic with no
 * progress row is brand new (stability floor below 1 day) so it starts
 * at the CONCRETE stage - exactly where the projector's first-session
 * math leaves it (currentStabilityDays floor 0.5-1.0).
 */
export function stageForTopicProgress(prev: TopicProgressRecord | null): string {
  if (!prev) return CPA_STAGES.CONCRETE;
  return stageForStabilityDays(prev.stabilityDays);
}

/** What the render layer may show at a stage (the fading policy). */
export interface ScaffoldPolicy {
  /** The interactive manipulative widget is the answer surface. */
  interactiveManipulative: boolean;
  /** A static visual row is visible. */
  staticVisual: boolean;
  /** The visual shows briefly then hides (window in ms), or null. */
  flashVisualMs: number | null;
}

/** Rendering policy per stage - all four stages are distinct. */
export function scaffoldPolicyForStage(stage: string): ScaffoldPolicy {
  if (stage === CPA_STAGES.CONCRETE) {
    return { interactiveManipulative: true, staticVisual: false, flashVisualMs: null };
  }
  if (stage === CPA_STAGES.PICTORIAL) {
    return { interactiveManipulative: false, staticVisual: true, flashVisualMs: null };
  }
  if (stage === CPA_STAGES.GHOST_FLASH) {
    return { interactiveManipulative: false, staticVisual: false, flashVisualMs: GHOST_FLASH_MS };
  }
  // PURE_ABSTRACT_SYMBOLIC and anything unknown to the ladder: no
  // scaffold. An unrecognized string degrades to the least help, never
  // to a crash.
  return { interactiveManipulative: false, staticVisual: false, flashVisualMs: null };
}

/** Short kid/parent-facing label per stage (badge text). */
export const CPA_STAGE_LABELS: Readonly<Record<string, string>> = {
  [CPA_STAGES.CONCRETE]: "Hands-on",
  [CPA_STAGES.PICTORIAL]: "Picture",
  [CPA_STAGES.GHOST_FLASH]: "Quick peek",
  [CPA_STAGES.ABSTRACT]: "Brain power",
};

/** Label for a stage value; unknown values fall back to the stage string. */
export function stageLabelFor(stage: string): string {
  return CPA_STAGE_LABELS[stage] ?? stage;
}
