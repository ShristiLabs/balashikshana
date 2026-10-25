// Gamification reward writers + read model (issue #55, roadmap D9).
//
// EVERY amount and rule comes from packages/core-engine (src/rewards.mjs)
// — this file owns NO reward math. It is the single server-side write
// path shared by the online handlers (server.mjs practice/complete and
// gate/evaluate) and the #48 sync reconciler's replay functions
// (sync.mjs), so the two cannot fork: an identical attempt stream
// produces identical ledger rows regardless of which path persisted it.
// The mobile projector (apps/mobile/src/gamification/rewardsProjector.ts)
// mirrors the same engine calls for the optimistic local ledger.
//
// Idempotency doctrine (mirrors 006's client-seq seam):
// - attempt XP rows carry dedupe_key `att:<deviceId>:<seq>` (sync) or
//   `att:<onlineSessionId>:<index>` (online); a replayed attempt inserts
//   nothing.
// - outcome rewards (pass bonus XP + coins) are TRANSITION-gated on the
//   sync path exactly like the pre-#55 coin awards (a re-replay of a
//   session whose persisted prefix already passed adds nothing; a failed
//   partial that passes as a whole rewards exactly once), and awarded on
//   every pass on the online path (each online call is a fresh session —
//   the historical coin behavior, preserved).
// - badge awards are idempotent by their composite PK.
// - streak transitions are idempotent per UTC day (engine rule).
//
// All writers run INSIDE the caller's transaction (they take the tx
// client), so attempts, progress, and rewards commit atomically — a
// crash can never strand one without the others.

import {
  xpForAttempt,
  awardXpForSessionOutcome,
  coinsForTopicPass,
  GATE_PASS_COINS,
  GOLD_UPGRADE_XP,
  levelForXp,
  dayKeyForMs,
  nextStreakState,
  evaluateBadges,
  badgeById
} from "../../packages/core-engine/src/index.mjs";

const XP_EVENT_INSERT_SQL = `
  INSERT INTO student_xp_events (
    student_id, session_type, session_id, unit_id, topic_id,
    xp_amount, reason, awarded_at, dedupe_key
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  ON CONFLICT (student_id, dedupe_key) DO NOTHING
`;

const GAMIFICATION_STATE_UPSERT_SQL = `
  INSERT INTO student_gamification_state (student_id, total_xp, updated_at)
  VALUES ($1, $2, $3)
  ON CONFLICT (student_id) DO UPDATE SET
    total_xp = student_gamification_state.total_xp + EXCLUDED.total_xp,
    updated_at = EXCLUDED.updated_at
`;

/** Insert one XP event (when its amount > 0) and bump the state total.
 *  Returns the XP actually credited (0 on a dedupe conflict or a
 *  zero-amount award — incorrect attempts never write empty rows). */
export async function insertXpEvent(client, { studentId, sessionType, sessionId, unitId, topicId, xpAmount, reason, awardedAtIso, dedupeKey }) {
  if (!Number.isFinite(xpAmount) || xpAmount <= 0) return 0;
  const result = await client.query(XP_EVENT_INSERT_SQL, [
    studentId,
    sessionType,
    sessionId,
    unitId ?? null,
    topicId ?? null,
    Math.floor(xpAmount),
    reason,
    awardedAtIso,
    dedupeKey
  ]);
  const credited = (result.rowCount ?? 0) > 0 ? Math.floor(xpAmount) : 0;
  if (credited > 0) {
    await client.query(GAMIFICATION_STATE_UPSERT_SQL, [studentId, credited, awardedAtIso]);
  }
  return credited;
}

/** Per-attempt XP for one newly inserted attempt row. */
export async function awardAttemptXp(client, { studentId, sessionType, sessionId, unitId, topicId, isCorrect, fluencyGrade, awardedAtIso, dedupeKey }) {
  const amount = xpForAttempt({ isCorrect, fluencyGrade });
  return insertXpEvent(client, {
    studentId,
    sessionType,
    sessionId,
    unitId,
    topicId,
    xpAmount: amount,
    reason: "attempt",
    awardedAtIso,
    dedupeKey
  });
}

