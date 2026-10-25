// Portal analytics — PURE aggregation logic (issue #61). No db, no
// clocks (time arrives as a parameter), no I/O: everything here is
// unit-tested math over rows the caller fetched. The route layer in
// portal.mjs owns SQL + scoping; this module owns MEANING.
//
// Definitions (documented decisions, stable contracts for the portal UI):
// - "Active time" is the sum of cognitive_time_sec per attempt: the
//   engine's motor-baseline-adjusted measure of engaged thinking time.
//   raw_time_sec includes motor-execution overhead that varies with a
//   child's age and motor ability, so it would systematically overstate
//   time-on-task for younger/slower-motor kids; cognitive time is the
//   ability-neutral measure and the same field family the quadrant's
//   "median cognitive speed" uses (one definition of engagement
//   everywhere).
// - Weeks are ISO weeks anchored on MONDAY 00:00 UTC (Postgres
//   date_trunc('week') convention). All analytics run in UTC: the
//   attempt ledger stores clock-adjusted UTC ISO-8601 strings, and the
//   repo's day-key convention (student_gamification_state.last_active_day_key)
//   is already UTC. Portal copy presents times as UTC-based aggregates.
// - A "passing topic session" is a session whose accuracy >= 80% — the
//   platform pass line (deriveTopicSession.passedTopic). A topic counts
//   as "mastered (first pass)" in the week containing its FIRST passing
//   session; later passes never re-count.
// - Quadrant classification (architecture doc sec 3): Y axis accuracy %
//   with the split at 80 (the platform pass line); X axis median
//   cognitive speed with the split at the topic's unit target speed
//   (units.gate_max_speed_sec — the platform's own fluency bar, so
//   "fast" means "at or under the target", the same rule crowns use).
//     top-right green  = accurate AND at/under target speed (fluent)
//     top-left  yellow = accurate but slower than target (needs speed)
//     bottom-right orange = fast but inaccurate (rushing/guessing)
//     bottom-left  red = slow and inaccurate (needs concept review)
//   A topic with no usable target speed (0/NULL) is still plotted and
//   returned, but classified null — the UI renders it gray/uncategorized
//   rather than inventing a split.

/** Pass line for both topic sessions and the quadrant accuracy axis. */
export const TOPIC_PASS_ACCURACY_PCT = 80;

/** Monday-anchored ISO week start (UTC) of an epoch-ms instant. */
export function isoWeekStartMs(epochMs) {
  const d = new Date(epochMs);
  const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dow = new Date(utc).getUTCDay(); // 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7;
  return utc - daysSinceMonday * 86400000;
}

/**
 * Build the zero-filled weekly series.
 *
 * @param {Array<{attemptedAtMs: number, cognitiveTimeSec: number, isCorrect: boolean, topicId: string, sessionId: string}>} attempts
 *   The child's FULL attempt history (oldest first not required).
 * @param {{weeks: number, nowMs: number}} opts
 *   weeks: 1..26 buckets ending with the week containing nowMs.
 * @returns {{weekStartIso: string, weekStartMs: number, attempts: number, correct: number,
 *            accuracyPct: number|null, activeMinutes: number, topicsPracticed: number,
 *            topicsFirstMastered: number, cumulativeTopicsMastered: number}[]}
 *   Weeks with no activity return zeroed rows (accuracyPct null — not a
 *   division by zero), never errors, per the issue AC.
 */
