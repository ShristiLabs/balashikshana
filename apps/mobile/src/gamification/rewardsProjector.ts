/**
 * Rewards projector (issue #55, roadmap D9) — the OPTIMISTIC local
 * ledger's pure transition functions. PURE TypeScript: no React Native,
 * no I/O, no clocks (time arrives as a parameter). Every amount comes
 * from @balashikshana/core-engine's reward rules — the SAME functions
 * services/api/rewards.mjs runs when the server materializes the
 * authoritative ledger — so an identical attempt stream yields identical
 * local and server state by construction (the tests prove it against the
 * API suite's fixtures).
 *
 * Gating semantics (mirrors the server exactly):
 * - per-attempt XP for every attempt of a locally-completed session (a
 *   local session is always a fresh session: first arrival);
 * - outcome XP + coins when the session/group passes (each passed
 *   session earns its outcome exactly once — the server's dedupe key is
 *   the session identity);
 * - streak transitions are idempotent per UTC day (engine rule);
 * - badges re-evaluate over the aggregates after every transition and
 *   only ever ADD ids (forward-only, like the server's ON CONFLICT).
 */

import {
  awardXpForAttempts,
  awardXpForSessionOutcome,
  coinsForTopicPass,
  GATE_PASS_COINS,
  levelForXp,
  dayKeyForMs,
  nextStreakState,
  evaluateBadges,
  badgeById,
} from "@balashikshana/core-engine";
import type {
  BadgeAggregates,
  GamificationState,
  GamificationSummary,
  RewardAttempt,
  ServerLedger,
} from "./types";
import type { SessionType, TopicProgressRecord, UnitProgressRecord } from "../practice/types";

/** A fresh state for a student (mirrors the schema defaults + star-coins floor). */
export function initialGamificationState(studentId: string, nowMs: number): GamificationState {
  return {
    studentId,
    totalXp: 0,
    starCoins: 50,
    streakDays: 1,
    lastActiveDayKey: "",
    bestBeatTargetPct: 0,
    sessionsCompleted: 0,
    earnedBadges: [],
    provisional: true,
    updatedAt: nowMs,
  };
}

/** XP awarded so far this transition (internal accumulator shape). */
interface Transition {
  xp: number;
  coins: number;
}

function applyStreak(state: GamificationState, sessionMs: number): void {
  const next = nextStreakState({
    currentStreakDays: state.streakDays,
    lastActiveDayKey: state.lastActiveDayKey,
    sessionDayKey: dayKeyForMs(sessionMs),
  });
  if (next.changed) {
    state.streakDays = next.streakDays;
    state.lastActiveDayKey = next.lastActiveDayKey;
  }
}

/**
 * A topic-practice session or a game session's topic group (the exact
 * unit the server's replayTopicSession/replayGameSession reward blocks
 * run). `beatTargetPct` (game groups only) is the engine's
 * beatTargetSharePct over the group's raw times against the topic's own
 * registry fluency target — computed by the caller and passed in so this
 * module stays free of pack parsing.
 */
export function applyTopicLikeSession(
  state: GamificationState,
  params: {
    sessionType: Extract<SessionType, "TOPIC_PRACTICE" | "GAME">;
    attempts: RewardAttempt[];
    passed: boolean;
    crowns: number;
    beatTargetPct?: number;
    sessionMs: number;
    nowMs: number;
  },
): Transition {
  const t: Transition = { xp: 0, coins: 0 };
  t.xp += awardXpForAttempts(params.attempts);
  if (params.passed) {
    t.xp += awardXpForSessionOutcome({
      sessionType: params.sessionType,
      passed: true,
      crowns: params.crowns,
    });
    t.coins += coinsForTopicPass(params.crowns);
  }
  if (typeof params.beatTargetPct === "number" && params.beatTargetPct > state.bestBeatTargetPct) {
    state.bestBeatTargetPct = params.beatTargetPct;
  }
  applyStreak(state, params.sessionMs);
  state.totalXp += t.xp;
  state.starCoins += t.coins;
  state.sessionsCompleted += 1;
  state.provisional = true;
  state.updatedAt = params.nowMs;
  return t;
}

/** A gate session (attempt XP + the flat pass bonus/coins). */
export function applyGateSession(
  state: GamificationState,
  params: { attempts: RewardAttempt[]; passed: boolean; sessionMs: number; nowMs: number },
): Transition {
  const t: Transition = { xp: 0, coins: 0 };
  t.xp += awardXpForAttempts(params.attempts);
  if (params.passed) {
    t.xp += awardXpForSessionOutcome({ sessionType: "GATE", passed: true });
    t.coins += GATE_PASS_COINS;
  }
  applyStreak(state, params.sessionMs);
  state.totalXp += t.xp;
  state.starCoins += t.coins;
  state.sessionsCompleted += 1;
  state.provisional = true;
  state.updatedAt = params.nowMs;
  return t;
}

