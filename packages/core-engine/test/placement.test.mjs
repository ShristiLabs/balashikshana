/**
 * Placement diagnostic specs (issue #60) — the engine matrices:
 * adaptive selection across DAG strands, termination rules, guardrail
 * caps EXACTLY at the boundary, recommendation correctness (no skip into
 * uncredited chains), determinism per seed, degenerate inputs
 * (all-correct, all-wrong, mixed, empty), provisional FSRS credit, DAG
 * credit spreading through propagateImplicitDagCredit, and the no-keys
 * posture.
 */
import { describe, expect, it } from "vitest";
import {
  PLACEMENT_RULES,
  initialPlacementState,
  placementNextItem,
  recordPlacementResponse,
  derivePlacementOutcome,
  strandChainsFromUnits,
  nextPlacementRand,
  updatePlacementStability
} from "../src/index.mjs";

/** Fixture factory: a two-strand grade shaped like the registry. */
function fixtureUnits({ mathUnits = 6, elaUnits = 5, seqBase = { math: 2, ela: 3 } } = {}) {
  const units = [];
  for (let i = 1; i <= mathUnits; i += 1) {
    units.push({
      unitId: `T-M${i}`,
      strand: "math",
      sequenceOrder: seqBase.math + (i - 1) * 2,
      title: `Math ${i}`,
      prerequisiteUnitIds: i === 1 ? ["PREV-M"] : [`T-M${i - 1}`],
      masteryGate: { maxMedianResponseTimeSec: 4.0 },
      skillTopics: [
        { code: "count", name: `Counting ${i}`, assets: {} },
        { code: "compare", name: `Comparing ${i}`, assets: {} }
      ]
    });
  }
  for (let i = 1; i <= elaUnits; i += 1) {
    units.push({
      unitId: `T-E${i}`,
      strand: "ela",
      sequenceOrder: seqBase.ela + (i - 1) * 2,
      title: `ELA ${i}`,
      prerequisiteUnitIds: i === 1 ? ["PREV-E"] : [`T-E${i - 1}`],
      masteryGate: { maxMedianResponseTimeSec: 6.0 },
      skillTopics: [{ code: "letters", name: `Letters ${i}`, assets: {} }]
    });
  }
  return units;
}

function unitsBy(units) {
  return new Map(units.map((u) => [u.unitId, u]));
}

/** Drives the probe with an answer policy fn(unitId) -> boolean. */
function runProbe({ units, seed = 7, policy, maxSteps = 40 }) {
  let state = initialPlacementState({ units, seed });
  const items = [];
  const responses = [];
  for (let step = 0; step < maxSteps; step += 1) {
    const next = placementNextItem(state, { unitsBy: unitsBy(units) });
    state = next.state;
    if (next.done) break;
    const item = next.item;
    items.push(item);
    const isCorrect = policy(item.unitId, item.kind, items.length);
    responses.push({ unitId: item.unitId, topicId: item.topicId, isCorrect, rawTimeSec: 3.0, motorBaselineSec: 0.42 });
    state = recordPlacementResponse(state, { unitId: item.unitId, isCorrect });
  }
  return { state, items, responses };
}

describe("strand chains", () => {
  it("groups by strand and orders by sequence then id", () => {
    const chains = strandChainsFromUnits(fixtureUnits());
    expect(chains.map((c) => c.strand)).toEqual(["ela", "math"]);
    expect(chains[1].units.map((u) => u.unitId)).toEqual(["T-M1", "T-M2", "T-M3", "T-M4", "T-M5", "T-M6"]);
  });

  it("tolerates empty and malformed input", () => {
    expect(strandChainsFromUnits([])).toEqual([]);
    expect(strandChainsFromUnits(null)).toEqual([]);
    expect(strandChainsFromUnits([{ unitId: "X" }])[0].strand).toBe("core");
  });
});

describe("seeded PRNG", () => {
  it("is deterministic per seed and varies across seeds", () => {
    const a1 = nextPlacementRand(42);
    const a2 = nextPlacementRand(42);
    const b = nextPlacementRand(43);
    expect(a1.value).toBe(a2.value);
    expect(a1.seed).toBe(a2.seed);
    expect(a1.value).not.toBe(b.value);
    expect(a1.value).toBeGreaterThanOrEqual(0);
    expect(a1.value).toBeLessThan(1);
  });
});

