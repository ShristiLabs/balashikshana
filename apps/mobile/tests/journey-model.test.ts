/**
 * Journey-map model tests (issue #49): the pure derivation contract.
 *
 * Covers: winding-path layout determinism, the full unit-state matrix
 * (every engine UNIT_STATES value, prerequisite DAG, provisional and
 * Silver/Gold key distinctions incl. the 14-hour countdown), garden
 * health math (computed, never hardcoded), and the loader against the
 * REAL node:sqlite practiceEnv fixture (multi-unit pack, grade
 * switching preservation, missing-pack null, the new pack_meta /
 * unit_progress seams).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { UNIT_STATES } from "@balashikshana/core-engine";
import {
  GARDEN_BANDS,
  computeGardenHealth,
  deriveJourneyModel,
  gardenBandFor,
  layoutWindingPath,
  unitMasteryFraction,
  type JourneyUnitSource,
} from "../src/journey/model";
import {
  STATE_ART,
  formatCountdown,
  goldBadge,
  nodeAccessibilityLabel,
  silverBadge,
  stateColors,
} from "../src/journey/art";
import { themes } from "../src/design/tokens";
import { loadJourneyModel } from "../src/journey/loader";
import { MS_HOUR, createPracticeEnv } from "./helpers/practiceEnv";
import type { UnitProgressRecord } from "../src/practice/types";

const NOW = 1_700_000_000_000;

function unit(partial: Partial<JourneyUnitSource> & { unitId: string }): JourneyUnitSource {
  return {
    subject: "math",
    sequenceOrder: 1,
    title: `Unit ${partial.unitId}`,
    prerequisiteUnitIds: [],
    ...partial,
  };
}

function progressRow(
  partial: Partial<UnitProgressRecord> & { unitId: string },
): UnitProgressRecord {
  return {
    studentId: "s1",
    status: "MASTERED",
    keyState: null,
    bestAccuracyPct: 0,
    bestMedianSpeedSec: 0,
    attemptsCount: 0,
    stabilityDays: 1,
    lastReviewedAt: 0,
    cpaStage: "CONCRETE_INTERACTIVE",
    provisional: false,
    silverAwardedAt: 0,
    goldVerifiedAt: 0,
    updatedAt: NOW,
    ...partial,
  };
}

describe("winding path layout", () => {
  const geometry = { width: 360, verticalStep: 132, amplitude: 90 };

  it("is deterministic: same count + geometry yields identical output", () => {
    const a = layoutWindingPath(12, geometry);
    const b = layoutWindingPath(12, geometry);
    expect(a).toEqual(b);
  });

  it("winds: consecutive nodes alternate across the center line", () => {
    const { positions } = layoutWindingPath(6, geometry);
    const center = geometry.width / 2;
    expect(positions[0]!.x).toBe(center);
    expect(positions[1]!.x).toBeGreaterThan(center);
    expect(positions[3]!.x).toBeLessThan(center);
    expect(positions[5]!.x).toBeGreaterThan(center);
  });

  it("steps down the drawable area and sizes the height by unit count", () => {
    const small = layoutWindingPath(3, geometry);
    const big = layoutWindingPath(22, geometry);
    expect(small.positions[1]!.y).toBeGreaterThan(small.positions[0]!.y);
    expect(big.height).toBe(geometry.verticalStep * 23);
    expect(big.positions.length).toBe(22);
  });

  it("builds one continuous SVG path through every node center", () => {
    const { pathD, positions } = layoutWindingPath(4, geometry);
    expect(pathD.startsWith(`M ${positions[0]!.x} ${positions[0]!.y}`)).toBe(true);
    expect(pathD).toContain("C ");
    expect(pathD.match(/C /g)!.length).toBe(3);
  });

  it("degrades safely on 0 and 1 units", () => {
    expect(layoutWindingPath(0, geometry).pathD).toBe("");
    expect(layoutWindingPath(1, geometry).pathD).toMatch(/^M /);
  });

  it("a 130-unit grade lays out monotonically, deterministically, without NaN", () => {
    const a = layoutWindingPath(130, geometry);
    const b = layoutWindingPath(130, geometry);
    expect(a).toEqual(b);
    expect(a.positions).toHaveLength(130);
    expect(a.height).toBe(geometry.verticalStep * 131);
    expect(a.pathD.match(/C /g)!.length).toBe(129);
    for (let i = 1; i < a.positions.length; i += 1) {
      expect(a.positions[i]!.y).toBeGreaterThan(a.positions[i - 1]!.y);
    }
    for (const p of a.positions) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it("degenerate geometry (zero amplitude/width) stays finite", () => {
    const flat = layoutWindingPath(5, { width: 320, verticalStep: 120, amplitude: 0 });
    expect(new Set(flat.positions.map((p) => p.x)).size).toBe(1); // single center column
    const zeroWidth = layoutWindingPath(5, { width: 0, verticalStep: 120, amplitude: 0 });
    for (const p of zeroWidth.positions) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });
});

describe("unit-state derivation matrix", () => {
  const base = {
    census: [{ unitId: "U1", totalTopics: 3 }],
    completion: [{ unitId: "U1", completedTopics: 0, averageCrowns: 0 }],
    unitProgress: [] as UnitProgressRecord[],
    nowMs: NOW,
  };

  function stateFor(overrides: Partial<typeof base>): string {
    const model = deriveJourneyModel({
      gradeId: "kindergarten",
      units: [unit({ unitId: "U1" })],
      ...base,
      ...overrides,
    } as Parameters<typeof deriveJourneyModel>[0]);
    return model.units[0]!.state;
  }

  it("covers exactly the engine's UNIT_STATES vocabulary", () => {
    const engineStates = new Set(Object.values(UNIT_STATES));
    const artStates = new Set(Object.keys(STATE_ART));
    expect(engineStates).toEqual(artStates);
  });

  it("STUDY_REQUIRED: unlocked, nothing completed", () => {
    expect(stateFor({})).toBe("STUDY_REQUIRED");
  });

  it("GUIDED_PRACTICE: some topics completed", () => {
    expect(stateFor({ completion: [{ unitId: "U1", completedTopics: 1, averageCrowns: 1 }] })).toBe(
      "GUIDED_PRACTICE",
    );
  });

  it("FLUENCY_READY: all topics completed below the fluency bar", () => {
    expect(stateFor({ completion: [{ unitId: "U1", completedTopics: 3, averageCrowns: 1 }] })).toBe(
      "FLUENCY_READY",
    );
  });

  it("GATE_UNLOCKED: all topics completed at fluency (avg crowns >= 2)", () => {
    expect(stateFor({ completion: [{ unitId: "U1", completedTopics: 3, averageCrowns: 2 }] })).toBe(
      "GATE_UNLOCKED",
    );
  });

  it("crown threshold sits exactly at the projector's fluency tier (avg 2)", () => {
    expect(
      stateFor({ completion: [{ unitId: "U1", completedTopics: 3, averageCrowns: 1.99 }] }),
    ).toBe("FLUENCY_READY");
    expect(stateFor({ completion: [{ unitId: "U1", completedTopics: 3, averageCrowns: 2 }] })).toBe(
      "GATE_UNLOCKED",
    );
  });

  it("MASTERED and REMEDIATION_REQUIRED come from the unit row", () => {
    expect(stateFor({ unitProgress: [progressRow({ unitId: "U1" })] })).toBe("MASTERED");
    expect(
      stateFor({
        unitProgress: [progressRow({ unitId: "U1", status: "REMEDIATION_REQUIRED" })],
      }),
    ).toBe("REMEDIATION_REQUIRED");
  });

  it("LOCKED while any prerequisite is unmastered; unlocked once all are", () => {
    const dag = deriveJourneyModel({
      gradeId: "kindergarten",
      units: [
        unit({ unitId: "A" }),
        unit({ unitId: "B", prerequisiteUnitIds: ["A"], sequenceOrder: 2 }),
      ],
      census: [
        { unitId: "A", totalTopics: 1 },
        { unitId: "B", totalTopics: 1 },
      ],
      completion: [],
      unitProgress: [],
      nowMs: NOW,
    });
    expect(dag.units[1]!.state).toBe("LOCKED");
    expect(dag.units[1]!.blockedBy).toEqual(["A"]);

    const unlocked = deriveJourneyModel({
      gradeId: "kindergarten",
      units: [
        unit({ unitId: "A" }),
        unit({ unitId: "B", prerequisiteUnitIds: ["A"], sequenceOrder: 2 }),
      ],
      census: [
        { unitId: "A", totalTopics: 1 },
        { unitId: "B", totalTopics: 1 },
      ],
      completion: [{ unitId: "A", completedTopics: 1, averageCrowns: 3 }],
      unitProgress: [progressRow({ unitId: "A" })],
      nowMs: NOW,
    });
    expect(unlocked.units[1]!.state).toBe("STUDY_REQUIRED");
    expect(unlocked.units[1]!.blockedBy).toEqual([]);
  });

  it("deep DAG: each tier unlocks only when its prerequisite masters", () => {
    const chain = ["A", "B", "C", "D"];
    const build = (mastered: string[]) =>
      deriveJourneyModel({
        gradeId: "kindergarten",
        units: chain.map((id, i) =>
          unit({
            unitId: id,
            sequenceOrder: i + 1,
            prerequisiteUnitIds: i === 0 ? [] : [chain[i - 1]!],
          }),
        ),
        census: chain.map((id) => ({ unitId: id, totalTopics: 1 })),
        completion: [],
        unitProgress: mastered.map((id) => progressRow({ unitId: id })),
        nowMs: NOW,
      });
    expect(build([]).units.map((n) => n.state)).toEqual([
      "STUDY_REQUIRED",
      "LOCKED",
      "LOCKED",
      "LOCKED",
    ]);
    expect(build(["A"]).units.map((n) => n.state)).toEqual([
      "MASTERED",
      "STUDY_REQUIRED",
      "LOCKED",
      "LOCKED",
    ]);
    expect(build(["A", "B"]).units.map((n) => n.state)).toEqual([
      "MASTERED",
      "MASTERED",
      "STUDY_REQUIRED",
      "LOCKED",
    ]);
  });

  it("prerequisite cycles and dangling ids are safe (never throw, stay locked)", () => {
    const cyclic = deriveJourneyModel({
      gradeId: "kindergarten",
      units: [
        unit({ unitId: "A", prerequisiteUnitIds: ["B"] }),
        unit({ unitId: "B", prerequisiteUnitIds: ["A"], sequenceOrder: 2 }),
        unit({ unitId: "C", prerequisiteUnitIds: ["GHOST"], sequenceOrder: 3 }),
      ],
      census: [
        { unitId: "A", totalTopics: 1 },
        { unitId: "B", totalTopics: 1 },
        { unitId: "C", totalTopics: 1 },
      ],
      completion: [],
      unitProgress: [],
      nowMs: NOW,
    });
    expect(cyclic.units.map((n) => n.state)).toEqual(["LOCKED", "LOCKED", "LOCKED"]);
    expect(cyclic.units[2]!.blockedBy).toEqual(["GHOST"]);
  });

  it("degenerate inputs: clamps overcounts, ignores completion without census, never NaN", () => {
    const model = deriveJourneyModel({
      gradeId: "kindergarten",
      units: [unit({ unitId: "A" }), unit({ unitId: "B", sequenceOrder: 2 })],
      // A: census present but completion claims MORE than total.
      // B: no census row at all (unit with zero pack topics).
      census: [{ unitId: "A", totalTopics: 2 }],
      completion: [
        { unitId: "A", completedTopics: 5, averageCrowns: 3 },
        { unitId: "B", completedTopics: 3, averageCrowns: 3 },
      ],
      unitProgress: [],
      nowMs: NOW,
    });
    const [a, b] = model.units;
    expect(a!.completedTopics).toBe(2); // clamped to the pack's census
    expect(a!.topicFraction).toBe(1);
    expect(a!.state).toBe("GATE_UNLOCKED"); // all (clamped) topics done at fluency
    expect(b!.totalTopics).toBe(0);
    expect(b!.completedTopics).toBe(0);
    expect(b!.topicFraction).toBe(0);
    expect(b!.state).toBe("STUDY_REQUIRED"); // zero-topic unit never claims fluency
    for (const node of model.units) {
      expect(Number.isFinite(node.topicFraction)).toBe(true);
    }
  });

  it("provisional passes through on REMEDIATION and MASTERED rows too", () => {
    const model = deriveJourneyModel({
      gradeId: "kindergarten",
      units: [unit({ unitId: "A" }), unit({ unitId: "B", sequenceOrder: 2 })],
      census: [
        { unitId: "A", totalTopics: 1 },
        { unitId: "B", totalTopics: 1 },
      ],
      completion: [],
      unitProgress: [
        progressRow({ unitId: "A", status: "MASTERED", provisional: true }),
        progressRow({ unitId: "B", status: "REMEDIATION_REQUIRED", provisional: true }),
      ],
      nowMs: NOW,
    });
    expect(model.units.map((n) => n.provisional)).toEqual([true, true]);
  });

  it("exactly one isCurrent node: the first unlocked non-mastered unit", () => {
    const model = deriveJourneyModel({
      gradeId: "kindergarten",
      units: [
        unit({ unitId: "A" }),
        unit({ unitId: "B", sequenceOrder: 2 }),
        unit({ unitId: "C", sequenceOrder: 3 }),
      ],
      census: [
        { unitId: "A", totalTopics: 1 },
        { unitId: "B", totalTopics: 1 },
        { unitId: "C", totalTopics: 1 },
      ],
      completion: [],
      unitProgress: [progressRow({ unitId: "A" })],
      nowMs: NOW,
    });
    expect(model.units.filter((n) => n.isCurrent)).toHaveLength(1);
    expect(model.units[1]!.isCurrent).toBe(true);
  });

  it("no current node when everything is mastered (celebration is #58)", () => {
    const model = deriveJourneyModel({
      gradeId: "kindergarten",
      units: [unit({ unitId: "A" })],
      census: [{ unitId: "A", totalTopics: 1 }],
      completion: [{ unitId: "A", completedTopics: 1, averageCrowns: 3 }],
      unitProgress: [progressRow({ unitId: "A" })],
      nowMs: NOW,
    });
    expect(model.units.filter((n) => n.isCurrent)).toHaveLength(0);
  });

  it("keys pass through with the provisional distinction", () => {
    const model = deriveJourneyModel({
      gradeId: "kindergarten",
      units: [unit({ unitId: "A" })],
      census: [{ unitId: "A", totalTopics: 1 }],
      completion: [{ unitId: "A", completedTopics: 1, averageCrowns: 3 }],
      unitProgress: [
        progressRow({
          unitId: "A",
          keyState: "SILVER_KEY",
          provisional: true,
          silverAwardedAt: NOW - 5 * MS_HOUR,
        }),
      ],
      nowMs: NOW,
    });
    const node = model.units[0]!;
    expect(node.keyState).toBe("SILVER_KEY");
    expect(node.provisional).toBe(true);
    // 14h window opened 5h ago -> 9h remain, not eligible yet.
    expect(node.goldEligibleAtMs).toBe(NOW - 5 * MS_HOUR + 14 * MS_HOUR);
    expect(node.goldCountdownMs).toBe(9 * MS_HOUR);
    expect(node.goldEligible).toBe(false);

    const eligible = deriveJourneyModel({
      gradeId: "kindergarten",
      units: [unit({ unitId: "A" })],
      census: [{ unitId: "A", totalTopics: 1 }],
      completion: [{ unitId: "A", completedTopics: 1, averageCrowns: 3 }],
      unitProgress: [
        progressRow({
          unitId: "A",
          keyState: "SILVER_KEY",
          provisional: false,
          silverAwardedAt: NOW - 15 * MS_HOUR,
        }),
      ],
      nowMs: NOW,
    });
    expect(eligible.units[0]!.goldCountdownMs).toBe(0);
    expect(eligible.units[0]!.goldEligible).toBe(true);

    const gold = deriveJourneyModel({
      gradeId: "kindergarten",
      units: [unit({ unitId: "A" })],
      census: [{ unitId: "A", totalTopics: 1 }],
      completion: [{ unitId: "A", completedTopics: 1, averageCrowns: 3 }],
      unitProgress: [
        progressRow({ unitId: "A", keyState: "GOLD_KEY", goldVerifiedAt: NOW - 20 * MS_HOUR }),
      ],
      nowMs: NOW,
    });
    expect(gold.units[0]!.keyState).toBe("GOLD_KEY");
    expect(gold.units[0]!.goldEligible).toBe(false);
  });

  it("14h countdown boundary: eligible exactly at the instant, one ms matters", () => {
    function silverNode(silverAwardedAt: number) {
      return deriveJourneyModel({
        gradeId: "kindergarten",
        units: [unit({ unitId: "A" })],
        census: [{ unitId: "A", totalTopics: 1 }],
        completion: [{ unitId: "A", completedTopics: 1, averageCrowns: 3 }],
        unitProgress: [
          progressRow({ unitId: "A", status: "MASTERED", keyState: "SILVER_KEY", silverAwardedAt }),
        ],
        nowMs: NOW,
      }).units[0]!;
    }
    const atInstant = silverNode(NOW - 14 * MS_HOUR);
    expect(atInstant.goldEligibleAtMs).toBe(NOW);
    expect(atInstant.goldEligible).toBe(true);
    expect(atInstant.goldCountdownMs).toBe(0);

    const oneMsEarly = silverNode(NOW - 14 * MS_HOUR + 1);
    expect(oneMsEarly.goldEligible).toBe(false);
    expect(oneMsEarly.goldCountdownMs).toBe(1);

    const oneMsLate = silverNode(NOW - 14 * MS_HOUR - 1);
    expect(oneMsLate.goldEligible).toBe(true);
    expect(oneMsLate.goldCountdownMs).toBe(0);
  });

  it("a held key without MASTERED status still renders MASTERED (forward-only keys)", () => {
    expect(
      stateFor({
        completion: [{ unitId: "U1", completedTopics: 1, averageCrowns: 3 }],
        unitProgress: [
          progressRow({ unitId: "U1", status: "GATE_UNLOCKED", keyState: "GOLD_KEY" }),
        ],
      }),
    ).toBe("MASTERED");
  });
});

describe("snapshot adoption flips provisional -> confirmed (model contract)", () => {
  const units = [unit({ unitId: "A" })];
  const census = [{ unitId: "A", totalTopics: 1 }];
  const completion = [{ unitId: "A", completedTopics: 1, averageCrowns: 3 }];

  it("offline rows render with the provisional flag; adoption clears it", () => {
    const offline = deriveJourneyModel({
      gradeId: "kindergarten",
      units,
      census,
      completion,
      unitProgress: [
        progressRow({
          unitId: "A",
          keyState: "SILVER_KEY",
          provisional: true,
          silverAwardedAt: NOW,
        }),
      ],
      nowMs: NOW,
    });
    expect(offline.units[0]!.provisional).toBe(true);
    expect(nodeAccessibilityLabel(offline.units[0]!)).toContain("Waiting for server check");

    const adopted = deriveJourneyModel({
      gradeId: "kindergarten",
      units,
      census,
      completion,
      unitProgress: [
        progressRow({
          unitId: "A",
          keyState: "SILVER_KEY",
          provisional: false,
          silverAwardedAt: NOW,
        }),
      ],
      nowMs: NOW,
    });
    expect(adopted.units[0]!.provisional).toBe(false);
    expect(nodeAccessibilityLabel(adopted.units[0]!)).not.toContain("Waiting for server check");
  });
});

describe("garden health", () => {
  it("empty garden is sprouting with zeroed aggregates", () => {
    const garden = computeGardenHealth([], []);
    expect(garden).toEqual({
      totalUnits: 0,
      masteredUnits: 0,
      silverKeys: 0,
      goldKeys: 0,
      overallPct: 0,
      gateHealthPct: 0,
      band: "sprouting",
    });
  });

  it("computes overall mastery from per-unit fractions (never hardcoded)", () => {
    const nodes = deriveJourneyModel({
      gradeId: "kindergarten",
      units: [unit({ unitId: "A" }), unit({ unitId: "B", sequenceOrder: 2 })],
      census: [
        { unitId: "A", totalTopics: 2 },
        { unitId: "B", totalTopics: 2 },
      ],
      completion: [
        { unitId: "A", completedTopics: 2, averageCrowns: 3 },
        { unitId: "B", completedTopics: 1, averageCrowns: 1 },
      ],
      unitProgress: [progressRow({ unitId: "A" })],
      nowMs: NOW,
    }).units;
    const garden = computeGardenHealth(nodes, [progressRow({ unitId: "A" })]);
    // A: MASTERED -> 1. B: GUIDED_PRACTICE -> 0.5 * 0.5 = 0.25. Mean = 62.5.
    expect(unitMasteryFraction(nodes[0]!)).toBe(1);
    expect(unitMasteryFraction(nodes[1]!)).toBeCloseTo(0.25, 10);
    expect(garden.overallPct).toBe(62.5);
    expect(garden.band).toBe("growing");
    expect(garden.masteredUnits).toBe(1);
    expect(garden.totalUnits).toBe(2);
  });

  it("gate health counts attempted units meeting the 80% bar", () => {
    const garden = computeGardenHealth(
      [],
      [
        progressRow({ unitId: "A", attemptsCount: 2, bestAccuracyPct: 90 }),
        progressRow({ unitId: "B", attemptsCount: 1, bestAccuracyPct: 70 }),
      ],
    );
    expect(garden.gateHealthPct).toBe(50);
  });

  it("bands follow the documented thresholds", () => {
    expect(gardenBandFor(GARDEN_BANDS.thrivingMinPct)).toBe("thriving");
    expect(gardenBandFor(GARDEN_BANDS.growingMinPct)).toBe("growing");
    expect(gardenBandFor(GARDEN_BANDS.growingMinPct - 0.1)).toBe("sprouting");
  });
});

describe("a11y art contract", () => {
  it("every state glyph is unique (shape redundancy, not color-only)", () => {
    const glyphs = Object.values(STATE_ART).map((art) => art.glyph);
    expect(new Set(glyphs).size).toBe(glyphs.length);
  });

  it("Silver and Gold badges are different shapes", () => {
    const colors = {
      textMuted: "#6F6F6F",
      warning: "#FF9600",
    } as Parameters<typeof silverBadge>[0];
    expect(silverBadge(colors).silhouette).not.toBe(goldBadge(colors).silhouette);
    expect(silverBadge(colors).label).toBe("Silver key");
    expect(goldBadge(colors).label).toBe("Gold key");
  });

  it("every state resolves real colors in all three themes (incl. highContrast)", () => {
    for (const mode of Object.keys(themes) as (keyof typeof themes)[]) {
      const colors = themes[mode];
      for (const art of Object.values(STATE_ART)) {
        const resolved = stateColors(colors, art.token);
        expect(resolved.fill.length, `${mode}/${art.token} fill`).toBeGreaterThan(0);
        expect(resolved.bottom.length, `${mode}/${art.token} bottom`).toBeGreaterThan(0);
        expect(resolved.ink.length, `${mode}/${art.token} ink`).toBeGreaterThan(0);
      }
    }
  });

  it("the spoken label carries state, key, provisional, countdown, position", () => {
    const label = nodeAccessibilityLabel({
      unitId: "U1",
      subject: "math",
      sequenceOrder: 3,
      title: "Shapes",
      state: "MASTERED",
      blockedBy: [],
      totalTopics: 4,
      completedTopics: 4,
      topicFraction: 1,
      keyState: "SILVER_KEY",
      provisional: true,
      silverAwardedAt: NOW - 5 * MS_HOUR,
      goldEligibleAtMs: NOW + 9 * MS_HOUR,
      goldCountdownMs: 9 * MS_HOUR,
      goldEligible: false,
      isCurrent: false,
    });
    expect(label).toContain("Mastered");
    expect(label).toContain("Silver key earned");
    expect(label).toContain("Waiting for server check");
    expect(label).toContain("Gold check unlocks in 9 hours");
    expect(label).toContain("4 of 4 topics done");
  });

  it("formats the countdown humanely", () => {
    expect(formatCountdown(30 * 60_000)).toBe("under an hour");
    expect(formatCountdown(9 * MS_HOUR)).toBe("9 hours");
  });
});

describe("loader against the real SQLite fixture", () => {
  it("derives the full model from pack + progress rows (offline-only reads)", async () => {
    const env = createPracticeEnv();
    try {
      // Seed progress: all 3 fixture topics completed at crowns 1 (FLUENCY_READY).
      const topics = await env.deps.openContent("kindergarten");
      expect(topics).not.toBeNull();
      const unitRows = await topics!.unitsForGrade("kindergarten");
      expect(unitRows.map((row) => row.unit_id)).toEqual(["K-M2"]);

      const topicRows = await topics!.topicsForGrade("kindergarten");
      expect(topicRows).toHaveLength(3);
      for (const topic of topicRows) {
        await env.storage.upsertTopicProgress({
          studentId: "s1",
          topicId: topic.topic_id,
          unitId: topic.unit_id,
          topicCode: topic.topic_code,
          completed: 1,
          crowns: 1,
          masteryScore: 88,
          bestAccuracyPct: 88,
          bestMedianSpeedSec: 3,
          attemptsCount: 1,
          fluencyGrade: 3,
          stabilityDays: 2,
          nextReviewAt: NOW + 172_800_000,
          lastReviewedAt: NOW,
          provisional: true,
          updatedAt: NOW,
        });
      }

      const result = await loadJourneyModel(env.deps, env.storage, {
        gradeId: "kindergarten",
        studentId: "s1",
        nowMs: NOW,
      });
      expect(result).not.toBeNull();
      expect(result!.model.units).toHaveLength(1);
      expect(result!.model.units[0]!.state).toBe("FLUENCY_READY");
      expect(result!.model.units[0]!.isCurrent).toBe(true);
      expect(result!.model.units[0]!.completedTopics).toBe(3);
      expect(result!.model.units[0]!.totalTopics).toBe(3);

      // The new seams work on real SQLite.
      expect(await env.storage.allUnitProgress("s1")).toEqual([]);
      expect(await env.storage.activePackVersions()).toEqual([
        { gradeId: "kindergarten", contentVersion: "1.0.0" },
      ]);
    } finally {
      env.dispose();
    }
  });

  it("returns null for a grade with no installed pack (download state)", async () => {
    const env = createPracticeEnv();
    try {
      const result = await loadJourneyModel(env.deps, env.storage, {
        gradeId: "grade-3",
        studentId: "s1",
        nowMs: NOW,
      });
      expect(result).toBeNull();
    } finally {
      env.dispose();
    }
  });

  it("multi-unit DAG: prereq lock flows through the loader end to end", async () => {
    const env = createPracticeEnv();
    try {
      // Grow the fixture pack: add a second unit that requires K-M2.
      const packPath = join(env.dir, "pack-kindergarten-v1.0.0.sqlite");
      const pack = new DatabaseSync(packPath);
      pack
        .prepare(
          `INSERT INTO units VALUES ('K-M3', 'kindergarten', 'math', 2, 'Shapes and Space', ?, 6, 80, 6, 4, '[]', '[]')`,
        )
        .run(JSON.stringify(["K-M2"]));
      pack
        .prepare(
          `INSERT INTO skill_topics VALUES ('K-M3-J', 'K-M3', 'kindergarten', 'math', 'J', '2D Shapes', 1, '[]')`,
        )
        .run();
      pack.close();

      const result = await loadJourneyModel(env.deps, env.storage, {
        gradeId: "kindergarten",
        studentId: "s1",
        nowMs: NOW,
      });
      expect(result!.model.units.map((node) => node.unitId)).toEqual(["K-M2", "K-M3"]);
      expect(result!.model.units[1]!.state).toBe("LOCKED");
      expect(result!.model.units[1]!.blockedBy).toEqual(["K-M2"]);

      // Master K-M2 (gate pass -> Silver, provisional) and re-derive.
      await env.storage.upsertUnitProgress({
        studentId: "s1",
        unitId: "K-M2",
        status: "MASTERED",
        keyState: "SILVER_KEY",
        bestAccuracyPct: 92,
        bestMedianSpeedSec: 4,
        attemptsCount: 1,
        stabilityDays: 2,
        lastReviewedAt: NOW,
        cpaStage: "PICTORIAL_STATIC",
        provisional: true,
        silverAwardedAt: NOW,
        goldVerifiedAt: 0,
        updatedAt: NOW,
      });
      const unlocked = await loadJourneyModel(env.deps, env.storage, {
        gradeId: "kindergarten",
        studentId: "s1",
        nowMs: NOW,
      });
      expect(unlocked!.model.units[0]!.state).toBe("MASTERED");
      expect(unlocked!.model.units[0]!.keyState).toBe("SILVER_KEY");
      expect(unlocked!.model.units[0]!.provisional).toBe(true);
      expect(unlocked!.model.units[1]!.state).toBe("STUDY_REQUIRED");

      // Per-grade progress preservation: rows survive any switch by
      // construction (keyed by unit id); a re-load reads them back.
      const reread = await env.storage.allUnitProgress("s1");
      expect(reread).toHaveLength(1);
      expect(reread[0]!.unitId).toBe("K-M2");
    } finally {
      env.dispose();
    }
  });
});

describe("zero curriculum data in journey source", () => {
  const here = fileURLToPath(new URL(".", import.meta.url));

  it("no unit ids, topic codes, or curriculum titles are hardcoded", () => {
    const sources = [
      readFileSync(join(here, "..", "src", "journey", "model.ts"), "utf-8"),
      readFileSync(join(here, "..", "src", "journey", "loader.ts"), "utf-8"),
      readFileSync(join(here, "..", "src", "journey", "store.ts"), "utf-8"),
      readFileSync(join(here, "..", "app", "journey", "index.tsx"), "utf-8"),
    ];
    const banned = [/K-M\d/, /Numbers to 10/, /Counting to 10/, /2D Shapes/];
    for (const source of sources) {
      for (const pattern of banned) {
        expect(pattern.test(source), `${pattern} must not appear in journey sources`).toBe(false);
      }
    }
  });
});
