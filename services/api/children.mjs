// Child profiles under parents (issue #42, roadmap D4 — the M2 capstone):
// parent-scoped child-profile creation/listing, the legacy standalone-student
// claim-or-archive flow, and the child device-session mint/revoke that gives
// the #40 dual-token doctrine its third kind ('child-device').
//
// Doctrine:
// - Every child-data-creating route here runs BEHIND the #41 consent gates:
//   create and claim require a verified parent with current-version standing
//   consent (requireParentWithCurrentConsent) and write the student-scoped
//   binding consent row INSIDE their transaction — the same attribution
//   doctrine as #41's POST /api/students, extended to the claim path so a
//   claimed legacy student leaves audit_students_without_consent at zero.
//   Device-session minting requires current-version consent FOR the student
//   (requireConsentForStudent); minting creates no child-data rows, so the
//   invariant is preserved trivially.
// - TOCTOU hardening (#41 reviewer advisory): the active policy version is
//   re-checked INSIDE every creation transaction (assertActivePolicyUnchanged
//   below) — a policy flipped between the gate check and the commit aborts
//   the whole transaction instead of binding evidence to a stale version.
// - Claim anti-hijack (the security core): a claim requires (1) a verified,
//   current-consent parent, (2) proof of knowledge of the student's username
//   AND PIN (the shared scrypt verifyPin, with a dummy-hash verification on
//   the unknown-student path so unknown/wrong fail identically in body and
//   timing — M1 anti-enumeration), and (3) students.status = 'legacy' — the
//   migration-005 population of standalone students. Exactly-once is
//   enforced atomically: the students-row status flip (legacy -> active) is
//   the claim mutex (the row lock serializes racing parents), backed by the
//   partial unique index uq_parent_children_claimed_student at the database
//   level. Nothing is ever auto-adopted: a legacy student stays unclaimed
//   until a parent explicitly claims it.
// - Child device tokens are scoped to exactly ONE student and ONE device by
//   their session row, stored hashed at rest (SHA-256 of the 32-byte
//   base64url value — #40 parent-token doctrine; the raw value is returned
//   exactly once and never logged), expire absolutely (30 days), and die
//   immediately on revocation (soft revoke keeps lifecycle evidence; the
//   bearer resolver rejects revoked rows). Device binding scopes ISSUANCE
//   and REVOCATION — revoking one device's session leaves another device's
//   session working; there is no per-request device attestation in scope
//   (that is future client work, #61+).
// - Archive removes the child from the login-screen listing, refuses mints,
//   revokes every live child device session, and deletes M1 student
//   sessions; the archived status on the students row additionally fails
//   requireStudentAccess and PIN login (server.mjs).
// - PINs: children use the SHARED db.mjs scrypt helpers and parameters
//   (hashPinScrypt / SCRYPT_PARAMS — identical hardening to M1; the issue
//   forbids forked parameters). No route accepts a client-supplied stored
//   hash, and no PII is logged (parentId/studentId keyed only).
//
// Rate limiting: claim presents student credentials and is a PIN-guessing
// surface — it gets a dedicated route-level bucket (the M1 login-bucket
// pattern). Every other route here presents a parent bearer token and sits
// behind the global per-IP + per-token buckets (the #40/#41 precedent).

import crypto from "node:crypto";
import { hashPinScrypt, verifyPin, createSessionToken } from "./db.mjs";
import { requireParentAuth, sha256Hex } from "./parent-auth.mjs";
import { sendProblem, PROBLEM_BASE } from "./problem.mjs";
import {
  requireParentWithCurrentConsent,
  requireConsentForStudent,
  sendConsentRequired
} from "./consent.mjs";

const CHILD_DEVICE_SESSION_TTL_MS = 30 * 86400000;

// Equalizes claim timing between unknown-student and wrong-PIN paths (same
// pattern as the M1 login dummy hash; a distinct constant so the surfaces
// can evolve independently).
const DUMMY_STUDENT_PIN_HASH = hashPinScrypt("claim-timing-equalizer");

// Exported since #70: the B2B roster-import stub validates roster grade
// values against the SAME registry id set — one grade vocabulary, no fork.
export const GRADE_IDS = ["pre-k", "kindergarten", "grade-1", "grade-2", "grade-3"];
const PLATFORMS = ["ios", "android", "web"];
const RELATION_MAX_LENGTH = 32;

function newChildSessionId() {
  return `cds-${crypto.randomBytes(10).toString("hex")}`;
}

