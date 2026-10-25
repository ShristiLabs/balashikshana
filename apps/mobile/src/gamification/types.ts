/**
 * Gamification contracts (issue #55, roadmap D9) — the OPTIMISTIC local
 * ledger. Types only; all math lives in @balashikshana/core-engine
 * (rewards) and rewardsProjector.ts composes it. The local state is a
 * PROVISIONAL projection of the append-only attempt log through the same
 * engine reward rules the server's ledger materialization runs
 * (services/api/rewards.mjs), confirmed by the #48 snapshot + the ledger
 * endpoint — never a second source of truth.
 */

import type { SessionType } from "../practice/types";

/** The local per-student reward projection row (gamification_state). */
export interface GamificationState {
  studentId: string;
  totalXp: number;
  starCoins: number;
  streakDays: number;
  /** UTC day key ("YYYY-MM-DD") of the last session that touched the streak. */
  lastActiveDayKey: string;
  /** Max beatTargetSharePct over game topic-groups (speed badge input). */
  bestBeatTargetPct: number;
  /** Distinct completed sessions (badge aggregate; server: distinct session ids in attempts). */
  sessionsCompleted: number;
  earnedBadges: string[];
  /** True until the server ledger confirms the values (D8 pattern). */
  provisional: boolean;
  updatedAt: number;
}

/** The badge aggregates both sides derive from their own stores. */
export interface BadgeAggregates {
  sessionsCompleted: number;
  topicsCompleted: number;
  threeCrownTopics: number;
  perfectTopics: number;
  silverKeys: number;
  goldKeys: number;
  bestBeatTargetPct: number;
  starCoins: number;
  streakDays: number;
}

/** One attempt item shaped for the reward rules. */
export interface RewardAttempt {
  isCorrect: boolean;
  fluencyGrade: number;
  rawTimeSec: number;
}

/** The server ledger endpoint's confirmed view (adopted wholesale). */
export interface ServerLedgerBadge {
  id: string;
  title: string;
  description: string | null;
  tier: string | null;
  scope: string;
  awardedAt: string;
}

export interface ServerLedger {
  studentId: string;
  totalXp: number;
  level: {
    level: number;
    maxLevel: number;
    maxed: boolean;
    levelFloorXp: number;
    nextLevelXp: number | null;
    xpIntoLevel: number;
    xpToNextLevel: number | null;
  };
  starCoins: number;
  streakDays: number;
  bestBeatTargetPct: number;
  badges: ServerLedgerBadge[];
  generatedAt: string;
}

/** The kid-facing display summary (level curve via the engine). */
export interface GamificationSummary {
  totalXp: number;
  level: number;
  maxLevel: number;
  maxed: boolean;
  xpIntoLevel: number;
  xpToNextLevel: number | null;
  /** 0-100 progress toward the next level (100 when maxed). */
  levelProgressPct: number;
  starCoins: number;
  streakDays: number;
  provisional: boolean;
  badges: { id: string; title: string; tier: string | null; description: string | null }[];
}

/** What a session completion reports back to its summary surface. */
export interface SessionRewardOutcome {
  xpAwarded: number;
  coinsAwarded: number;
  sessionType: SessionType;
}
