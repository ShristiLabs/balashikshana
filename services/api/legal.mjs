// Legal documents API (issue #68, M6 compliance pack).
//
// Serves the versioned privacy policy and terms of service that ship
// in-app (mobile onboarding consent screen — reachable BEFORE consent
// capture, COPPA good practice — the gated parent area, and the portal
// footer). Same doctrine as GET /api/consent/policy/latest (issue #41):
//
// - PUBLIC by nature: the legal texts are public documents and the client
//   needs them pre-consent; no PII is involved. Behind the global per-IP
//   bucket only (the #41 posture — not a token-guessing surface).
// - Versioning mirrors consent_policy_versions: append-only rows, exactly
//   one active per (kind, locale) enforced by the partial unique index
//   uq_legal_documents_active (migration 014).
// - LEGAL DOCUMENT VERSIONS ARE INDEPENDENT OF THE CONSENT POLICY
//   VERSION: publishing a new privacy/terms text does NOT trigger
//   re-consent (consent status compares consent_policy_versions.version
//   only — consent.mjs). A material legal change that should re-trigger
//   consent bumps BOTH (ops runbook: docs/legal/README.md).
// - The texts are drafts pending legal counsel review; the banner lives
//   in the document bodies themselves, so every rendered copy carries it.
// - Fail closed: no active document of the requested kind -> 404 (there
//   is nothing to render), matching the policy/latest behavior.

import { sendProblem, PROBLEM_BASE } from "./problem.mjs";

const KINDS = Object.freeze(["privacy-policy", "terms-of-service"]);

function getActiveLegalDocument(db, kind) {
  return db.get(
    "SELECT kind, version, locale, body, created_at FROM legal_documents WHERE kind = $1 AND active = true ORDER BY created_at DESC LIMIT 1",
    [kind]
  );
}

function sendLegalDocument(reply, doc) {
  return {
    kind: doc.kind,
    version: doc.version,
    locale: doc.locale,
    body: doc.body,
    createdAt: doc.created_at,
    active: true
  };
}

export const legalPlugin = async function legalPlugin(app, opts) {
  const { db } = opts;

  for (const kind of KINDS) {
    app.get(`/api/legal/${kind}/latest`, async (_req, reply) => {
      const doc = await getActiveLegalDocument(db, kind);
      if (!doc) {
        return sendProblem(reply, 404, {
          type: `${PROBLEM_BASE}/not-found`,
          detail: `No active ${kind} version is configured.`
        });
      }
      return sendLegalDocument(reply, doc);
    });
  }
};
