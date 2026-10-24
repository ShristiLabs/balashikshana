// Verifiable parental consent (issue #41, roadmap D5 + M2 hard gate):
// versioned policy text, timestamped consent capture, re-consent on policy
// bump, and the consent-required guards that make "no child-data row without
// a matching consent record" hold on every child-data-CREATING route.
//
// Doctrine:
// - consent_records is APPEND-ONLY. No route updates or deletes a consent
//   row; corrections are new rows. The only writer besides this module is
//   POST /api/students, which inserts the student-scoped BINDING row inside
//   the creation transaction (binding the parent's standing consent to the
//   new child at creation time — attribution of existing evidence, never a
//   fabricated acceptance; legacy standalone students are dev data and are
//   never back-filled — their path is #42's claim-or-archive).
// - Timestamps are SERVER-side only (timestamptz DEFAULT now()); no capture
//   route accepts a client-supplied captured_at.
// - The capture method is SERVER-DERIVED from evidence state (a prior
//   consent row for the parent means the new acceptance is a re-consent);
//   the client never asserts a verification method.
// - The active policy version lives in consent_policy_versions (migration
//   004): append-only rows, exactly one active per locale (partial unique
//   index). Bumping the policy inserts a new active row; every consent row
//   captured at an older version is then insufficient for NEW child-data
//   creation until the parent re-consents (the consent-required problem
//   carries the current version).
// - Legacy/dev posture: students created before this gate (seeded demo
//   accounts, pre-gate dev data) have no consent rows and are REFUSED on
//   gated routes with consent-required; no consent is fabricated for them.
//
// Rate limiting: the routes below sit behind the existing global per-IP and
// per-token buckets (the #40 refresh/logout precedent) — none of them is a
// token-guessing or email-harvesting surface, so no dedicated route buckets.

import crypto from "node:crypto";
import { requireParentAuth } from "./parent-auth.mjs";
import { sendProblem, PROBLEM_BASE } from "./problem.mjs";

function newConsentId() {
  return `con-${crypto.randomBytes(10).toString("hex")}`;
}

// --- Policy resolution --------------------------------------------------------

// Single active locale supported for now ('en-US' is the only seeded locale);
// if multiple locales ever carry an active row, the latest created wins so
// resolution stays deterministic. Locale-aware selection is future client
// work (#44 onboarding).
export async function getActivePolicyVersion(db) {
  return db.get(
    "SELECT version, locale, policy_text, created_at FROM consent_policy_versions WHERE active = true ORDER BY created_at DESC LIMIT 1"
  );
}

async function requireActivePolicy(db, reply) {
  const policy = await getActivePolicyVersion(db);
  if (!policy) {
    // Fail closed: with no active policy there is nothing to consent to.
    sendProblem(reply, 500, {
      type: `${PROBLEM_BASE}/internal`,
      detail: "No active consent policy version is configured."
    });
    return null;
  }
  return policy;
}

// --- Parent gating (consent capture + child creation) -------------------------

// requireParentAuth (parent-auth.mjs) handles 401 (missing/invalid/expired)
// and 403 wrong-token-type; this adds the email-verified requirement that
// verifiable consent depends on (#40 leaves emailVerified on the login
// response precisely so this surface can gate on it).
export async function requireVerifiedParent(db, req, reply) {
  const session = await requireParentAuth(db, req, reply);
  if (!session) return null;
  const parent = await db.get("SELECT parent_id, email_verified_at FROM parents WHERE parent_id = $1", [
    session.parent_id
  ]);
  if (!parent || !parent.email_verified_at) {
    sendProblem(reply, 403, {
      type: `${PROBLEM_BASE}/email-verification-required`,
      detail: "Verifiable parental consent requires a verified email address. Verify the account email before recording consent."
    });
    return null;
  }
  return session;
}

export function sendConsentRequired(reply, currentPolicyVersion, detail) {
  sendProblem(reply, 403, {
    type: `${PROBLEM_BASE}/consent-required`,
    detail:
      detail ||
      "Verifiable parental consent matching the current policy version is required before child data can be created.",
    // RFC 9457 extension member: the version the parent must (re-)accept.
    extensions: { currentPolicyVersion }
  });
}

// Full gate for child creation (POST /api/students): verified parent whose
// latest consent row matches the active policy version. Returns the standing
// row (its policy_version/method are reused for the student-scoped binding
// row inserted at creation) or null after replying with the specific problem.
export async function requireParentWithCurrentConsent(db, req, reply) {
  const session = await requireVerifiedParent(db, req, reply);
  if (!session) return null;
  const policy = await requireActivePolicy(db, reply);
  if (!policy) return null;
  const standing = await latestConsentForParent(db, session.parent_id);
  if (!standing || standing.policy_version !== policy.version) {
    sendConsentRequired(reply, policy.version);
    return null;
  }
  return { parentSession: session, policy, standing };
}

export async function latestConsentForParent(db, parentId) {
  return db.get(
    "SELECT consent_id, parent_id, student_id, policy_version, captured_at, method FROM consent_records WHERE parent_id = $1 ORDER BY captured_at DESC, created_at DESC LIMIT 1",
    [parentId]
  );
}

// --- Student-scoped gating (progress writes) ----------------------------------