describe("adaptive probe", () => {
  it("probes both strands (representative coverage), starting at depth 0", () => {
    const units = fixtureUnits();
    const { items } = runProbe({ units, policy: () => false });
    const strands = new Set(items.map((i) => i.strand));
    expect(strands.has("math")).toBe(true);
    expect(strands.has("ela")).toBe(true);
    // Deterministic tie-break: strand name ASC, so the ela chain probes
    // first; its confirmation resolves before math opens (confirm-first).
    expect(items[0].unitId).toBe("T-E1");
    expect(items[0].kind).toBe("probe");
    expect(items[1].unitId).toBe("T-E1");
    expect(items[1].kind).toBe("confirm");
    expect(items[2].unitId).toBe("T-M1");
  });

  it("advances deeper on correct answers and confirms frontiers on two wrongs", () => {
    const units = fixtureUnits();
    const { items } = runProbe({
      units,
      policy: (unitId) => unitId === "T-M1" || unitId === "T-M3" // math depth 0 correct, depth 1 wrong+confirm-wrong
    });
    const mathItems = items.filter((i) => i.strand === "math");
    // T-M1 probe correct -> T-M2 probe wrong -> T-M2 confirm wrong -> confirmed.
    expect(mathItems.map((i) => i.unitId)).toEqual(["T-M1", "T-M2", "T-M2"]);
    expect(mathItems[1].kind).toBe("probe");
    expect(mathItems[2].kind).toBe("confirm");
  });

  it("forgives a slip: correct confirm continues deeper", () => {
    const units = fixtureUnits();
    const { items } = runProbe({
      units,
      policy: (unitId, kind) => !(unitId === "T-M2" && kind === "probe") // wrong probe, correct confirm
    });
    const mathItems = items.filter((i) => i.strand === "math");
    expect(mathItems.map((i) => i.unitId)).toContain("T-M3");
  });

  it("stops when every strand frontier is confirmed (confidence rule)", () => {
    const units = fixtureUnits();
    const { items } = runProbe({ units, policy: () => false });
    // 2 strands x (probe wrong + confirm wrong) = 4 items exactly.
    expect(items.length).toBe(4);
  });

  it("stops at chain ends before the cap when both strands are aced", () => {
    const units = fixtureUnits();
    const { items, state } = runProbe({ units, policy: () => true });
    // 5 ela + 6 math chain-end stop: 11 items, under the 14 cap.
    expect(items.length).toBe(11);
    expect(Object.values(state.strands).every((s) => s.status === "chain-end")).toBe(true);
  });

  it("hard-caps the session at maxItems on chains longer than the cap can cover", () => {
    const units = fixtureUnits({ mathUnits: 9, elaUnits: 9 });
    const { items } = runProbe({ units, policy: () => true });
    expect(items.length).toBe(PLACEMENT_RULES.maxItems);
  });

  it("is deterministic per seed (identical policy + seed => identical sequence)", () => {
    const units = fixtureUnits();
    const a = runProbe({ units, seed: 99, policy: (id) => id.length % 2 === 0 });
    const b = runProbe({ units, seed: 99, policy: (id) => id.length % 2 === 0 });
    expect(a.items.map((i) => i.question.questionId)).toEqual(b.items.map((i) => i.question.questionId));
    const c = runProbe({ units, seed: 100, policy: (id) => id.length % 2 === 0 });
    expect(
      c.items.map((i) => i.question.questionId).join(",") === a.items.map((i) => i.question.questionId).join(",")
    ).toBe(false);
  });

  it("emits engine-generated questions with renderable shape", () => {
    const units = fixtureUnits();
    const state = initialPlacementState({ units, seed: 3 });
    const next = placementNextItem(state, { unitsBy: unitsBy(units) });
    const q = next.item.question;
    expect(q.questionId).toBeTruthy();
    expect(q.unitId).toBe("T-E1");
    expect(Array.isArray(q.choices)).toBe(true);
    expect(q.choices.length).toBeGreaterThanOrEqual(3);
    expect(q.correctAnswer).toBeTruthy();
    expect(q.prompt).toBeTruthy();
  });
});

