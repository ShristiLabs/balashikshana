/**
 * Gold-window countdown helpers (issue #51) — PURE. The 14-hour window
 * math itself lives in goldKey.ts (goldEligibleAtMs/isGoldEligible,
 * pinned to the registry and mirrored server-side); this module only
 * formats and slices time for the gate screen's countdown display,
 * with exact-boundary behavior (at / 1 ms before / 1 ms after) covered
 * by tests.
 */

/** "13 h 59 m" style label; negatives clamp to 0. */
export function formatGoldCountdown(remainingMs: number): string {
  const totalMin = Math.max(0, Math.ceil(remainingMs / 60_000));
  const hours = Math.floor(totalMin / 60);
  const minutes = totalMin % 60;
  if (hours <= 0 && minutes <= 0) return "0 m";
  if (hours <= 0) return `${minutes} m`;
  if (minutes <= 0) return `${hours} h`;
  return `${hours} h ${minutes} m`;
}

export interface GoldWindowState {
  /** True only at/after the exact eligibility instant. */
  eligible: boolean;
  /** Positive before the window opens; exactly 0 (never negative) after. */
  remainingMs: number;
  /** Coarse label for accessibility strings ("tomorrow" / "today"). */
  coarseLabel: string;
}

export function goldWindow(
  silverAwardedAt: number,
  nowMs: number,
  eligibleAtMs: number,
): GoldWindowState {
  const remainingMs = Math.max(0, eligibleAtMs - nowMs);
  const eligible = nowMs >= eligibleAtMs;
  const hoursRemaining = remainingMs / 3_600_000;
  return {
    eligible,
    remainingMs,
    coarseLabel: eligible
      ? "Gold check ready"
      : hoursRemaining > 12
        ? "Gold check unlocks tomorrow"
        : "Gold check unlocks today",
  };
}