export function buildWeeklySeries(attempts, { weeks, nowMs }) {
  const count = Math.max(1, Math.min(26, Math.floor(weeks)));
  const lastWeekStart = isoWeekStartMs(nowMs);
  const firstWeekStart = lastWeekStart - (count - 1) * 604800000;

  const buckets = new Map();
  for (let i = 0; i < count; i++) {
    const start = firstWeekStart + i * 604800000;
    buckets.set(start, {
      weekStartMs: start,
      weekStartIso: new Date(start).toISOString(),
      attempts: 0,
      correct: 0,
      cognitiveSec: 0,
      topics: new Set(),
      sessions: new Set()
    });
  }

  // Session-level accuracy rollup across ALL history (before the window
  // too): "first mastered week" needs the first passing session ever,
  // and cumulative counts must include pre-window mastery.
  const sessionCorrect = new Map(); // sessionKey -> correct count
  const sessionTotal = new Map(); // sessionKey -> total count
  const sessionMeta = new Map(); // sessionKey -> { topicId, weekStartMs }
  for (const a of attempts) {
    const weekStart = isoWeekStartMs(a.attemptedAtMs);
    const key = `${a.topicId}|${a.sessionId}`;
    sessionCorrect.set(key, (sessionCorrect.get(key) || 0) + (a.isCorrect ? 1 : 0));
    sessionTotal.set(key, (sessionTotal.get(key) || 0) + 1);
    sessionMeta.set(key, { topicId: a.topicId, weekStartMs: weekStart });
  }

  // First passing session per topic (the mastery curve anchor).
  const firstPassWeekByTopic = new Map();
  for (const [key, meta] of sessionMeta) {
    const total = sessionTotal.get(key) || 0;
    const correct = sessionCorrect.get(key) || 0;
    if (total > 0 && (correct / total) * 100 >= TOPIC_PASS_ACCURACY_PCT) {
      const prev = firstPassWeekByTopic.get(meta.topicId);
      if (prev === undefined || meta.weekStartMs < prev) {
        firstPassWeekByTopic.set(meta.topicId, meta.weekStartMs);
      }
    }
  }

  // Bucket the attempts that fall inside the window.
  for (const a of attempts) {
    const b = buckets.get(isoWeekStartMs(a.attemptedAtMs));
    if (!b) continue; // before the requested window
    b.attempts += 1;
    if (a.isCorrect) b.correct += 1;
    b.cognitiveSec += Math.max(0, Number(a.cognitiveTimeSec) || 0);
    b.topics.add(a.topicId);
  }

  // First-mastered counts per in-window week + cumulative across all time.
  const masteredPerWeek = new Map();
  let cumulative = 0;
  for (const [, weekMs] of firstPassWeekByTopic) {
    if (weekMs < firstWeekStart) cumulative += 1;
    else if (buckets.has(weekMs)) masteredPerWeek.set(weekMs, (masteredPerWeek.get(weekMs) || 0) + 1);
  }

  const rows = [];
  for (const [, b] of buckets) {
    cumulative += masteredPerWeek.get(b.weekStartMs) || 0;
    rows.push({
      weekStartIso: b.weekStartIso,
      weekStartMs: b.weekStartMs,
      attempts: b.attempts,
      correct: b.correct,
      // null accuracy for empty weeks (no division by zero, no fake 0%).
      accuracyPct: b.attempts > 0 ? round1((b.correct / b.attempts) * 100) : null,
      activeMinutes: round1(b.cognitiveSec / 60),
      topicsPracticed: b.topics.size,
      topicsFirstMastered: masteredPerWeek.get(b.weekStartMs) || 0,
      cumulativeTopicsMastered: cumulative
    });
  }
  return rows;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Classify one topic point into the four-quadrant scheme.
 * Pure; returns null when the point cannot be classified honestly
 * (no attempts, or no usable target speed).
 *
 * @returns {"fluent"|"accurate-slow"|"rushing"|"needs-review"|null}
 */
export function classifyQuadrantPoint({ attempts, correct, medianSpeedSec, targetSpeedSec }) {
  if (!Number.isFinite(attempts) || attempts < 1) return null;
  if (!Number.isFinite(medianSpeedSec) || medianSpeedSec < 0) return null;
  if (!Number.isFinite(targetSpeedSec) || targetSpeedSec <= 0) return null;
  const accuracyPct = (correct / attempts) * 100;
  const accurate = accuracyPct >= TOPIC_PASS_ACCURACY_PCT;
  const fast = medianSpeedSec <= targetSpeedSec;
  if (accurate && fast) return "fluent"; // top-right, green
  if (accurate && !fast) return "accurate-slow"; // top-left, yellow
  if (!accurate && fast) return "rushing"; // bottom-right, orange
  return "needs-review"; // bottom-left, red
}

/**
 * Shape raw per-topic aggregate rows into quadrant points. Pure.
 *
 * @param {Array<{topicId: string, topicName?: string, unitId?: string, subject?: string,
 *                attempts: number, correct: number, medianSpeedSec: number, targetSpeedSec: number|null}>} rows
 * @returns the same rows with accuracyPct (rounded 1dp; null never —
 *   grouped rows have >=1 attempt by construction, but a defensive null
 *   stays for malformed input) and quadrant fields added. Degenerate
 *   child (no attempts) is simply an empty input array -> empty output.
 */
export function buildQuadrantPoints(rows) {
  return rows.map((r) => ({
    ...r,
    accuracyPct: r.attempts >= 1 ? round1((r.correct / r.attempts) * 100) : null,
    quadrant: classifyQuadrantPoint(r)
  }));
}