describe("derivePlacementOutcome — start-point mapping", () => {
  it("all-correct child is capped at maxSkipAheadUnits (boundary exactness)", () => {
    const units = fixtureUnits({ mathUnits: 9, elaUnits: 9 });
    const { responses } = runProbe({ units, policy: () => true });
    const outcome = derivePlacementOutcome({ responses, units });
    expect(outcome.itemsAsked).toBe(PLACEMENT_RULES.maxItems);
    expect(outcome.skipAheadUnitCount).toBe(PLACEMENT_RULES.maxSkipAheadUnits);
    // Math start index exactly AT the cap (5th unit of the chain, index 4).
    const math = outcome.perStrand.find((s) => s.strand === "math");
    expect(math.frontierIndex).toBeGreaterThanOrEqual(PLACEMENT_RULES.maxSkipAheadUnits);
    expect(math.cappedBySkipAhead).toBe(true);
    expect(math.startUnitId).toBe("T-M5");
    expect(outcome.creditedUnits.filter((u) => u.strand === "math").length).toBe(PLACEMENT_RULES.maxSkipAheadUnits);
    // Credit never flows past the cap even though evidence exists beyond it.
    expect(outcome.creditedUnits.some((u) => u.unitId === "T-M6")).toBe(false);
  });

  it("all-wrong child starts at the grade's first unit with zero credit", () => {
    const units = fixtureUnits();
    const { responses } = runProbe({ units, policy: () => false });
    const outcome = derivePlacementOutcome({ responses, units });
    // Earliest journey order among the per-strand starts (T-M1 seq 2).
    expect(outcome.recommendedStartUnitId).toBe("T-M1");
    expect(outcome.creditedUnits).toEqual([]);
    expect(outcome.skipAheadUnitCount).toBe(0);
    expect(outcome.perStrand.every((s) => s.frontierIndex === 0)).toBe(true);
  });

  it("mixed child: per-strand frontiers land on first unprobed/unconfirmed units", () => {
    const units = fixtureUnits();
    const { responses } = runProbe({
      units,
      policy: (unitId) => unitId === "T-M1" || unitId === "T-M2" || unitId === "T-E1"
    });
    const outcome = derivePlacementOutcome({ responses, units });
    const math = outcome.perStrand.find((s) => s.strand === "math");
    const ela = outcome.perStrand.find((s) => s.strand === "ela");
    expect(math.frontierIndex).toBe(2); // M1, M2 demonstrated; M3 confirmed-wrong
    expect(math.startUnitId).toBe("T-M3");
    expect(ela.frontierIndex).toBe(1);
    expect(ela.startUnitId).toBe("T-E2");
    // Journey order by sequenceOrder: T-E2 (seq 5) < T-M3 (seq 6).
    expect(outcome.recommendedStartUnitId).toBe("T-E2");
    expect(outcome.creditedUnits.map((u) => u.unitId).sort()).toEqual(["T-E1", "T-M1", "T-M2"]);
  });

  it("empty evidence: unit-1 start, no credit (degenerate no-credit case)", () => {
    const units = fixtureUnits();
    const outcome = derivePlacementOutcome({ responses: [], units });
    expect(outcome.recommendedStartUnitId).toBe("T-M1");
    expect(outcome.creditedUnits).toEqual([]);
    expect(outcome.itemsAsked).toBe(0);
    expect(outcome.skipAheadUnitCount).toBe(0);
  });

  it("unprobed unit in the middle pins the frontier (never credit past a gap)", () => {
    const units = fixtureUnits();
    // Direct evidence: M1 correct only — M2 never probed.
    const outcome = derivePlacementOutcome({
      responses: [{ unitId: "T-M1", topicId: "T-M1-count", isCorrect: true }],
      units
    });
    const math = outcome.perStrand.find((s) => s.strand === "math");
    expect(math.frontierIndex).toBe(1);
    expect(math.startUnitId).toBe("T-M2");
    // Only the demonstrated unit carries credit.
    expect(outcome.creditedUnits.map((u) => u.unitId)).toEqual(["T-M1"]);
  });

  it("asymmetric strands: a capped strong strand never drags the start past a weaker strand's frontier", () => {
    // Math aced to the cap (start T-M5, seq 10); ela missed at unit 1
    // (start T-E1, seq 3). The recommendation is the EARLIEST unfinished
    // point in journey order — ela unit 1 — never inside math's
    // uncredited chain, and never past an unprobed unit of any strand.
    const units = fixtureUnits({ mathUnits: 9, elaUnits: 9 });
    const mathCorrect = new Set(["T-M1", "T-M2", "T-M3", "T-M4", "T-M5"]);
    const responses = [];
    for (const unitId of mathCorrect) {
      responses.push({ unitId, topicId: `${unitId}-count`, isCorrect: true });
    }
    responses.push({ unitId: "T-E1", topicId: "T-E1-letters", isCorrect: false });
    responses.push({ unitId: "T-E1", topicId: "T-E1-letters", isCorrect: false });
    const outcome = derivePlacementOutcome({ responses, units });
    const math = outcome.perStrand.find((s) => s.strand === "math");
    const ela = outcome.perStrand.find((s) => s.strand === "ela");
    expect(math.creditedUnits).toBe(PLACEMENT_RULES.maxSkipAheadUnits);
    expect(math.startUnitId).toBe("T-M5");
    expect(ela.frontierIndex).toBe(0);
    expect(ela.startUnitId).toBe("T-E1");
    // Journey order: T-E1 (seq 3) < T-M5 (seq 10).
    expect(outcome.recommendedStartUnitId).toBe("T-E1");
    // The recommended start's own strand prefix is fully credited-or-
    // re-probed BY CONSTRUCTION: ela's frontier is the chain head.
    expect(outcome.prerequisiteChainCredited).toBe(true);
  });

  it("order independence: shuffled responses derive the identical outcome (D8 batch splits)", () => {
    const units = fixtureUnits();
    const { responses } = runProbe({ units, seed: 11, policy: (id) => id.endsWith("1") || id.endsWith("2") });
    const a = derivePlacementOutcome({ responses, units });
    const shuffled = [...responses].reverse();
    const b = derivePlacementOutcome({ responses: shuffled, units });
    expect(b.recommendedStartUnitId).toBe(a.recommendedStartUnitId);
    expect(b.creditedUnits.map((u) => u.unitId).sort()).toEqual(a.creditedUnits.map((u) => u.unitId).sort());
    expect(b.skipAheadUnitCount).toBe(a.skipAheadUnitCount);
  });
});

