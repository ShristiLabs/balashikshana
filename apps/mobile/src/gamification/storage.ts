/**
 * Gamification storage seam (issue #55) — the lifecycle-database row for
 * the optimistic local ledger (gamification_state, schema v5). DI
 * doctrine: this interface is pure TypeScript; nativePractice.ts
 * (expo-sqlite) and the node test adapter (tests/helpers/practiceEnv.ts)
 * implement it speaking the exact same SQL.
 */

import type { GamificationState } from "./types";
import type { SessionType } from "../practice/types";

export interface GamificationStorage {
  /** The student's local reward row, or null when none was written yet. */
  getGamificationState(studentId: string): Promise<GamificationState | null>;
  /** Persist the projector-computed full row (single-writer model). */
  upsertGamificationState(state: GamificationState): Promise<void>;
  /**
   * Units the child's OWN attempt log carries rows of the given session
   * type for (the earned-key badge rule — placement-seed keys never
   * count). Empty array when none exist.
   */
  playedUnitIds(studentId: string, sessionType: SessionType): Promise<string[]>;
}
