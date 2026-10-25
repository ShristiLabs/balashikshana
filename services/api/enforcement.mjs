// Parent controls enforcement (issue #61) — the single source of truth
// for reading a child's portal settings and deciding what they gate.
// Shared by the portal routes (portal.mjs), the child-device sync
// surfaces (sync.mjs), and the question-serving routes (server.mjs) so
// the parent's limits can never fork between surfaces.
//
// Doctrine (binding):
// - Settings resolve through the CLAIMED parent binding
//   (parent_children.status = 'claimed'): the child of an unclaimed /
//   archived binding has NO settings row reachable, so platform
//   defaults apply. Ownership is structural, never client-supplied.
// - A missing settings row is NOT an error: DEFAULT_CHILD_SETTINGS is
//   the effective state (no limit, nothing restricted, reminders off).
// - Time limits bind the UTC day (the repo's day-key convention —
//   student_gamification_state.last_active_day_key; the attempt ledger
//   stores clock-adjusted UTC ISO strings). "Over the limit" means the
//   RECORDED active time for today's UTC day is >= the cap; the session
//   that crosses the line lands in full (attempts are never split), and
//   every upload AFTER the cap is reached that would add today-dated
//   sessions is refused. Backfill of PREVIOUS UTC days is always
//   accepted: it is accounting for practice that already happened, not
//   new practice.
// - Content controls gate what is SERVED (question routes, pack
//   listing for child callers) — they never rewrite, hide, or delete
//   recorded attempts (the ledger is append-only COPPA evidence, D8).

import { resolveBearerAuth } from "./parent-auth.mjs";

/** The fixed subject vocabulary (units.subject; see migration 001 seed). */
export const SUBJECTS = Object.freeze(["math", "ela", "science", "socialStudies"]);

/** Canonical grade order for ceiling comparisons (registry order). */
export const GRADE_ORDER = Object.freeze(["pre-k", "kindergarten", "grade-1", "grade-2", "grade-3"]);

/** Settings bounds (mirror the migration 010 CHECKs + route schema). */
export const DAILY_LIMIT_MIN_MINUTES = 5;
export const DAILY_LIMIT_MAX_MINUTES = 480;

/** Effective settings when no portal_child_settings row exists. */
export const DEFAULT_CHILD_SETTINGS = Object.freeze({
  dailyLimitMinutes: null, // null = unlimited
  restrictedSubjects: Object.freeze([]),
  gradeCeiling: null, // null = no ceiling
  remindersEnabled: false, // #57 COPPA-safe default: OFF
  reminderHour: 17,
  reminderMinute: 0
});

function parseSubjects(jsonText) {
  try {
    const parsed = JSON.parse(jsonText || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s) => typeof s === "string" && SUBJECTS.includes(s));
  } catch {
    return [];
  }
}

function rowToSettings(row) {
  if (!row) return { ...DEFAULT_CHILD_SETTINGS, restrictedSubjects: [] };
  return {
    dailyLimitMinutes: row.daily_limit_minutes == null ? null : Number(row.daily_limit_minutes),
    restrictedSubjects: parseSubjects(row.restricted_subjects),
    gradeCeiling: row.grade_ceiling || null,
    remindersEnabled: Boolean(row.reminders_enabled),
    reminderHour: Number(row.reminder_hour),
    reminderMinute: Number(row.reminder_minute)
  };
}

/**
 * Resolve a child's effective settings through the CLAIMED parent
 * binding. Returns DEFAULT_CHILD_SETTINGS semantics when the child has
 * no settings row (or no claimed parent).
 *
 * Why LIMIT 1 is deterministic: migration 005's partial unique index
 * `uq_parent_children_claimed_student ON parent_children (student_id)
 * WHERE status = 'claimed'` makes exactly-one-claimant a DATABASE
 * constraint — at most ONE parent_children row per student can carry
 * status='claimed' (the claim route's students-row mutex closes the
 * race window; archived bindings may coexist arbitrarily many per
 * student but are excluded by the WHERE). The join therefore can never
 * surface two claimed rows — and hence two portal_child_settings rows
 * — for one student, so LIMIT 1 orders nothing arbitrary; it exists
 * only to bound the shape, not to choose between duplicates.
 */
