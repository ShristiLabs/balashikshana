/**
 * Streak surfacing hook (issue #57) — the focused seam for surfaces
 * that want ONLY the day streak (the #49 journey and future home
 * surfaces). Wraps useGamificationSummary: the value is the engine's
 * streakDays from the optimistic local ledger (updated on every
 * session completion by the projector) and confirmed by the server
 * ledger on the same mount — identical offline and online by
 * construction (D9: both sides run the same nextStreakState rule).
 *
 * Display doctrine (GamificationHeaderStrip): the number is shown
 * text-with-label ("N day streak"), never by color alone, and nothing
 * here can gate or reset anything — the streak is motivational state,
 * not a lock.
 */
import { useGamificationSummary } from "./useGamificationSummary";
import type { GamificationSummary } from "./types";

/** The streak-only view of the gamification summary. */
export interface StreakView {
  streakDays: number;
  /** True until the server ledger confirms (D8 pattern). */
  provisional: boolean;
}

function toStreakView(summary: GamificationSummary | null): StreakView | null {
  return summary ? { streakDays: summary.streakDays, provisional: summary.provisional } : null;
}

export function useStreak(studentId: string | null): StreakView | null {
  return toStreakView(useGamificationSummary(studentId));
}
