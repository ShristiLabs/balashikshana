/**
 * TTS rate calibration invariants (issue #45 acceptance: "TTS rate math
 * is a pure, unit-tested module: registry WPM -> platform rate, always
 * clamped 110-150").
 *
 * The per-grade defaults are cross-checked against the canonical registry
 * (docs/us-curriculum-registry.json) read straight from disk, so the
 * calibration table can never drift from its source of truth.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  clampWpm,
  countWords,
  estimateSpeechDurationSec,
  GRADE_DEFAULT_WPM,
  MAX_WPM,
  MIN_WPM,
  REFERENCE_WPM,
  resolveWpm,
  wpmToRate,
} from "../src/audio/rateMath";
import type { GradeId } from "../src/onboarding/types";

const REPO_ROOT = resolve(__dirname, "../../..");
const REGISTRY_PATH = resolve(REPO_ROOT, "docs/us-curriculum-registry.json");

interface RegistryVoiceNarration {
  speakingRateWpm?: number;
}

function registryWpmByGrade(): Map<string, Set<number>> {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as unknown;
  const byGrade = new Map<string, Set<number>>();
  const visit = (node: unknown, grade: string | null) => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, grade);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const record = node as Record<string, unknown>;
    let currentGrade = grade;
    if (typeof record.gradeId === "string") {
      currentGrade = record.gradeId;
      if (!byGrade.has(currentGrade)) byGrade.set(currentGrade, new Set());
    }
    if (currentGrade && record.voiceNarration) {
      const narration = record.voiceNarration as RegistryVoiceNarration;
      if (typeof narration.speakingRateWpm === "number") {
        byGrade.get(currentGrade)?.add(narration.speakingRateWpm);
      }
    }
    for (const value of Object.values(record)) visit(value, currentGrade);
  };
  visit(registry, null);
  return byGrade;
}

describe("clampWpm", () => {
  it("clamps below the floor to 110", () => {
    expect(clampWpm(60)).toBe(110);
    expect(clampWpm(109.4)).toBe(110);
  });

  it("clamps above the ceiling to 150", () => {
    expect(clampWpm(220)).toBe(150);
    expect(clampWpm(150.6)).toBe(150);
  });

  it("rounds and keeps in-range values", () => {
    expect(clampWpm(132.4)).toBe(132);
    expect(clampWpm(110)).toBe(110);
    expect(clampWpm(150)).toBe(150);
  });

  it("degrades non-finite input to the slowest calibration", () => {
    expect(clampWpm(Number.NaN)).toBe(110);
    expect(clampWpm(Number.POSITIVE_INFINITY)).toBe(110);
  });
});

describe("resolveWpm", () => {
  it("prefers an explicit wpm over the grade default", () => {
    expect(resolveWpm({ grade: "grade-3", wpm: 118 })).toBe(118);
  });

  it("uses the grade default when no explicit wpm exists", () => {
    expect(resolveWpm({ grade: "pre-k" })).toBe(110);
    expect(resolveWpm({ grade: "kindergarten" })).toBe(120);
    expect(resolveWpm({ grade: "grade-1" })).toBe(130);
    expect(resolveWpm({ grade: "grade-2" })).toBe(140);
    expect(resolveWpm({ grade: "grade-3" })).toBe(150);
  });

  it("falls back to the slowest calibration without grade or wpm", () => {
    expect(resolveWpm({})).toBe(110);
  });

  it("always clamps whatever it resolves", () => {
    expect(resolveWpm({ grade: "pre-k", wpm: 999 })).toBe(150);
    expect(resolveWpm({ grade: "grade-3", wpm: 10 })).toBe(110);
  });
});

describe("wpmToRate", () => {
  it("maps clamped WPM onto the platform multiplier", () => {
    expect(wpmToRate(110)).toBeCloseTo(110 / REFERENCE_WPM, 3);
    expect(wpmToRate(150)).toBeCloseTo(150 / REFERENCE_WPM, 3);
  });

  it("clamps out-of-range WPM before converting", () => {
    expect(wpmToRate(400)).toBeCloseTo(150 / REFERENCE_WPM, 3);
    expect(wpmToRate(1)).toBeCloseTo(110 / REFERENCE_WPM, 3);
  });

  it("keeps the multiplier inside the safe platform range", () => {
    expect(wpmToRate(110)).toBeGreaterThanOrEqual(0.5);
    expect(wpmToRate(150)).toBeLessThanOrEqual(2);
  });
});

describe("speech duration estimate", () => {
  it("computes words over WPM plus break pauses", () => {
    // 10 words at 120 WPM = 5s, plus 1.2s of SSML breaks
    expect(
      estimateSpeechDurationSec("one two three four five six seven eight nine ten", 120, 1200),
    ).toBe(6.2);
  });

  it("has a small floor for very short lines", () => {
    expect(estimateSpeechDurationSec("Hi", 150)).toBeGreaterThanOrEqual(0.3);
  });

  it("returns the floor for empty text without pauses", () => {
    expect(estimateSpeechDurationSec("", 130, 0)).toBe(0.3);
  });

  it("counts words robustly", () => {
    expect(countWords("  hello   world  ")).toBe(2);
    expect(countWords("")).toBe(0);
  });
});

describe("grade calibration table vs registry", () => {
  const byGrade = registryWpmByGrade();

  it("covers all five grades", () => {
    expect([...byGrade.keys()].sort()).toEqual(
      ["grade-1", "grade-2", "grade-3", "kindergarten", "pre-k"].sort(),
    );
  });

  it("every registry topic's speakingRateWpm equals the grade default (uniform)", () => {
    for (const [grade, values] of byGrade) {
      const expected = GRADE_DEFAULT_WPM[grade as GradeId];
      expect(expected, `unknown grade id ${grade}`).toBeDefined();
      expect(values, `grade ${grade}`).toEqual(new Set([expected]));
    }
  });

  it("keeps every grade default inside the mandated 110-150 band", () => {
    for (const wpm of Object.values(GRADE_DEFAULT_WPM)) {
      expect(wpm).toBeGreaterThanOrEqual(MIN_WPM);
      expect(wpm).toBeLessThanOrEqual(MAX_WPM);
    }
  });

  it("sees 614 topics across the registry", () => {
    const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf8")) as { grades: unknown };
    let topics = 0;
    const visit = (node: unknown) => {
      if (Array.isArray(node)) {
        for (const child of node) visit(child);
        return;
      }
      if (node === null || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (record.voiceNarration) topics += 1;
      for (const value of Object.values(record)) visit(value);
    };
    visit(registry);
    expect(topics).toBe(614);
  });
});
