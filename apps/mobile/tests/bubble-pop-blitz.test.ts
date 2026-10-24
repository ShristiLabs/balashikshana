/**
 * Bubble Pop Blitz pure-module tests (issue #54, pack B): field
 * determinism and seed handling, the D6-tiered pressure phases, the
 * input-vs-visual drift bound, and the exact-label draft contract.
 * All fixtures are synthetic rows in the engine's question shape - no
 * registry data is copied here.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PracticeQuestion } from "../src/practice/types";
import {
  bubbleFieldFor,
  BUBBLE_SHAPES,
  guidedHintForField,
  MAX_FIELD_BUBBLES,
  phaseRank,
  pressureDriftBoundSec,
  pressureLabelFor,
  pressurePhaseFor,
  pressureTierForTopicId,
  PRESSURE_TICK_MS,
} from "../src/games/bubblePopBlitz";

function row(overrides: Partial<PracticeQuestion>): PracticeQuestion {
  return {
    questionId: "q-blitz",
    topicId: "G2-M2-F",
    unitId: "G2-M2",
    topicCode: "F",
    topicName: "Test topic",
    difficultyLevel: 1,
    interactionType: "multiple-choice",
    prompt: "Add fast",
    visualAid: "",
    choices: ["6", "7", "5", "8"],
    correctAnswer: "7",
    misconceptionTags: [],
    explanation: "",
    ...overrides,
  };
}

describe("bubbleFieldFor (spawn determinism + seed handling)", () => {
  it("mounts exactly one bubble per choice, labels VERBATIM (draft === choice label)", () => {
    const field = bubbleFieldFor(row({}));
    expect(field).not.toBeNull();
    expect(field!.map((b) => b.label).sort()).toEqual(["5", "6", "7", "8"]);
    // Every label is the EXACT choice string - the tap publishes it
    // and the framework's string comparison grades it.
    for (const bubble of field!) {
      expect(["5", "6", "7", "8"]).toContain(bubble.label);
    }
  });

  it("same question id -> identical field, every time (deterministic replay)", () => {
    const a = bubbleFieldFor(row({}));
    const b = bubbleFieldFor(row({}));
    expect(a).toEqual(b);
  });

  it("different question ids -> shuffled fields can differ (the seed is the item)", () => {
    let differs = false;
    for (let n = 0; n < 20 && !differs; n += 1) {
      const a = bubbleFieldFor(row({ questionId: `q-${n}` }));
      const b = bubbleFieldFor(row({ questionId: `q-${n}-x` }));
      differs = a!.some((bubble, i) => bubble.label !== b![i]!.label);
    }
    expect(differs).toBe(true);
  });

  it("slots are 0..n-1, shapes rotate from the token set, tints follow", () => {
    const field = bubbleFieldFor(row({}));
    expect(field!.map((b) => b.slot)).toEqual([0, 1, 2, 3]);
    for (const bubble of field!) {
      expect(BUBBLE_SHAPES).toContain(bubble.shape);
      expect(bubble.tintIndex).toBe(bubble.slot % BUBBLE_SHAPES.length);
    }
  });

  it("refuses degenerate fields: <2 choices, >MAX choices, blank labels -> substrate", () => {
    expect(bubbleFieldFor(row({ choices: ["7"] }))).toBeNull();
    expect(
      bubbleFieldFor(
        row({
          choices: Array.from({ length: MAX_FIELD_BUBBLES + 1 }, (_, i) => String(i)),
        }),
      ),
    ).toBeNull();
    expect(bubbleFieldFor(row({ choices: ["7", "  ", "5", "8"] }))).toBeNull();
  });
});

describe("pressureTierForTopicId (D6 age tiering)", () => {
  it("sprint tier ONLY for G2/G3 fluency-sprint grades", () => {
    expect(pressureTierForTopicId("G2-M2-F")).toBe("sprint");
    expect(pressureTierForTopicId("G3-M3-B")).toBe("sprint");
  });

  it("gentle tier for Pre-K/K/G1 - and anything unrecognized (safe default)", () => {
    expect(pressureTierForTopicId("PK-M1-A")).toBe("gentle");
    expect(pressureTierForTopicId("K-E5-C")).toBe("gentle");
    expect(pressureTierForTopicId("G1-E1-D")).toBe("gentle");
    expect(pressureTierForTopicId("later-unit-9")).toBe("gentle");
    expect(pressureTierForTopicId("")).toBe("gentle");
  });
});

describe("pressurePhaseFor (quantized pacing, kid-safe by construction)", () => {
  const target = 6;

  it("phase boundaries quantize at 50% / 80% of the target", () => {
    // target 10 keeps the boundaries exactly representable (5 / 8).
    expect(pressurePhaseFor(0, 10, "sprint")).toBe("steady");
    expect(pressurePhaseFor(4.9, 10, "sprint")).toBe("steady");
    expect(pressurePhaseFor(5, 10, "sprint")).toBe("rising");
    expect(pressurePhaseFor(7.9, 10, "sprint")).toBe("rising");
    expect(pressurePhaseFor(8, 10, "sprint")).toBe("urgent");
    // The registry-shaped target still quantizes sanely.
    expect(pressurePhaseFor(0, target, "sprint")).toBe("steady");
    expect(pressurePhaseFor(target, target, "sprint")).toBe("urgent");
  });

  it("elapsed CLAMPS at the target - nothing escalates past 100%", () => {
    expect(pressurePhaseFor(target, target, "sprint")).toBe("urgent");
    expect(pressurePhaseFor(target * 10, target, "sprint")).toBe("urgent");
  });

  it("the gentle tier can NEVER present urgent (D6: young grades)", () => {
    expect(pressurePhaseFor(target, target, "gentle")).toBe("rising");
    expect(pressurePhaseFor(target * 50, target, "gentle")).toBe("rising");
    // Gentle copy stays encouraging end-to-end.
    expect(pressureLabelFor("urgent", "gentle")).toBe("Keep going");
  });

  it("untimed targets yield null (guided stage / targetResponseSpeedSec 0)", () => {
    expect(pressurePhaseFor(1, 0, "sprint")).toBeNull();
    expect(pressurePhaseFor(1, -3, "sprint")).toBeNull();
    expect(pressurePhaseFor(1, Number.NaN, "sprint")).toBeNull();
    expect(pressurePhaseFor(-1, target, "sprint")).toBeNull();
  });

  it("phase is monotone in elapsed time within a tier (never reorders)", () => {
    let last = -1;
    for (let t = 0; t <= target; t += target / 60) {
      const phase = pressurePhaseFor(t, target, "sprint");
      expect(phase).not.toBeNull();
      const rank = phaseRank(phase!);
      expect(rank).toBeGreaterThanOrEqual(last);
      last = rank;
    }
  });
});

describe("input-vs-visual drift bound (AC: bounded and test-covered)", () => {
  it("the bound is the pressure tick, capped by the smallest phase bucket", () => {
    // Registry target range 3.0-14.0s: bound = min(0.25s, 20% of target).
    expect(pressureDriftBoundSec(14)).toBe(0.25);
    expect(pressureDriftBoundSec(6)).toBe(0.25);
    expect(pressureDriftBoundSec(3)).toBe(0.25);
    expect(pressureDriftBoundSec(1)).toBeCloseTo(0.2, 10);
    expect(pressureDriftBoundSec(0)).toBeNull();
  });

  it("NO phase bucket can be skipped between ticks at ANY registry target", () => {
    for (const targetSec of [3, 3.5, 5.5, 8, 14]) {
      const bound = pressureDriftBoundSec(targetSec)!;
      expect(bound).toBeGreaterThan(0);
      // Walk elapsed in bound-sized steps: consecutive samples can
      // advance at most one phase rank (nothing is jumped over).
      let last = -1;
      for (let t = 0; t <= targetSec + bound; t += bound / 2) {
        const phase = pressurePhaseFor(t, targetSec, "sprint");
        if (phase === null) continue;
        const rank = phaseRank(phase);
        expect(rank - last).toBeLessThanOrEqual(1);
        last = rank;
      }
      // The smallest bucket (urgent, 20% of target) must outlive the
      // tick so the visual can never skip straight into/past it.
      expect(targetSec * 0.2).toBeGreaterThanOrEqual(bound);
    }
  });

  it("the tick stays well under the smallest registry bucket", () => {
    // 3.0s is the fastest registry target -> 0.6s bucket vs 0.25s tick.
    expect(PRESSURE_TICK_MS).toBe(250);
    expect(3.0 * 0.2).toBeGreaterThan(PRESSURE_TICK_MS / 1000);
  });
});

describe("guided variant hooks (surface parity)", () => {
  it("the guided hint is a single deterministic invite (reflex has no build state)", () => {
    expect(guidedHintForField()).toBe(guidedHintForField());
    expect(guidedHintForField()).toContain("Take your time");
  });
});

describe("source pins (no RN harness - the renderer rides the seams)", () => {
  const rendererSource = readFileSync(
    fileURLToPath(new URL("../src/games/BubblePopBlitzGame.tsx", import.meta.url)),
    "utf-8",
  );

  it("the tap publishes the exact label THEN calls the reflex submit seam", () => {
    expect(rendererSource).toContain("onDraftChange(bubble.label);");
    expect(rendererSource).toContain("onSubmitAnswer?.();");
    expect(rendererSource).toContain("if (disabled) return;");
  });

  it("no clock escapes the component: the tick lives inside the effect, cleared on unmount/feedback", () => {
    expect(rendererSource).toContain(
      "setInterval(() => setElapsedMs(Date.now() - startedAt), PRESSURE_TICK_MS)",
    );
    expect(rendererSource).toContain("return () => clearInterval(id);");
    expect(rendererSource).not.toContain("setTimeout");
    expect(rendererSource).not.toContain("new Date");
    expect(rendererSource).not.toContain("Animated");
  });

  it("updater purity: no onDraftChange inside a setState updater (#53 pattern)", () => {
    expect(rendererSource).not.toMatch(/setState\(\s*\(\s*\)?\s*=>[^)]*onDraftChange/);
  });
});