/** A Gold-key verification upgrade (XP only — no coins on the two-key step). */
export function applyGoldUpgrade(
  state: GamificationState,
  params: { sessionMs: number; nowMs: number },
): Transition {
  const t: Transition = { xp: 0, coins: 0 };
  t.xp += awardXpForSessionOutcome({ sessionType: "GOLD_VERIFICATION", goldUpgraded: true });
  applyStreak(state, params.sessionMs);
  state.totalXp += t.xp;
  state.sessionsCompleted += 1;
  state.provisional = true;
  state.updatedAt = params.nowMs;
  return t;
}

/**
 * Badge aggregates from the stores both sides hold. `gateUnitIds` /
 * `goldVerificationUnitIds` are the units the child's OWN attempt log
 * carries GATE / GOLD_VERIFICATION rows for — the same earned-key rule
 * the server applies (placement-seed keys never count; a badge must be
 * earned).
 */
export function badgeAggregates(params: {
  state: GamificationState;
  topicRows: TopicProgressRecord[];
  unitRows: UnitProgressRecord[];
  gateUnitIds: string[];
  goldVerificationUnitIds: string[];
}): BadgeAggregates {
  const { state, topicRows, unitRows } = params;
  const gateUnits = new Set(params.gateUnitIds);
  const goldUnits = new Set(params.goldVerificationUnitIds);
  return {
    sessionsCompleted: state.sessionsCompleted,
    topicsCompleted: topicRows.filter((r) => r.completed === 1).length,
    threeCrownTopics: topicRows.filter((r) => r.crowns === 3).length,
    perfectTopics: topicRows.filter((r) => r.bestAccuracyPct >= 100).length,
    silverKeys: unitRows.filter((u) => u.keyState !== null && gateUnits.has(u.unitId)).length,
    goldKeys: unitRows.filter((u) => u.keyState === "GOLD_KEY" && goldUnits.has(u.unitId)).length,
    bestBeatTargetPct: state.bestBeatTargetPct,
    starCoins: state.starCoins,
    streakDays: state.streakDays,
  };
}

/**
 * Re-evaluate the engine catalog over the aggregates and merge newly
 * earned ids into the state (forward-only). Returns the ids added this
 * call.
 */
export function evaluateAndMergeBadges(
  state: GamificationState,
  aggregates: BadgeAggregates,
  nowMs: number,
): string[] {
  // Spread into a plain record: the engine takes a metric->number map.
  const earned = evaluateBadges({ ...aggregates });
  const known = new Set(state.earnedBadges);
  const added: string[] = [];
  for (const id of earned) {
    if (!known.has(id)) {
      added.push(id);
    }
  }
  if (added.length > 0) {
    state.earnedBadges = [...state.earnedBadges, ...added].sort();
    state.provisional = true;
    state.updatedAt = nowMs;
  }
  return added;
}

/**
 * Adopt the server's authoritative ledger wholesale (the D8 confirm
 * step): totals, coins, streak, and badges become confirmed; the
 * provisional flag clears until the next local transition.
 */
export function adoptServerLedger(
  state: GamificationState,
  ledger: ServerLedger,
  nowMs: number,
): GamificationState {
  return {
    ...state,
    totalXp: ledger.totalXp,
    starCoins: ledger.starCoins,
    streakDays: ledger.streakDays,
    bestBeatTargetPct: ledger.bestBeatTargetPct,
    earnedBadges: ledger.badges.map((b) => b.id).sort(),
    provisional: false,
    updatedAt: nowMs,
  };
}

/** The kid-facing display summary (level curve via the engine). */
export function gamificationSummary(state: GamificationState): GamificationSummary {
  const level = levelForXp(state.totalXp);
  const span = level.xpToNextLevel ?? 0;
  const levelProgressPct = level.maxed
    ? 100
    : span > 0
      ? Math.min(100, Math.round((level.xpIntoLevel / span) * 100))
      : 100;
  return {
    totalXp: state.totalXp,
    level: level.level,
    maxLevel: level.maxLevel,
    maxed: level.maxed,
    xpIntoLevel: level.xpIntoLevel,
    xpToNextLevel: level.xpToNextLevel,
    levelProgressPct,
    starCoins: state.starCoins,
    streakDays: state.streakDays,
    provisional: state.provisional,
    badges: state.earnedBadges.map((id) => {
      const meta = badgeById(id);
      return {
        id,
        title: meta ? meta.title : id,
        tier: meta ? meta.tier : null,
        description: meta ? meta.description : null,
      };
    }),
  };
}