/**
 * Session-outcome rewards for a topic-practice session or a game
 * session's topic group: the engine's pass bonus XP plus the coin award
 * (the exact pre-#55 formulas, now engine-owned). Callers gate the
 * transition (sync: passed && !priorPassed; online: passed). Returns the
 * XP credited and coins awarded (0 when the engine yields none).
 */
export async function awardTopicOutcomeRewards(client, { studentId, sessionType, sessionId, unitId, topicId, passed, crowns, awardedAtIso, dedupeKey }) {
  if (!passed) return { xp: 0, coins: 0 };
  const xpAmount = awardXpForSessionOutcome({ sessionType, passed, crowns });
  const coins = coinsForTopicPass(crowns);
  const xp = await insertXpEvent(client, {
    studentId,
    sessionType,
    sessionId,
    unitId,
    topicId,
    xpAmount,
    reason: "topic-pass",
    awardedAtIso,
    dedupeKey
  });
  if (coins > 0) {
    await client.query("UPDATE students SET star_coins = star_coins + $1, last_active_at = $2 WHERE student_id = $3", [
      coins,
      awardedAtIso,
      studentId
    ]);
  }
  return { xp, coins };
}

/** Gate-pass rewards: flat XP + flat coins. Same gating contract. */
export async function awardGateOutcomeRewards(client, { studentId, sessionId, unitId, passed, awardedAtIso, dedupeKey }) {
  if (!passed) return { xp: 0, coins: 0 };
  const xpAmount = awardXpForSessionOutcome({ sessionType: "GATE", passed });
  const xp = await insertXpEvent(client, {
    studentId,
    sessionType: "GATE",
    sessionId,
    unitId,
    topicId: null,
    xpAmount,
    reason: "gate-pass",
    awardedAtIso,
    dedupeKey
  });
  await client.query("UPDATE students SET star_coins = star_coins + $1, last_active_at = $2 WHERE student_id = $3", [
    GATE_PASS_COINS,
    awardedAtIso,
    studentId
  ]);
  return { xp, coins: GATE_PASS_COINS };
}

/** Gold-key upgrade reward (XP only — no coins on the two-key step). */
export async function awardGoldUpgradeRewards(client, { studentId, sessionId, unitId, awardedAtIso, dedupeKey }) {
  const xp = await insertXpEvent(client, {
    studentId,
    sessionType: "GOLD_VERIFICATION",
    sessionId,
    unitId,
    topicId: null,
    xpAmount: GOLD_UPGRADE_XP,
    reason: "gold-upgrade",
    awardedAtIso,
    dedupeKey
  });
  return { xp };
}

/**
 * Streak transition for a replayed session, evaluated at the session's
 * OWN adopted timestamp (sync latency never moves a day boundary) in UTC
 * day keys — the server-authoritative evaluation. Idempotent per day
 * (the engine rule); writes students.streak_days and the state row's
 * last_active_day_key together when the streak changed. Cross-device
 * same-instant races are bounded by the single-row UPDATE exactly like
 * the existing coin path.
 */
export async function applyStreakForSession(client, { studentId, sessionMs }) {
  const sessionDayKey = dayKeyForMs(sessionMs);
  if (sessionDayKey === "") return { streakDays: null, changed: false };
  const stu = await client.query("SELECT streak_days FROM students WHERE student_id = $1", [studentId]);
  const currentStreakDays = stu.rows?.[0]?.streak_days ?? 0;
  const state = await client.query(
    "SELECT last_active_day_key FROM student_gamification_state WHERE student_id = $1",
    [studentId]
  );
  const lastActiveDayKey = state.rows?.[0]?.last_active_day_key ?? "";
  const next = nextStreakState({ currentStreakDays, lastActiveDayKey, sessionDayKey });
  if (!next.changed) return { streakDays: next.streakDays, changed: false };
  const nowIso = new Date(sessionMs).toISOString();
  await client.query("UPDATE students SET streak_days = $1, last_active_at = $2 WHERE student_id = $3", [
    next.streakDays,
    nowIso,
    studentId
  ]);
  await client.query(
    `INSERT INTO student_gamification_state (student_id, total_xp, last_active_day_key, updated_at)
     VALUES ($1, 0, $2, $3)
     ON CONFLICT (student_id) DO UPDATE SET
       last_active_day_key = EXCLUDED.last_active_day_key,
       updated_at = EXCLUDED.updated_at`,
    [studentId, next.lastActiveDayKey, nowIso]
  );
  return { streakDays: next.streakDays, changed: true };
}