describe("provisional credit + DAG credit", () => {
  it("grants provisional FSRS stability on correct items only, capped at 4 days", () => {
    const units = fixtureUnits();
    const { responses } = runProbe({
      units,
      policy: (unitId) => unitId === "T-M1" || unitId === "T-M2" || unitId === "T-E1"
    });
    const outcome = derivePlacementOutcome({ responses, units });
    const m1 = outcome.creditedUnits.find((u) => u.unitId === "T-M1");
    expect(m1.topics.length).toBeGreaterThan(0);
    for (const topic of m1.topics) {
      if (topic.correctItems === 0) {
        expect(topic.provisionalStabilityDays).toBe(0);
      } else {
        expect(topic.provisionalStabilityDays).toBeGreaterThan(0);
        expect(topic.provisionalStabilityDays).toBeLessThanOrEqual(4);
      }
    }
  });

  it("spreads implicit DAG credit to prerequisite chains via propagateImplicitDagCredit", () => {
    const units = fixtureUnits();
    const { responses } = runProbe({
      units,
      policy: (unitId) => unitId === "T-M1" || unitId === "T-M2" || unitId === "T-E1"
    });
    const outcome = derivePlacementOutcome({ responses, units });
    const m2 = outcome.creditedUnits.find((u) => u.unitId === "T-M2");
    expect(m2.implicitDagCredit).toHaveLength(1);
    expect(m2.implicitDagCredit[0].prerequisiteUnitId).toBe("T-M1");
    expect(m2.implicitDagCredit[0].implicitStabilityBoostDays).toBeGreaterThan(0);
    expect(m2.implicitDagCredit[0].implicitStabilityBoostDays).toBeLessThanOrEqual(
      Number((4 * PLACEMENT_RULES.dagCreditWeight).toFixed(2))
    );
    // Chain-head units credit their CROSS-GRADE entry link exactly once
    // (the depth-0 demonstration subsumes the prior-grade transition);
    // units with no prereqs at all are the true no-credit case.
    const m1 = outcome.creditedUnits.find((u) => u.unitId === "T-M1");
    expect(m1.implicitDagCredit).toHaveLength(1);
    expect(m1.implicitDagCredit[0].prerequisiteUnitId).toBe("PREV-M");
    const headless = {
      unitId: "T-X1",
      strand: "math",
      sequenceOrder: 99,
      title: "Island",
      prerequisiteUnitIds: [],
      masteryGate: { maxMedianResponseTimeSec: 4 },
      skillTopics: [{ code: "solo", name: "Solo", assets: {} }]
    };
    const lone = derivePlacementOutcome({
      responses: [{ unitId: "T-X1", topicId: "T-X1-solo", isCorrect: true }],
      units: [headless]
    });
    expect(lone.creditedUnits[0].implicitDagCredit).toEqual([]);
  });

  it("stability growth is the engine's own function, clamped", () => {
    const one = updatePlacementStability({ fluencyGrade: 4 });
    expect(one.stabilityDays).toBeGreaterThan(0);
    expect(one.stabilityDays).toBeLessThanOrEqual(4);
  });

  it("provisional credit decays through the ORDINARY retrievability path if unused (no second memory system)", async () => {
    const { computeRetrievabilityPct } = await import("../src/index.mjs");
    const units = fixtureUnits();
    const { responses } = runProbe({
      units,
      policy: (unitId) => unitId === "T-M1" || unitId === "T-M2" || unitId === "T-E1"
    });
    const outcome = derivePlacementOutcome({ responses, units });
    const m1 = outcome.creditedUnits.find((u) => u.unitId === "T-M1");
    const granted = m1.topics.find((t) => t.correctItems > 0).provisionalStabilityDays;
    expect(granted).toBeGreaterThan(0);
    // The SAME engine decay function the practice path serves: memory
    // fades without review, and is stronger sooner after the placement.
    const soon = computeRetrievabilityPct(0.5, granted);
    const later = computeRetrievabilityPct(7, granted);
    const muchLater = computeRetrievabilityPct(30, granted);
    expect(soon).toBeGreaterThan(later);
    expect(later).toBeGreaterThan(muchLater);
    expect(muchLater).toBeLessThan(50);
    // A placement item can never out-stabilize real practice: even a
    // max-band grant decays below a mid-band practice stability.
    expect(computeRetrievabilityPct(7, granted)).toBeLessThan(computeRetrievabilityPct(7, 21));
  });

  it("repeated correct growth saturates at the provisional cap (many confirms never exceed the band)", () => {
    let stability = 0;
    for (let i = 0; i < 12; i += 1) {
      stability = updatePlacementStability({
        currentStabilityDays: stability > 0 ? stability : PLACEMENT_RULES.provisionalBaseStabilityDays,
        fluencyGrade: 4
      }).stabilityDays;
    }
    expect(stability).toBeLessThanOrEqual(4);
  });

  it("NEVER awards keys or unit mastery (guardrail vocabulary)", () => {
    const units = fixtureUnits();
    const { responses } = runProbe({ units, policy: () => true });
    const outcome = derivePlacementOutcome({ responses, units });
    expect(outcome.keysAwarded).toEqual([]);
    expect(outcome.prerequisiteChainCredited).toBe(true);
    expect(JSON.stringify(outcome)).not.toContain("SILVER");
    expect(JSON.stringify(outcome)).not.toContain("GOLD");
    expect(JSON.stringify(outcome)).not.toContain("MASTERED");
  });
});

