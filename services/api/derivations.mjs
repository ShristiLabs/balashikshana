// Shared progress derivations (issue #48) — the SINGLE SOURCE OF TRUTH for
// every topic/unit progress computation on the server.
//
// History: these lines lived inline in server.mjs (POST
// /api/practice/topic/complete and POST /api/gate/evaluate) until #47's
// mobile projector mirrored them line-for-line and pinned them with a
// server-source tripwire test. #48 extracts them here so the sync
// reconciler REUSES the exact same code paths as the online handlers
// (D8: "the server recomputes via core-engine — both sides agree by
// construction"), instead of forking a second copy.
//
// The mobile tripwire (apps/mobile/tests/practice-server-equivalence.test.ts)
// pins these lines IN THIS FILE. Editing a load-bearing line here must
// update the tripwire consciously and re-prove equivalence.
//
// TWO-KEY PORT (issue #48, resolving #47's documented divergence): the
// registry's twoKeySleepConsolidationGate machine — Silver on a day-1 gate
// pass; Gold ONLY via a 5-item verification session with >= 4 correct,
// >= 14 h after the FIRST Silver award (window frozen at first award);
// forward-only — now applies SERVER-SIDE too, in both the online
// /api/gate/evaluate handler and the sync reconciler. The pre-#48
// "any second pass -> GOLD_KEY" promotion is retired. Mirrors
// apps/mobile/src/practice/goldKey.ts exactly (mobile is the reference
// implementation; tests assert the equivalence).

import {
  median,
  computeCognitiveTimeSec,
  computeFluencyGrade,
  updateTopicMemoryStability
} from "../../packages/core-engine/src/index.mjs";

// --- Topic-practice session derivation (was inline in server.mjs) -----------

/**
 * Full topic-session derivation with the unit target speed in scope.
 * Every line below is load-bearing: the mobile projector mirrors it and
 * the server-source tripwire pins it.
 */
export function deriveTopicSession({ responses, motorBaselineSec, targetSpeed }) {
  const total = Math.max(1, responses.length);
  const correct = responses.filter((r) => r.isCorrect).length;
  const accPct = Number(((correct / total) * 100).toFixed(1));
  const cogTimes = responses.map((r) => computeCognitiveTimeSec(r.rawTimeSec || 3.0, motorBaselineSec, 0));
  const medSpeed = Number(median(cogTimes).toFixed(2));

  const passedTopic = accPct >= 80;
  const crowns = accPct >= 95 && medSpeed <= targetSpeed ? 3 : accPct >= 85 ? 2 : passedTopic ? 1 : 0;

  return { total, correct, accPct, cogTimes, medSpeed, passedTopic, crowns };
}

export function deriveTopicFluencyAndSr({ passedTopic, medSpeed, targetSpeed, prevStabilityDays, gradeRow }) {
  const fg = computeFluencyGrade(passedTopic, medSpeed, targetSpeed);
  const srUpdate = updateTopicMemoryStability({
    currentStabilityDays: prevStabilityDays,
    fluencyGrade: fg,
    gradeGrowthFactor: gradeRow ? gradeRow.sr_growth_factor : 2.0,
    maxIntervalCapDays: gradeRow ? gradeRow.sr_max_interval_days : 45
  });
  return { fg, srUpdate };
}

export function perAttemptFluencyGrade(isCorrect, cSec, targetSpeed) {
  return computeFluencyGrade(Boolean(isCorrect), cSec, targetSpeed);
}

// --- Gate unit reconstruction + key machine ----------------------------------

export function buildGateUnitObject({ unitRow, topicRows }) {
  return {
    unitId: unitRow.unit_id,
    title: unitRow.title,
    masteryGate: {
      questionCount: unitRow.gate_question_count,
      minAccuracyPercent: unitRow.gate_min_accuracy_pct,
      maxMedianResponseTimeSec: unitRow.gate_max_speed_sec,
      challengeZoneStreak: unitRow.gate_streak_req
    },
    skillTopics: topicRows.map((t) => ({ code: t.topic_code, name: t.topic_name }))
  };
}

// Two-key sleep-consolidation machine (registry globalMasteryRules.
// twoKeySleepConsolidationGate; mirrors apps/mobile/src/practice/goldKey.ts).
export const TWO_KEY_RULES = {
  day1PassAward: "SILVER_KEY",
  minSleepConsolidationHours: 14,
  day2GoldKeyVerificationItems: 5,
  day2MinPassCount: 4
};

export const MS_PER_HOUR = 3600000;

export function goldEligibleAtMs(silverAwardedAtMs) {
  return silverAwardedAtMs + TWO_KEY_RULES.minSleepConsolidationHours * MS_PER_HOUR;
}