function newDeviceId() {
  return `dev-${crypto.randomBytes(10).toString("hex")}`;
}

// --- Shared creation core (children.mjs + POST /api/students) ------------------

// Thrown inside a creation transaction when the active policy version no
// longer matches the version the pre-transaction gate validated (#41
// reviewer advisory: close the gate-to-commit TOCTOU window atomically).
// currentVersion is the newly-active version, or null when no active policy
// remains (fail closed).
export class PolicyDriftError extends Error {
  constructor(currentVersion) {
    super("The active consent policy version changed during the request");
    this.name = "PolicyDriftError";
    this.currentVersion = currentVersion;
  }
}

// Maps a PolicyDriftError to the correct problem response: a drifted
// version is a consent-required 403 carrying the new version (the client
// re-renders the policy and re-consents); a vanished policy fails closed
// like the pre-txn requireActivePolicy check (500).
export function sendPolicyDrift(reply, err) {
  if (err.currentVersion == null) {
    return sendProblem(reply, 500, {
      type: `${PROBLEM_BASE}/internal`,
      detail: "No active consent policy version is configured."
    });
  }
  return sendConsentRequired(reply, err.currentVersion);
}

export async function assertActivePolicyUnchanged(client, expectedVersion) {
  const res = await client.query(
    "SELECT version FROM consent_policy_versions WHERE active = true ORDER BY created_at DESC LIMIT 1"
  );
  const current = res.rows[0]?.version ?? null;
  if (current !== expectedVersion) {
    throw new PolicyDriftError(current);
  }
}

// The one implementation of "a student row comes into existence bound to a
// parent with standing consent": students row (+ prerequisite-grade unlock
// seeds), parent_children binding ('claimed'), and the student-scoped
// binding consent row — all inside the caller's transaction, after the
// in-transaction policy re-check. Used by POST /api/parent/children and
// (via server.mjs) POST /api/students so no creation path can produce a
// standalone student.
export async function insertStudentProfile(client, params) {
  const {
    studentId,
    username,
    pin,
    nickname,
    avatar,
    ageYears,
    gradeId,
    motorBaselineSec,
    nowIso,
    parentId,
    relation,
    policyVersion,
    standingMethod
  } = params;

  await assertActivePolicyUnchanged(client, policyVersion);

  await client.query(
    `INSERT INTO students (
      student_id, username, pin_hash, nickname, avatar, age_years,
      current_grade, motor_baseline_sec, streak_days, star_coins, hearts,
      last_active_at, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 50, 5, $9, $10)`,
    [studentId, username, hashPinScrypt(pin), nickname, avatar, ageYears, gradeId, motorBaselineSec, nowIso, nowIso]
  );

  // Unlock prerequisite grade final units so the chosen grade's Unit 1 is unlocked
  const prereqSeeds = {
    kindergarten: ["PK-M7", "PK-E7"],
    "grade-1": ["K-M10", "K-E9", "K-S5", "K-SS4"],
    "grade-2": ["G1-M9", "G1-E10", "G1-S5", "G1-SS4"],
    "grade-3": ["G2-M9", "G2-E10", "G2-S6", "G2-SS4"]
  };
  for (const pid of prereqSeeds[gradeId] || []) {
    await client.query(
      `INSERT INTO student_unit_progress (
        student_id, unit_id, status, key_state, best_accuracy_pct,
        best_median_speed_sec, attempts_count, stability_days,
        last_reviewed_at, cpa_stage, updated_at
      ) VALUES ($1, $2, 'MASTERED', 'GOLD_KEY', 90.0, 4.5, 1, 21.0, $3, 'PURE_ABSTRACT_SYMBOLIC', $4)
      ON CONFLICT (student_id, unit_id) DO UPDATE SET
        status = 'MASTERED', key_state = 'GOLD_KEY'`,
      [studentId, pid, nowIso, nowIso]
    );
  }

  await client.query(
    "INSERT INTO parent_children (parent_id, student_id, relation, status, claimed_at) VALUES ($1, $2, $3, 'claimed', now())",
    [parentId, studentId, relation]
  );

  // Student-scoped consent binding row (#41 attribution doctrine, extended
  // to every #42 creation path): the standing consent just validated by the
  // gate, attributed to this child at creation time.
  await client.query(
    `INSERT INTO consent_records (consent_id, parent_id, student_id, policy_version, method)
     VALUES ($1, $2, $3, $4, $5)`,
    [`con-${crypto.randomBytes(10).toString("hex")}`, parentId, studentId, policyVersion, standingMethod]
  );
}