// A student's data is consented for the active policy version when EITHER
// the student has a direct consent row at that version (the creation-time
// binding row) OR a parent of the student — derived purely from
// consent_records lineage: any parent holding a student-scoped row for this
// student — has a current-version, parent-level (student_id IS NULL) row,
// which is exactly what a re-consent inserts. No parent_children dependency
// (that binding arrives with #42); the lineage is already unambiguous.
export async function hasCurrentConsentForStudent(db, studentId, policyVersion) {
  const row = await db.get(
    `SELECT 1 FROM consent_records r
     WHERE r.policy_version = $1
       AND (
         r.student_id = $2
         OR (
           r.student_id IS NULL
           AND r.parent_id IN (SELECT parent_id FROM consent_records WHERE student_id = $2)
         )
       )
     LIMIT 1`,
    [policyVersion, studentId]
  );
  return Boolean(row);
}

// Guard for the student-scoped child-data-creating routes
// (practice/topic/complete, gate/evaluate). Call AFTER requireStudentAccess
// so authentication and session-scoping problems surface first; it replies
// 403 consent-required (with the current version) and the caller must then
// write nothing.
export async function requireConsentForStudent(db, req, reply, studentId) {
  const policy = await requireActivePolicy(db, reply);
  if (!policy) return false;
  if (!(await hasCurrentConsentForStudent(db, studentId, policy.version))) {
    sendConsentRequired(reply, policy.version);
    return false;
  }
  return true;
}

// --- Fastify plugin -------------------------------------------------------------

export const consentPlugin = async function consentPlugin(app, opts) {
  const { db } = opts;

  // GET /api/consent/policy/latest -> the active policy version + text for
  // the app to render (public: the policy text is public by nature and the
  // client needs it before onboarding; no PII involved).
  app.get("/api/consent/policy/latest", async (_req, reply) => {
    const policy = await getActivePolicyVersion(db);
    if (!policy) {
      return sendProblem(reply, 404, {
        type: `${PROBLEM_BASE}/not-found`,
        detail: "No active consent policy version is configured."
      });
    }
    return {
      version: policy.version,
      locale: policy.locale,
      policyText: policy.policy_text,
      createdAt: policy.created_at,
      active: true
    };
  });

  // POST /api/consent/records -> timestamped, append-only consent capture.
  // Requires a VERIFIED parent session. The body names the policy version
  // being accepted (the version the client rendered); anything other than
  // the active version is a 409 naming the current version. An optional
  // studentId captures consent for a bound child — pre-#42 no parent_children
  // rows exist, so any studentId is a 403 no-child-binding until #42 creates
  // bindings; parent-level captures (the onboarding norm) leave it out.
  app.post(
    "/api/consent/records",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["policyVersion"],
          properties: {
            policyVersion: { type: "string", minLength: 1, maxLength: 32 },
            studentId: { type: "string", minLength: 1, maxLength: 64 }
          }
        }
      }
    },
    async (req, reply) => {
      const session = await requireVerifiedParent(db, req, reply);
      if (!session) return reply;
      const policy = await requireActivePolicy(db, reply);
      if (!policy) return reply;

      if (req.body.policyVersion !== policy.version) {
        return sendProblem(reply, 409, {
          type: `${PROBLEM_BASE}/policy-version-mismatch`,
          detail: "The consent policy has been updated; accept the current version.",
          extensions: { currentPolicyVersion: policy.version }
        });
      }

      let studentId = null;
      if (req.body.studentId !== undefined) {
        const binding = await db.get(
          "SELECT 1 FROM parent_children WHERE parent_id = $1 AND student_id = $2",
          [session.parent_id, req.body.studentId]
        );
        if (!binding) {
          return sendProblem(reply, 403, {
            type: `${PROBLEM_BASE}/no-child-binding`,
            detail: "Consent can only name a student bound to this parent account."
          });
        }
        studentId = req.body.studentId;
      }

      // Method is derived from evidence state, never asserted by the client:
      // an existing consent row for this parent means this acceptance follows
      // a policy bump (or a re-affirmation) — recorded as 're-consent'.
      const prior = await db.get("SELECT 1 FROM consent_records WHERE parent_id = $1 LIMIT 1", [
        session.parent_id
      ]);
      const method = prior ? "re-consent" : "signup-form";

      const consentId = newConsentId();
      const inserted = await db.get(
        `INSERT INTO consent_records (consent_id, parent_id, student_id, policy_version, method)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING captured_at, created_at`,
        [consentId, session.parent_id, studentId, policy.version, method]
      );

      return reply.code(201).send({
        consentId,
        parentId: session.parent_id,
        studentId,
        policyVersion: policy.version,
        method,
        capturedAt: inserted.captured_at
      });
    }
  );

  // GET /api/consent/status -> the parent's latest consent and whether it
  // matches the active version (re-consent surfacing: the client shows the
  // policy + parental gate again when consentCurrent is false).
  app.get("/api/consent/status", async (req, reply) => {
    const session = await requireParentAuth(db, req, reply);
    if (!session) return reply;
    const policy = await getActivePolicyVersion(db);
    const latest = await latestConsentForParent(db, session.parent_id);
    const current = Boolean(policy && latest && latest.policy_version === policy.version);
    return {
      currentPolicyVersion: policy ? policy.version : null,
      consentCurrent: current,
      latestConsent: latest
        ? {
            policyVersion: latest.policy_version,
            capturedAt: latest.captured_at,
            method: latest.method,
            studentId: latest.student_id
          }
        : null
    };
  });
};
