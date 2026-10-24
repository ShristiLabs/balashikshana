/**
 * Archetype pack B test suite (issue #54): the tester-stage matrices
 * over the REAL content packs (node:sqlite, read-only - the
 * games-session-integration precedent):
 *
 * - item-level completeness: EVERY real practice row fields a bubble
 *   surface (permutation-only, never degrading) and EVERY tile-bank
 *   row mounts a valid feed plan whose target assembly drafts the
 *   row's exact correct_answer (grading by construction, proven on
 *   real data, not fixtures);
 * - seed handling: fields/banks are permutations of their source
 *   data across seeds (no loss, duplication, or case drift);
 * - stage-variant wiring + the reflex seam (source pins - no RN
 *   component harness, standing debt);
 * - reduced-motion + a11y source pins;
 * - the #53 advisory follow-through: StubArchetypeGame retired.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// eslint-disable-next-line import/no-unresolved
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { PracticeQuestion } from "../src/practice/types";
import { bubbleFieldFor } from "../src/games/bubblePopBlitz";
import { draftForPlaced, feederPlanFor } from "../src/games/monsterPhonemeFeeder";
import {
  pressureLabelFor,
  type PressurePhase,
  type PressureTier,
} from "../src/games/bubblePopBlitz";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const PACK_GRADES = ["pre-k", "kindergarten", "grade-1", "grade-2", "grade-3"] as const;

interface PackRow {
  question_id: string;
  topic_id: string;
  unit_id: string;
  topic_code: string;
  topic_name: string;
  difficulty_level: number;
  interaction_type: string;
  prompt: string;
  visual_aid_svg: string | null;
  visual_objects: string | null;
  target_count: number | null;
  max_counter_cells: number | null;
  counter_emoji: string | null;
  tile_bank_json: string | null;
  choices_json: string;
  correct_answer: string;
  misconception_tags_json: string;
  explanation: string;
}

function rowToQuestion(row: PackRow): PracticeQuestion {
  return {
    questionId: row.question_id,
    topicId: row.topic_id,
    unitId: row.unit_id,
    topicCode: row.topic_code,
    topicName: row.topic_name,
    difficultyLevel: row.difficulty_level,
    interactionType: row.interaction_type,
    prompt: row.prompt,
    visualAid: row.visual_aid_svg ?? "",
    visualObjects: row.visual_objects,
    targetCount: row.target_count ?? undefined,
    maxCounterCells: row.max_counter_cells ?? undefined,
    counterEmoji: row.counter_emoji ?? undefined,
    tileBank:
      row.tile_bank_json === null ? undefined : (JSON.parse(row.tile_bank_json) as unknown[]),
    choices: JSON.parse(row.choices_json) as unknown[],
    correctAnswer: row.correct_answer,
    misconceptionTags: JSON.parse(row.misconception_tags_json) as string[],
    explanation: row.explanation,
  };
}

/**
 * The built pack DBs are LOCAL-ONLY artifacts (services/api/
 * content-packs/ is gitignored; `npm run packs:build` generates them
 * from the registry). Wherever they exist - developer machines and
 * any environment that runs packs:build - this matrix proves the
 * pack-B modules against every live row; where they do not (the
 * cheap CI job does not build packs), it skips instead of passing
 * vacuously. The synthetic matrices below run everywhere.
 */
const PACK_PATHS = PACK_GRADES.map(
  (grade) => `${repoRoot}/services/api/content-packs/pack-${grade}-v1.0.0.sqlite`,
).filter((path) => existsSync(path));

/** Read-only pass over every real pack DB. */
function* realPackRows(): Generator<{ question: PracticeQuestion; raw: PackRow }> {
  for (const path of PACK_PATHS) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const rows = db
        .prepare(
          "SELECT question_id, topic_id, unit_id, topic_code, topic_name, difficulty_level, interaction_type, prompt, visual_aid_svg, visual_objects, target_count, max_counter_cells, counter_emoji, tile_bank_json, choices_json, correct_answer, misconception_tags_json, explanation FROM practice_questions",
        )
        .all() as unknown as PackRow[];
      for (const raw of rows) yield { question: rowToQuestion(raw), raw };
    } finally {
      db.close();
    }
  }
}