/** Monotone best-share bump (the speed badge's input). */
export async function updateBestBeatTargetPct(client, { studentId, pct, awardedAtIso }) {
  if (!Number.isFinite(pct) || pct <= 0) return;
  await client.query(
    `INSERT INTO student_gamification_state (student_id, total_xp, best_beat_target_pct, updated_at)
     VALUES ($1, 0, $2, $3)
     ON CONFLICT (student_id) DO UPDATE SET
       best_beat_target_pct = GREATEST(student_gamification_state.best_beat_target_pct, EXCLUDED.best_beat_target_pct),
       updated_at = EXCLUDED.updated_at`,
    [studentId, pct, awardedAtIso]
  );
}

/**
 * Evaluate the engine's badge catalog over the student's aggregate state
 * and insert any newly met awards (idempotent). Every aggregate is
 * derived from the SAME progress/attempt stores both sides hold; the
 * metric definitions are documented on the engine's BADGE_CATALOG.
 * Returns the newly awarded badge ids (for logging/stats).
 */
export async function evaluateAndAwardBadges(client, { studentId }) {
  const [sessions, topicAgg, unitAgg, stu, state] = await Promise.all([
    client.query(
      `SELECT COUNT(*)::int AS c FROM (
         SELECT DISTINCT session_id, session_type FROM student_question_attempts
         WHERE student_id = $1 AND session_id <> ''
       ) s`,
      [studentId]
    ),
    client.query(
      `SELECT COUNT(*) FILTER (WHERE completed = 1)::int AS topics_completed,
              COUNT(*) FILTER (WHERE crowns = 3)::int AS three_crown_topics,
              COUNT(*) FILTER (WHERE best_accuracy_pct >= 100)::int AS perfect_topics,
              COUNT(*) FILTER (WHERE crowns >= 1)::int AS topics_with_crowns,
              COALESCE(SUM(crowns), 0)::int AS total_crowns
       FROM student_topic_progress WHERE student_id = $1`,
      [studentId]
    ),
    client.query(
      // Keys count only where the child actually PLAYED the session:
      // insertStudentProfile seeds prerequisite-grade final units as
      // MASTERED/GOLD_KEY (placement credit), and a badge must mean the
      // child earned it — a Silver/Gold key counts iff the unit also has
      // the child's own GATE (resp. GOLD_VERIFICATION) attempt rows. The
      // mobile projector mirrors this rule off its attempt_log.
      `SELECT COUNT(*) FILTER (WHERE key_state IN ('SILVER_KEY','GOLD_KEY') AND EXISTS (
                 SELECT 1 FROM student_question_attempts a
                 WHERE a.student_id = sp.student_id AND a.unit_id = sp.unit_id
                   AND a.session_type = 'GATE'))::int AS silver_keys,
              COUNT(*) FILTER (WHERE key_state = 'GOLD_KEY' AND EXISTS (
                 SELECT 1 FROM student_question_attempts a
                 WHERE a.student_id = sp.student_id AND a.unit_id = sp.unit_id
                   AND a.session_type = 'GOLD_VERIFICATION'))::int AS gold_keys
       FROM student_unit_progress sp WHERE sp.student_id = $1`,
      [studentId]
    ),
    client.query("SELECT star_coins, streak_days FROM students WHERE student_id = $1", [studentId]),
    client.query("SELECT best_beat_target_pct FROM student_gamification_state WHERE student_id = $1", [studentId])
  ]);

  const context = {
    sessionsCompleted: sessions.rows?.[0]?.c ?? 0,
    topicsCompleted: topicAgg.rows?.[0]?.topics_completed ?? 0,
    threeCrownTopics: topicAgg.rows?.[0]?.three_crown_topics ?? 0,
    perfectTopics: topicAgg.rows?.[0]?.perfect_topics ?? 0,
    silverKeys: unitAgg.rows?.[0]?.silver_keys ?? 0,
    goldKeys: unitAgg.rows?.[0]?.gold_keys ?? 0,
    bestBeatTargetPct: state.rows?.[0]?.best_beat_target_pct ?? 0,
    starCoins: stu.rows?.[0]?.star_coins ?? 0,
    streakDays: stu.rows?.[0]?.streak_days ?? 0
  };

  const earned = evaluateBadges(context);
  const newlyAwarded = [];
  for (const badgeId of earned) {
    const result = await client.query(
      `INSERT INTO student_badge_awards (student_id, badge_id, scope, awarded_at)
       VALUES ($1, $2, 'global', $3)
       ON CONFLICT (student_id, badge_id, scope) DO NOTHING`,
      [studentId, badgeId, new Date().toISOString()]
    );
    if ((result.rowCount ?? 0) > 0) newlyAwarded.push(badgeId);
  }
  return { newlyAwarded, context };
}