export async function loadChildSettings(db, studentId) {
  const row = await db.get(
    `SELECT s.* FROM portal_child_settings s
     JOIN parent_children pc ON pc.parent_id = s.parent_id AND pc.student_id = s.student_id
     WHERE s.student_id = $1 AND pc.status = 'claimed'
     LIMIT 1`,
    [studentId]
  );
  return rowToSettings(row);
}

/** UTC day key ("YYYY-MM-DD") of an epoch-ms instant. */
export function utcDayKey(epochMs) {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Recorded active minutes (sum of cognitive_time_sec / 60) for the
 * given UTC day key. attempted_at is a uniform toISOString() value
 * (clock-adjusted at ingest, sync.mjs), so the text-prefix range is
 * exact and index-compatible (idx_attempts_student).
 */
export async function recordedMinutesForDay(db, studentId, dayKey) {
  // Exclusive upper bound = next UTC day 00:00:00.000Z (toISOString is
  // always millisecond precision, so this range is exactly the day).
  const endKey = new Date(new Date(`${dayKey}T00:00:00.000Z`).getTime() + 86400000).toISOString().slice(0, 10);
  const row = await db.get(
    `SELECT COALESCE(SUM(cognitive_time_sec), 0) AS sec
     FROM student_question_attempts
     WHERE student_id = $1
       AND attempted_at >= $2 AND attempted_at < $3`,
    [studentId, `${dayKey}T00:00:00.000Z`, `${endKey}T00:00:00.000Z`]
  );
  return Math.round(((Number(row?.sec) || 0) / 60) * 10) / 10;
}

/**
 * The time-limit verdict for a sync upload. PURE over its inputs.
 *
 * @param {{dailyLimitMinutes: number|null}} settings
 * @param {{usedMinutesToday: number, nowMs: number}} usage
 * @param {Array<{answeredAtMs?: number}>|undefined} uploadAttempts
 *   The batch's attempts (client timestamps; the sync layer clamps
 *   future skew before this is consulted on the ingest path — callers
 *   pass server-clamped values where they have them; the decision only
 *   needs the UTC day, which a 5-minute clamp cannot flip).
 * @returns {{limited: boolean, limitMinutes: number|null, usedMinutes: number,
 *            resetsAtUtc: string|null}}
 *   limited=true => the caller MUST refuse the batch with the
 *   time-limit problem (only batches touching today are limited; pure
 *   backfill never is).
 */
export function timeLimitVerdict(settings, { usedMinutesToday, nowMs }, uploadAttempts = []) {
  const limit = settings.dailyLimitMinutes;
  if (limit == null) {
    return { limited: false, limitMinutes: null, usedMinutes: usedMinutesToday, resetsAtUtc: null };
  }
  const over = usedMinutesToday >= limit;
  if (!over) {
    return { limited: false, limitMinutes: limit, usedMinutes: usedMinutesToday, resetsAtUtc: null };
  }
  const todayKey = utcDayKey(nowMs);
  const touchesToday = (uploadAttempts || []).some(
    (a) => typeof a.answeredAtMs === "number" && utcDayKey(a.answeredAtMs) === todayKey
  );
  if (!touchesToday) {
    return { limited: false, limitMinutes: limit, usedMinutes: usedMinutesToday, resetsAtUtc: null };
  }
  const resetIso = new Date(Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate() + 1)).toISOString();
  return { limited: true, limitMinutes: limit, usedMinutes: usedMinutesToday, resetsAtUtc: resetIso };
}

