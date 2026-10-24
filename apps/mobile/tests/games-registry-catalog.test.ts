/**
 * Data-driven games catalog test (issue #52): the archetype inventory
 * and games-block shape are enumerated FROM THE REGISTRY (the same
 * data packs carry verbatim in assets_json) — the framework's
 * ARCHETYPE_IDS and parser defaults can never drift from the data.
 * A registry games change that breaks the framework FAILS this suite.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ARCHETYPE_IDS, resolveGameRoute } from "../src/games/archetypes";
import { availableStages, parseGamesAssetBlock } from "../src/games/gamesAssets";

interface RegistryFile {
  grades: {
    subjects: Record<string, { units: RegistryUnit[] }>;
  }[];
}
interface RegistryUnit {
  unitId: string;
  games?: { stage?: string; archetype?: string; id?: string; title?: string }[];
  skillTopics: { code: string; assets?: { games?: unknown } }[];
}

const registry = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../../docs/us-curriculum-registry.json", import.meta.url)),
    "utf-8",
  ),
) as RegistryFile;

const topicBlocks: { topicId: string; block: ReturnType<typeof parseGamesAssetBlock> }[] = [];
const unitArchetypes = new Set<string>();
const topicArchetypes = new Set<string>();
const mixes = new Set<string>();
let topics = 0;
let topicsWithoutBothStages = 0;

for (const grade of registry.grades) {
  for (const subject of Object.values(grade.subjects)) {
    for (const unit of subject.units) {
      for (const game of unit.games ?? []) {
        if (typeof game.archetype === "string") unitArchetypes.add(game.archetype);
      }
      for (const topic of unit.skillTopics) {
        topics += 1;
        const block = parseGamesAssetBlock((topic.assets ?? {}) as Record<string, unknown>);
        if (block.guidedPracticeGame) topicArchetypes.add(block.guidedPracticeGame.archetype);
        if (block.fluencySprintGame) {
          topicArchetypes.add(block.fluencySprintGame.archetype);
          mixes.add(JSON.stringify(block.fluencySprintGame.spiralMix));
        }
        if (availableStages(block).length !== 2) topicsWithoutBothStages += 1;
        topicBlocks.push({ topicId: `${unit.unitId}-${topic.code}`, block });
      }
    }
  }
}

/**
 * The runtime supported set lives in archetypeRegistry.ts, which
 * transitively imports React Native (the stub component) - node tests
 * reach it via the repo's source-contract scan pattern instead.
 */
const registrySource = readFileSync(
  fileURLToPath(new URL("../src/games/archetypeRegistry.ts", import.meta.url)),
  "utf-8",
);
const registeredEntries = [...registrySource.matchAll(/^\s{2}"([a-z-]+)":\s*\w+,/gm)].map(
  (match) => match[1]!,
);
const SUPPORTED = new Set<string>(registeredEntries);

