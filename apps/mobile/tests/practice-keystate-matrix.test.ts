/**
 * Exhaustive key-state transition matrix (issue #47, tester pass):
 * {prev: none|SILVER|GOLD} x {gate: pass|fail} x {window: before|at|after}
 * x {verification: 0..5 correct}.
 *
 * Invariants asserted everywhere:
 * - FORWARD-ONLY: a held key is never revoked by any local event.
 * - The 14-hour window is measured from the FIRST Silver award; a gate
 *   re-pass never resets it.
 * - goldVerifiedAt, once set, is sticky.
 * - provisional is 1 after every local write path.
 * - Gold upgrades ONLY via (SILVER, window elapsed, >= 4 of 5).
 */
import { describe, expect, it } from "vitest";
import { MS_PER_HOUR, goldEligibleAtMs, isGoldEligible } from "../src/practice/goldKey";
import {
  deriveGateSession,
  deriveGoldVerification,
  mergeUnitProgress,
} from "../src/practice/progressProjector";
import type { KeyState, UnitProgressRecord } from "../src/practice/types";

const NOW = 1_700_000_000_000;
const SR = { gradeGrowthFactor: 1.85, maxIntervalCapDays: 30 };

const PASS_VERDICT = { passed: true, overallAccuracyPct: 95, medianCogSpeedSec: 2.5 };
const FAIL_VERDICT = { passed: false, overallAccuracyPct: 40, medianCogSpeedSec: 5.5 };

function prevRow(key: KeyState | null, silverAgeHours: number): UnitProgressRecord {
  return {
    studentId: "s1",
    unitId: "K-M2",
    status: key ? "MASTERED" : "REMEDIATION_REQUIRED",
    keyState: key,
    bestAccuracyPct: 88,
    bestMedianSpeedSec: 3.2,
    attemptsCount: 1,
    stabilityDays: 4,
    lastReviewedAt: NOW - silverAgeHours * MS_PER_HOUR,
    cpaStage: "PICTORIAL_STATIC",
    provisional: true,
    silverAwardedAt: key ? NOW - silverAgeHours * MS_PER_HOUR : 0,
    goldVerifiedAt: key === "GOLD_KEY" ? NOW - MS_PER_HOUR : 0,
    updatedAt: NOW - silverAgeHours * MS_PER_HOUR,
  };
}

function afterGate(
  key: KeyState | null,
  silverAgeHours: number,
  passed: boolean,
): UnitProgressRecord {
  const derivation = deriveGateSession({
    studentId: "s1",
    unitId: "K-M2",
    verdict: passed ? PASS_VERDICT : FAIL_VERDICT,
    targetSpeedSec: 6,
    srPolicy: SR,
    prev: prevRow(key, silverAgeHours),
    nowMs: NOW,
  });
  return mergeUnitProgress(prevRow(key, silverAgeHours), derivation.fresh);
}

describe("gate transitions: {none, SILVER, GOLD} x {pass, fail}", () => {
  const cases: [KeyState | null, boolean, KeyState | null][] = [
    [null, true, "SILVER_KEY"], // day-1 pass awards Silver
    [null, false, null], // fail keeps no key
    ["SILVER_KEY", true, "SILVER_KEY"], // DIVERGENCE: re-pass stays Silver locally
    ["SILVER_KEY", false, "SILVER_KEY"], // fail never revokes Silver
    ["GOLD_KEY", true, "GOLD_KEY"], // Gold sticky
    ["GOLD_KEY", false, "GOLD_KEY"], // fail never revokes Gold
  ];

  for (const [prev, passed, expected] of cases) {
    it(`prev=${String(prev)} gate ${passed ? "pass" : "fail"} -> ${String(expected)}`, () => {
      const row = afterGate(prev, 24, passed);
      expect(row.keyState).toBe(expected);
      expect(row.provisional).toBe(true);
    });
  }

  it("window start is frozen at the FIRST Silver award (re-pass does not reset)", () => {
    const first = afterGate(null, 0, true); // Silver awarded at NOW
    expect(first.silverAwardedAt).toBe(NOW);
    // Advance 10 h, re-pass: silver_awarded_at must stay at the original.
    const later = afterGate("SILVER_KEY", 10, true);
    expect(later.silverAwardedAt).toBe(NOW - 10 * MS_PER_HOUR);
    // A fail 20 h in also leaves the original award time intact.
    const failedLater = afterGate("SILVER_KEY", 20, false);
    expect(failedLater.silverAwardedAt).toBe(NOW - 20 * MS_PER_HOUR);
  });

  it("goldVerifiedAt is sticky through gate re-evaluations", () => {
    const row = afterGate("GOLD_KEY", 48, false);
    expect(row.goldVerifiedAt).toBe(NOW - MS_PER_HOUR);
  });
});

