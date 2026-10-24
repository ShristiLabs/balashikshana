/**
 * Two-key sleep-consolidation state machine tests (issue #47).
 *
 * Registry contract: Day-1 pass -> SILVER_KEY; Gold eligible only
 * >= 14 h after the Silver award; 5-item verification with >= 4
 * correct upgrades to GOLD_KEY; transitions are forward-only.
 */
import { describe, expect, it } from "vitest";
import {
  MS_PER_HOUR,
  TWO_KEY_RULES,
  goldEligibleAtMs,
  goldVerificationPassed,
  isGoldEligible,
  nextKeyAfterGatePass,
} from "../src/practice/goldKey";

const SILVER_AT = 1_700_000_000_000;

describe("TWO_KEY_RULES pinned to the registry", () => {
  it("matches globalMasteryRules.twoKeySleepConsolidationGate", () => {
    expect(TWO_KEY_RULES.day1PassAward).toBe("SILVER_KEY");
    expect(TWO_KEY_RULES.minSleepConsolidationHours).toBe(14);
    expect(TWO_KEY_RULES.day2GoldKeyVerificationItems).toBe(5);
    expect(TWO_KEY_RULES.day2MinPassCount).toBe(4);
  });
});

describe("14-hour window boundaries", () => {
  it("is not eligible before 14 hours have elapsed", () => {
    expect(isGoldEligible(SILVER_AT, SILVER_AT + 14 * MS_PER_HOUR - 1)).toBe(false);
  });

  it("is eligible exactly at the 14-hour boundary", () => {
    expect(isGoldEligible(SILVER_AT, SILVER_AT + 14 * MS_PER_HOUR)).toBe(true);
  });

  it("is eligible well after the window", () => {
    expect(isGoldEligible(SILVER_AT, SILVER_AT + 30 * MS_PER_HOUR)).toBe(true);
  });

  it("never reports eligibility without a Silver award", () => {
    expect(isGoldEligible(0, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it("goldEligibleAtMs is exactly silver + 14 h", () => {
    expect(goldEligibleAtMs(SILVER_AT)).toBe(SILVER_AT + 14 * MS_PER_HOUR);
  });
});

describe("verification thresholds", () => {
  it("4 of 5 passes, 3 of 5 fails", () => {
    expect(goldVerificationPassed(4)).toBe(true);
    expect(goldVerificationPassed(5)).toBe(true);
    expect(goldVerificationPassed(3)).toBe(false);
    expect(goldVerificationPassed(0)).toBe(false);
  });
});

describe("forward-only key transitions on a gate pass", () => {
  it("first pass awards Silver", () => {
    expect(nextKeyAfterGatePass(null)).toBe("SILVER_KEY");
  });

  it("a Silver holder passing again stays Silver locally (Gold only via verification)", () => {
    // DELIBERATE DIVERGENCE from today's server (second pass -> GOLD);
    // documented in goldKey.ts and reconciled in #48.
    expect(nextKeyAfterGatePass("SILVER_KEY")).toBe("SILVER_KEY");
  });

  it("Gold is sticky", () => {
    expect(nextKeyAfterGatePass("GOLD_KEY")).toBe("GOLD_KEY");
  });
});