describe.skipIf(PACK_PATHS.length === 0)(
  "real-pack item matrix (every live row, all five grades)",
  () => {
    it("EVERY practice row fields a bubble surface: labels are an exact permutation of the choices", () => {
      let rows = 0;
      for (const { question } of realPackRows()) {
        rows += 1;
        const field = bubbleFieldFor(question);
        expect(field, question.questionId).not.toBeNull();
        expect(field!.map((b) => b.label).sort(), question.questionId).toEqual(
          question.choices.map((c) => String(c)).sort(),
        );
      }
      expect(rows).toBeGreaterThan(5000); // the packs carry ~6k rows total
    });

    it("EVERY phoneme-shaped tile-bank row mounts a valid feed plan; non-phoneme banks correctly refuse", () => {
      let feedRows = 0;
      let refusedRows = 0;
      let feederTopics = new Set<string>();
      const SEGMENT = /^[a-z]{1,4}$/;
      for (const { question, raw } of realPackRows()) {
        if (raw.tile_bank_json === null) continue;
        const bank = JSON.parse(raw.tile_bank_json) as string[];
        const target = raw.correct_answer.trim().split(/\s+/);
        const phonemeShaped =
          bank.every((token) => SEGMENT.test(token)) &&
          target.length >= 2 &&
          target.every((segment) => SEGMENT.test(segment));
        const plan = feederPlanFor(question);
        if (!phonemeShaped) {
          // Math ordering rows (digit tiles: "3","1","2") refuse the
          // anchored grammar - they belong to pack A surfaces, never the
          // feeder. The refusal is the correctness property.
          expect(plan.kind, question.questionId).toBe("substrate");
          refusedRows += 1;
          continue;
        }
        expect(plan.kind, question.questionId).toBe("feed");
        if (plan.kind !== "feed") continue;
        feedRows += 1;
        feederTopics.add(question.topicId);
        // The target segments must all be servable from the bank.
        const byLabel = (label: string) => plan.bank.find((tile) => tile.label === label);
        const fed = plan.targetSegments.map(byLabel);
        expect(
          fed.every((tile) => tile !== undefined),
          question.questionId,
        ).toBe(true);
        // Grading by construction, on real data: draft === correct_answer.
        expect(
          draftForPlaced(fed as NonNullable<(typeof fed)[number]>[]),
          question.questionId,
        ).toBe(raw.correct_answer);
      }
      expect(feedRows).toBeGreaterThan(40); // the ELA phoneme tile inventory (49 today)
      expect(refusedRows).toBeGreaterThan(30); // the math digit-tile rows (42 today)
      expect(feederTopics.size).toBeGreaterThan(15); // feeder-guided ELA topics
      feederTopics = new Set();
    });

    it("rows WITHOUT a tile bank are substrate BY DESIGN (whole-word multiple choice)", () => {
      let substrateRows = 0;
      for (const { question, raw } of realPackRows()) {
        if (raw.tile_bank_json !== null) continue;
        substrateRows += 1;
        expect(feederPlanFor(question).kind, question.questionId).toBe("substrate");
      }
      expect(substrateRows).toBeGreaterThan(1000);
    });
  },
);

describe("seed handling: permutation-only across seeds", () => {
  const base: PracticeQuestion = {
    questionId: "q-seeds",
    topicId: "PK-E4-I",
    unitId: "PK-E4",
    topicCode: "I",
    topicName: "Phoneme blending",
    difficultyLevel: 1,
    interactionType: "tile-builder",
    prompt: "Blend the word",
    visualAid: "",
    tileBank: ["f", "a", "n", "z", "m"],
    choices: ["f a n", "n a f", "f u n", "m a p"],
    correctAnswer: "f a n",
    misconceptionTags: [],
    explanation: "",
  };

  it("bubble fields never lose, duplicate, or case-drift a choice across 50 seeds", () => {
    const canonical = base.choices.map((c) => String(c)).sort();
    for (let n = 0; n < 50; n += 1) {
      const field = bubbleFieldFor({ ...base, questionId: `q-${n}` })!;
      expect(field.map((b) => b.label).sort()).toEqual(canonical);
      expect(new Set(field.map((b) => b.key)).size).toBe(field.length);
    }
  });

  it("feeder banks are always permutations of the row's tile bank across 50 seeds", () => {
    const tileBank = ["f", "a", "n", "z", "m"];
    const canonical = [...tileBank].sort();
    for (let n = 0; n < 50; n += 1) {
      const plan = feederPlanFor({ ...base, tileBank, questionId: `q-${n}` });
      expect(plan.kind).toBe("feed");
      if (plan.kind !== "feed") continue;
      expect(plan.bank.map((t) => t.label).sort()).toEqual(canonical);
      expect(new Set(plan.bank.map((t) => t.key)).size).toBe(plan.bank.length);
    }
  });

  it("unicode labels round-trip verbatim (the draft is graded by string equality)", () => {
    const unicode = bubbleFieldFor({
      ...base,
      choices: ["63\u00a2", "5\u00a2 (1 nickel)", "\u00e9", "\u00a75"],
    })!;
    // Default sort is by UTF-16 code units: "5" < "6" < "\u00a7" < "\u00e9".
    expect(unicode.map((b) => b.label).sort()).toEqual([
      "5\u00a2 (1 nickel)",
      "63\u00a2",
      "\u00a75",
      "\u00e9",
    ]);
  });
});

