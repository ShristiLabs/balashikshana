/**
 * Offline question-generation tests (issue #47, tester pass):
 * determinism (same seed -> identical item on both consumption paths),
 * variety (distinct seeds yield distinct items), and id-space
 * separation between stored pack rows and engine-generated padding.
 */
import { afterEach, describe, expect, it } from "vitest";
import { generateProceduralQuestion, generateTopicPracticeSet } from "@balashikshana/core-engine";
import { PracticeSessionEngine } from "../src/practice/practiceEngine";
import { packTopicToEngineTopic, packUnitToEngineUnit } from "../src/practice/packShapes";
import { createPracticeEnv, type PracticeTestEnv } from "./helpers/practiceEnv";

const GRADE = "kindergarten";
const UNIT = "K-M2";

let env: PracticeTestEnv | null = null;

afterEach(() => {
  env?.dispose();
  env = null;
});

describe("engine generator determinism and variety (fixture topic)", () => {
  it("same (unit, topic, seed) -> identical item", async () => {
    const localEnv = createPracticeEnv();
    try {
      const shapes = await engineShapes(localEnv);
      const a = generateProceduralQuestion(shapes.unit, shapes.topic, 3);
      const b = generateProceduralQuestion(shapes.unit, shapes.topic, 3);
      expect(a).toEqual(b);
      expect(JSON.stringify(a)).toBe(JSON.stringify(b));

      const setA = generateTopicPracticeSet(shapes.unit, shapes.topic, 10);
      const setB = generateTopicPracticeSet(shapes.unit, shapes.topic, 10);
      expect(setA).toEqual(setB);
    } finally {
      localEnv.dispose();
    }
  });

  it("distinct seeds produce distinct items (variety)", async () => {
    const localEnv = createPracticeEnv();
    try {
      const { unit, topic } = await engineShapes(localEnv);
      const distinct = new Set<string>();
      for (let seed = 0; seed < 10; seed += 1) {
        distinct.add(JSON.stringify(generateProceduralQuestion(unit, topic, seed)));
      }
      expect(distinct.size).toBeGreaterThan(1);
    } finally {
      localEnv.dispose();
    }
  });
});

describe("engine padding through the session engine", () => {
  it("count beyond the stored pool pads with engine items in a disjoint id space", async () => {
    env = env ?? createPracticeEnv();
    const engine = new PracticeSessionEngine(env.deps);
    // Fixture stores 10 questions for K-M2-G; request 15.
    const start = await engine.startTopicSession({
      studentId: "s1",
      gradeId: GRADE,
      unitId: UNIT,
      topicCode: "G",
      count: 15,
    });
    expect(start.questions).toHaveLength(15);
    const ids = start.questions.map((q) => q.questionId);
    expect(new Set(ids).size).toBe(15); // no collisions, no duplicates
    const stored = ids.filter((id) => /^K-M2-G-Q\d+$/.test(id));
    const generated = ids.filter((id) => /^K-M2-G-G\d+$/.test(id));
    expect(stored).toHaveLength(10);
    expect(generated).toHaveLength(5);

    // Deterministic: a second session pads with the SAME items.
    const second = await engine.startTopicSession({
      studentId: "s1",
      gradeId: GRADE,
      unitId: UNIT,
      topicCode: "G",
      count: 15,
    });
    expect(second.questions.map((q) => q.questionId)).toEqual(ids);
    const genA = JSON.stringify(start.questions.filter((q) => q.questionId.includes("-G")));
    const genB = JSON.stringify(second.questions.filter((q) => q.questionId.includes("-G")));
    expect(genA).toBe(genB);
  });

  it("generated items carry the render contract (prompt, choices, correctAnswer)", async () => {
    env = env ?? createPracticeEnv();
    const engine = new PracticeSessionEngine(env.deps);
    const start = await engine.startTopicSession({
      studentId: "s1",
      gradeId: GRADE,
      unitId: UNIT,
      topicCode: "I",
      count: 12,
    });
    const generated = start.questions.filter((q) => q.questionId.includes("-G"));
    expect(generated).toHaveLength(2);
    for (const q of generated) {
      expect(q.prompt.length).toBeGreaterThan(0);
      expect(q.correctAnswer.length).toBeGreaterThan(0);
      expect(q.interactionType.length).toBeGreaterThan(0);
      expect(q.visualAid.length).toBeGreaterThan(0);
    }
  });
});

/** Opens the fixture pack and returns engine-shaped unit + first topic. */
async function engineShapes(localEnv: PracticeTestEnv) {
  const reader = await localEnv.deps.openContent(GRADE);
  if (!reader) throw new Error("fixture pack missing");
  const unitRow = await reader.unit(UNIT);
  const topics = await reader.topicsForUnit(UNIT);
  if (!unitRow || !topics[0]) throw new Error("fixture incomplete");
  return {
    unit: packUnitToEngineUnit(unitRow, topics),
    topic: packTopicToEngineTopic(topics[0]!),
  };
}
