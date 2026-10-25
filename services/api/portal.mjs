// Parent portal API (issue #61, M5) — the parent-facing analytics and
// control surface under /api/portal/*.
//
// Security doctrine (the issue's security core):
// - EVERY route requires a PARENT session token via the #40
//   requireParentAuth: student PIN sessions and child device tokens
//   fail 403 wrong-token-type (token-kind confusion tests extend the
//   #40 middleware, exactly as the AC demands). Anonymous callers are
//   401.
// - Ownership is resolved SERVER-SIDE through parent_children, never
//   from trust in the client: the child id in the path is only ever
//   read AFTER binding to the caller's parent id. Another parent's
//   child id gets the SAME 404 as an unknown id (anti-enumeration; the
//   AC's "403/404" satisfied with the uniform 404 the repo uses for
//   scoped lookups).
// - Reads cover only data the parent is the accountable actor for
//   (D4): their children's learning telemetry. No PII beyond the
//   profiles they created. Nothing here creates child data, so the #41
//   consent-required creation gate does not bind these routes; the
//   data they read exists only because standing consent was captured.
// - Rate limiting: every route presents a parent bearer token — the
//   global per-IP + per-token buckets (the #40/#42 posture). None is a
//   token-guessing surface.
//
// Aggregation doctrine: SQL fetches raw grouped rows; MEANING lives in
// the pure portal-analytics.mjs (unit-tested math, no db) — the same
// DI split as derivations.mjs.

import { requireParentAuth } from "./parent-auth.mjs";
import { sendProblem, PROBLEM_BASE } from "./problem.mjs";
import { buildQuadrantPoints, buildWeeklySeries } from "./portal-analytics.mjs";
import {
  SUBJECTS,
  GRADE_ORDER,
  DAILY_LIMIT_MIN_MINUTES,
  DAILY_LIMIT_MAX_MINUTES,
  DEFAULT_CHILD_SETTINGS,
  loadChildSettings,
  parentSettingsBlock,
  recordedMinutesForDay,
  utcDayKey
} from "./enforcement.mjs";

// --- Ownership guard -----------------------------------------------------------

/**
 * Resolves a child THROUGH the caller's claimed binding. Sends the
 * uniform scoped-404 (same body for "not yours" and "does not exist")
 * and returns null when the caller has no such child.
 *
 * Exported since #62: the data-rights routes (export + deletion) resolve
 * ownership through the EXACT same guard — one ownership doctrine, no
 * drift between portal reads and destructive routes.
 */
export async function requireOwnedChild(db, req, reply, studentId) {
  const row = await db.get(
    `SELECT s.student_id, s.nickname, s.avatar, s.current_grade, s.streak_days,
            pc.status AS binding_status
     FROM parent_children pc
     JOIN students s ON s.student_id = pc.student_id
     WHERE pc.parent_id = $1 AND pc.student_id = $2
     LIMIT 1`,
    [req._balashiParentId, studentId]
  );
  if (!row || row.binding_status !== "claimed") {
    sendProblem(reply, 404, {
      type: `${PROBLEM_BASE}/child-not-found`,
      detail: "No such child is linked to this parent account."
    });
    return null;
  }
  return row;
}

/**
 * The effective child-settings shape from a portal_child_settings row
 * (null row -> platform defaults). Exported since #62: the data-rights
 * export embeds the settings in EXACTLY the shape the portal routes
 * serve — one derivation, no drift.
 */
export function effectiveChildSettings(row) {
  return row
    ? {
        dailyLimitMinutes: row.daily_limit_minutes == null ? null : Number(row.daily_limit_minutes),
        restrictedSubjects: JSON.parse(row.restricted_subjects || "[]"),
        gradeCeiling: row.grade_ceiling || null,
        remindersEnabled: Boolean(row.reminders_enabled),
        reminderHour: Number(row.reminder_hour),
        reminderMinute: Number(row.reminder_minute)
      }
    : { ...DEFAULT_CHILD_SETTINGS, restrictedSubjects: [] };
}

/**
 * Quadrant points for a child: the same SQL + the same pure
 * buildQuadrantPoints mapping the GET quadrant route serves. Exported
 * since #62 so the data-rights export computes its analytics parity
 * block through the identical code path (export numbers == portal
 * numbers BY CONSTRUCTION, not by copy).
 */