describe("stage-variant + reflex-seam wiring (source pins)", () => {
  const blitzSource = readFileSync(
    fileURLToPath(new URL("../src/games/BubblePopBlitzGame.tsx", import.meta.url)),
    "utf-8",
  );
  const feederSource = readFileSync(
    fileURLToPath(new URL("../src/games/MonsterPhonemeFeederGame.tsx", import.meta.url)),
    "utf-8",
  );
  const screenSource = readFileSync(
    fileURLToPath(new URL("../src/games/GameSessionScreen.tsx", import.meta.url)),
    "utf-8",
  );

  it("the submit path is single-flight: an in-flight guard blocks reflex double-taps", () => {
    // #54 review finding: a second tap in the submit-await window saw
    // the stale question-phase closure and double-submitted the item.
    expect(screenSource).toContain("if (checkingRef.current) return;");
    expect(screenSource).toContain("checkingRef.current = true;");
    // Cleared on EVERY exit path (finally), so a failed submit re-opens.
    expect(screenSource).toContain("checkingRef.current = false;");
    const guardSet = screenSource.indexOf("checkingRef.current = true;");
    const guardClear = screenSource.indexOf("checkingRef.current = false;");
    expect(guardSet).toBeGreaterThan(-1);
    expect(guardClear).toBeGreaterThan(guardSet);
  });

  it("blitz mounts pressure ONLY for fluency with a positive target; guided gets the hint line", () => {
    expect(blitzSource).toContain('gameStage === "fluency" && targetResponseSpeedSec > 0');
    expect(blitzSource).toContain("const guided = gameStage === ");
    expect(blitzSource).toContain("{phase !== null ? <PressureChip");
    expect(blitzSource).toContain("{guided ?");
  });

  it("the screen feeds the renderer the registry target + the reflex submit seam (draftRef ordering)", () => {
    expect(screenSource).toContain(
      "targetResponseSpeedSec={state.route?.targetResponseSpeedSec ?? 0}",
    );
    expect(screenSource).toContain("draftRef.current = draft;");
    // The mirror updates BEFORE the dispatch so the same-tick submit reads it.
    const mirrorAt = screenSource.indexOf("draftRef.current = draft;");
    const dispatchAt = screenSource.indexOf('dispatch({ type: "draft-changed"');
    expect(mirrorAt).toBeGreaterThan(-1);
    expect(dispatchAt).toBeGreaterThan(mirrorAt);
    expect(screenSource).toContain(
      "onSubmitAnswer={() => void handleCheck(draftRef.current ?? undefined)}",
    );
  });

  it("feeder hint chain is guided-only; the audio affordance is unconditional", () => {
    expect(feederSource).toContain("{guided ?");
    expect(feederSource).toContain('testID="feeder-replay"');
    expect(feederSource).not.toContain("targetResponseSpeedSec > 0");
  });
});

describe("reduced-motion + a11y pins (both renderers)", () => {
  const blitzSource = readFileSync(
    fileURLToPath(new URL("../src/games/BubblePopBlitzGame.tsx", import.meta.url)),
    "utf-8",
  );
  const feederSource = readFileSync(
    fileURLToPath(new URL("../src/games/MonsterPhonemeFeederGame.tsx", import.meta.url)),
    "utf-8",
  );

  it("both consume the reduced-motion token and never animate on their own", () => {
    for (const source of [blitzSource, feederSource]) {
      expect(source).toContain("useReducedMotion");
      expect(source).toContain("motion.pressTranslateY");
      expect(source).not.toContain("Animated");
      expect(source).not.toContain("Easing");
    }
  });

  it("every interactive surface is a labeled button at >= the 48pt floor", () => {
    for (const source of [blitzSource, feederSource]) {
      expect(source).toContain('accessibilityRole="button"');
      expect(source).toContain("MIN_TOUCH_TARGET");
      expect(source).not.toMatch(/minHeight:\s*(4|8|12|16|24|32|40)\b/);
    }
  });

  it("the pressure chip never carries state by color alone (text always present)", () => {
    const phases: PressurePhase[] = ["steady", "rising", "urgent"];
    const tiers: PressureTier[] = ["gentle", "sprint"];
    for (const tier of tiers) {
      for (const phase of phases) {
        expect(pressureLabelFor(phase, tier).length).toBeGreaterThan(0);
      }
    }
    expect(blitzSource).toContain("{label}</Text>");
  });

  it("the decorative monster face is hidden from accessibility (the tray carries the labels)", () => {
    expect(feederSource).toContain("accessibilityElementsHidden");
    expect(feederSource).toContain('importantForAccessibility="no-hide-descendants"');
  });
});

describe("#53 advisory follow-through: the stub is retired", () => {
  it("StubArchetypeGame is deleted and unexported (four real renderers are the templates)", () => {
    expect(
      existsSync(fileURLToPath(new URL("../src/games/StubArchetypeGame.tsx", import.meta.url))),
    ).toBe(false);
    const barrel = readFileSync(
      fileURLToPath(new URL("../src/games/index.ts", import.meta.url)),
      "utf-8",
    );
    expect(barrel).not.toContain("export { StubArchetypeGame }");
  });
});
