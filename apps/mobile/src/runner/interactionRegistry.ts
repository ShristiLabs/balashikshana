/**
 * Interaction-type renderer registry (issue #50).
 *
 * The inventory of interaction types is DATA-DERIVED (the seeded pack
 * rows; the #46 compiler seeds them from the engine generator over the
 * registry), so this module never decides what exists - it only maps
 * each type to a widget-kit renderer and exposes a coverage check the
 * data-driven vitest suite asserts against:
 *
 *   tests/runner-interaction-coverage.test.ts enumerates the distinct
 *   interaction_type values exactly the way the seeder does (engine
 *   generateTopicPracticeSet over every registry topic) and fails when
 *   any type has neither a renderer here nor an entry in
 *   TRACKED_FALLBACK_TYPES.
 *
 * The tracked checklist lives in docs/runner-interaction-coverage.md
 * (kept honest by the same test).
 */

/** The widget-kit renderer families (one per interaction-type family). */
export type InteractionRendererKind = "choice" | "tile-builder" | "interactive-counter";

export interface InteractionRendererSpec {
  /** Renderer family the widget kit implements. */
  kind: InteractionRendererKind;
  /** Widget component name (src/runner/widgets/) that renders the type. */
  widget: string;
}

/**
 * Registered renderers. Keys are the interaction_type column values the
 * seeded data actually contains (enumerated by the coverage test - if a
 * new type ships in a pack without a renderer, the test fails until a
 * renderer or an explicit fallback entry is added here).
 */
export const INTERACTION_RENDERERS: Readonly<Record<string, InteractionRendererSpec>> = {
  "multiple-choice": { kind: "choice", widget: "ChoiceGrid" },
  "tile-builder": { kind: "tile-builder", widget: "TileBuilder" },
  "interactive-counter": { kind: "interactive-counter", widget: "CounterFrame" },
};

/**
 * Explicit, tracked fallbacks: types that intentionally render through a
 * degraded shared widget today. Empty at v1 - every seeded type has a
 * dedicated renderer. Adding an entry REQUIRES a line in
 * docs/runner-interaction-coverage.md explaining the fallback.
 */
export const TRACKED_FALLBACK_TYPES: readonly string[] = [];

/** Renderer spec for an interaction type, or null when unknown. */
export function rendererForInteractionType(
  interactionType: string,
): InteractionRendererSpec | null {
  return INTERACTION_RENDERERS[interactionType] ?? null;
}

export interface InteractionCoverage {
  covered: string[];
  uncovered: string[];
}

/**
 * Coverage of an enumerated type inventory (distinct interaction_type
 * values off the seeded data). A type is covered when it has a renderer
 * entry or a tracked fallback; `uncovered` types fail the coverage test.
 */
export function interactionCoverage(types: readonly string[]): InteractionCoverage {
  const covered: string[] = [];
  const uncovered: string[] = [];
  for (const type of types) {
    if (INTERACTION_RENDERERS[type] !== undefined || TRACKED_FALLBACK_TYPES.includes(type)) {
      covered.push(type);
    } else {
      uncovered.push(type);
    }
  }
  return { covered, uncovered };
}
