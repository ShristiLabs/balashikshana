/**
 * Hearts policy rules (issue #56, roadmap D6) — PURE functions and data
 * only. Zero dependencies, no clocks (time arrives as a parameter), no
 * I/O. The module is the ONE source of the D6 tier rule so the client
 * UI gate and the server telemetry validation can never fork.
 *
 * D6 DOCTRINE (binding, roadmap decision table): hearts are
 * grade-tiered — heart depletion exists ONLY in Grade 2–3 fluency
 * sprints; Pre-K–Grade 1 is no-fail with gentle retry (the AGENTS.md
 * onGentleRetry pedagogy: punishing a 4-year-old contradicts the
 * project's own pedagogy). The M4 verification gate names it: "hearts
 * UI absent in Pre-K–G1 builds".
 *
 * Hearts are SESSION-SCOPED UI state, not a ledger currency and not
 * progress (issue #56 body): every fluency sprint starts at the full
 * heart count (next-session refill — no cross-session persistence, no
 * gate, no cooldown that could ever block play), a miss costs one
 * heart, and empty hearts END the session with a growth-mindset
 * reframe — never a fail state, never blocked content. The legacy
 * pre-D6 students.hearts counter (migration 001) is NOT part of this
 * policy and stays unwired.
 *
 * Kid-safety rules encoded here: re-queued repeats of an item never
 * cost a second heart (the miss already paid); incorrect answers earn
 * zero XP elsewhere (rewards.mjs) and cost at most one heart here;
 * nothing in this module can lock a child out of anything.
 *
 * Determinism policy: no function reads the wall clock — refill
 * progress takes explicit epoch-ms inputs so tests pin the timing
 * boundaries and the caller owns the clock.
 */

// ---------------------------------------------------------------------------
// Tier rule (the mount predicate)
// ---------------------------------------------------------------------------

/** Grade ids whose FLUENCY sprints carry hearts (roadmap D6: G2–G3). */
export const HEARTS_GRADES = Object.freeze(["grade-2", "grade-3"]);

/**
 * The bounded heart count every hearts session starts with (and the
 * maximum any hearts telemetry field may carry).
 */
export const HEART_COUNT = 5;

/**
 * D6 mount predicate — the single gate for whether a hearts UI exists
 * in a session at all. True ONLY for a Grade 2/Grade 3 FLUENCY sprint.
 * False for every guided session, every practice-runner session, and
 * — fail-closed — every unrecognized grade id (the same gentle-tier
 * convention as the #54 bubblePopBlitz pressure phases: an unknown
 * grade can never present fluency pressure).
 *
 * @param {string} gradeId registry grade id (e.g. "grade-2", "pre-k")
 * @param {string} stage game stage ("guided" | "fluency")
 * @returns {boolean}
 */
export function shouldMountHearts(gradeId, stage) {
  return stage === "fluency" && HEARTS_GRADES.includes(gradeId);
}

// ---------------------------------------------------------------------------
// In-session transitions
// ---------------------------------------------------------------------------

/**
 * One response's heart transition. A heart is lost ONLY on a
 * first-answer miss (`isCorrect` false and `isRequeue` false): a
 * re-queued repeat of an already-missed item never costs a second
 * heart (the miss already paid — the re-queue ladder is a second
 * chance, not a second penalty), and a correct answer never costs
 * anything. The count floors at 0 and never rises mid-session
 * (refill is next-session by design).
 *
 * @param {number} heartsRemaining current count (0..HEART_COUNT)
 * @param {{ isCorrect: boolean, isRequeue?: boolean }} response
 * @returns {{ remaining: number, lost: boolean }}
 */
export function heartStateAfterResponse(heartsRemaining, { isCorrect, isRequeue = false }) {
  // Invalid input (out of range, non-finite) resolves to FULL hearts:
  // the only writers of this state are this module's own transitions
  // (a session starts at HEART_COUNT), so garbage means a bug — and a
  // bug must never cost a child a heart.
  const valid =
    Number.isFinite(heartsRemaining) && heartsRemaining >= 0 && heartsRemaining <= HEART_COUNT;
  const safeStart = valid ? Math.trunc(heartsRemaining) : HEART_COUNT;
  const lost = !isCorrect && !isRequeue && safeStart > 0;
  return { remaining: lost ? safeStart - 1 : safeStart, lost };
}