describe("verification transitions: SILVER x {before, at, after} x {0..5}", () => {
  const windows = [
    { label: "before (13h)", silverAgeHours: 13 },
    { label: "at boundary (14h)", silverAgeHours: 14 },
    { label: "after (30h)", silverAgeHours: 30 },
  ] as const;

  for (const w of windows) {
    for (let correct = 0; correct <= 5; correct += 1) {
      const shouldUpgrade = w.silverAgeHours >= 14 && correct >= 4;
      it(`SILVER, window ${w.label}, ${correct}/5 -> ${shouldUpgrade ? "GOLD" : "stay SILVER"}`, () => {
        const prev = prevRow("SILVER_KEY", w.silverAgeHours);
        expect(isGoldEligible(prev.silverAwardedAt, NOW)).toBe(w.silverAgeHours >= 14);
        const result = deriveGoldVerification({
          studentId: "s1",
          unitId: "K-M2",
          correctCount: correct,
          prev,
          nowMs: NOW,
        });
        expect(result.upgraded).toBe(shouldUpgrade);
        if (shouldUpgrade && result.record) {
          expect(result.record.keyState).toBe("GOLD_KEY");
          expect(result.record.goldVerifiedAt).toBe(NOW);
          expect(result.record.provisional).toBe(true);
        }
      });
    }
  }

  it("verification without Silver (none or GOLD) never produces a row", () => {
    for (const key of [null, "GOLD_KEY"] as (KeyState | null)[]) {
      const result = deriveGoldVerification({
        studentId: "s1",
        unitId: "K-M2",
        correctCount: 5,
        prev: prevRow(key, 48),
        nowMs: NOW,
      });
      expect(result.upgraded).toBe(false);
      expect(result.record).toBeNull();
    }
  });

  it("a failed verification can be retried and the window never re-arms", () => {
    const prev = prevRow("SILVER_KEY", 24);
    const fail = deriveGoldVerification({
      studentId: "s1",
      unitId: "K-M2",
      correctCount: 3,
      prev,
      nowMs: NOW,
    });
    expect(fail.upgraded).toBe(false);
    const retry = deriveGoldVerification({
      studentId: "s1",
      unitId: "K-M2",
      correctCount: 4,
      prev,
      nowMs: NOW + MS_PER_HOUR,
    });
    expect(retry.upgraded).toBe(true);
    expect(retry.record?.silverAwardedAt).toBe(prev.silverAwardedAt);
  });

  it("goldEligibleAtMs is exactly silver + 14h for every input", () => {
    for (const silver of [0, 1, NOW, Number.MAX_SAFE_INTEGER - 1]) {
      expect(goldEligibleAtMs(silver)).toBe(silver + 14 * MS_PER_HOUR);
    }
  });
});

describe("provisional flag on every local write path", () => {
  it("gate pass, gate fail, and gold upgrade all leave provisional = 1", () => {
    expect(afterGate(null, 24, true).provisional).toBe(true);
    expect(afterGate(null, 24, false).provisional).toBe(true);
    const upgraded = deriveGoldVerification({
      studentId: "s1",
      unitId: "K-M2",
      correctCount: 5,
      prev: prevRow("SILVER_KEY", 48),
      nowMs: NOW,
    });
    expect(upgraded.record?.provisional).toBe(true);
  });
});
