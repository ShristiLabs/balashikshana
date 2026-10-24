/**
 * Question-shape adapters (issue #50) - PURE module.
 *
 * Normalizes the #47 PracticeQuestion rows into the exact prop shapes
 * the widget kit consumes, and decides the render plan (widget x CPA
 * stage x visual mode) for a question. Everything here is deterministic
 * and node-testable; the RN widgets stay dumb presentational surfaces.
 *
 * Seeded-row contract (verified by the coverage test): every question
 * row carries a non-empty choices array, so the choice grid is the
 * universal degraded-stage answer surface - a manipulative that fades
 * out (PICTORIAL/GHOST/ABSTRACT stages) always falls through to it.
 */
import { CPA_STAGES } from "@balashikshana/core-engine";
import type { PracticeQuestion } from "../practice/types";
import type { InteractionRendererKind } from "./interactionRegistry";

/** One selectable option (choice card, bank tile). */
export interface RunnerOption {
  key: string;
  label: string;
}

/** Interactive-counter widget spec (concrete stage). */
export interface CounterSpec {
  emoji: string;
  /** Grid size in cells; clamped to [5, 20], five columns per row. */
  maxCells: number;
  targetCount: number | null;
}

/** Tile-builder widget spec (concrete stage). */
export interface TileSpec {
  bank: RunnerOption[];
  /** Separator joining the built sequence into the answer string. */
  separator: string;
}

const DEFAULT_COUNTER_EMOJI = "\u25CF"; // neutral filled circle, never a brand glyph
const COUNTER_CELL_FLOOR = 5;
const COUNTER_CELL_CEILING = 20;

/**
 * Deterministic FNV-1a hash of a seed string -> uint32 (the shuffle
 * seed source; no Math.random anywhere in the render path, so the same
 * question always presents the same choice order on every device).
 */
export function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Deterministic Fisher-Yates shuffle: identical seed -> identical
 * order. The seeded rows place the correct answer FIRST (the engine's
 * uniqueChoices), so the runner must not present them unshuffled.
 */
export function deterministicShuffle<T>(items: readonly T[], seed: string): T[] {
  const copy = [...items];
  let state = hashSeed(seed) || 1;
  const next = (): number => {
    // xorshift32 - small, fast, deterministic on every JS engine.
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = next() % (i + 1);
    const tmp = copy[i] as T;
    copy[i] = copy[j] as T;
    copy[j] = tmp;
  }
  return copy;
}

function toOptions(values: readonly unknown[], idPrefix: string): RunnerOption[] {
  return values.map((value, index) => ({
    key: `${idPrefix}-${index}`,
    label: String(value),
  }));
}

/** Choice options for a question, deterministically shuffled by question id. */
export function choiceOptionsFor(question: PracticeQuestion): RunnerOption[] {
  return deterministicShuffle(
    toOptions(question.choices, question.questionId),
    question.questionId,
  );
}

/** Counter widget spec with safe clamps for missing/padded rows. */
export function counterSpecFor(question: PracticeQuestion): CounterSpec {
  const raw = question.maxCounterCells ?? 10;
  return {
    emoji: question.counterEmoji || DEFAULT_COUNTER_EMOJI,
    maxCells: Math.min(COUNTER_CELL_CEILING, Math.max(COUNTER_CELL_FLOOR, Math.floor(raw))),
    targetCount: question.targetCount ?? null,
  };
}

/**
 * Tile bank for the builder widget: the row's tile_bank_json when the
 * pack stored tiles, otherwise the choices as single tiles (degraded
 * but truthful - matches the web harness's `q.tileBank || q.choices`).
 */
export function tileSpecFor(question: PracticeQuestion): TileSpec {
  const rawBank = question.tileBank;
  const source = Array.isArray(rawBank) && rawBank.length > 0 ? rawBank : question.choices;
  return {
    bank: toOptions(source, `${question.questionId}-tile`),
    separator: " ",
  };
}

/** The visual scaffold content row (emoji/object strings off visual_objects). */
export function visualRowFor(question: PracticeQuestion): string | null {
  const raw = question.visualObjects;
  if (typeof raw === "string" && raw.trim() !== "") return raw;
  if (Array.isArray(raw)) {
    const joined = raw.map((entry) => String(entry)).join(" ");
    return joined.trim() !== "" ? joined : null;
  }
  return null;
}

/** Friendly label for a manipulative anchor from its asset path stem. */
export function anchorLabelForVisualAid(visualAid: string): string | null {
  if (!visualAid) return null;
  const stem = visualAid.split("/").pop() ?? "";
  const base = stem
    .replace(/\.svg$/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  if (base === "") return null;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/** Which widget family renders the question (renderer kind -> widget). */
export type RunnerWidget = Extract<InteractionRendererKind, string>;

/** How the visual scaffold behaves at this stage. */
export type VisualMode = "none" | "static" | "flash";

/** The full render plan for one question at one CPA stage. */
export interface RenderPlan {
  widget: RunnerWidget;
  visualMode: VisualMode;
  /**
   * Whether the manipulative-anchor chip (the tool in play, from the
   * row's visual_aid) is visible. The CONCRETE stage names the tool -
   * part of how all four stages render distinctly (for choice-type
   * questions concrete and pictorial differ by the anchor, since the
   * choice type has no interactive manipulative to swap in).
   */
  anchorVisible: boolean;
}

/**
 * The interaction-type x CPA-stage render matrix. The manipulative is
 * the answer surface ONLY at the CONCRETE stage; later stages fade to
 * the choice grid with progressively less scaffold. The matrix is pure
 * data - tests pin all type x stage combinations.
 */
export function renderPlanFor(interactionType: string, stage: string): RenderPlan {
  const kind = rendererKindFor(interactionType);
  if (stage === CPA_STAGES.CONCRETE) {
    if (kind === "interactive-counter") {
      return { widget: "interactive-counter", visualMode: "none", anchorVisible: true };
    }
    if (kind === "tile-builder") {
      return { widget: "tile-builder", visualMode: "none", anchorVisible: true };
    }
    return { widget: "choice", visualMode: "static", anchorVisible: true };
  }
  if (stage === CPA_STAGES.PICTORIAL) {
    return { widget: "choice", visualMode: "static", anchorVisible: false };
  }
  if (stage === CPA_STAGES.GHOST_FLASH) {
    return { widget: "choice", visualMode: "flash", anchorVisible: false };
  }
  // PURE_ABSTRACT_SYMBOLIC (and any unknown stage degrades unscaffolded)
  return { widget: "choice", visualMode: "none", anchorVisible: false };
}

function rendererKindFor(interactionType: string): InteractionRendererKind | null {
  if (interactionType === "interactive-counter") return "interactive-counter";
  if (interactionType === "tile-builder") return "tile-builder";
  if (interactionType === "multiple-choice") return "choice";
  return null;
}

/** The answer string for a question, trimmed for comparison. */
export function answerTextFor(question: PracticeQuestion): string {
  return String(question.correctAnswer).trim();
}