/** Terminal session-end reasons a hearts session can report. */
export const HEARTS_END_REASONS = Object.freeze(["completed", "hearts-empty"]);

/**
 * The end reason for a closed hearts session: an emptied heart row
 * ends the sprint ("hearts-empty" — the client shows the growth
 * reframe screen); anything else completed the planned item stream.
 *
 * @param {number} heartsRemaining the session's final heart count
 * @returns {"completed" | "hearts-empty"}
 */
export function heartsSessionEndReason(heartsRemaining) {
  return heartsRemaining <= 0 ? "hearts-empty" : "completed";
}

// ---------------------------------------------------------------------------
// Refill (growth-mindset UX, never a gate)
// ---------------------------------------------------------------------------

/**
 * Rest-refill progress: how many of the hearts a hearts-empty session
 * lost have "grown back" after `msPerHeart` of rest each. PURELY
 * presentational reassurance for the reframe screen ("hearts grow
 * back while you rest") — the NEXT session always starts full
 * regardless of this value, and NO caller may gate, block, or scale a
 * session on it (kid-safety: hearts never block content access).
 * Negative elapsed time clamps to zero progress (clock skew safety).
 *
 * @param {{ lostHearts: number, endedAtMs: number, nowMs: number, msPerHeart?: number }} input
 * @returns {{ regrown: number, stillGrowing: boolean }}
 */
export function heartsRegrowProgress({ lostHearts, endedAtMs, nowMs, msPerHeart }) {
  const lost = Number.isFinite(lostHearts)
    ? Math.min(Math.max(Math.trunc(lostHearts), 0), HEART_COUNT)
    : 0;
  const perHeart = Number.isFinite(msPerHeart) && msPerHeart > 0 ? msPerHeart : HEART_REGROW_MS_PER_HEART;
  const elapsed = nowMs - endedAtMs;
  if (lost === 0 || !Number.isFinite(elapsed) || elapsed <= 0) {
    return { regrown: 0, stillGrowing: lost > 0 };
  }
  const regrown = Math.min(Math.floor(elapsed / perHeart), lost);
  return { regrown, stillGrowing: regrown < lost };
}

/** Rest-refill pacing: how long one heart takes to grow back (UX copy
 *  and the reframe screen's regrow indicator; 30 s per heart — a
 *  take-a-breath scale, and never a wait the child must endure). */
export const HEART_REGROW_MS_PER_HEART = 30000;

// ---------------------------------------------------------------------------
// Telemetry validation (shared by the #48 sync ingestion)
// ---------------------------------------------------------------------------

/**
 * Validate a hearts session-outcome telemetry record (the fields the
 * client stamps on the sync wire). Returns null when the record is a
 * consistent terminal hearts outcome, or a short machine-readable
 * problem string the server wraps in a 400 problem+json response.
 * Shared by BOTH sides so the wire contract cannot fork.
 *
 * Rules: fields are integers in [0, HEART_COUNT]; the two counts sum
 * to exactly HEART_COUNT (a terminal outcome accounts for every
 * heart); endReason is one of HEARTS_END_REASONS; "hearts-empty"
 * reports zero remaining and "completed" reports at least one.
 *
 * @param {{ heartsLost: number, heartsRemaining: number, endReason: string }} outcome
 * @returns {string | null}
 */
export function heartsOutcomeProblem({ heartsLost, heartsRemaining, endReason }) {
  const isInt = (v) => Number.isInteger(v) && v >= 0 && v <= HEART_COUNT;
  if (!isInt(heartsLost) || !isInt(heartsRemaining)) return "hearts-counts-out-of-range";
  if (heartsLost + heartsRemaining !== HEART_COUNT) return "hearts-counts-do-not-sum";
  if (!HEARTS_END_REASONS.includes(endReason)) return "hearts-end-reason-unknown";
  if (endReason === "hearts-empty" && heartsRemaining !== 0) return "hearts-empty-with-hearts-left";
  if (endReason === "completed" && heartsRemaining < 1) return "hearts-completed-with-no-hearts";
  return null;
}