export async function quadrantPointsForChild(db, studentId) {
  const rows = await db.all(
    `SELECT a.topic_id AS "topicId",
            t.topic_name AS "topicName",
            t.unit_id AS "unitId",
            u.subject AS "subject",
            COUNT(*)::int AS attempts,
            SUM(a.is_correct)::int AS correct,
            PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY a.cognitive_time_sec) AS "medianSpeedSec",
            u.gate_max_speed_sec AS "targetSpeedSec"
     FROM student_question_attempts a
     JOIN skill_topics t ON t.topic_id = a.topic_id
     JOIN units u ON u.unit_id = a.unit_id
     WHERE a.student_id = $1
     GROUP BY a.topic_id, t.topic_name, t.unit_id, u.subject, u.gate_max_speed_sec
     ORDER BY attempts DESC, a.topic_id ASC`,
    [studentId]
  );
  return buildQuadrantPoints(
    rows.map((r) => ({
      topicId: r.topicId,
      topicName: r.topicName,
      unitId: r.unitId,
      subject: r.subject,
      attempts: Number(r.attempts),
      correct: Number(r.correct),
      medianSpeedSec: r.medianSpeedSec == null ? null : Number(r.medianSpeedSec),
      targetSpeedSec: r.targetSpeedSec == null ? null : Number(r.targetSpeedSec)
    }))
  );
}

/**
 * Weekly series for a child: the same SQL + the same pure
 * buildWeeklySeries mapping the GET weekly route serves (exported since
 * #62 — parity by construction, see quadrantPointsForChild).
 */
export async function weeklySeriesForChild(db, studentId, weeks, nowMs) {
  const rows = await db.all(
    `SELECT EXTRACT(EPOCH FROM (attempted_at::timestamptz))::bigint * 1000 AS "attemptedAtMs",
            cognitive_time_sec AS "cognitiveTimeSec",
            is_correct AS "isCorrect",
            topic_id AS "topicId",
            session_id AS "sessionId"
     FROM student_question_attempts
     WHERE student_id = $1`,
    [studentId]
  );
  return buildWeeklySeries(
    rows.map((r) => ({
      attemptedAtMs: Number(r.attemptedAtMs),
      cognitiveTimeSec: Number(r.cognitiveTimeSec),
      isCorrect: Number(r.isCorrect) === 1,
      topicId: r.topicId,
      sessionId: r.sessionId
    })),
    { weeks, nowMs }
  );
}

// --- Fastify plugin ------------------------------------------------------------