export function isGoldEligible(silverAwardedAtMs, nowMs) {
  return silverAwardedAtMs > 0 && nowMs >= goldEligibleAtMs(silverAwardedAtMs);
}

/**
 * Key transition for a passed GATE session (two-key machine). A Gold
 * holder keeps Gold; anyone else who passes is (re)awarded Silver. The
 * pre-#48 server promoted a Silver holder to Gold on a second pass —
 * retired per the registry contract.
 */
export function nextKeyAfterGatePass(prevKeyState) {
  if (prevKeyState === "GOLD_KEY") return "GOLD_KEY";
  return "SILVER_KEY";
}

export function goldVerificationPassed(correctCount) {
  return correctCount >= TWO_KEY_RULES.day2MinPassCount;
}

/**
 * Silver window policy: the FIRST Silver award freezes the 14-hour
 * window start; re-passing the gate while Silver never resets the clock.
 * Input/output epoch ms (0 = never awarded).
 */
export function nextSilverAwardedAtMs(prevSilverMs, passed, sessionMs) {
  if (!passed) return prevSilverMs || 0;
  return prevSilverMs && prevSilverMs > 0 ? prevSilverMs : sessionMs;
}

/** Forward-only: an existing verified Gold timestamp never moves. */
export function nextGoldVerifiedAtMs(prevGoldMs, verificationPassed, sessionMs) {
  if (prevGoldMs && prevGoldMs > 0) return prevGoldMs;
  return verificationPassed ? sessionMs : 0;
}

/**
 * Combined two-key transition for a completed gate session. `prev` is
 * the existing student_unit_progress row (or null), `sessionMs` the
 * authoritative (server-adopted) timestamp of the session's last
 * attempt. Returns epoch-ms key timestamps; ISO strings are persisted
 * by the callers.
 */
export function computeKeyTransition({ prev, passed, sessionMs }) {
  const prevKey = prev ? prev.key_state : null;
  const prevSilverMs = prev && prev.silver_awarded_at ? Date.parse(prev.silver_awarded_at) : 0;
  const prevGoldMs = prev && prev.gold_verified_at ? Date.parse(prev.gold_verified_at) : 0;

  if (passed) {
    return {
      keyState: nextKeyAfterGatePass(prevKey),
      silverAwardedAtMs: nextSilverAwardedAtMs(prevSilverMs, true, sessionMs),
      goldVerifiedAtMs: prevGoldMs
    };
  }
  return {
    keyState: prevKey,
    silverAwardedAtMs: prevSilverMs,
    goldVerifiedAtMs: prevGoldMs
  };
}

/**
 * Verdict of a GOLD_VERIFICATION session: upgrades Silver -> Gold iff the
 * frozen 14-hour window has elapsed AND >= 4 of 5 correct. Evaluation is
 * against the session's OWN adopted timestamp (the child answered then,
 * not at sync time), so device/sync latency cannot extend the window.
 */
export function computeGoldVerificationTransition({ prev, correctCount, sessionMs }) {
  const prevKey = prev ? prev.key_state : null;
  const prevSilverMs = prev && prev.silver_awarded_at ? Date.parse(prev.silver_awarded_at) : 0;
  const prevGoldMs = prev && prev.gold_verified_at ? Date.parse(prev.gold_verified_at) : 0;
  if (!prev || prevKey !== "SILVER_KEY") {
    return { upgraded: false, keyState: prevKey, silverAwardedAtMs: prevSilverMs, goldVerifiedAtMs: prevGoldMs };
  }
  if (!isGoldEligible(prevSilverMs, sessionMs)) {
    return { upgraded: false, keyState: prevKey, silverAwardedAtMs: prevSilverMs, goldVerifiedAtMs: prevGoldMs };
  }
  if (!goldVerificationPassed(correctCount)) {
    return { upgraded: false, keyState: prevKey, silverAwardedAtMs: prevSilverMs, goldVerifiedAtMs: prevGoldMs };
  }
  return { upgraded: true, keyState: "GOLD_KEY", silverAwardedAtMs: prevSilverMs, goldVerifiedAtMs: sessionMs };
}

// --- Shared upsert SQL (exact pre-#48 statements; now used by both the
// --- online handlers and the sync reconciler) --------------------------------

