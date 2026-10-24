/**
 * Archetype renderer registry (issue #52) - the single registration
 * point where archetype packs mount their renderers.
 *
 *   #53 (pack A): block-builder, market-cashier   (replaces the stub)
 *   #54 (pack B): bubble-pop-blitz, monster-phoneme-feeder
 *
 * "Supported" is exactly the map's keys: resolveGameRoute routes every
 * other registry archetype to the #50 practice runner (fallback marker
 * in telemetry). The stub under "block-builder" is the #52
 * proof-of-pipeline renderer and is replaced by #53's real one - the
 * framework contract (GameRendererProps) stays the same.
 */
import type { ComponentType } from "react";
import { StubArchetypeGame } from "./StubArchetypeGame";
import type { GameRendererProps } from "./types";

/** Archetype id -> installed renderer component. */
export const ARCHETYPE_RENDERERS: Readonly<Record<string, ComponentType<GameRendererProps>>> = {
  // #52 stub: proves the framework end-to-end on real registry data
  // (block-builder is the most common guided archetype: 136 topics).
  // #53 replaces this entry with the real Block Builder renderer.
  "block-builder": StubArchetypeGame,
};

/** The typed supported set (derived from the map - one source of truth). */
export const SUPPORTED_ARCHETYPES: ReadonlySet<string> = new Set(Object.keys(ARCHETYPE_RENDERERS));

/** Renderer for an archetype id, or null when not installed (fallback). */
export function rendererForArchetype(archetype: string): ComponentType<GameRendererProps> | null {
  return ARCHETYPE_RENDERERS[archetype] ?? null;
}