describe("registry games catalog (data-derived)", () => {
  it("every one of the 614 topics carries BOTH game stages", () => {
    expect(topics).toBe(614);
    expect(topicsWithoutBothStages).toBe(0);
  });

  it("ARCHETYPE_IDS covers every archetype the registry references (unit + topic level)", () => {
    const inUse = new Set([...unitArchetypes, ...topicArchetypes]);
    expect([...inUse].sort()).toEqual([...ARCHETYPE_IDS].sort());
  });

  it("today's registry carries exactly one spiralMix - the 70/20/10 - as data", () => {
    expect([...mixes]).toEqual([
      JSON.stringify({ currentTopic: 0.7, contrastivePrerequisite: 0.2, spacedReview: 0.1 }),
    ]);
  });

  it("the parser accepts every registry block without degradation (all fields valid)", () => {
    for (const { block } of topicBlocks) {
      expect(block.guidedPracticeGame).not.toBeNull();
      expect(block.fluencySprintGame).not.toBeNull();
      expect(block.guidedPracticeGame!.targetMasteryScore).toBeGreaterThan(0);
      expect(block.guidedPracticeGame!.minQuestionsToComplete).toBeGreaterThan(0);
      expect(block.fluencySprintGame!.targetResponseSpeedSec).toBeGreaterThan(0);
    }
  });

  it("route resolution over the WHOLE registry against the installed renderer set never dead-ends", () => {
    let games = 0;
    let fallbacks = 0;
    for (const { block } of topicBlocks) {
      for (const stage of ["guided", "fluency"] as const) {
        const decision = resolveGameRoute(block, stage, SUPPORTED);
        if (decision.kind === "game") {
          games += 1;
          expect(SUPPORTED.has(decision.archetype)).toBe(true);
        } else {
          fallbacks += 1;
          expect(decision.reason).toBe("archetype-not-installed");
          // The fallback still names the intended archetype for telemetry.
          expect(decision.archetype).toBeTruthy();
        }
      }
    }
    // The #53 pack A renderers (block-builder, market-cashier) serve
    // the guided stage of their 136 + 32 topics; the #54 pack B
    // renderers (bubble-pop-blitz, monster-phoneme-feeder) serve the
    // fluency side of every bubble-pop-blitz topic and the guided side
    // of every feeder topic. The remaining archetypes still fall back.
    expect(registeredEntries).toContain("block-builder");
    expect(registeredEntries).toContain("market-cashier");
    expect(registeredEntries).toContain("bubble-pop-blitz");
    expect(registeredEntries).toContain("monster-phoneme-feeder");
    expect(games).toBeGreaterThan(0);
    expect(fallbacks).toBeGreaterThan(0);
  });

  it("#53 route flip: EVERY guided block-builder / market-cashier topic now routes to game (never fallback)", () => {
    let packAGuided = 0;
    for (const { block } of topicBlocks) {
      const guided = block.guidedPracticeGame;
      if (
        guided &&
        (guided.archetype === "block-builder" || guided.archetype === "market-cashier")
      ) {
        packAGuided += 1;
        const decision = resolveGameRoute(block, "guided", SUPPORTED);
        expect(decision.kind).toBe("game");
        expect(decision.archetype).toBe(guided.archetype);
      }
    }
    // The data-derived pack A footprint (136 block-builder + 32
    // market-cashier); the count is enumerated FROM the registry, so a
    // registry change re-pins itself.
    expect(packAGuided).toBe(168);
  });

  it("#54 route flip: EVERY fluency bubble-pop-blitz topic routes to game (never fallback)", () => {
    let packBFluency = 0;
    let gentleTier = 0;
    let sprintTier = 0;
    for (const { topicId, block } of topicBlocks) {
      const fluency = block.fluencySprintGame;
      if (fluency && fluency.archetype === "bubble-pop-blitz") {
        packBFluency += 1;
        const decision = resolveGameRoute(block, "fluency", SUPPORTED);
        expect(decision.kind).toBe("game");
        if (decision.kind !== "game") return;
        expect(decision.archetype).toBe("bubble-pop-blitz");
        // Every flipped sprint target is positive data the renderer
        // paces from; grade tier follows the structural topic prefix.
        expect(fluency.targetResponseSpeedSec).toBeGreaterThan(0);
        const grade = topicId.split("-")[0] ?? "";
        if (grade === "G2" || grade === "G3") sprintTier += 1;
        else gentleTier += 1;
      }
    }
    // The data-derived pack B fluency footprint (250 topics across all
    // five grades; both D6 tiers carry real sprint targets).
    expect(packBFluency).toBe(250);
    expect(gentleTier).toBeGreaterThan(0);
    expect(sprintTier).toBeGreaterThan(0);
  });

  it("#54 route flip: EVERY guided monster-phoneme-feeder topic routes to game (never fallback)", () => {
    let packBGuided = 0;
    for (const { block } of topicBlocks) {
      const guided = block.guidedPracticeGame;
      if (guided && guided.archetype === "monster-phoneme-feeder") {
        packBGuided += 1;
        const decision = resolveGameRoute(block, "guided", SUPPORTED);
        expect(decision.kind).toBe("game");
        if (decision.kind !== "game") return;
        expect(decision.archetype).toBe("monster-phoneme-feeder");
      }
    }
    // The data-derived ELA feeder footprint (102 topics, 22 units).
    expect(packBGuided).toBe(102);
  });

  it("#54 route flip: the feeder topics flip BOTH stages (guided feeder + fluency blitz)", () => {
    let bothStages = 0;
    for (const { block } of topicBlocks) {
      const guided = block.guidedPracticeGame;
      const fluency = block.fluencySprintGame;
      if (guided?.archetype === "monster-phoneme-feeder") {
        // Registry fact: every feeder topic's fluency sprint IS a
        // bubble-pop-blitz - after #54 neither stage falls back.
        expect(fluency?.archetype).toBe("bubble-pop-blitz");
        expect(resolveGameRoute(block, "guided", SUPPORTED).kind).toBe("game");
        expect(resolveGameRoute(block, "fluency", SUPPORTED).kind).toBe("game");
        bothStages += 1;
      }
    }
    expect(bothStages).toBe(102);
  });

  it("the remaining archetypes still fall back until their packs land", () => {
    const stillUnsupported = new Set<string>();
    for (const { block } of topicBlocks) {
      for (const stage of ["guided", "fluency"] as const) {
        const decision = resolveGameRoute(block, stage, SUPPORTED);
        if (decision.kind === "practice-fallback" && decision.archetype) {
          stillUnsupported.add(decision.archetype);
        }
      }
    }
    expect([...stillUnsupported].sort()).toEqual([
      "array-grid-architect",
      "bridge-builder",
      "lilypad-jumper",
      "slice-share-kitchen",
      "story-detective",
      "tactile-sorter",
    ]);
  });
});
