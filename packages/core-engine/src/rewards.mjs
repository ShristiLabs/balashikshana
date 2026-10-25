/**
 * Gamification reward rules (issue #55, roadmap D9) — PURE functions and
 * data only. Zero dependencies, no clocks (time arrives as a parameter),
 * no I/O, no floating inputs left unrounded where kid-facing numbers are
 * produced.
 *
 * D9 DOCTRINE (binding): every reward number a child can see is computed
 * by THIS module on BOTH sides — the RN client's optimistic local ledger
 * (provisional until #48 sync confirms) and the server's authoritative
 * ledger (materialized from the append-only attempt stream at replay
 * time). The rules therefore cannot fork: an identical attempt stream
 * yields identical XP, levels, coins, streaks, and badges by
 * construction. Server call sites: services/api/rewards.mjs (online
 * handlers + the #48 sync reconciler). Client call site:
 * apps/mobile/src/gamification/rewardsProjector.ts.
 *
 * Determinism policy: no function here reads the wall clock, Math.random,
 * or locale-dependent formatting. Day keys are derived from explicit
 * epoch-ms inputs with an explicit UTC-offset parameter (default 0 — the
 * server evaluates UTC day keys; a client may pass its local offset for
 * provisional display, reconciled by sync).
 */

// ---------------------------------------------------------------------------
// XP accrual
// ---------------------------------------------------------------------------

/**
 * Per-attempt XP, fluency-weighted by the engine's 4-point
 * computeFluencyGrade scale: an incorrect answer earns nothing (grade 1
 * and every incorrect item map to 0 — effort is celebrated elsewhere,
 * never numerically punished); a slow-correct answer earns 1; a fluent
 * answer 2; an automatic (at-or-under 0.75x target) answer 3.
 */
export const XP_PER_CORRECT_ATTEMPT_BY_GRADE = Object.freeze({ 1: 0, 2: 1, 3: 2, 4: 3 });

/** Session pass bonus XP: base + per-crown (mirrors the coin shape). */
export const TOPIC_PASS_XP_BASE = 10;
export const XP_PER_CROWN = 5;

/** A passed boss-gate session (a Silver-key pass). */
export const GATE_PASS_XP = 25;

/** A Gold-key verification upgrade (the two-key machine's day-2 step). */
export const GOLD_UPGRADE_XP = 20;

/**
 * XP for one attempt item `{ isCorrect, fluencyGrade }` (the grade the
 * recording side already computed per attempt — the SAME value on both
 * sides because both run computeFluencyGrade on the same facts).
 * Unknown/invalid grades safely earn 0.
 */
export function xpForAttempt({ isCorrect, fluencyGrade }) {
  if (!isCorrect) return 0;
  const amount = XP_PER_CORRECT_ATTEMPT_BY_GRADE[fluencyGrade];
  return Number.isFinite(amount) ? amount : 0;
}

/** Sum of per-attempt XP over a list of attempt items. */
export function awardXpForAttempts(attempts = []) {
  let total = 0;
  for (const a of attempts) total += xpForAttempt(a);
  return total;
}

/**
 * Session-outcome bonus XP. A topic-practice or game topic-group pass
 * earns `TOPIC_PASS_XP_BASE + crowns * XP_PER_CROWN` (crowns 0..3 ->
 * 10/15/20/25 — the crowns come from the shared deriveTopicSession
 * derivation); a passed gate earns GATE_PASS_XP; a Gold upgrade earns
 * GOLD_UPGRADE_XP. A failed (non-pass) session earns 0 bonus XP.
 */