export const portalPlugin = async function portalPlugin(app, opts) {
  const { db } = opts;

  const studentIdParam = {
    type: "object",
    required: ["studentId"],
    properties: { studentId: { type: "string", minLength: 1, maxLength: 64 } }
  };

  const weeklyQuery = {
    type: "object",
    additionalProperties: false,
    properties: { weeks: { type: "integer", minimum: 1, maximum: 26 } }
  };

  const settingsSchema = {
    body: {
      type: "object",
      additionalProperties: false,
      required: ["restrictedSubjects", "remindersEnabled"],
      properties: {
        dailyLimitMinutes: {
          anyOf: [
            { type: "null" },
            { type: "integer", minimum: DAILY_LIMIT_MIN_MINUTES, maximum: DAILY_LIMIT_MAX_MINUTES }
          ]
        },
        restrictedSubjects: {
          type: "array",
          maxItems: SUBJECTS.length,
          uniqueItems: true,
          items: { type: "string", enum: [...SUBJECTS] }
        },
        gradeCeiling: {
          anyOf: [{ type: "null" }, { type: "string", enum: [...GRADE_ORDER] }]
        },
        remindersEnabled: { type: "boolean" },
        reminderHour: { type: "integer", minimum: 0, maximum: 23 },
        reminderMinute: { type: "integer", minimum: 0, maximum: 59 }
      }
    }
  };

  function settingsResponse(row, nowMs) {
    const effective = effectiveChildSettings(row);
    return { settings: effective, updatedAt: row ? row.updated_at : null, serverTime: new Date(nowMs).toISOString() };
  }

  // GET /api/portal/children -> the children overview: per-child card
  // data (nickname, avatar, grade, streak, mastered units, Silver/Gold
  // keys) resolved through the caller's CLAIMED bindings only.
  app.get("/api/portal/children", async (req, reply) => {
    const session = await requireParentAuth(db, req, reply);
    if (!session) return reply;
    const rows = await db.all(
      `SELECT pc.student_id, pc.relation, pc.claimed_at,
              s.nickname, s.avatar, s.current_grade, s.streak_days, s.last_active_at
       FROM parent_children pc
       JOIN students s ON s.student_id = pc.student_id
       WHERE pc.parent_id = $1 AND pc.status = 'claimed'
       ORDER BY pc.claimed_at ASC`,
      [session.parent_id]
    );
    const children = [];
    for (const r of rows) {
      const units = await db.get(
        `SELECT
           COUNT(*)::int AS started,
           COUNT(*) FILTER (WHERE silver_awarded_at IS NOT NULL)::int AS silver_keys,
           COUNT(*) FILTER (WHERE gold_verified_at IS NOT NULL)::int AS gold_keys,
           COUNT(DISTINCT sup.unit_id)::int AS touched
         FROM student_unit_progress sup
         WHERE sup.student_id = $1`,
        [r.student_id]
      );
      children.push({
        studentId: r.student_id,
        nickname: r.nickname,
        avatar: r.avatar,
        currentGrade: r.current_grade,
        relation: r.relation,
        streakDays: r.streak_days,
        lastActiveAt: r.last_active_at,
        unitsStarted: units?.touched ?? 0,
        unitsMastered: units?.silver_keys ?? 0,
        silverKeys: units?.silver_keys ?? 0,
        goldKeys: units?.gold_keys ?? 0
      });
    }
    return { parentId: session.parent_id, children };
  });

  // GET /api/portal/children/:studentId/analytics/quadrant -> per
  // skill-topic accuracy % + median cognitive speed (server-side
  // aggregation from student_question_attempts; the UI plots the four
  // labeled quadrants per the architecture-doc spec).
  app.get(
    "/api/portal/children/:studentId/analytics/quadrant",
    { schema: { params: studentIdParam } },
    async (req, reply) => {
      const session = await requireParentAuth(db, req, reply);
      if (!session) return reply;
      const child = await requireOwnedChild(db, req, reply, req.params.studentId);
      if (!child) return reply;

      const topics = await quadrantPointsForChild(db, child.student_id);
      return {
        studentId: child.student_id,
        // Empty child -> empty array (the UI renders the empty state).
        topics,
        generatedAt: new Date().toISOString()
      };
    }
  );

  // GET /api/portal/children/:studentId/analytics/weekly -> ISO-week
  // (Monday UTC) time/progress series; empty weeks zeroed, not errors.
  app.get(
    "/api/portal/children/:studentId/analytics/weekly",
    { schema: { params: studentIdParam, querystring: weeklyQuery } },
    async (req, reply) => {
      const session = await requireParentAuth(db, req, reply);
      if (!session) return reply;
      const child = await requireOwnedChild(db, req, reply, req.params.studentId);
      if (!child) return reply;

      const nowMs = Date.now();
      const weeks = Number(req.query?.weeks || 8);
      const series = await weeklySeriesForChild(db, child.student_id, weeks, nowMs);
      return { studentId: child.student_id, weeks: series.length, series, generatedAt: new Date(nowMs).toISOString() };
    }
  );

  // GET /api/portal/children/:studentId/settings -> effective settings
  // (row or platform defaults) + today's usage so the portal can show
  // the live cap state.
  app.get("/api/portal/children/:studentId/settings", { schema: { params: studentIdParam } }, async (req, reply) => {
    const session = await requireParentAuth(db, req, reply);
    if (!session) return reply;
    const child = await requireOwnedChild(db, req, reply, req.params.studentId);
    if (!child) return reply;

    const row = await db.get(
      `SELECT s.* FROM portal_child_settings s
       WHERE s.parent_id = $1 AND s.student_id = $2`,
      [req._balashiParentId, child.student_id]
    );
    const settings = effectiveChildSettings(row);
    const nowMs = Date.now();
    const usedMinutesToday = await recordedMinutesForDay(db, child.student_id, utcDayKey(nowMs));
    return {
      studentId: child.student_id,
      settings,
      updatedAt: row ? row.updated_at : null,
      usage: parentSettingsBlock(settings, { usedMinutesToday }).timeLimits,
      serverTime: new Date(nowMs).toISOString()
    };
  });

  // AJV's coerceTypes silently maps a falsy 0 to null inside the anyOf
  // (verified empirically) — for a SAFETY limit that coercion goes the
  // wrong way (a parent asking for "zero minutes" would get
  // "unlimited"). This preValidation guard sees the raw body BEFORE any
  // coercion and rejects out-of-range numbers explicitly.
  function rejectInvalidCapPreValidation(req, reply, done) {
    const cap = req.body && req.body.dailyLimitMinutes;
    if (typeof cap === "number" && (!Number.isInteger(cap) || cap < DAILY_LIMIT_MIN_MINUTES || cap > DAILY_LIMIT_MAX_MINUTES)) {
      sendProblem(reply, 400, {
        type: `${PROBLEM_BASE}/validation`,
        title: "Validation failed",
        detail: `dailyLimitMinutes must be null (unlimited) or an integer between ${DAILY_LIMIT_MIN_MINUTES} and ${DAILY_LIMIT_MAX_MINUTES}.`
      });
      return;
    }
    done();
  }

  // PUT /api/portal/children/:studentId/settings -> upsert the parent's
  // configuration (time limits, content controls, notification
  // defaults). Full-shape upsert: the body IS the new effective state
  // (absent optional fields reset to defaults; the required fields
  // force a conscious choice). One row per (parent, child).
  app.put(
    "/api/portal/children/:studentId/settings",
    { schema: { params: studentIdParam, ...settingsSchema }, preValidation: rejectInvalidCapPreValidation },
    async (req, reply) => {
      const session = await requireParentAuth(db, req, reply);
      if (!session) return reply;
      const child = await requireOwnedChild(db, req, reply, req.params.studentId);
      if (!child) return reply;

      const b = req.body;
      const remindersEnabled = Boolean(b.remindersEnabled);
      // When reminders are off, store the default 17:00 shape (the
      // #57 engine default) so the row never carries a stale time.
      const hour = remindersEnabled && Number.isInteger(b.reminderHour) ? b.reminderHour : 17;
      const minute = remindersEnabled && Number.isInteger(b.reminderMinute) ? b.reminderMinute : 0;

      const row = await db.get(
        `INSERT INTO portal_child_settings
           (parent_id, student_id, daily_limit_minutes, restricted_subjects, grade_ceiling,
            reminders_enabled, reminder_hour, reminder_minute, updated_at)
         VALUES ($1, $2, $3, $4::jsonb::text, $5, $6, $7, $8, now())
         ON CONFLICT (parent_id, student_id) DO UPDATE SET
           daily_limit_minutes = EXCLUDED.daily_limit_minutes,
           restricted_subjects = EXCLUDED.restricted_subjects,
           grade_ceiling = EXCLUDED.grade_ceiling,
           reminders_enabled = EXCLUDED.reminders_enabled,
           reminder_hour = EXCLUDED.reminder_hour,
           reminder_minute = EXCLUDED.reminder_minute,
           updated_at = now()
         RETURNING *`,
        [
          req._balashiParentId,
          child.student_id,
          b.dailyLimitMinutes ?? null,
          JSON.stringify(b.restrictedSubjects ?? []),
          b.gradeCeiling ?? null,
          remindersEnabled,
          hour,
          minute
        ]
      );
      return settingsResponse(row, Date.now());
    }
  );

  // --- Notification preferences (issue #63: the weekly email toggle) ---------
  // PARENT-level (the digest is one email per parent), unlike the per-child
  // settings above. Stored on parents.weekly_email_enabled (migration 012,
  // default on); flipping it takes effect on the next digest run — the job
  // reads the flag at selection time, so an opted-out parent is skipped
  // entirely (the issue's immediate-effect AC). Same parent-token doctrine
  // as every portal route; behind the global per-IP + per-token buckets.

  const notificationPreferencesSchema = {
    body: {
      type: "object",
      additionalProperties: false,
      required: ["weeklyEmailEnabled"],
      properties: { weeklyEmailEnabled: { type: "boolean" } }
    }
  };

  // GET /api/portal/notification-preferences -> the parent's email
  // notification preferences (today: the weekly summary toggle).
  app.get("/api/portal/notification-preferences", async (req, reply) => {
    const session = await requireParentAuth(db, req, reply);
    if (!session) return reply;
    const row = await db.get("SELECT weekly_email_enabled FROM parents WHERE parent_id = $1", [
      req._balashiParentId
    ]);
    if (!row) {
      return sendProblem(reply, 404, { type: `${PROBLEM_BASE}/not-found`, detail: "Parent account not found." });
    }
    return { weeklyEmailEnabled: Boolean(row.weekly_email_enabled), serverTime: new Date().toISOString() };
  });

  // PUT /api/portal/notification-preferences -> set the preferences
  // (full-shape replace: the body IS the new state).
  app.put(
    "/api/portal/notification-preferences",
    { schema: notificationPreferencesSchema },
    async (req, reply) => {
      const session = await requireParentAuth(db, req, reply);
      if (!session) return reply;
      const row = await db.get(
        "UPDATE parents SET weekly_email_enabled = $2, updated_at = now() WHERE parent_id = $1 RETURNING weekly_email_enabled",
        [req._balashiParentId, req.body.weeklyEmailEnabled]
      );
      if (!row) {
        return sendProblem(reply, 404, { type: `${PROBLEM_BASE}/not-found`, detail: "Parent account not found." });
      }
      return { weeklyEmailEnabled: Boolean(row.weekly_email_enabled), serverTime: new Date().toISOString() };
    }
  );
};
