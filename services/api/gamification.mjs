// Gamification ledger route (issue #55, roadmap D9) — the kid-facing read.
//
//   GET /api/students/:studentId/gamification/ledger
//
// Doctrine:
// - STUDENT-SCOPED READ, exactly like GET /api/students/:studentId:
//   student PIN sessions and child-device tokens may read THEIR bound
//   student's ledger; a parent token is a 403 wrong-token-type (parent
//   reward views are #61/M5, deliberately not this surface); archived
//   children fail 403 child-archived (the archive freeze). The student
//   binding comes from the TOKEN, never the path, so a session can only
//   ever read its own child's rewards.
// - Everything displayed is engine-derived (levels via levelForXp,
//   badge metadata via the engine catalog); the route owns no math.
// - Errors are problem+json per house style. Read-only: no consent gate
//   (same as the other student reads — consent gates WRITES).

import fp from "fastify-plugin";
import { sendProblem, PROBLEM_BASE } from "./problem.mjs";
import { resolveBearerAuth } from "./parent-auth.mjs";
import { getGamificationLedger } from "./rewards.mjs";

export const gamificationPlugin = fp(async (app, options) => {
  const db = options.db;

  app.get("/api/students/:studentId/gamification/ledger", async (req, reply) => {
    const studentId = req.params.studentId;

    const auth = await resolveBearerAuth(db, req.headers.authorization);
    if (auth.error) {
      return sendProblem(reply, 401, { type: `${PROBLEM_BASE}/unauthorized`, detail: auth.error });
    }
    if (auth.kind === "parent") {
      return sendProblem(reply, 403, {
        type: `${PROBLEM_BASE}/wrong-token-type`,
        detail: "Parent session tokens cannot access student gamification surfaces."
      });
    }
    const scoped = auth.session || auth.childSession;
    if (scoped.student_id !== studentId) {
      return sendProblem(reply, 403, {
        type: `${PROBLEM_BASE}/forbidden`,
        detail: "Session does not grant access to this student"
      });
    }
    const stuRow = await db.get("SELECT status FROM students WHERE student_id = $1", [studentId]);
    if (!stuRow || stuRow.status === "archived") {
      // Same fold as requireStudentAccess: an archived (or vanished)
      // profile is the archive freeze, never a data oracle.
      return sendProblem(reply, 403, {
        type: `${PROBLEM_BASE}/child-archived`,
        detail: "This child profile has been archived by its parent."
      });
    }

    return getGamificationLedger(db, studentId);
  });
});
