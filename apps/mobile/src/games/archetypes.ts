/**
 * Archetype inventory + game-route resolution (issue #52) - PURE module.
 *
 * ARCHETYPE_IDS is the DATA-DERIVED inventory of the 11 archetype ids
 * the registry actually references (enumerated from
 * docs/us-curriculum-registry.json unit `games` blocks and per-topic
 * assets.games across all 614 topics; docs/games-and-study-materials.md
 * section 2 lists "10 archetypes" but packs bubble-pop-blitz and
 * story-detective into one row, and trace-draw-studio appears at unit
 * level only - the registry is the source of truth). The data-driven
 * test in tests/games-registry-catalog.test.ts re-enumerates the
 * registry and fails if the two ever drift.
 *
 * Route resolution is the framework's front door: a topic + stage
 * either mounts an installed archetype renderer or transparently falls
 * back to the #50 practice runner - never a dead end (issue #52 AC).
 */
import { gameConfigForStage } from "./gamesAssets";
import type { GameRouteDecision, GameStage, GamesAssetBlock } from "./types";

/**
 * Every archetype id the registry references today. "supported" is a
 * RUNTIME property (which renderers are installed), never a property of
 * this list: an id here without a renderer routes to the practice
 * fallback with reason "archetype-not-installed".
 */
export const ARCHETYPE_IDS = [
  "tactile-sorter",
  "trace-draw-studio",
  "lilypad-jumper",
  "block-builder",
  "monster-phoneme-feeder",
  "bridge-builder",
  "market-cashier",
  "array-grid-architect",
  "slice-share-kitchen",
  "bubble-pop-blitz",
  "story-detective",
] as const;

export type ArchetypeId = (typeof ARCHETYPE_IDS)[number];

/**
 * Resolve the route for a topic + stage against the set of installed
 * renderers. Decision order (each miss degrades to the practice
 * fallback, never to an error screen):
 *   1. no games block at all            -> reason "no-games-block"
 *   2. stage not offered by this topic  -> reason "stage-missing"
 *   3. archetype has no renderer yet    -> reason "archetype-not-installed"
 *   4. otherwise                        -> kind "game" with the config
 */
export function resolveGameRoute(
  block: GamesAssetBlock,
  stage: GameStage | null,
  supportedArchetypes: ReadonlySet<string>,
): GameRouteDecision {
  if (!block.guidedPracticeGame && !block.fluencySprintGame) {
    return { kind: "practice-fallback", stage: null, archetype: null, reason: "no-games-block" };
  }
  if (stage === null) {
    return { kind: "practice-fallback", stage: null, archetype: null, reason: "stage-missing" };
  }
  const config = gameConfigForStage(block, stage);
  if (!config) {
    return { kind: "practice-fallback", stage, archetype: null, reason: "stage-missing" };
  }
  if (!supportedArchetypes.has(config.archetype)) {
    return {
      kind: "practice-fallback",
      stage,
      archetype: config.archetype,
      reason: "archetype-not-installed",
    };
  }
  return {
    kind: "game",
    stage,
    archetype: config.archetype,
    gameId: config.gameId,
    gameTitle: config.title,
    guided: stage === "guided" ? block.guidedPracticeGame : null,
    fluency: stage === "fluency" ? block.fluencySprintGame : null,
  };
}
