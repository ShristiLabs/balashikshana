/**
 * Topic assets.games parser (issue #52) - PURE module.
 *
 * Reads the `games` slice of a topic's parsed assets_json (the shape
 * packTopicToEngineTopic produces: Record<string, unknown>) and returns
 * a validated GamesAssetBlock. The registry is the only author of this
 * data; the parser TRUSTS NOTHING - malformed numbers, missing fields,
 * or a wholly absent block degrade to nulls (never throw: a broken
 * games block routes the topic to the practice fallback, it never
 * blocks the child).
 */
import type { FluencyGameConfig, GameStage, GamesAssetBlock, GuidedGameConfig } from "./types";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asPositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function parseGuided(raw: unknown): GuidedGameConfig | null {
  const record = asRecord(raw);
  if (!record) return null;
  const gameId = asString(record.gameId);
  const archetype = asString(record.archetype);
  if (!gameId || !archetype) return null;
  return {
    gameId,
    archetype,
    title: asString(record.title) ?? gameId,
    mechanics: asString(record.mechanics) ?? "",
    // Registry data carries 80 / 8 today; the defaults are the documented
    // pedagogy floor so a malformed field still yields a playable game.
    targetMasteryScore: asPositiveNumber(record.targetMasteryScore) ?? 80,
    minQuestionsToComplete: asPositiveNumber(record.minQuestionsToComplete) ?? 8,
  };
}

function parseFluency(raw: unknown): FluencyGameConfig | null {
  const record = asRecord(raw);
  if (!record) return null;
  const gameId = asString(record.gameId);
  const archetype = asString(record.archetype);
  if (!gameId || !archetype) return null;
  const mixRecord = asRecord(record.spiralMix);
  const spiralMix = mixRecord
    ? {
        currentTopic: asPositiveNumber(mixRecord.currentTopic) ?? 0.7,
        contrastivePrerequisite: asPositiveNumber(mixRecord.contrastivePrerequisite) ?? 0.2,
        spacedReview: asPositiveNumber(mixRecord.spacedReview) ?? 0.1,
      }
    : { currentTopic: 0.7, contrastivePrerequisite: 0.2, spacedReview: 0.1 };
  return {
    gameId,
    archetype,
    title: asString(record.title) ?? gameId,
    mechanics: asString(record.mechanics) ?? "",
    targetResponseSpeedSec: asPositiveNumber(record.targetResponseSpeedSec) ?? 0,
    spiralMix,
  };
}

/**
 * Parse a topic's full assets object (assets_json already JSON.parsed)
 * into the validated games block. Absent/malformed => both sides null
 * (the host falls back to the practice runner).
 */
export function parseGamesAssetBlock(assets: Record<string, unknown>): GamesAssetBlock {
  const games = asRecord(assets.games);
  if (!games) return { guidedPracticeGame: null, fluencySprintGame: null };
  return {
    guidedPracticeGame: parseGuided(games.guidedPracticeGame),
    fluencySprintGame: parseFluency(games.fluencySprintGame),
  };
}

/** The config for one stage, or null when that stage is not offered. */
export function gameConfigForStage(
  block: GamesAssetBlock,
  stage: GameStage,
): GuidedGameConfig | FluencyGameConfig | null {
  return stage === "guided" ? block.guidedPracticeGame : block.fluencySprintGame;
}

/** Which stages does this topic actually offer (drives the host's stage picker). */
export function availableStages(block: GamesAssetBlock): GameStage[] {
  const stages: GameStage[] = [];
  if (block.guidedPracticeGame) stages.push("guided");
  if (block.fluencySprintGame) stages.push("fluency");
  return stages;
}

/**
 * Session length for a game: the registry's single length knob
 * (guidedPracticeGame.minQuestionsToComplete; 8 across today's data)
 * applies to BOTH stages - the fluency sprint does not carry its own
 * count in the data. Falls back to 8 when the guided side is malformed.
 */
export function gameSessionLength(block: GamesAssetBlock): number {
  return block.guidedPracticeGame?.minQuestionsToComplete ?? 8;
}
