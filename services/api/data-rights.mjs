// Data-rights API (issue #62, M5) — COPPA parent rights over child data:
// the per-child JSON export and the self-serve child-data deletion, both
// under /api/portal/* with the #61 portal doctrine.
//
// Security doctrine:
// - PARENT session tokens only (requireParentAuth): student PIN sessions
//   and child device tokens are 403 wrong-token-type; anonymous 401.
// - Ownership resolves through the SAME exported requireOwnedChild guard
//   as the #61 portal reads — the child id in the path is only ever read
//   after binding to the caller's CLAIMED parent_children row, and
//   another parent's child id gets the uniform scoped-404.
// - DELETION additionally requires PASSWORD RE-AUTHENTICATION: the
//   bearer token proves the session, the password proves the account
//   holder. verifyPin (db.mjs) checks it against parents.password_hash —
//   the same scrypt primitive as login, no new crypto. A wrong password
//   is 401 re-auth-required, and the route carries its own tight
//   per-IP rate bucket (the login-bucket doctrine for password checks:
//   this is a password-guessing surface even behind a valid token).
// - The export NEVER contains credentials or credential verifiers:
//   students.pin_hash, student_sessions.token (the live bearer),
//   child_device_sessions.token_hash are excluded by column selection.
//
// COPPA posture (the #62 decision — documented here, in migration 011,
// and in the architecture doc):
// - Verifiable parental consent evidence (consent_records) is RETAINED
//   past a child-data deletion: FTC COPPA record-keeping expects the
//   operator to demonstrate consent for a retention period even after a
//   deletion request. The child PII lives in the students row (nickname,
//   username, avatar, age) and IS deleted; consent_records carries no
//   child PII beyond the opaque student_id linkage, which the deletion
//   transaction severs explicitly (student_id -> NULL) in the same
//   commit. The linkage survives ONLY in deletion_audit (plain-text
//   student id + policy version) — AC4's "audit linkage".
// - consent_records.student_id stays ON DELETE RESTRICT (migration 002):
//   no code path can cascade evidence away. Only this module's explicit,
//   audited severance UPDATE clears the way for the students delete, and
//   it exists ONLY inside the deletion transaction.
//
// Deletion design:
// - ONE transaction, explicit ordered deletes (the issue's order:
//   attempts -> topic progress -> unit progress -> sessions/device
//   sessions -> remaining child-data tables -> binding -> child profile
//   row). Explicit deletes (not silent cascade) give exact per-table
//   counts for the audit row and make the deletion surface reviewable.
//   The students delete still relies on the schema's CASCADE as the
//   belt-and-braces backstop for any table added without an explicit
//   statement here.
// - The deletion_audit INSERT is in the SAME transaction (AC3): either
//   the cascade and its evidence commit together, or neither does.
// - devices rows SURVIVE: they are the parent's hardware registrations
//   (parents.parent_id FK, not child data); other children on the same
//   device keep their sessions. Child-device SESSIONS are deleted with
//   the child.
// - Idempotent re-request: the binding row is deleted with the child, so
//   a second DELETE resolves to the same uniform scoped-404 as any
//   unknown child (never a partial second cascade).
//
// Export design:
// - ONE JSON document per child covering every child-data class
//   (profile, binding, consent records, portal settings, attempts,
//   topic/unit progress, student + device sessions, gamification,
//   session outcomes, placement records) plus an `analytics` parity
//   block computed through the SAME exported helpers as the #61 portal
//   endpoints — export numbers == portal numbers by construction.
// - Served as a downloadable attachment (Content-Disposition). Memory is
//   bounded by ONE child's rows (all queries are student_id-scoped); the
//   document is assembled once and stringified once. A single child's
//   attempt volume is thousands of rows at most — a streaming JSON
//   writer would buy nothing at this scale and forfeit the shared
//   aggregation path.

import crypto from "node:crypto";
import { requireParentAuth } from "./parent-auth.mjs";
import { sendProblem, PROBLEM_BASE } from "./problem.mjs";
import { verifyPin } from "./db.mjs";
import { getActivePolicyVersion } from "./consent.mjs";
import {
  requireOwnedChild,
  effectiveChildSettings,
  quadrantPointsForChild,
  weeklySeriesForChild
} from "./portal.mjs";

const EXPORT_FORMAT_VERSION = 1;

