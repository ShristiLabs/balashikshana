// Vitest specs for curriculum-wide coverage (issue #32): the full-registry
// procedural question sweep ported from verify-engine.mjs (every one of the
// 614 skill topics must yield a valid question), question determinism for
// the client-side practice sessions, and FIRe implicit DAG credit
// propagation through prerequisite edges.

import { describe, test, expect } from "vitest";
import fs from "node:fs";
import {
  generateProceduralQuestion,
  generateTopicPracticeSet,
  propagateImplicitDagCredit
} from "../src/index.mjs";

const registry = JSON.parse(
  fs.readFileSync(new URL("../../../docs/us-curriculum-registry.json", import.meta.url), "utf8")
);

const unitMap = {};
let topicCount = 0;
for (const g of registry.grades) {
  for (const s of Object.values(g.subjects)) {
    for (const u of s.units) {
      unitMap[u.unitId] = u;
      topicCount += u.skillTopics.length;
    }
  }
}

describe("registry shape", () => {
  test("covers exactly 130 units and 614 skill topics", () => {
    expect(Object.keys(unitMap).length).toBe(130);
    expect(topicCount).toBe(614);
  });
});

describe("procedural question generation across all skill topics", () => {
  test("every topic generates a valid question (ported full-registry sweep)", () => {
    let generated = 0;
    for (const u of Object.values(unitMap)) {
      for (const t of u.skillTopics) {
        const q = generateProceduralQuestion(u, t, generated + 1);
        expect(q.prompt, `${u.unitId}/${t.code} prompt`).toBeTruthy();
        expect(q.choices.length, `${u.unitId}/${t.code} choices`).toBeGreaterThanOrEqual(3);
        expect(q.correctAnswer, `${u.unitId}/${t.code} answer`).toBeTruthy();
        generated += 1;
      }
    }
    expect(generated).toBe(614);
  });

  test("choices are unique and always contain the correct answer", () => {
    const unit = unitMap["PK-M1"];
    for (const t of unit.skillTopics) {
      for (const seed of [0, 3, 7]) {
        const q = generateProceduralQuestion(unit, t, seed);
        expect(new Set(q.choices).size).toBe(q.choices.length);
        expect(q.choices.map(String)).toContain(String(q.correctAnswer));
      }
    }
  });

  test("generation is deterministic: same seed reproduces the identical question", () => {
    const unit = unitMap["K-M2"];
    for (const t of unit.skillTopics.slice(0, 3)) {
      const a = generateProceduralQuestion(unit, t, 5);
      const b = generateProceduralQuestion(unit, t, 5);
      expect(b).toEqual(a);
    }
  });

  test("different seeds yield different variants of the same topic", () => {
    const unit = unitMap["K-M2"];
    const topic = unit.skillTopics[0];
    const ids = new Set();
    for (let seed = 0; seed < 12; seed += 1) {
      ids.add(generateProceduralQuestion(unit, topic, seed).questionId);
    }
    expect(ids.size).toBe(12);
  });

  test("a topic practice set of 8 contains 8 distinct items", () => {
    const unit = unitMap["K-M2"];
    const set = generateTopicPracticeSet(unit, unit.skillTopics[0], 8);
    expect(set).toHaveLength(8);
    expect(new Set(set.map((q) => q.questionId)).size).toBe(8);
  });
});

describe("FIRe implicit DAG credit propagation", () => {
  test("credit flows to the prerequisite unit at the given weight (PK-M2 -> PK-M1)", () => {
    const credits = propagateImplicitDagCredit("PK-M2", 2.0, unitMap, 0.4);
    expect(credits).toHaveLength(1);
    expect(credits[0].prerequisiteUnitId).toBe("PK-M1");
    expect(credits[0].implicitStabilityBoostDays).toBe(0.8); // 2.0 * 0.4
  });

  test("units with several prerequisites credit every edge (synthetic DAG)", () => {
    const synthetic = {
      "T-M1": { unitId: "T-M1", prerequisiteUnitIds: [] },
      "T-M2": { unitId: "T-M2", prerequisiteUnitIds: [] },
      "T-M3": { unitId: "T-M3", prerequisiteUnitIds: ["T-M1", "T-M2"] }
    };
    const credits = propagateImplicitDagCredit("T-M3", 5.0, synthetic, 0.5);
    expect(credits.map((c) => c.prerequisiteUnitId)).toEqual(["T-M1", "T-M2"]);
    expect(credits.every((c) => c.implicitStabilityBoostDays === 2.5)).toBe(true);
  });

  test("default credit weight is 0.4", () => {
    const credits = propagateImplicitDagCredit("PK-M2", 10, unitMap);
    expect(credits[0].implicitStabilityBoostDays).toBe(4.0);
  });

  test("unknown unit ids and prerequisite-free units propagate nothing", () => {
    expect(propagateImplicitDagCredit("DOES-NOT-EXIST", 2.0, unitMap, 0.4)).toEqual([]);
    expect(propagateImplicitDagCredit("PK-M1", 2.0, unitMap, 0.4)).toEqual([]);
  });
});
