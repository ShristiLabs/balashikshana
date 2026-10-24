/**
 * Games module barrel (issue #52). PURE exports first (node-testable),
 * then the renderer registry (component references), then screens.
 *
 * Framework contract for #53/#54 archetype packs:
 * 1. Implement a component satisfying GameRendererProps.
 * 2. Register it in archetypeRegistry.ts under the registry archetype
 *    id (replacing the #52 stub where it overlaps).
 * That is the entire authoring surface - composition, telemetry, the
 * re-queue ladder, durable recording, audio, and fallback stay here.
 */
// Pure (vitest/node, no React Native).
export { ARCHETYPE_IDS, resolveGameRoute, type ArchetypeId } from "./archetypes";
export {
  buildBankFor,
  buildPlanFor,
  buildTargetFor,
  bundleViewFor,
  draftForBuild,
  guidedHintFor,
  sumOfPlaced,
  validateBuild,
  type BlockBuilderPlan,
  type BlockBuilderPlanKind,
  type BuildTile,
  type BuildValidation,
  type BundleView,
} from "./blockBuilder";
export {
  availableStages,
  gameConfigForStage,
  gameSessionLength,
  parseGamesAssetBlock,
} from "./gamesAssets";
export {
  cashierPlanFor,
  changeDueCents,
  choiceLabelForCents,
  COIN_DENOMINATIONS,
  denominationsFor,
  DOLLAR_BILL,
  formatCents,
  guidedHintForCheckout,
  moneyStyleFor,
  parseCentsValue,
  priceCentsFromQuestion,
  sumCents,
  type CashDenomination,
  type MarketCashierPlan,
  type MarketCashierPlanKind,
  type MoneyDisplayStyle,
} from "./marketCashier";
export {
  composeGameItemPlan,
  mixPercentagesFromFractions,
  summarizeGameTelemetry,
  type GameItem,
  type GameItemPlan,
  type GameItemPools,
  type GameItemTelemetry,
  type GameSessionTelemetrySummary,
  type GameSpeedVsTarget,
} from "./sessionModel";
export {
  currentGameQuestion,
  currentGameStage,
  gameReducer,
  initialGameState,
  PROVENANCE_LABELS,
  type GameAction,
  type GameCheckedFeedback,
  type GamePhase,
  type GameRouteInfo,
  type GameState,
} from "./gameStore";
export type {
  FluencyGameConfig,
  GameRendererProps,
  GameRouteDecision,
  GamesAssetBlock,
  GameStage,
  GuidedGameConfig,
  SpiralProvenance,
} from "./types";
export type { GameAttemptTelemetry } from "../practice/types";

// Renderer registry (component references; #54 registration point).
export {
  ARCHETYPE_RENDERERS,
  SUPPORTED_ARCHETYPES,
  rendererForArchetype,
} from "./archetypeRegistry";

// Screens (thin RN layers).
export { GameHostScreen } from "./GameHostScreen";
export { GameSessionScreen } from "./GameSessionScreen";
// #53 pack A renderers (registered in archetypeRegistry).
export { BlockBuilderGame } from "./BlockBuilderGame";
export { MarketCashierGame } from "./MarketCashierGame";
// #52 proof-of-pipeline renderer - unregistered since #53; kept as the
// authoring template for the #54 pack.
export { StubArchetypeGame } from "./StubArchetypeGame";
