/**
 * Archetype renderer registry (issues #52/#53) - the single
 * registration point where archetype packs mount their renderers.
 *
 *   #53 (pack A): block-builder, market-cashier   (shipped)
 *   #54 (pack B): bubble-pop-blitz, monster-phoneme-feeder
 *
 * "Supported" is exactly the map's keys: resolveGameRoute routes every
 * other registry archetype to the #50 practice runner (fallback marker
 * in telemetry). The #52 proof-of-pipeline stub is no longer
 * registered - BlockBuilderGame is the real "block-builder" renderer;
 * StubArchetypeGame stays in the tree as the authoring template for
 * the #54 pack (the GameRendererProps contract is unchanged).
 */
import type { ComponentType } from "react";
import { BlockBuilderGame } from "./BlockBuilderGame";
import { MarketCashierGame } from "./MarketCashierGame";
import type { GameRendererProps } from "./types";

/** Archetype id -> installed renderer component. */
export const ARCHETYPE_RENDERERS: Readonly<Record<string, ComponentType<GameRendererProps>>> = {
  "block-builder": BlockBuilderGame,
  "market-cashier": MarketCashierGame,
};

/** The typed supported set (derived from the map - one source of truth). */
export const SUPPORTED_ARCHETYPES: ReadonlySet<string> = new Set(Object.keys(ARCHETYPE_RENDERERS));

/** Renderer for an archetype id, or null when not installed (fallback). */
export function rendererForArchetype(archetype: string): ComponentType<GameRendererProps> | null {
  return ARCHETYPE_RENDERERS[archetype] ?? null;
}
