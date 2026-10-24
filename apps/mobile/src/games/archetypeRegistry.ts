/**
 * Archetype renderer registry (issues #52/#53/#54) - the single
 * registration point where archetype packs mount their renderers.
 *
 *   #53 (pack A): block-builder, market-cashier          (shipped)
 *   #54 (pack B): bubble-pop-blitz, monster-phoneme-feeder (shipped)
 *
 * "Supported" is exactly the map's keys: resolveGameRoute routes every
 * other registry archetype to the #50 practice runner (fallback marker
 * in telemetry). The #52 proof-of-pipeline stub is gone - the four
 * real renderers are the authoring templates now (pure module + thin
 * RN component over the widget kit, per the GameRendererProps
 * contract; pack B adds the optional reflex submit seam).
 */
import type { ComponentType } from "react";
import { BlockBuilderGame } from "./BlockBuilderGame";
import { MarketCashierGame } from "./MarketCashierGame";
import { BubblePopBlitzGame } from "./BubblePopBlitzGame";
import { MonsterPhonemeFeederGame } from "./MonsterPhonemeFeederGame";
import type { GameRendererProps } from "./types";

/** Archetype id -> installed renderer component. */
export const ARCHETYPE_RENDERERS: Readonly<Record<string, ComponentType<GameRendererProps>>> = {
  "block-builder": BlockBuilderGame,
  "market-cashier": MarketCashierGame,
  "bubble-pop-blitz": BubblePopBlitzGame,
  "monster-phoneme-feeder": MonsterPhonemeFeederGame,
};

/** The typed supported set (derived from the map - one source of truth). */
export const SUPPORTED_ARCHETYPES: ReadonlySet<string> = new Set(Object.keys(ARCHETYPE_RENDERERS));

/** Renderer for an archetype id, or null when not installed (fallback). */
export function rendererForArchetype(archetype: string): ComponentType<GameRendererProps> | null {
  return ARCHETYPE_RENDERERS[archetype] ?? null;
}
