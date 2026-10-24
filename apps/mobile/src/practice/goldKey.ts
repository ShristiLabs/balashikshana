/**
 * Two-key sleep-consolidation state machine (issue #47).
 *
 * Registry contract (docs/us-curriculum-registry.json,
 * globalMasteryRules.twoKeySleepConsolidationGate — the pack artifact
 * carries per-grade SR policy but not these GLOBAL rules, so they are
 * pinned here with the registry as the cited source):
 *   day1PassAward:               SILVER_KEY
 *   minSleepConsolidationHours:  14
 *   day2GoldKeyVerificationItems: 5
 *   day2MinPassCount:            4
 *
 * Day-1 gate pass -> Silver (provisional). Gold becomes eligible only
 * >= 14 h after the Silver award and requires a 5-item verification
 * session with >= 4 correct. Transitions are FORWARD-ONLY: Silver ->
 * Gold; a key, once held, is never revoked by any local event (rollback
 * is a #48 server-authoritative concern).
 *
 * DIVERGENCE RESOLVED (#48): the server's /api/gate/evaluate and the
 * sync reconciler now run this exact machine (ported to
 * services/api/derivations.mjs) — a Silver holder who passes the gate
 * again stays Silver on BOTH sides; Gold always goes through the
 * window + verification. Local and server agree on synced streams.
 */
import type { KeyState, UnitProgressRecord } from "./types";

export const TWO_KEY_RULES = {
  day1PassAward: "SILVER_KEY" as const,
  minSleepConsolidationHours: 14,
  day2GoldKeyVerificationItems: 5,
  day2MinPassCount: 4,
} as const;

export const MS_PER_HOUR = 3_600_000;

/** Earliest epoch-ms at which the Gold verification may run. */
export function goldEligibleAtMs(silverAwardedAt: number): number {
  return silverAwardedAt + TWO_KEY_RULES.minSleepConsolidationHours * MS_PER_HOUR;
}

export function isGoldEligible(silverAwardedAt: number, nowMs: number): boolean {
  return silverAwardedAt > 0 && nowMs >= goldEligibleAtMs(silverAwardedAt);
}

/**
 * Key transition for a completed GATE session. Mirrors the server's
 * `nextKeyState = passed ? (prev SILVER|GOLD ? GOLD : SILVER) : keep`
 * EXCEPT that a Silver holder who passes again stays Silver — the
 * registry route to Gold is the 14 h + verification session only.
 * Null never overwrites an existing key (server COALESCE semantics).
 */
export function nextKeyAfterGatePass(prev: KeyState | null): KeyState | null {
  if (prev === "GOLD_KEY") return "GOLD_KEY";
  return "SILVER_KEY";
}

/**
 * Verdict of a Gold verification session: >= day2MinPassCount correct
 * of day2GoldKeyVerificationItems items upgrades Silver -> Gold.
 */
export function goldVerificationPassed(correctCount: number): boolean {
  return correctCount >= TWO_KEY_RULES.day2MinPassCount;
}

/**
 * The Silver award timestamp policy: the FIRST Silver award freezes the
 * 14-hour window start; re-passing the gate while Silver does not reset
 * the clock (consolidation time is measured from the first success).
 */
export function nextSilverAwardedAt(
  prevRecord: UnitProgressRecord | null,
  passed: boolean,
  nowMs: number,
): number {
  if (!passed) return prevRecord?.silverAwardedAt ?? 0;
  return prevRecord?.silverAwardedAt && prevRecord.silverAwardedAt > 0
    ? prevRecord.silverAwardedAt
    : nowMs;
}

/** Forward-only: an existing Gold (with a verified timestamp) is never un-verified locally. */
export function nextGoldVerifiedAt(
  prevRecord: UnitProgressRecord | null,
  verificationPassed: boolean,
  nowMs: number,
): number {
  if (prevRecord?.goldVerifiedAt && prevRecord.goldVerifiedAt > 0) return prevRecord.goldVerifiedAt;
  return verificationPassed ? nowMs : 0;
}
