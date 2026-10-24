/**
 * Issue #50 acceptance test: the interaction-type inventory is derived
 * from the DATA (the exact derivation the seeder runs - engine
 * generateTopicPracticeSet over every registry topic), and every
 * distinct type maps to a registered renderer or a tracked fallback.
 * A pack question type with no renderer FAILS this suite.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateTopicPracticeSet } from "@balashikshana/core-engine";
import { describe, expect, it } from "vitest";
import {
  INTERACTION_RENDERERS,
  TRACKED_FALLBACK_TYPES,
  interactionCoverage,
} from "../src/runner/interactionRegistry";

interface RegistryTopic {
  code: string;
  name: string;
  assets?: Record<string, unknown>;
}
interface RegistryUnit {
  unitId: string;
  title: string;
  skillTopics: RegistryTopic[];
}
interface RegistryGrade {
  gradeId: string;
  subjects: Record<string, { units: RegistryUnit[] }>;
}

interface RegistryFile {
  grades: RegistryGrade[];
}

const registryPath = fileURLToPath(
  new URL("../../../docs/us-curriculum-registry.json", import.meta.url),
);

interface EnumerationResult {
  types: string[];
  questionCount: number;
  choicesMissing: number;
}

/**
 * The seeder's derivation (tools/content-pipeline/src/rows.mjs): for
 * every registry topic, generate the topic's question set with the
 * engine and collect the interaction_type values the rows would carry
 * (p.interactionType || "multiple-choice").
 */
function enumerateInteractionTypes(): EnumerationResult {
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as RegistryFile;
  const types = new Set<string>();
  let questionCount = 0;
  let choicesMissing = 0;
  for (const grade of registry.grades) {
    for (const subject of Object.values(grade.subjects)) {
      for (const unit of subject.units) {
        for (const topic of unit.skillTopics) {
          const problems = generateTopicPracticeSet(unit, topic, 10);
          for (const problem of problems) {
            types.add(problem.interactionType || "multiple-choice");
            questionCount += 1;
            if (!Array.isArray(problem.choices) || problem.choices.length === 0) {
              choicesMissing += 1;
            }
          }
        }
      }
    }
  }
  return { types: [...types].sort(), questionCount, choicesMissing };
}

describe("interaction-type coverage (data-derived)", () => {
  const enumeration = enumerateInteractionTypes();

  it("enumerates the seeded inventory (sweep actually ran)", () => {
    // 614 topics x 10 questions in the seeded registry.
    expect(enumeration.questionCount).toBe(6140);
    // Guard against a schema change silently sweeping nothing.
    expect(enumeration.types.length).toBeGreaterThanOrEqual(2);
  });

  it("every distinct interaction type has a renderer or a tracked fallback", () => {
    const coverage = interactionCoverage(enumeration.types);
    expect(coverage.uncovered, `uncovered types: ${coverage.uncovered.join(", ")}`).toEqual([]);
    expect(coverage.covered).toEqual(enumeration.types);
  });

  it("every generated question carries choices (degraded-stage answer surface)", () => {
    // The CPA fade falls through to the choice grid; a row without
    // choices would be unanswerable at pictorial+ stages.
    expect(enumeration.choicesMissing).toBe(0);
  });

  it("the tracked checklist doc lists exactly the derived inventory", () => {
    const doc = readFileSync(
      fileURLToPath(new URL("../../../docs/runner-interaction-coverage.md", import.meta.url)),
      "utf8",
    );
    const tableRows = [...doc.matchAll(/^\| `([a-z-]+)` \| registered \|/gm)].map((m) => m[1]);
    expect(tableRows.sort()).toEqual(enumeration.types);
    // Fallback section honesty: an empty fallback list must say so.
    if (TRACKED_FALLBACK_TYPES.length === 0) {
      expect(doc).toContain("None at v1");
    }
  });

  it("renderer registry maps each type to a widget-kit component", () => {
    for (const type of enumeration.types) {
      const spec = INTERACTION_RENDERERS[type];
      expect(spec, `${type} must be registered`).toBeDefined();
      expect(spec?.widget).toMatch(/^(ChoiceGrid|TileBuilder|CounterFrame)$/);
    }
  });
});