/**
 * Content-control verdict for a unit. PURE.
 *
 * FAIL-CLOSED on unknown grade vocabulary: GRADE_ORDER is a frozen
 * duplicate of the grades registry — if the registry ever grows a grade
 * this list does not know, indexOf's -1 must never widen access. Under
 * raw indexOf semantics an unknown unit gradeId (-1) compares "below"
 * every ceiling and an unknown ceiling (-1) compares "above" every
 * unit, which is exactly the above-ceiling bypass; instead, an unknown
 * ceiling string restricts, and an unknown unit gradeId is treated as
 * above the ceiling. Mirrors the sibling explicit ceilingIdx guard in
 * filterPackIndexForChild below.
 *
 * @param {{restrictedSubjects: string[], gradeCeiling: string|null}} settings
 * @param {{subject: string, gradeId: string}} unit
 * @returns {{restricted: boolean, reason: "subject-restricted"|"grade-ceiling"|null}}
 */
export function unitContentVerdict(settings, unit) {
  if ((settings.restrictedSubjects || []).includes(unit.subject)) {
    return { restricted: true, reason: "subject-restricted" };
  }
  const ceiling = settings.gradeCeiling;
  if (ceiling != null) {
    const unitIdx = GRADE_ORDER.indexOf(unit.gradeId);
    const ceilingIdx = GRADE_ORDER.indexOf(ceiling);
    if (ceilingIdx < 0) {
      return { restricted: true, reason: "grade-ceiling" };
    }
    if (unitIdx < 0 || unitIdx > ceilingIdx) {
      return { restricted: true, reason: "grade-ceiling" };
    }
  }
  return { restricted: false, reason: null };
}

/**
 * Filter a content-pack index for a child caller (grade ceiling only:
 * subject controls live INSIDE packs and cannot be carved out of a
 * signed artifact; they gate question-serving instead). PURE.
 */
export function filterPackIndexForChild(packs, settings) {
  if (settings.gradeCeiling == null) return packs;
  const ceilingIdx = GRADE_ORDER.indexOf(settings.gradeCeiling);
  if (ceilingIdx < 0) return packs;
  return packs.filter((p) => GRADE_ORDER.indexOf(p.gradeId) <= ceilingIdx);
}

/**
 * Resolve the student identity of an OPTIONAL bearer on a public route
 * (question serving, pack hosting). Returns the student id when the
 * caller presented a valid student-session or child-device token, or
 * null for anonymous callers AND for unresolvable tokens — public
 * routes must not grow new failure modes; controls are an additional
 * protection layered onto child-authenticated callers, and the pack
 * artifacts themselves are public content (existing distribution
 * doctrine — the device verifies signatures; parental controls gate the
 * child's experience, not curriculum secrecy).
 */
export async function resolveOptionalStudentId(db, authorizationHeader) {
  const auth = await resolveBearerAuth(db, authorizationHeader);
  if (auth.error) return null;
  if (auth.kind === "student") return auth.session.student_id;
  if (auth.kind === "child-device") return auth.childSession.student_id;
  return null;
}

/**
 * The advisory block served on GET /api/sync/progress so an offline-first
 * device can gate new practice locally (stop offering sessions past the
 * cap, hide restricted subjects) BEFORE burning an upload. PURE shaping;
 * never a substitute for the server-side refusals.
 */
export function parentSettingsBlock(settings, { usedMinutesToday }) {
  return {
    timeLimits: {
      dailyLimitMinutes: settings.dailyLimitMinutes,
      usedMinutesToday,
      exceeded: settings.dailyLimitMinutes != null && usedMinutesToday >= settings.dailyLimitMinutes
    },
    contentControls: {
      restrictedSubjects: [...settings.restrictedSubjects],
      gradeCeiling: settings.gradeCeiling
    },
    notifications: {
      // #57 mirror: device-local reminders, parent-owned defaults.
      remindersEnabled: settings.remindersEnabled,
      reminderHour: settings.reminderHour,
      reminderMinute: settings.reminderMinute
    }
  };
}
