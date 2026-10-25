/**
 * Gamification store (issue #55) — the PURE state machine between the
 * projector/storage and the kid-facing surfaces. No React Native imports
 * (the vitest suite drives every transition directly); the screens mount
 * it via the loader + reducer below.
 */

import { adoptServerLedger, gamificationSummary } from "./rewardsProjector";
import type { GamificationState, GamificationSummary, ServerLedger } from "./types";

export type GamificationStatus = "empty" | "ready";

export interface GamificationStoreState {
  status: GamificationStatus;
  studentId: string | null;
  state: GamificationState | null;
  summary: GamificationSummary | null;
  /** Bumped whenever a fresh projection lands — the view's memo key. */
  version: number;
}

export type GamificationAction =
  | { type: "state-loaded"; state: GamificationState }
  | { type: "ledger-adopted"; ledger: ServerLedger; nowMs: number }
  | { type: "reset" };

export function initialGamificationStoreState(): GamificationStoreState {
  return { status: "empty", studentId: null, state: null, summary: null, version: 0 };
}

export function gamificationReducer(
  state: GamificationStoreState,
  action: GamificationAction,
): GamificationStoreState {
  switch (action.type) {
    case "state-loaded": {
      const next = action.state;
      return {
        status: "ready",
        studentId: next.studentId,
        state: next,
        summary: gamificationSummary(next),
        version: state.version + 1,
      };
    }
    case "ledger-adopted": {
      if (!state.state || state.state.studentId !== action.ledger.studentId) return state;
      const next = adoptServerLedger(state.state, action.ledger, action.nowMs);
      return {
        status: "ready",
        studentId: next.studentId,
        state: next,
        summary: gamificationSummary(next),
        version: state.version + 1,
      };
    }
    case "reset":
      return initialGamificationStoreState();
    default:
      return state;
  }
}
