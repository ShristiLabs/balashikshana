/**
 * Game-route resolution matrices (issue #52): supported archetypes
 * mount the game; every miss degrades to the practice fallback with a
 * machine-readable reason - never a dead end (AC).
 */
import { describe, expect, it } from "vitest";
import { ARCHETYPE_IDS, resolveGameRoute } from "../src/games/archetypes";
import { parseGamesAssetBlock } from "../src/games/gamesAssets";

const BLOCK = parseGamesAssetBlock({
  games: {
    guidedPracticeGame: {
      gameId: "g-guided",
      archetype: "block-builder",
      title: "Builder",
      targetMasteryScore: 80,
      minQuestionsToComplete: 8,
    },
    fluencySprintGame: {
      gameId: "g-fluency",
      archetype: "bubble-pop-blitz",
      title: "Blitz",
      targetResponseSpeedSec: 5.5,
      spiralMix: { currentTopic: 0.7, contrastivePrerequisite: 0.2, spacedReview: 0.1 },
    },
  },
});

const ONLY_GUIDED = parseGamesAssetBlock({
  games: { guidedPracticeGame: BLOCK.guidedPracticeGame },
});

describe("resolveGameRoute", () => {
  it("supported archetype -> game with the stage's config", () => {
    const decision = resolveGameRoute(BLOCK, "guided", new Set(["block-builder"]));
    expect(decision).toMatchObject({
      kind: "game",
      stage: "guided",
      archetype: "block-builder",
      gameId: "g-guided",
    });
    expect(decision.kind === "game" && decision.guided?.minQuestionsToComplete).toBe(8);
  });

  it("unsupported archetype -> practice fallback, reason archetype-not-installed, intended archetype carried", () => {
    const decision = resolveGameRoute(BLOCK, "fluency", new Set(["block-builder"]));
    expect(decision).toEqual({
      kind: "practice-fallback",
      stage: "fluency",
      archetype: "bubble-pop-blitz",
      reason: "archetype-not-installed",
    });
  });

  it("stage the topic does not offer -> fallback reason stage-missing", () => {
    const decision = resolveGameRoute(ONLY_GUIDED, "fluency", new Set(["block-builder"]));
    expect(decision).toMatchObject({ kind: "practice-fallback", reason: "stage-missing" });
  });

  it("no games block at all -> fallback reason no-games-block", () => {
    const decision = resolveGameRoute(
      parseGamesAssetBlock({}),
      "guided",
      new Set(["block-builder"]),
    );
    expect(decision).toEqual({
      kind: "practice-fallback",
      stage: null,
      archetype: null,
      reason: "no-games-block",
    });
  });

  it("null stage with an otherwise valid block -> fallback reason stage-missing (the host must pick)", () => {
    const decision = resolveGameRoute(BLOCK, null, new Set(["block-builder"]));
    expect(decision).toMatchObject({ kind: "practice-fallback", reason: "stage-missing" });
  });

  it("an empty supported set falls back for EVERY archetype (framework uninstall case)", () => {
    for (const stage of ["guided", "fluency"] as const) {
      expect(resolveGameRoute(BLOCK, stage, new Set()).kind).toBe("practice-fallback");
    }
  });
});

describe("ARCHETYPE_IDS inventory", () => {
  it("carries the 11 registry archetypes (incl. unit-level trace-draw-studio) with no duplicates", () => {
    expect(ARCHETYPE_IDS).toHaveLength(11);
    expect(new Set(ARCHETYPE_IDS).size).toBe(11);
    for (const id of [
      "tactile-sorter",
      "trace-draw-studio",
      "block-builder",
      "lilypad-jumper",
      "monster-phoneme-feeder",
      "bridge-builder",
      "market-cashier",
      "array-grid-architect",
      "slice-share-kitchen",
      "bubble-pop-blitz",
      "story-detective",
    ]) {
      expect(ARCHETYPE_IDS).toContain(id);
    }
  });
});