// Devices upsert on the (parent_id, client_device_id) unique index: a
// re-seen device keeps its device_id (sessions stay bound to it) and
// refreshes platform + last_seen_at. Returns the device row.
async function upsertDevice(client, parentId, clientDeviceId, platform) {
  const res = await client.query(
    `INSERT INTO devices (device_id, parent_id, client_device_id, platform)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (parent_id, client_device_id) DO UPDATE SET
       platform = EXCLUDED.platform, last_seen_at = now()
     RETURNING device_id`,
    [newDeviceId(), parentId, clientDeviceId, platform]
  );
  return res.rows[0];
}

// Derives the same nickname/username/grade/age defaults POST /api/students
// has used since M1 so both creation paths produce identical profile shapes.
function deriveProfileDefaults(payload) {
  const nickname = String(payload.nickname || "Explorer").trim();
  const baseUsername = String(payload.username || nickname).toLowerCase().replace(/[^a-z0-9]/g, "") || "student";
  const gradeId = payload.currentGrade || "kindergarten";
  const ageYears =
    Number(payload.ageYears) ||
    (gradeId === "pre-k" ? 4 : gradeId === "kindergarten" ? 5 : gradeId === "grade-1" ? 6 : gradeId === "grade-2" ? 7 : 8);
  const avatar = payload.avatar || "\u{1F43C}";
  return { nickname, baseUsername, gradeId, ageYears, avatar };
}

// Bounded unique-username retry (the M1 convention): if the base name (or a
// randomly drawn suffix) is taken, draw again instead of failing the insert.
async function availableUsername(db, baseUsername) {
  let username = baseUsername;
  let existing = await db.get("SELECT student_id FROM students WHERE username = $1", [username]);
  for (let attempt = 0; existing && attempt < 8; attempt += 1) {
    username = `${baseUsername}${Math.floor(100 + Math.random() * 900)}`;
    existing = await db.get("SELECT student_id FROM students WHERE username = $1", [username]);
  }
  return username;
}

// --- Fastify plugin ------------------------------------------------------------