function newAuditId() {
  return `del-${crypto.randomBytes(12).toString("hex")}`;
}

// Password bounds mirror the signup schema (parent-auth.mjs: 12-char
// floor for parent accounts); the body schema enforces shape, verifyPin
// enforces truth.
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;

export const dataRightsPlugin = async function dataRightsPlugin(app, opts) {
  const { db, rateLimits } = opts;

  const studentIdParam = {
    type: "object",
    required: ["studentId"],
    properties: { studentId: { type: "string", minLength: 1, maxLength: 64 } }
  };

  // --- Export ------------------------------------------------------------------

  app.get(
    "/api/portal/children/:studentId/export",
    { schema: { params: studentIdParam } },
    async (req, reply) => {
      const session = await requireParentAuth(db, req, reply);
      if (!session) return reply;
      const child = await requireOwnedChild(db, req, reply, req.params.studentId);
      if (!child) return reply;
      const studentId = child.student_id;

      // Every child-data class, credential columns excluded by selection.
      const profile = await db.get(
        `SELECT student_id AS "studentId", username, nickname, avatar, age_years AS "ageYears",
                current_grade AS "currentGrade", motor_baseline_sec AS "motorBaselineSec",
                streak_days AS "streakDays", star_coins AS "starCoins", hearts, status,
                last_active_at AS "lastActiveAt", created_at AS "createdAt"
         FROM students WHERE student_id = $1`,
        [studentId]
      );
      const binding = await db.get(
        `SELECT relation, status AS "bindingStatus", claimed_at AS "claimedAt", created_at AS "createdAt"
         FROM parent_children WHERE parent_id = $1 AND student_id = $2`,
        [req._balashiParentId, studentId]
      );
      const consentRecords = await db.all(
        // Scoped by student_id only: rows are evidence about THIS child's
        // use of the service. A former (archived) binder's child-bound
        // capture would also match — parent_id is deliberately not
        // selected, so no other-parent identifier is ever exported.
        `SELECT consent_id AS "consentId", policy_version AS "policyVersion",
                captured_at AS "capturedAt", method, created_at AS "createdAt"
         FROM consent_records WHERE student_id = $1 ORDER BY captured_at ASC`,
        [studentId]
      );
      const settingsRow = await db.get(
        `SELECT s.* FROM portal_child_settings s WHERE s.parent_id = $1 AND s.student_id = $2`,
        [req._balashiParentId, studentId]
      );
      const attempts = await db.all(
        `SELECT attempt_id AS "attemptId", session_type AS "sessionType", session_id AS "sessionId",
                unit_id AS "unitId", topic_id AS "topicId", question_id AS "questionId",
                chosen_answer AS "chosenAnswer", is_correct AS "isCorrect",
                raw_time_sec AS "rawTimeSec", audio_duration_sec AS "audioDurationSec",
                cognitive_time_sec AS "cognitiveTimeSec", fluency_grade AS "fluencyGrade",
                misconception_tags_json AS "misconceptionTags", device_id AS "deviceId",
                client_seq AS "clientSeq", attempted_at AS "attemptedAt"
         FROM student_question_attempts WHERE student_id = $1 ORDER BY attempted_at ASC, attempt_id ASC`,
        [studentId]
      );
      const topicProgress = await db.all(
        `SELECT topic_id AS "topicId", unit_id AS "unitId", topic_code AS "topicCode", completed,
                crowns, mastery_score AS "masteryScore", best_accuracy_pct AS "bestAccuracyPct",
                best_median_speed_sec AS "bestMedianSpeedSec", attempts_count AS "attemptsCount",
                fluency_grade AS "fluencyGrade", stability_days AS "stabilityDays",
                next_review_at AS "nextReviewAt", last_reviewed_at AS "lastReviewedAt"
         FROM student_topic_progress WHERE student_id = $1 ORDER BY topic_id ASC`,
        [studentId]
      );
      const unitProgress = await db.all(
        `SELECT unit_id AS "unitId", status, key_state AS "keyState",
                best_accuracy_pct AS "bestAccuracyPct", best_median_speed_sec AS "bestMedianSpeedSec",
                attempts_count AS "attemptsCount", stability_days AS "stabilityDays",
                last_reviewed_at AS "lastReviewedAt", cpa_stage AS "cpaStage", updated_at AS "updatedAt"
         FROM student_unit_progress WHERE student_id = $1 ORDER BY unit_id ASC`,
        [studentId]
      );
      // Live credential columns are NEVER exported: the student session
      // token IS the bearer; device token_hash is the credential verifier.
      const sessions = await db.all(
        `SELECT created_at AS "createdAt", expires_at AS "expiresAt"
         FROM student_sessions WHERE student_id = $1 ORDER BY created_at ASC`,
        [studentId]
      );
      const deviceSessions = await db.all(
        `SELECT session_id AS "sessionId", device_id AS "deviceId", created_at AS "createdAt",
                expires_at AS "expiresAt", revoked_at AS "revokedAt",
                revocation_reason AS "revocationReason", last_seen_at AS "lastSeenAt"
         FROM child_device_sessions WHERE student_id = $1 ORDER BY created_at ASC`,
        [studentId]
      );
      const xpEvents = await db.all(
        `SELECT id, session_type AS "sessionType", session_id AS "sessionId", unit_id AS "unitId",
                topic_id AS "topicId", xp_amount AS "xpAmount", reason, awarded_at AS "awardedAt"
         FROM student_xp_events WHERE student_id = $1 ORDER BY awarded_at ASC, id ASC`,
        [studentId]
      );
      const badgeAwards = await db.all(
        `SELECT badge_id AS "badgeId", scope, awarded_at AS "awardedAt"
         FROM student_badge_awards WHERE student_id = $1 ORDER BY awarded_at ASC`,
        [studentId]
      );
      const gamificationState = await db.get(
        `SELECT total_xp AS "totalXp", best_beat_target_pct AS "bestBeatTargetPct",
                last_active_day_key AS "lastActiveDayKey", updated_at AS "updatedAt"
         FROM student_gamification_state WHERE student_id = $1`,
        [studentId]
      );
      const sessionOutcomes = await db.all(
        `SELECT id, device_id AS "deviceId", session_id AS "sessionId", session_type AS "sessionType",
                stage, hearts_lost AS "heartsLost", hearts_remaining AS "heartsRemaining",
                end_reason AS "endReason", ended_at AS "endedAt", created_at AS "createdAt"
         FROM student_session_outcomes WHERE student_id = $1 ORDER BY ended_at ASC, id ASC`,
        [studentId]
      );
      const placementRecords = await db.all(
        `SELECT id, grade_id AS "gradeId", recommended_start_unit_id AS "recommendedStartUnitId",
                credited_units_json AS "creditedUnits", per_strand_json AS "perStrand",
                items_asked AS "itemsAsked", session_id AS "sessionId", placed_at AS "placedAt",
                updated_at AS "updatedAt"
         FROM student_placement_records WHERE student_id = $1 ORDER BY placed_at ASC, id ASC`,
        [studentId]
      );

      // Parity block: identical code path to the portal endpoints, so the
      // export's numbers are the portal's numbers.
      const nowMs = Date.now();
      const analytics = {
        quadrant: await quadrantPointsForChild(db, studentId),
        weekly: await weeklySeriesForChild(db, studentId, 8, nowMs)
      };

      const document = {
        formatVersion: EXPORT_FORMAT_VERSION,
        exportedAt: new Date(nowMs).toISOString(),
        studentId,
        profile,
        binding,
        consentRecords,
        portalSettings: settingsRow
          ? { ...effectiveChildSettings(settingsRow), updatedAt: settingsRow.updated_at }
          : effectiveChildSettings(null),
        attempts,
        topicProgress,
        unitProgress,
        sessions,
        deviceSessions,
        gamification: { xpEvents, badgeAwards, state: gamificationState ?? null },
        sessionOutcomes,
        placementRecords,
        analytics
      };

      // Charset-stripped id in the filename: header/CRLF-safe by
      // construction even if the id scheme ever widens (ids are app-minted
      // today; this is defense-in-depth, reviewer advisory).
      const safeId = String(studentId).replace(/[^A-Za-z0-9_-]/g, "_");
      const filename = `balashikshana-data-export-${safeId}-${new Date(nowMs).toISOString().slice(0, 10)}.json`;
      reply.header("Content-Disposition", `attachment; filename="${filename}"`);
      return document;
    }
  );

  // --- Deletion ----------------------------------------------------------------

  app.delete(
    "/api/portal/children/:studentId",
    {
      schema: {
        params: studentIdParam,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["password"],
          properties: {
            password: { type: "string", minLength: PASSWORD_MIN, maxLength: PASSWORD_MAX }
          }
        }
      },
      // Password-verification surface: the login-bucket doctrine applies
      // behind the token (a stolen session must not brute-force the
      // password to escalate into destructive action). Env-configurable
      // like every route-level bucket (RATE_LIMIT_DELETE_PER_IP_MIN).
      config: {
        rateLimit: rateLimits?.delete ?? { max: 5, timeWindow: "1 minute" }
      }
    },
    async (req, reply) => {
      const session = await requireParentAuth(db, req, reply);
      if (!session) return reply;
      const child = await requireOwnedChild(db, req, reply, req.params.studentId);
      if (!child) return reply;

      // Password re-authentication against the account's stored hash.
      const parent = await db.get("SELECT password_hash FROM parents WHERE parent_id = $1", [
        req._balashiParentId
      ]);
      if (!parent || !verifyPin(req.body.password, parent.password_hash)) {
        return sendProblem(reply, 401, {
          type: `${PROBLEM_BASE}/re-auth-required`,
          title: "Re-authentication failed",
          detail: "Deleting your child's data requires your account password."
        });
      }

      // Policy version in force at deletion (what the retained consent
      // evidence references); the audit row records it.
      const activePolicy = await getActivePolicyVersion(db);
      const policyVersion = activePolicy?.version ?? "unknown";

      const studentId = child.student_id;
      const result = await db.withTransaction(async (client) => {
        // Serialize concurrent deletions of the same child on the row
        // itself. The guard ran OUTSIDE this transaction, so the lock is
        // also an existence RE-CHECK: a concurrent winner may have deleted
        // the child in the window. A vanished row aborts with the sentinel
        // — never a phantom zero-count audit row for work someone else
        // already did (found by the tester's interleaved-lock test).
        const locked = await client.query("SELECT 1 FROM students WHERE student_id = $1 FOR UPDATE", [studentId]);
        if ((locked.rowCount ?? 0) === 0) {
          return { vanished: true };
        }

        const counts = {};
        const del = async (table) => {
          const res = await client.query(`DELETE FROM ${table} WHERE student_id = $1`, [studentId]);
          counts[table] = res.rowCount ?? 0;
        };

        // The issue's cascade order: attempts -> topic progress -> unit
        // progress -> sessions/device sessions, then every remaining
        // child-data table, then the binding, then the profile row.
        await del("student_question_attempts");
        await del("student_topic_progress");
        await del("student_unit_progress");
        await del("student_sessions");
        await del("child_device_sessions");
        await del("student_xp_events");
        await del("student_badge_awards");
        await del("student_gamification_state");
        await del("student_session_outcomes");
        await del("student_placement_records");
        await del("portal_child_settings");
        await del("parent_children");

        // Consent evidence: RETAINED, linkage severed (the COPPA posture
        // in the module header). Count goes to the audit row.
        const detached = await client.query(
          "UPDATE consent_records SET student_id = NULL WHERE student_id = $1",
          [studentId]
        );

        // The child profile row last; schema CASCADE is the backstop for
        // any child table without an explicit statement above.
        await del("students");

        const audit = await client.query(
          `INSERT INTO deletion_audit
             (audit_id, parent_id, student_id, policy_version, scope, consent_records_detached, deleted_counts)
           VALUES ($1, $2, $3, $4, 'child-data', $5, $6::jsonb::text)
           RETURNING audit_id, deleted_at`,
          [
            newAuditId(),
            req._balashiParentId,
            studentId,
            policyVersion,
            detached.rowCount ?? 0,
            JSON.stringify(counts)
          ]
        );
        return { counts, detached: detached.rowCount ?? 0, audit: audit.rows[0] };
      });

      if (result.vanished) {
        // The child disappeared between the guard and the lock (a
        // concurrent deletion won): the uniform scoped-404, exactly as a
        // repeat request.
        return sendProblem(reply, 404, {
          type: `${PROBLEM_BASE}/child-not-found`,
          detail: "No such child is linked to this parent account."
        });
      }

      return {
        deleted: true,
        studentId,
        auditId: result.audit.audit_id,
        deletedAt: result.audit.deleted_at,
        scope: "child-data",
        consentRecordsDetached: result.detached,
        deletedCounts: result.counts
      };
    }
  );
};
