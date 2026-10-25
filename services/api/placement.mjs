// Placement record routes + server-side placement derivation helpers
// (issue #60, roadmap E10).
//
//   GET /api/placement/record?gradeId=<grade>   the authoritative
//                                               placement outcome for a
//                                               child's grade (404 when
//                                               none was ever derived)
//
// Doctrine (mirrors sync.mjs):
// - CHILD-DEVICE TOKENS ONLY (the #48 dual-token doctrine): the record
//   describes the child's own attempt stream; parent tokens and student
//   PIN sessions are a uniform 403 wrong-token-type. Consent-gated like
//   every child-data read.
// - The record is a SERVER DERIVATION of the append-only PLACEMENT
//   attempt stream, produced by the reconciler inside the sync
//   transaction through the SAME core-engine placement module the RN
//   client runs (derivePlacementOutcome). There is deliberately NO
//   submit endpoint: the client uploads attempts (POST /api/sync/attempts,
//   sessionType PLACEMENT) and the server recomputes — the D8 shape,
//   identical to how topic/gate/game progress materializes.
// - COPPA: unit ids and counts only; no PII, no free text.
//
// The helpers below (placementUnitsForGrade, upsertPlacementRecord) are
// the reconciler's seams — shared, not forked.

import fp from "fastify-plugin";
import { sendProblem, PROBLEM_BASE } from "./problem.mjs";
import { resolveBearerAuth } from "./parent-auth.mjs";
import { requireConsentForStudent } from "./consent.mjs";
import { derivePlacementOutcome } from "../../packages/core-engine/src/index.mjs";

/**
 * Engine placement units for a grade, straight off the units table:
 * { unitId, strand (= registry subject), sequenceOrder, title,
 *   prerequisiteUnitIds, masteryGate.maxMedianResponseTimeSec } — exactly
 * the shape the engine's outcome derivation consumes. skillTopics are
 * NOT loaded here: item selection is client-side; the server only
 * re-derives outcomes from uploaded facts.
 */
export async function placementUnitsForGrade(client, gradeId) {
  const rows = await client.query(
    `SELECT unit_id, subject, sequence_order, title, prerequisite_unit_ids_json, gate_max_speed_sec
     FROM units WHERE grade_id = $1 ORDER BY subject ASC, sequence_order ASC, unit_id ASC`,
    [gradeId]
  );
  return rows.rows.map((row) => ({
    unitId: row.unit_id,
    strand: row.subject,
    sequenceOrder: row.sequence_order,
    title: row.title,
    prerequisiteUnitIds: safeParseIds(row.prerequisite_unit_ids_json),
    masteryGate: { maxMedianResponseTimeSec: row.gate_max_speed_sec }
  }));
}

function safeParseIds(json) {
  try {
    const parsed = JSON.parse(json || "[]");
    return Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Derives the placement outcome over a session's FULL union of attempt
 * rows (prior + new — the #48 convergence seam) and upserts the record.
 * Called ONLY inside the reconciler's transaction; pure w.r.t. inputs
 * beyond `client`.
 */
export async function deriveAndStorePlacementRecord(client, { studentId, gradeId, sessionId, sessionMs, responses }) {
  const units = await placementUnitsForGrade(client, gradeId);
  const outcome = derivePlacementOutcome({ responses, units });
  const creditedUnits = outcome.creditedUnits.map((unit) => ({
    strand: unit.strand,
    unitIds: [unit.unitId],
    topics: unit.topics.map((topic) => ({
      topicId: topic.topicId,
      provisionalStabilityDays: topic.provisionalStabilityDays
    }))
  }));
  // Group per strand for the compact record shape.
  const byStrand = new Map();
  for (const entry of creditedUnits) {
    const existing = byStrand.get(entry.strand) ?? { strand: entry.strand, unitIds: [], topics: [] };
    existing.unitIds.push(...entry.unitIds);
    existing.topics.push(...entry.topics);
    byStrand.set(entry.strand, existing);
  }
  const placedAt = new Date(sessionMs).toISOString();
  await client.query(
    `INSERT INTO student_placement_records (
       student_id, grade_id, recommended_start_unit_id, credited_units_json,
       per_strand_json, items_asked, session_id, placed_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
     ON CONFLICT (student_id, grade_id) DO UPDATE SET
       recommended_start_unit_id = excluded.recommended_start_unit_id,
       credited_units_json = excluded.credited_units_json,
       per_strand_json = excluded.per_strand_json,
       items_asked = excluded.items_asked,
       session_id = excluded.session_id,
       placed_at = excluded.placed_at,
       updated_at = now()`,
    [
      studentId,
      gradeId,
      outcome.recommendedStartUnitId,
      JSON.stringify([...byStrand.values()]),
      JSON.stringify(outcome.perStrand),
      outcome.itemsAsked,
      sessionId,
      placedAt
    ]
  );
  return outcome;
}

/** The record row in wire shape (camelCase, engine vocabulary only). */
export function placementRecordWire(row) {
  return {
    gradeId: row.grade_id,
    recommendedStartUnitId: row.recommended_start_unit_id,
    creditedUnits: row.credited_units_json,
    perStrand: row.per_strand_json,
    itemsAsked: row.items_asked,
    sessionId: row.session_id,
    placedAt: row.placed_at
  };
}

export const placementPlugin = fp(async (app, options) => {
  const db = options.db;

  app.get(
    "/api/placement/record",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["gradeId"],
          properties: {
            gradeId: { type: "string", minLength: 1, maxLength: 32 }
          }
        }
      }
    },
    async (req, reply) => {
      const auth = await resolveBearerAuth(db, req.headers.authorization);
      if (auth.error) {
        return sendProblem(reply, 401, { type: `${PROBLEM_BASE}/unauthorized`, detail: auth.error });
      }
      if (auth.kind !== "child-device") {
        return sendProblem(reply, 403, {
          type: `${PROBLEM_BASE}/wrong-token-type`,
          detail: "Placement records are read under child device session tokens (issue #60); parent and student PIN sessions cannot read them."
        });
      }
      const scoped = auth.childSession;
      const stuRow = await db.get("SELECT status FROM students WHERE student_id = $1", [scoped.student_id]);
      if (!stuRow || stuRow.status === "archived") {
        return sendProblem(reply, 403, {
          type: `${PROBLEM_BASE}/child-archived`,
          detail: "This child profile has been archived by its parent."
        });
      }
      if (!(await requireConsentForStudent(db, req, reply, scoped.student_id))) return reply;

      const row = await db.get(
        `SELECT grade_id, recommended_start_unit_id, credited_units_json, per_strand_json,
                items_asked, session_id, placed_at
         FROM student_placement_records
         WHERE student_id = $1 AND grade_id = $2`,
        [scoped.student_id, req.query.gradeId]
      );
      if (!row) {
        return sendProblem(reply, 404, {
          type: `${PROBLEM_BASE}/placement-not-found`,
          title: "No placement record",
          detail: "No placement diagnostic has been synced for this grade yet."
        });
      }
      return placementRecordWire(row);
    }
  );
});