export const childrenPlugin = async function childrenPlugin(app, opts) {
  const { db, rateLimits } = opts;

  const pinField = { type: "string", pattern: "^[0-9]{4}$" };
  const createChildSchema = {
    body: {
      type: "object",
      additionalProperties: false,
      required: ["pin", "clientDeviceId", "platform"],
      properties: {
        nickname: { type: "string", maxLength: 32 },
        username: { type: "string", maxLength: 32 },
        pin: pinField,
        currentGrade: { type: "string", enum: GRADE_IDS },
        ageYears: { type: "number", minimum: 3, maximum: 10 },
        avatar: { type: "string", maxLength: 8 },
        relation: { type: "string", minLength: 1, maxLength: RELATION_MAX_LENGTH },
        clientDeviceId: { type: "string", minLength: 8, maxLength: 128 },
        platform: { type: "string", enum: PLATFORMS }
      }
    }
  };

  // GET /api/parent/children -> the caller's bindings with child profiles
  // and active device-session counts (the #61 portal surface). Archived
  // children are included with their status — the portal manages them.
  app.get("/api/parent/children", async (req, reply) => {
    const session = await requireParentAuth(db, req, reply);
    if (!session) return reply;
    const rows = await db.all(
      `SELECT pc.student_id, pc.relation, pc.status AS binding_status, pc.claimed_at, pc.archived_at,
              s.username, s.nickname, s.avatar, s.age_years, s.current_grade, s.status AS student_status,
              (SELECT COUNT(*)::int FROM child_device_sessions cds
               WHERE cds.student_id = pc.student_id AND cds.revoked_at IS NULL AND cds.expires_at > now()) AS active_device_sessions
       FROM parent_children pc
       JOIN students s ON s.student_id = pc.student_id
       WHERE pc.parent_id = $1
       ORDER BY pc.claimed_at ASC`,
      [session.parent_id]
    );
    return {
      parentId: session.parent_id,
      children: rows.map((r) => ({
        studentId: r.student_id,
        username: r.username,
        nickname: r.nickname,
        avatar: r.avatar,
        ageYears: r.age_years,
        currentGrade: r.current_grade,
        relation: r.relation,
        status: r.binding_status,
        claimedAt: r.claimed_at,
        archivedAt: r.archived_at,
        activeDeviceSessions: r.active_device_sessions
      }))
    };
  });

  // POST /api/parent/children -> create a child profile bound to the caller
  // (the D4 canonical creation path). One transaction: in-txn policy
  // re-check, students row, parent_children binding, binding consent row,
  // devices upsert. No session token is issued here — parents mint child
  // device sessions explicitly (device-sessions below).
  app.post("/api/parent/children", { schema: createChildSchema }, async (req, reply) => {
    const gate = await requireParentWithCurrentConsent(db, req, reply);
    if (!gate) return reply;

    const payload = req.body;
    const { nickname, baseUsername, gradeId, ageYears, avatar } = deriveProfileDefaults(payload);
    const username = await availableUsername(db, baseUsername);
    const studentId = `stu-${username}-${Date.now().toString().slice(-4)}`;
    const now = new Date().toISOString();

    let deviceId;
    try {
      deviceId = await db.withTransaction(async (client) => {
        await insertStudentProfile(client, {
          studentId,
          username,
          pin: payload.pin,
          nickname,
          avatar,
          ageYears,
          gradeId,
          motorBaselineSec: ageYears <= 4 ? 0.55 : ageYears <= 6 ? 0.44 : 0.34,
          nowIso: now,
          parentId: gate.parentSession.parent_id,
          relation: payload.relation || "guardian",
          policyVersion: gate.policy.version,
          standingMethod: gate.standing.method
        });
        const device = await upsertDevice(client, gate.parentSession.parent_id, payload.clientDeviceId, payload.platform);
        return device.device_id;
      });
    } catch (err) {
      if (err instanceof PolicyDriftError) return sendPolicyDrift(reply, err);
      throw err;
    }
    req._balashiParentId = gate.parentSession.parent_id;

    return reply.code(201).send({
      studentId,
      username,
      nickname,
      avatar,
      ageYears,
      currentGrade: gradeId,
      relation: payload.relation || "guardian",
      parentId: gate.parentSession.parent_id,
      deviceId,
      consent: { policyVersion: gate.policy.version, method: gate.standing.method }
    });
  });

  // POST /api/parent/children/claim -> claim a LEGACY standalone student
  // (the M2 §3 migration story). Anti-hijack: verified + current-consent
  // parent, username+PIN proof of knowledge, legacy-status-only eligibility,
  // atomic exactly-once via the students-row status mutex.
  app.post(
    "/api/parent/children/claim",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["username", "pin"],
          properties: {
            username: { type: "string", minLength: 1, maxLength: 64 },
            pin: pinField,
            relation: { type: "string", minLength: 1, maxLength: RELATION_MAX_LENGTH }
          }
        }
      },
      config: { rateLimit: rateLimits.claim }
    },
    async (req, reply) => {
      const gate = await requireParentWithCurrentConsent(db, req, reply);
      if (!gate) return reply;

      const uname = String(req.body.username).trim().toLowerCase();
      const relation = req.body.relation || "guardian";
      // Byte-identical refusal for unknown student, wrong PIN, and archived
      // student (the archived state is not an enumeration oracle; PIN login
      // behaves the same way).
      const claimRejected = () =>
        sendProblem(reply, 403, {
          type: `${PROBLEM_BASE}/claim-rejected`,
          detail: "Claim rejected: the username or PIN does not match an unclaimed student."
        });

      const stuRow = await db.get(
        "SELECT * FROM students WHERE LOWER(username) = $1 OR LOWER(nickname) = $2",
        [uname, uname]
      );
      if (!stuRow) {
        verifyPin(req.body.pin, DUMMY_STUDENT_PIN_HASH);
        return claimRejected();
      }
      if (!verifyPin(req.body.pin, stuRow.pin_hash)) {
        return claimRejected();
      }
      if (stuRow.status === "archived") {
        return claimRejected();
      }
      if (stuRow.status !== "legacy") {
        // Claimed/active: the exactly-once rejection the issue requires.
        return sendProblem(reply, 409, {
          type: `${PROBLEM_BASE}/already-claimed`,
          detail: "This student is already claimed by a parent."
        });
      }

      let claimedAt;
      try {
        claimedAt = await db.withTransaction(async (client) => {
          // The claim mutex: flipping legacy -> active takes the row lock,
          // so racing claimants serialize and exactly one wins; a loser
          // sees rowCount 0 (someone claimed in front of it). The partial
          // unique index uq_parent_children_claimed_student is the DB-level
          // backstop under this lock.
          const flip = await client.query(
            "UPDATE students SET status = 'active' WHERE student_id = $1 AND status = 'legacy' RETURNING student_id",
            [stuRow.student_id]
          );
          if (flip.rowCount === 0) return null;

          // The binding consent row attributes the parent's standing
          // consent to the claimed child (in-txn policy re-check inside):
          // after a claim the student leaves audit_students_without_consent.
          await assertActivePolicyUnchanged(client, gate.policy.version);
          await client.query(
            "INSERT INTO parent_children (parent_id, student_id, relation, status, claimed_at) VALUES ($1, $2, $3, 'claimed', now())",
            [gate.parentSession.parent_id, stuRow.student_id, relation]
          );
          await client.query(
            `INSERT INTO consent_records (consent_id, parent_id, student_id, policy_version, method)
             VALUES ($1, $2, $3, $4, $5)`,
            [
              `con-${crypto.randomBytes(10).toString("hex")}`,
              gate.parentSession.parent_id,
              stuRow.student_id,
              gate.policy.version,
              gate.standing.method
            ]
          );
          const stamped = await client.query(
            "SELECT claimed_at FROM parent_children WHERE parent_id = $1 AND student_id = $2",
            [gate.parentSession.parent_id, stuRow.student_id]
          );
          return stamped.rows[0].claimed_at;
        });
      } catch (err) {
        if (err instanceof PolicyDriftError) return sendPolicyDrift(reply, err);
        if (err.code === "23505") {
          // Partial unique index backstop fired (defense in depth).
          return sendProblem(reply, 409, {
            type: `${PROBLEM_BASE}/already-claimed`,
            detail: "This student is already claimed by a parent."
          });
        }
        throw err;
      }

      if (claimedAt === null) {
        return sendProblem(reply, 409, {
          type: `${PROBLEM_BASE}/already-claimed`,
          detail: "This student is already claimed by a parent."
        });
      }
      req._balashiParentId = gate.parentSession.parent_id;

      return reply.code(201).send({
        studentId: stuRow.student_id,
        username: stuRow.username,
        nickname: stuRow.nickname,
        relation,
        status: "claimed",
        parentId: gate.parentSession.parent_id,
        claimedAt,
        consent: { policyVersion: gate.policy.version, method: gate.standing.method }
      });
    }
  );

  // POST /api/parent/children/:studentId/archive -> archive a bound child:
  // excluded from the login-screen listing, unable to mint device sessions,
  // every live child device session and M1 student session killed, binding
  // status + archived_at recorded (append-only evidence of the event).
  app.post(
    "/api/parent/children/:studentId/archive",
    {
      schema: {
        params: { type: "object", required: ["studentId"], properties: { studentId: { type: "string", minLength: 1 } } }
      }
    },
    async (req, reply) => {
      const session = await requireParentAuth(db, req, reply);
      if (!session) return reply;
      const { studentId } = req.params;

      const binding = await db.get(
        "SELECT status FROM parent_children WHERE parent_id = $1 AND student_id = $2",
        [session.parent_id, studentId]
      );
      if (!binding) {
        return sendProblem(reply, 403, {
          type: `${PROBLEM_BASE}/no-child-binding`,
          detail: "This student is not bound to the calling parent account."
        });
      }
      if (binding.status === "archived") {
        return sendProblem(reply, 409, {
          type: `${PROBLEM_BASE}/child-archived`,
          detail: "This child profile is already archived."
        });
      }

      const archivedAt = await db.withTransaction(async (client) => {
        const stamped = await client.query(
          `UPDATE parent_children SET status = 'archived', archived_at = now()
           WHERE parent_id = $1 AND student_id = $2 AND status = 'claimed'
           RETURNING archived_at`,
          [session.parent_id, studentId]
        );
        if (stamped.rowCount === 0) return null;
        await client.query("UPDATE students SET status = 'archived' WHERE student_id = $1", [studentId]);
        await client.query(
          "UPDATE child_device_sessions SET revoked_at = now(), revocation_reason = 'child-archived' WHERE student_id = $1 AND revoked_at IS NULL",
          [studentId]
        );
        // M1 tokens die with the archive too (requireStudentAccess also
        // refuses archived students, so even un-deleted rows are inert).
        await client.query("DELETE FROM student_sessions WHERE student_id = $1", [studentId]);
        return stamped.rows[0].archived_at;
      });
      if (archivedAt === null) {
        return sendProblem(reply, 409, {
          type: `${PROBLEM_BASE}/child-archived`,
          detail: "This child profile is already archived."
        });
      }

      return {
        ok: true,
        studentId,
        status: "archived",
        archivedAt
      };
    }
  );

  // POST /api/parent/children/:studentId/device-sessions -> mint a child
  // device token scoped to (student, device). Requires a claimed binding,
  // a live (non-archived) student, and current-version consent FOR the
  // student (a policy bump blocks minting until the parent re-consents).
  // The raw token appears exactly once in this response, hashed at rest.
  app.post(
    "/api/parent/children/:studentId/device-sessions",
    {
      schema: {
        params: { type: "object", required: ["studentId"], properties: { studentId: { type: "string", minLength: 1 } } },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["clientDeviceId", "platform"],
          properties: {
            clientDeviceId: { type: "string", minLength: 8, maxLength: 128 },
            platform: { type: "string", enum: PLATFORMS }
          }
        }
      }
    },
    async (req, reply) => {
      const session = await requireParentAuth(db, req, reply);
      if (!session) return reply;
      const { studentId } = req.params;

      const binding = await db.get(
        `SELECT pc.status AS binding_status, s.status AS student_status
         FROM parent_children pc JOIN students s ON s.student_id = pc.student_id
         WHERE pc.parent_id = $1 AND pc.student_id = $2`,
        [session.parent_id, studentId]
      );
      if (!binding) {
        return sendProblem(reply, 403, {
          type: `${PROBLEM_BASE}/no-child-binding`,
          detail: "This student is not bound to the calling parent account."
        });
      }
      if (binding.binding_status === "archived" || binding.student_status === "archived") {
        return sendProblem(reply, 409, {
          type: `${PROBLEM_BASE}/child-archived`,
          detail: "An archived child profile cannot mint device sessions."
        });
      }
      if (!(await requireConsentForStudent(db, req, reply, studentId))) return reply;

      const token = createSessionToken();
      const sessionId = newChildSessionId();
      const expiresAt = new Date(Date.now() + CHILD_DEVICE_SESSION_TTL_MS).toISOString();

      const deviceId = await db.withTransaction(async (client) => {
        const device = await upsertDevice(client, session.parent_id, req.body.clientDeviceId, req.body.platform);
        await client.query(
          `INSERT INTO child_device_sessions (session_id, token_hash, parent_id, student_id, device_id, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [sessionId, sha256Hex(token), session.parent_id, studentId, device.device_id, expiresAt]
        );
        return device.device_id;
      });

      return reply.code(201).send({ sessionId, token, deviceId, studentId, expiresAt });
    }
  );

  // DELETE /api/parent/children/:studentId/device-sessions/:sessionId ->
  // parent-side revocation (the hook the #61 portal calls). Soft revoke:
  // the row stays as lifecycle evidence and the token dies on its next
  // use. Unknown or already-revoked sessions are a uniform 404.
  app.delete(
    "/api/parent/children/:studentId/device-sessions/:sessionId",
    {
      schema: {
        params: {
          type: "object",
          required: ["studentId", "sessionId"],
          properties: {
            studentId: { type: "string", minLength: 1 },
            sessionId: { type: "string", minLength: 1 }
          }
        }
      }
    },
    async (req, reply) => {
      const session = await requireParentAuth(db, req, reply);
      if (!session) return reply;
      const { studentId, sessionId } = req.params;

      const binding = await db.get(
        "SELECT 1 FROM parent_children WHERE parent_id = $1 AND student_id = $2",
        [session.parent_id, studentId]
      );
      if (!binding) {
        return sendProblem(reply, 403, {
          type: `${PROBLEM_BASE}/no-child-binding`,
          detail: "This student is not bound to the calling parent account."
        });
      }

      const revoked = await db.run(
        `UPDATE child_device_sessions
         SET revoked_at = now(), revocation_reason = 'parent-revoked'
         WHERE session_id = $1 AND student_id = $2 AND parent_id = $3 AND revoked_at IS NULL
         RETURNING revoked_at`,
        [sessionId, studentId, session.parent_id]
      );
      if (revoked.rowCount === 0) {
        return sendProblem(reply, 404, {
          type: `${PROBLEM_BASE}/not-found`,
          detail: "Device session not found for this child."
        });
      }

      return { ok: true, sessionId, revokedAt: revoked.rows[0].revoked_at };
    }
  );
};