describe("real-registry smoke (all five grades)", () => {
  it("runs the probe and mapping over the real DAG for every grade", async () => {
    const { readFileSync } = await import("node:fs");
    const registry = JSON.parse(
      readFileSync(new URL("../../../docs/us-curriculum-registry.json", import.meta.url), "utf8")
    );
    for (const grade of registry.grades) {
      const units = [];
      for (const [subjectKey, subject] of Object.entries(grade.subjects)) {
        for (const unit of subject.units) {
          units.push({
            unitId: unit.unitId,
            strand: subjectKey,
            sequenceOrder: unit.sequenceOrder,
            title: unit.title,
            prerequisiteUnitIds: unit.prerequisiteUnitIds || [],
            masteryGate: unit.masteryGate,
            skillTopics: unit.skillTopics
          });
        }
      }
      const strandCount = new Set(units.map((u) => u.strand)).size; // 2 in Pre-K, 4 in K+
      const strong = runProbe({ units, seed: 5, policy: () => true });
      expect(strong.items.length).toBe(PLACEMENT_RULES.maxItems);
      const strongOutcome = derivePlacementOutcome({ responses: strong.responses, units });
      expect(strongOutcome.skipAheadUnitCount).toBe(PLACEMENT_RULES.maxSkipAheadUnits);
      expect(strongOutcome.recommendedStartUnitId).toBeTruthy();
      // Representative coverage: every strand received at least one item.
      expect(new Set(strong.items.map((i) => i.strand)).size).toBe(strandCount);

      const weak = runProbe({ units, seed: 5, policy: () => false });
      expect(weak.items.length).toBe(strandCount * 2); // probe + confirm per strand
      const weakOutcome = derivePlacementOutcome({ responses: weak.responses, units });
      expect(weakOutcome.creditedUnits).toEqual([]);

      const mid = runProbe({ units, seed: 5, policy: (id, _kind, n) => n % 3 !== 0 });
      const midOutcome = derivePlacementOutcome({ responses: mid.responses, units });
      // Guardrail: the recommended start's chain position is at most the cap.
      for (const strand of midOutcome.perStrand) {
        expect(strand.creditedUnits).toBeLessThanOrEqual(PLACEMENT_RULES.maxSkipAheadUnits);
      }
    }
  });
});