export function awardXpForSessionOutcome({ sessionType, passed, crowns = 0, goldUpgraded = false }) {
  if (sessionType === "GOLD_VERIFICATION") return goldUpgraded ? GOLD_UPGRADE_XP : 0;
  if (!passed) return 0;
  if (sessionType === "GATE") return GATE_PASS_XP;
  if (sessionType === "TOPIC_PRACTICE" || sessionType === "GAME") {
    return TOPIC_PASS_XP_BASE + crowns * XP_PER_CROWN;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Coin derivation (the pre-#55 formulas, now shared)
// ---------------------------------------------------------------------------

/** Coins for a passed topic session / game topic-group: 15 + crowns * 5. */
export function coinsForTopicPass(crowns = 0) {
  return 15 + crowns * 5;
}

/** Coins for a passed boss-gate session (historical literal, now named). */
export const GATE_PASS_COINS = 50;

/**
 * One call composing the full reward amounts for a session (or a game
 * session's per-topic group): per-attempt XP plus the outcome bonus, and
 * the coin award (the exact formulas the server historically applied
 * inline — surfaced here so both sides share them).
 */
export function deriveSessionRewards({ sessionType, attempts = [], passed, crowns = 0, goldUpgraded = false }) {
  const attemptXp = awardXpForAttempts(attempts);
  const sessionBonusXp = awardXpForSessionOutcome({ sessionType, passed, crowns, goldUpgraded });
  const coins = passed
    ? sessionType === "GATE"
      ? GATE_PASS_COINS
      : sessionType === "TOPIC_PRACTICE" || sessionType === "GAME"
        ? coinsForTopicPass(crowns)
        : 0
    : 0;
  return { attemptXp, sessionBonusXp, totalXp: attemptXp + sessionBonusXp, coins };
}

// ---------------------------------------------------------------------------
// Level curve
// ---------------------------------------------------------------------------

/** The level ladder is capped; beyond it XP still accrues, the level does not. */
export const MAX_LEVEL = 50;

/**
 * Cumulative XP required to REACH a level: `25 * level * (level - 1)`.
 * Level 1 starts at 0 XP; the per-level cost grows by 50 XP each level
 * (50, 100, 150, ...) so early levels arrive within a session or two and
 * the curve stays gentle for a Pre-K-G3 attention span. Integer-exact.
 */
export function xpThresholdForLevel(level) {
  const l = Math.max(1, Math.min(MAX_LEVEL, Math.floor(level)));
  return 25 * l * (l - 1);
}

/**
 * Level for a cumulative XP total. Returns the full display shape:
 * floor/next thresholds, progress into the level, XP to next, and the
 * maxed flag (nextLevelXp/xpToNextLevel are null at MAX_LEVEL).
 * Non-finite or negative totals clamp to level 1.
 */
export function levelForXp(totalXp) {
  const xp = Number.isFinite(totalXp) && totalXp > 0 ? Math.floor(totalXp) : 0;
  let level = 1;
  while (level < MAX_LEVEL && xp >= xpThresholdForLevel(level + 1)) level += 1;
  const levelFloorXp = xpThresholdForLevel(level);
  const maxed = level >= MAX_LEVEL;
  const nextLevelXp = maxed ? null : xpThresholdForLevel(level + 1);
  return {
    level,
    maxLevel: MAX_LEVEL,
    maxed,
    levelFloorXp,
    nextLevelXp,
    xpIntoLevel: xp - levelFloorXp,
    xpToNextLevel: maxed ? null : nextLevelXp - xp
  };
}

// ---------------------------------------------------------------------------
// Streak-day accrual
// ---------------------------------------------------------------------------

/**
 * Local-day key ("YYYY-MM-DD") for an epoch-ms timestamp at a fixed
 * UTC offset in minutes, positive EAST of UTC (local = UTC + offset;
 * e.g. +330 India, -240 US Eastern). Default 0 = UTC — the
 * server-authoritative evaluation; a client may pass its device offset
 * for provisional display. Invalid input yields "" (callers treat an
 * empty key as "no day").
 */
export function dayKeyForMs(ms, utcOffsetMinutes = 0) {
  if (!Number.isFinite(ms)) return "";
  const shifted = ms + utcOffsetMinutes * 60000;
  return new Date(shifted).toISOString().slice(0, 10);
}

/** Whole days between two day keys (b - a); non-finite input -> NaN. */
export function dayKeysApart(dayKeyA, dayKeyB) {
  const a = Date.parse(`${dayKeyA}T00:00:00Z`);
  const b = Date.parse(`${dayKeyB}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN;
  return Math.round((b - a) / 86400000);
}

/**
 * Streak transition for one session's day: a first-ever session starts a
 * streak at 1; a session on the SAME day is a no-op (idempotent — many
 * sessions per day never grow or reset the streak); a session on the
 * next consecutive day extends it; a gap of a day or more resets to 1.
 * `changed` tells the caller whether persisted state needs a write.
 */
export function nextStreakState({ currentStreakDays = 0, lastActiveDayKey = "", sessionDayKey = "" }) {
  if (sessionDayKey === "") {
    return { streakDays: currentStreakDays, lastActiveDayKey, changed: false };
  }
  if (lastActiveDayKey === "") {
    return { streakDays: 1, lastActiveDayKey: sessionDayKey, changed: true };
  }
  if (lastActiveDayKey === sessionDayKey) {
    return { streakDays: currentStreakDays, lastActiveDayKey, changed: false };
  }
  const apart = dayKeysApart(lastActiveDayKey, sessionDayKey);
  if (!Number.isFinite(apart) || apart <= 0) {
    // Out-of-order or malformed prior key: never move the streak
    // backwards; treat as a same-or-earlier day no-op.
    return { streakDays: currentStreakDays, lastActiveDayKey, changed: false };
  }
  if (apart === 1) {
    return { streakDays: currentStreakDays + 1, lastActiveDayKey: sessionDayKey, changed: true };
  }
  // A gap of one or more full days resets the streak to 1.
  return { streakDays: 1, lastActiveDayKey: sessionDayKey, changed: true };
}

// ---------------------------------------------------------------------------
// Speed badge input (beat-the-target share)
// ---------------------------------------------------------------------------

/**
 * Share (0-100, one decimal) of raw answer times at-or-below a speed
 * target. This is the speed badge's ONLY input, computed by ONE function
 * on both sides: the client feeds a game topic-group's raw times and the
 * topic's own registry fluency target; the server replay computes the
 * identical value from the same attempt rows and the same registry
 * assets. A non-positive target or an empty list yields 0 (an untimed
 * guided stage simply has no speed stat).
 *
 * COMPOSITION RULE (binding on both callers): the input list is the
 * CORRECT items of a PASSING topic group — fast-wrong answers carry no
 * speed credit (they are fluency grade 1 everywhere else in the engine)
 * and a failed group never updates the metric at all.
 */
export function beatTargetSharePct(rawTimeSecs = [], targetSec = 0) {
  const total = rawTimeSecs.length;
  if (total === 0 || !Number.isFinite(targetSec) || targetSec <= 0) return 0;
  let beat = 0;
  for (const t of rawTimeSecs) {
    if (Number.isFinite(t) && t <= targetSec) beat += 1;
  }
  return Number(((beat / total) * 100).toFixed(1));
}

// ---------------------------------------------------------------------------
// Badge / achievement catalog (engine DATA) + pure evaluation
// ---------------------------------------------------------------------------

/**
 * The badge catalog is DATA: every rule is a threshold (`gte`) over a
 * named aggregate metric, so the catalog can be serialized, diffed, and
 * consumed by any surface without code changes. Metric definitions
 * (identical on both sides — each side computes them from its own
 * progress/attempt store with the documented rule):
 * - sessionsCompleted: distinct (sessionId, sessionType) in the attempt
 *   store (online rows carry per-call session ids post-006; the wire and
 *   the local log both do).
 * - topicsCompleted / threeCrownTopics / perfectTopics: student_topic_
 *   progress rows — completed = 1, crowns = 3, best accuracy >= 100.
 * - silverKeys: unit rows holding SILVER or GOLD where the child's own
 *   GATE attempts exist for that unit (prerequisite-placement seed keys
 *   do NOT count — a badge must be earned); goldKeys: the same for GOLD
 *   with GOLD_VERIFICATION attempts.
 * - bestBeatTargetPct: max beatTargetSharePct over a student's game
 *   topic-groups (gamification state, both sides).
 * - starCoins: the student's coin counter (same formula both sides).
 * - streakDays: the streak state this module computes.
 * Names and descriptions are kid-safe, encouraging, and brand-free
 * (COPPA house rules); no PII ever enters a badge row.
 */
export const BADGE_CATALOG = Object.freeze(
  [
    { id: "first-steps", title: "First Steps", description: "Completed a first learning session.", tier: "bronze", metric: "sessionsCompleted", gte: 1 },
    { id: "practice-fan", title: "Practice Fan", description: "Completed 25 learning sessions.", tier: "bronze", metric: "sessionsCompleted", gte: 25 },
    { id: "marathon-learner", title: "Marathon Learner", description: "Completed 100 learning sessions.", tier: "gold", metric: "sessionsCompleted", gte: 100 },
    { id: "topic-explorer", title: "Topic Explorer", description: "Completed 5 skill topics.", tier: "bronze", metric: "topicsCompleted", gte: 5 },
    { id: "topic-champion", title: "Topic Champion", description: "Completed 25 skill topics.", tier: "silver", metric: "topicsCompleted", gte: 25 },
    { id: "crown-earner", title: "Crown Earner", description: "Earned a three-crown topic.", tier: "bronze", metric: "threeCrownTopics", gte: 1 },
    { id: "crown-collector", title: "Crown Collector", description: "Earned ten three-crown topics.", tier: "silver", metric: "threeCrownTopics", gte: 10 },
    { id: "perfect-aim", title: "Perfect Aim", description: "Finished a topic session with every answer correct.", tier: "silver", metric: "perfectTopics", gte: 1 },
    { id: "gate-conqueror", title: "Gate Conqueror", description: "Passed a unit boss gate.", tier: "silver", metric: "silverKeys", gte: 1 },
    { id: "gold-guardian", title: "Gold Guardian", description: "Verified a Gold key after sleep consolidation.", tier: "gold", metric: "goldKeys", gte: 1 },
    { id: "lightning-learner", title: "Lightning Learner", description: "Beat the speed target on 80% of a game's items.", tier: "silver", metric: "bestBeatTargetPct", gte: 80 },
    { id: "coin-collector", title: "Coin Collector", description: "Saved up 200 star coins.", tier: "bronze", metric: "starCoins", gte: 200 },
    { id: "streak-spark", title: "Streak Spark", description: "Practiced 3 days in a row.", tier: "bronze", metric: "streakDays", gte: 3 },
    { id: "streak-star", title: "Streak Star", description: "Practiced 7 days in a row.", tier: "gold", metric: "streakDays", gte: 7 }
  ].map(Object.freeze)
);

/** Catalog lookup by badge id (undefined when unknown). */
export function badgeById(id) {
  return BADGE_CATALOG.find((b) => b.id === id);
}

/**
 * Evaluate the whole catalog against an aggregate context and return the
 * ids of every badge whose threshold is met (`metric >= gte`). Missing
 * metrics count as 0; non-finite values count as 0. Deterministic:
 * catalog order, no duplicates, pure function of the context.
 */
export function evaluateBadges(context = {}) {
  const earned = [];
  for (const badge of BADGE_CATALOG) {
    const value = context[badge.metric];
    const numeric = Number.isFinite(value) ? value : 0;
    if (numeric >= badge.gte) earned.push(badge.id);
  }
  return earned;
}