// The $15 (topic) / $13 (unit) count-increment parameter is the sync
// reconciler's exactly-once seam (#48 review finding 4): the online
// handlers and a session's FIRST replay pass 1; a re-replay of a
// session that previously persisted rows passes 0 so a client that
// splits one session across batches can never double-count it. The
// INSERT branch keeps its literal 1 — a fresh row only ever appears
// with a session's first arrival.
export const TOPIC_PROGRESS_UPSERT_SQL = `
  INSERT INTO student_topic_progress (
    student_id, topic_id, unit_id, topic_code, completed, crowns,
    mastery_score, best_accuracy_pct, best_median_speed_sec,
    attempts_count, fluency_grade, stability_days, next_review_at, last_reviewed_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
  ON CONFLICT(student_id, topic_id) DO UPDATE SET
    completed = GREATEST(student_topic_progress.completed, excluded.completed),
    crowns = GREATEST(student_topic_progress.crowns, excluded.crowns),
    mastery_score = GREATEST(student_topic_progress.mastery_score, excluded.mastery_score),
    best_accuracy_pct = GREATEST(student_topic_progress.best_accuracy_pct, excluded.best_accuracy_pct),
    best_median_speed_sec = CASE
      WHEN student_topic_progress.best_median_speed_sec > 0
      THEN LEAST(student_topic_progress.best_median_speed_sec, excluded.best_median_speed_sec)
      ELSE excluded.best_median_speed_sec
    END,
    attempts_count = student_topic_progress.attempts_count + $15,
    fluency_grade = excluded.fluency_grade,
    stability_days = excluded.stability_days,
    next_review_at = excluded.next_review_at,
    last_reviewed_at = excluded.last_reviewed_at
`;

export const UNIT_PROGRESS_UPSERT_SQL = `
  INSERT INTO student_unit_progress (
    student_id, unit_id, status, key_state, best_accuracy_pct,
    best_median_speed_sec, attempts_count, stability_days,
    last_reviewed_at, cpa_stage, updated_at, silver_awarded_at, gold_verified_at
  ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $10, $11, $12)
  ON CONFLICT(student_id, unit_id) DO UPDATE SET
    status = CASE WHEN student_unit_progress.status = 'MASTERED' THEN 'MASTERED' ELSE excluded.status END,
    key_state = COALESCE(excluded.key_state, student_unit_progress.key_state),
    best_accuracy_pct = GREATEST(student_unit_progress.best_accuracy_pct, excluded.best_accuracy_pct),
    best_median_speed_sec = CASE
      WHEN student_unit_progress.best_median_speed_sec > 0
      THEN LEAST(student_unit_progress.best_median_speed_sec, excluded.best_median_speed_sec)
      ELSE excluded.best_median_speed_sec
    END,
    attempts_count = student_unit_progress.attempts_count + $13,
    stability_days = excluded.stability_days,
    last_reviewed_at = excluded.last_reviewed_at,
    cpa_stage = excluded.cpa_stage,
    updated_at = excluded.updated_at,
    silver_awarded_at = COALESCE(excluded.silver_awarded_at, student_unit_progress.silver_awarded_at),
    gold_verified_at = COALESCE(excluded.gold_verified_at, student_unit_progress.gold_verified_at)
`;

export const ATTEMPT_INSERT_SQL = `
  INSERT INTO student_question_attempts (
    student_id, session_type, unit_id, topic_id, question_id,
    chosen_answer, is_correct, raw_time_sec, cognitive_time_sec,
    fluency_grade, misconception_tags_json, attempted_at,
    audio_duration_sec, session_id, device_id, client_seq
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
  ON CONFLICT (student_id, device_id, client_seq) WHERE client_seq IS NOT NULL DO NOTHING
`;

// #60 placement PROVISIONAL topic credit — the one upsert placement is
// allowed to touch, and it deliberately touches nothing else: no
// completed, no crowns, no mastery_score (a placement item is evidence,
// not a crowning pass; only a practice session or a Boss Gate completes
// a topic, and only a Boss Gate awards keys). Stability grows to at
// most the engine's provisional band (GREATEST never regresses a real
// practice-earned stability) and next_review_at re-arms so the ordinary
// FSRS decay path schedules the topic like any other. attempts_count
// still increments once per first arrival (the $8 exactly-once seam,
// same convention as the upserts above).
export const PLACEMENT_TOPIC_CREDIT_SQL = `
  INSERT INTO student_topic_progress (
    student_id, topic_id, unit_id, topic_code, completed, crowns,
    mastery_score, best_accuracy_pct, best_median_speed_sec,
    attempts_count, fluency_grade, stability_days, next_review_at, last_reviewed_at
  ) VALUES ($1, $2, $3, $4, 0, 0, 0, $5, 0, $6, $7, $8, $9, $10)
  ON CONFLICT(student_id, topic_id) DO UPDATE SET
    best_accuracy_pct = GREATEST(student_topic_progress.best_accuracy_pct, excluded.best_accuracy_pct),
    attempts_count = student_topic_progress.attempts_count + $11,
    stability_days = GREATEST(student_topic_progress.stability_days, excluded.stability_days),
    next_review_at = excluded.next_review_at,
    last_reviewed_at = excluded.last_reviewed_at
`;
