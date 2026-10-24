/**
 * Games asset-block parser matrices (issue #52): the registry shape
 * (real PK-M1 data below), malformed-field tolerance (defaults), and
 * wholly-absent/malformed blocks degrading to nulls - a broken games
 * block routes to the practice fallback, it never throws.
 */
import { describe, expect, it } from "vitest";
import {
  availableStages,
  gameConfigForStage,
  gameSessionLength,
  parseGamesAssetBlock,
} from "../src/games/gamesAssets";

const REAL_PK_M1_A = {
  games: {
    guidedPracticeGame: {
      gameId: "game_guided_PK-M1-A",
      stage: "Stage 2: Guided Practice (Untimed)",
      archetype: "block-builder",
      title: "Numbers to 3 - Guided Explorer",
      mechanics: "Untimed drag-counters with hints.",
      targetMasteryScore: 80,
      minQuestionsToComplete: 8,
    },
    fluencySprintGame: {
      gameId: "game_fluency_PK-M1-A",
      stage: "Stage 3: Fluency Zone (Timed Automaticity)",
      archetype: "bubble-pop-blitz",
      title: "Numbers to 3 - Fluency Blitz",
      mechanics: "Fast-paced bubble-pop with 5.5s pacemaker.",
      targetResponseSpeedSec: 5.5,
      spiralMix: { currentTopic: 0.7, contrastivePrerequisite: 0.2, spacedReview: 0.1 },
    },
  },
};

describe("parseGamesAssetBlock", () => {
  it("parses the real registry shape (PK-M1 topic A) field-for-field", () => {
    const block = parseGamesAssetBlock(REAL_PK_M1_A);
    expect(block.guidedPracticeGame).toMatchObject({
      gameId: "game_guided_PK-M1-A",
      archetype: "block-builder",
      targetMasteryScore: 80,
      minQuestionsToComplete: 8,
    });
    expect(block.fluencySprintGame).toMatchObject({
      archetype: "bubble-pop-blitz",
      targetResponseSpeedSec: 5.5,
      spiralMix: { currentTopic: 0.7, contrastivePrerequisite: 0.2, spacedReview: 0.1 },
    });
  });

  it("absent games block -> both nulls (never throws)", () => {
    expect(parseGamesAssetBlock({})).toEqual({
      guidedPracticeGame: null,
      fluencySprintGame: null,
    });
    expect(parseGamesAssetBlock({ games: "nonsense" })).toEqual({
      guidedPracticeGame: null,
      fluencySprintGame: null,
    });
    expect(parseGamesAssetBlock({ games: { guidedPracticeGame: 7 } })).toEqual({
      guidedPracticeGame: null,
      fluencySprintGame: null,
    });
  });

  it("malformed numbers degrade to documented defaults, ids stay required", () => {
    const block = parseGamesAssetBlock({
      games: {
        guidedPracticeGame: {
          gameId: "g1",
          archetype: "tactile-sorter",
          targetMasteryScore: "eighty",
          minQuestionsToComplete: -3,
        },
        fluencySprintGame: { archetype: "bubble-pop-blitz" },
      },
    });
    // No gameId on the fluency side -> null despite the archetype.
    expect(block.fluencySprintGame).toBeNull();
    expect(block.guidedPracticeGame).toMatchObject({
      gameId: "g1",
      archetype: "tactile-sorter",
      targetMasteryScore: 80,
      minQuestionsToComplete: 8,
    });
    // Title falls back to the gameId; mechanics to "".
    expect(block.guidedPracticeGame?.title).toBe("g1");
    expect(block.guidedPracticeGame?.mechanics).toBe("");
  });

  it("missing spiralMix object falls back to the registry default 70/20/10", () => {
    const block = parseGamesAssetBlock({
      games: {
        fluencySprintGame: { gameId: "g2", archetype: "lilypad-jumper", targetResponseSpeedSec: 4 },
      },
    });
    expect(block.fluencySprintGame?.spiralMix).toEqual({
      currentTopic: 0.7,
      contrastivePrerequisite: 0.2,
      spacedReview: 0.1,
    });
  });
});

describe("stage helpers", () => {
  const block = parseGamesAssetBlock(REAL_PK_M1_A);

  it("availableStages lists guided then fluency; empty block lists none", () => {
    expect(availableStages(block)).toEqual(["guided", "fluency"]);
    expect(availableStages(parseGamesAssetBlock({}))).toEqual([]);
  });

  it("gameConfigForStage returns the narrowed config per stage", () => {
    expect(gameConfigForStage(block, "guided")?.archetype).toBe("block-builder");
    expect(gameConfigForStage(block, "fluency")?.archetype).toBe("bubble-pop-blitz");
    expect(
      gameConfigForStage(
        parseGamesAssetBlock({
          games: { guidedPracticeGame: REAL_PK_M1_A.games.guidedPracticeGame },
        }),
        "fluency",
      ),
    ).toBeNull();
  });

  it("gameSessionLength is the registry's single length knob (8)", () => {
    expect(gameSessionLength(block)).toBe(8);
    expect(gameSessionLength(parseGamesAssetBlock({}))).toBe(8);
  });
});