// --- Read model (the kid-facing ledger endpoint) -------------------------------

/**
 * The full kid-facing ledger: XP total + level (engine curve), coins,
 * streak, badges with catalog metadata, recent XP events, and the crown
 * summary. `db` is the app-level db wrapper (get/all).
 */
export async function getGamificationLedger(db, studentId) {
  const [state, stu, badgeRows, eventRows, topicAgg] = await Promise.all([
    db.get("SELECT total_xp, best_beat_target_pct, last_active_day_key, updated_at FROM student_gamification_state WHERE student_id = $1", [studentId]),
    db.get("SELECT star_coins, streak_days FROM students WHERE student_id = $1", [studentId]),
    db.all("SELECT badge_id, scope, awarded_at FROM student_badge_awards WHERE student_id = $1 ORDER BY awarded_at ASC, badge_id ASC", [studentId]),
    db.all(
      `SELECT session_type, session_id, unit_id, topic_id, xp_amount, reason, awarded_at
       FROM student_xp_events WHERE student_id = $1
       ORDER BY awarded_at DESC, id DESC LIMIT 20`,
      [studentId]
    ),
    db.get(
      `SELECT COUNT(*) FILTER (WHERE crowns >= 1)::int AS topics_with_crowns,
              COUNT(*) FILTER (WHERE crowns = 3)::int AS three_crown_topics,
              COALESCE(SUM(crowns), 0)::int AS total_crowns
       FROM student_topic_progress WHERE student_id = $1`,
      [studentId]
    )
  ]);

  const totalXp = state?.total_xp ?? 0;
  const level = levelForXp(totalXp);
  return {
    studentId,
    totalXp,
    level,
    starCoins: stu?.star_coins ?? 0,
    streakDays: stu?.streak_days ?? 0,
    bestBeatTargetPct: state?.best_beat_target_pct ?? 0,
    badges: badgeRows.map((row) => {
      const meta = badgeById(row.badge_id);
      return {
        id: row.badge_id,
        title: meta ? meta.title : row.badge_id,
        description: meta ? meta.description : null,
        tier: meta ? meta.tier : null,
        scope: row.scope,
        awardedAt: row.awarded_at
      };
    }),
    badgesAvailable: new Set(badgeRows.map((r) => r.badge_id)).size,
    recentXpEvents: eventRows.map((row) => ({
      sessionType: row.session_type,
      sessionId: row.session_id,
      unitId: row.unit_id,
      topicId: row.topic_id,
      xpAmount: row.xp_amount,
      reason: row.reason,
      awardedAt: row.awarded_at
    })),
    crowns: {
      topicsWithCrowns: topicAgg?.topics_with_crowns ?? 0,
      threeCrownTopics: topicAgg?.three_crown_topics ?? 0,
      totalCrowns: topicAgg?.total_crowns ?? 0
    },
    generatedAt: new Date().toISOString()
  };
}
