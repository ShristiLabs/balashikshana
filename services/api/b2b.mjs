// B2B licensing seam API (issue #70, roadmap D10) — license activation,
// seat validation, and the teacher roster-import STUB under /api/b2b/*.
//
// A SEAM, NOT A PRODUCT (issue AC): no school admin UI, no billing (the
// ShristiLabs licensing platform owns issuance/billing), no teacher
// portal, no classes/assignments. What ships here is the validation
// infrastructure the future schools platform will stand on, plus the
// dry-run roster harness.
//
// Security doctrine:
// - EVERY route requires a PARENT session token via the #40
//   requireParentAuth: student tokens and child device tokens fail 403
//   wrong-token-type; anonymous callers 401. The activating parent IS the
//   org's administrative surface for the seam's lifetime (one org per
//   parent, migration 015) — no new token kind, because the issue
//   deliberately ships no teacher UX.
// - License verification is OFFLINE (licensing-core semantics implemented
//   in license-verifier.mjs — Ed25519 over canonical claims; no licensing
//   server dependency at runtime). The verifier is INJECTED by server.mjs
//   (dev-key fallback in dev, BALASHIKSHANA_LICENSE_PUBLIC_KEY in
//   production, fail-closed when the configured key is invalid).
// - Failure taxonomy maps 1:1 to licensing-core errors; problem details
//   never leak which byte failed beyond that taxonomy (an invalid
//   signature is reported as exactly that).
// - Seat claims RE-VALIDATE the active license's expiry at write time
//   (an expired-at-runtime license stops granting seats without any
//   sweep); seat accounting counts only seats on the ACTIVE license.
// - Roster stub performs ZERO WRITES by construction (no INSERT/UPDATE
//   anywhere on its path — test-enforced via table row-count deltas) and
//   logs row COUNTS only, never submitted names/emails (no PII in logs).
//
// Roster intake format (documented in docs/b2b/licensing-seam.md):
// CSV with a required header of exactly student_name,grade,guardian_email
// (any column order), RFC 4180 quoting; or JSON { rows: [...] }. Max 500
// rows. Per-row validation: name 1-100 chars (trimmed), grade one of the
// five registry grade ids, guardian email the repo's pragmatic RFC shape.

import crypto from "node:crypto";
import { requireParentAuth, EMAIL_PATTERN, EMAIL_MAX_LENGTH } from "./parent-auth.mjs";
import { sendProblem, PROBLEM_BASE } from "./problem.mjs";
import { GRADE_IDS } from "./children.mjs";

export const B2B_ROSTER_MAX_ROWS = 500;
const ROSTER_COLUMNS = ["student_name", "grade", "guardian_email"];
const NAME_MAX_LENGTH = 100;
const SUBJECT_MAX_LENGTH = 128;
const LICENSE_TEXT_MAX_LENGTH = 256;

const emailRegex = new RegExp(EMAIL_PATTERN);

// --- CSV (minimal RFC 4180: quoted fields, embedded commas/newlines,
// doubled quotes; CRLF or LF line endings; a lone trailing newline is not
// a row). Hand-rolled to stay zero-dependency and fully testable. ------

export function parseRosterCsv(text) {
  if (typeof text !== "string") return { ok: false, error: "csv-malformed", message: "body must be CSV text" };
  if (text.includes("\0")) return { ok: false, error: "csv-malformed", message: "CSV contains a NUL byte" };
  // Excel-style UTF-8 BOM would otherwise break the header compare
  // (found by the tester pass: spreadsheet exports carry it routinely).
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  let fieldWasQuoted = false;
  const endField = () => {
    row.push(field);
    field = "";
    fieldWasQuoted = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "" && !fieldWasQuoted) {
      inQuotes = true;
      fieldWasQuoted = true;
      continue;
    }
    if (ch === ",") {
      endField();
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
      continue;
    }
    field += ch;
  }
  if (inQuotes) return { ok: false, error: "csv-malformed", message: "unterminated quoted field" };
  if (field !== "" || row.length > 0) endRow();
  // Drop a single completely-empty trailing line artifact ("a,b\n" parses
  // one artifact row only when the text ends without a terminator).
  if (rows.length > 1 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === "") {
    rows.pop();
  }
  return { ok: true, rows };
}

/**
 * Validate one roster row object (already header-mapped). Returns an
 * array of reasons (empty = accepted). Pure — shared by the CSV and JSON
 * intake paths and unit-testable in isolation.
 */
export function rosterRowReasons(r) {
  const reasons = [];
  const name = typeof r.student_name === "string" ? r.student_name.trim() : "";
  if (name.length === 0) reasons.push("student_name is required");
  else if (name.length > NAME_MAX_LENGTH) reasons.push(`student_name exceeds ${NAME_MAX_LENGTH} characters`);
  if (typeof r.grade !== "string" || !GRADE_IDS.includes(r.grade)) {
    reasons.push(`grade must be one of: ${GRADE_IDS.join(", ")}`);
  }
  const email = typeof r.guardian_email === "string" ? r.guardian_email.trim() : "";
  if (email.length === 0) reasons.push("guardian_email is required");
  else if (email.length > EMAIL_MAX_LENGTH) reasons.push(`guardian_email exceeds ${EMAIL_MAX_LENGTH} characters`);
  else if (!emailRegex.test(email)) reasons.push("guardian_email is not a valid email address");
  return reasons;
}

// --- Plugin ---------------------------------------------------------------------

export const b2bPlugin = async function b2bPlugin(app, opts) {
  const { db, verifier } = opts;
  const rateLimits = {
    activate: { max: 10, timeWindow: "1 minute" },
    roster: { max: 10, timeWindow: "1 minute" },
    ...(opts.rateLimits || {})
  };

  // Encapsulated content-type parser: text/csv bodies arrive as raw
  // strings for the roster stub ONLY (plugin scope — no global parser
  // added; other routes are untouched).
  app.addContentTypeParser("text/csv", { parseAs: "string" }, (_req, body, done) => done(null, body));

  const licenseFileSchema = {
    body: {
      type: "object",
      required: [
        "license_id", "product_id", "customer", "plan", "seats", "instance_id",
        "issued_at", "expires_at", "features", "signature"
      ],
      properties: {
        license_id: { type: "string", minLength: 1, maxLength: LICENSE_TEXT_MAX_LENGTH },
        product_id: { type: "string", minLength: 1, maxLength: LICENSE_TEXT_MAX_LENGTH },
        customer: { type: "string", minLength: 1, maxLength: LICENSE_TEXT_MAX_LENGTH },
        plan: { type: "string", minLength: 1, maxLength: LICENSE_TEXT_MAX_LENGTH },
        seats: { type: "integer", minimum: 0, maximum: 4294967295 },
        instance_id: { type: "string", minLength: 1, maxLength: LICENSE_TEXT_MAX_LENGTH },
        issued_at: { type: "string", minLength: 1, maxLength: 64 },
        expires_at: { type: "string", minLength: 1, maxLength: 64 },
        features: { type: "array", items: { type: "string", maxLength: LICENSE_TEXT_MAX_LENGTH }, maxItems: 100 },
        signature: { type: "string", minLength: 1, maxLength: 512 }
      }
      // additionalProperties left OPEN: unknown fields are ignored by
      // licensing-core's tolerant deserialization (serde default), and the
      // signature covers only the known claims re-serialized canonically —
      // the verifier's extra-field-parity test pins this.
    }
  };

  async function orgForParent(parentId) {
    return db.get("SELECT * FROM organizations WHERE owner_parent_id = $1", [parentId]);
  }

  async function activeLicenseForOrg(orgId) {
    return db.get(
      "SELECT * FROM organization_licenses WHERE org_id = $1 AND status = 'active'",
      [orgId]
    );
  }

  async function seatCount(licenseId) {
    const row = await db.get(
      "SELECT COUNT(*)::int AS n FROM organization_seats WHERE license_id = $1",
      [licenseId]
    );
    return row ? row.n : 0;
  }

  // POST /api/b2b/licenses — activate a licensing-core license file for
  // the caller's organization (created on first activation).
  app.post("/api/b2b/licenses", { schema: licenseFileSchema, config: { rateLimit: rateLimits.activate } }, async (req, reply) => {
    const session = await requireParentAuth(db, req, reply);
    if (!session) return reply;

    const outcome = verifier.verifyLicenseFile(req.body);
    if (!outcome.ok) {
      const status = outcome.code === "verifier-unavailable" ? 503 : 422;
      return sendProblem(reply, status, {
        type: `${PROBLEM_BASE}/b2b-license-${outcome.code}`,
        detail: outcome.message
      });
    }
    const claims = outcome.claims;

    const existingLicense = await db.get("SELECT org_id FROM organization_licenses WHERE license_id = $1", [claims.license_id]);
    if (existingLicense) {
      return sendProblem(reply, 409, {
        type: `${PROBLEM_BASE}/b2b-license-already-activated`,
        detail: "This license has already been activated."
      });
    }

    const result = await db.withTransaction(async (client) => {
      const org = await client.query("SELECT * FROM organizations WHERE owner_parent_id = $1 FOR UPDATE", [req._balashiParentId]);
      let orgRow = org.rows[0];
      if (!orgRow) {
        const orgId = `org-${crypto.randomBytes(9).toString("hex")}`;
        // ON CONFLICT DO NOTHING + re-select closes the concurrent
        // FIRST-activation race (two parallel activations for a
        // brand-new parent-org would otherwise unique-violation into a
        // 500; the loser re-reads the winner's row and continues —
        // reviewer finding, fixed structurally rather than caught).
        const inserted = await client.query(
          "INSERT INTO organizations (org_id, owner_parent_id, name) VALUES ($1, $2, $3) ON CONFLICT (owner_parent_id) DO NOTHING RETURNING *",
          [orgId, req._balashiParentId, claims.customer]
        );
        orgRow = inserted.rows[0];
        if (!orgRow) {
          const reread = await client.query("SELECT * FROM organizations WHERE owner_parent_id = $1 FOR UPDATE", [req._balashiParentId]);
          orgRow = reread.rows[0];
        }
      } else {
        const active = await client.query(
          "SELECT license_id, expires_at FROM organization_licenses WHERE org_id = $1 AND status = 'active'",
          [orgRow.org_id]
        );
        if (active.rows[0]) {
          const stillValid = active.rows[0].expires_at.getTime() > Date.now();
          if (stillValid) {
            return { conflict: "active-license-exists", activeLicenseId: active.rows[0].license_id };
          }
          // Expired (or locally revoked-but-unexpired) active license:
          // renewal supersedes. The partial unique index requires the flip
          // BEFORE the new insert, inside this transaction.
          await client.query(
            "UPDATE organization_licenses SET status = 'superseded' WHERE license_id = $1",
            [active.rows[0].license_id]
          );
        }
      }
      const inserted = await client.query(
        `INSERT INTO organization_licenses
           (license_id, org_id, product_id, customer, plan, seats, instance_id,
            issued_at, expires_at, features, signature)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (license_id) DO NOTHING RETURNING *`,
        [
          claims.license_id, orgRow.org_id, claims.product_id, claims.customer, claims.plan,
          claims.seats, claims.instance_id, claims.issued_at, claims.expires_at,
          JSON.stringify(claims.features), req.body.signature
        ]
      );
      if (inserted.rows.length === 0) {
        // Concurrent activation of the same issued license lost the race
        // (license_id is globally unique) — the honest answer is the same
        // 409 the pre-check returns, never a 500.
        return { conflict: "already-activated" };
      }
      return { license: inserted.rows[0], org: orgRow };
    });

    if (result.conflict) {
      if (result.conflict === "already-activated") {
        return sendProblem(reply, 409, {
          type: `${PROBLEM_BASE}/b2b-license-already-activated`,
          detail: "This license has already been activated."
        });
      }
      return sendProblem(reply, 409, {
        type: `${PROBLEM_BASE}/b2b-active-license-exists`,
        detail: "The organization already has an active, unexpired license. Revoke or let it expire before activating another."
      });
    }

    const license = result.license;
    return reply.code(201).send({
      organizationId: result.org.org_id,
      organizationName: result.org.name,
      licenseId: license.license_id,
      plan: license.plan,
      seats: license.seats,
      features: claims.features,
      issuedAt: license.issued_at,
      expiresAt: license.expires_at,
      status: license.status
    });
  });

  // GET /api/b2b/licenses/current — seat status for the caller's org.
  app.get("/api/b2b/licenses/current", async (req, reply) => {
    const session = await requireParentAuth(db, req, reply);
    if (!session) return reply;

    const org = await orgForParent(req._balashiParentId);
    if (!org) {
      return sendProblem(reply, 404, {
        type: `${PROBLEM_BASE}/b2b-no-organization`,
        detail: "No organization exists for this account. Activate a license first."
      });
    }
    const license = await activeLicenseForOrg(org.org_id);
    if (!license) {
      return sendProblem(reply, 409, {
        type: `${PROBLEM_BASE}/b2b-no-active-license`,
        detail: "The organization has no active license. Activate a license first."
      });
    }
    const assigned = await seatCount(license.license_id);
    const licenseState = license.expires_at.getTime() > Date.now() ? "active" : "active-expired";
    return {
      organizationId: org.org_id,
      licenseId: license.license_id,
      plan: license.plan,
      seatsLicensed: license.seats,
      seatsAssigned: assigned,
      seatsRemaining: Math.max(0, license.seats - assigned),
      issuedAt: license.issued_at,
      expiresAt: license.expires_at,
      licenseState
    };
  });

  // POST /api/b2b/seats — claim one seat for an opaque subject label.
  const seatSchema = {
    body: {
      type: "object",
      additionalProperties: false,
      required: ["subject"],
      properties: { subject: { type: "string", minLength: 1, maxLength: SUBJECT_MAX_LENGTH } }
    }
  };
  app.post("/api/b2b/seats", { schema: seatSchema }, async (req, reply) => {
    const session = await requireParentAuth(db, req, reply);
    if (!session) return reply;

    const subject = String(req.body.subject).trim();
    if (subject.length === 0) {
      return sendProblem(reply, 422, { type: `${PROBLEM_BASE}/validation`, detail: "subject must not be blank" });
    }
    const org = await orgForParent(req._balashiParentId);
    if (!org) {
      return sendProblem(reply, 409, {
        type: `${PROBLEM_BASE}/b2b-no-active-license`,
        detail: "No organization or active license exists for this account."
      });
    }
    const license = await activeLicenseForOrg(org.org_id);
    if (!license) {
      return sendProblem(reply, 409, {
        type: `${PROBLEM_BASE}/b2b-no-active-license`,
        detail: "The organization has no active license."
      });
    }
    // Runtime re-validation: an expired-at-claim-time license grants
    // nothing, even though its row still says 'active' (status flips are
    // renewal events, not clock ticks).
    if (license.expires_at.getTime() <= Date.now()) {
      return sendProblem(reply, 409, {
        type: `${PROBLEM_BASE}/b2b-license-expired`,
        detail: "The organization's license has expired; seats cannot be claimed."
      });
    }
    const duplicate = await db.get(
      "SELECT seat_id FROM organization_seats WHERE org_id = $1 AND subject = $2",
      [org.org_id, subject]
    );
    if (duplicate) {
      return sendProblem(reply, 409, {
        type: `${PROBLEM_BASE}/b2b-seat-subject-exists`,
        detail: "A seat is already assigned to this subject."
      });
    }
    const assigned = await seatCount(license.license_id);
    if (assigned >= license.seats) {
      return sendProblem(reply, 409, {
        type: `${PROBLEM_BASE}/b2b-seat-exhausted`,
        detail: "All licensed seats are in use.",
        extensions: { seatsLicensed: license.seats, seatsAssigned: assigned }
      });
    }
    const seatId = `seat-${crypto.randomBytes(9).toString("hex")}`;
    const seat = await db.get(
      `INSERT INTO organization_seats (seat_id, org_id, license_id, subject)
       VALUES ($1, $2, $3, $4) RETURNING seat_id, subject, license_id, created_at`,
      [seatId, org.org_id, license.license_id, subject]
    );
    return reply.code(201).send({
      seatId: seat.seat_id,
      subject: seat.subject,
      licenseId: seat.license_id,
      createdAt: seat.created_at
    });
  });

  // POST /api/b2b/roster/validate — the teacher roster-import STUB.
  // Validation-only dry run: NO writes anywhere on this path (no INSERT,
  // no UPDATE — enforced by tests via row-count deltas). Accepts CSV
  // (Content-Type: text/csv) or JSON { rows: [...] }; cap 500 rows.
  app.post("/api/b2b/roster/validate", { config: { rateLimit: rateLimits.roster }, bodyLimit: 262144 }, async (req, reply) => {
    const session = await requireParentAuth(db, req, reply);
    if (!session) return reply;

    let rowObjects = null;
    if (typeof req.body === "string") {
      const parsed = parseRosterCsv(req.body);
      if (!parsed.ok) {
        return sendProblem(reply, 422, {
          type: `${PROBLEM_BASE}/b2b-roster-csv-invalid`,
          detail: parsed.message
        });
      }
      const rows = parsed.rows;
      if (rows.length < 2) {
        return sendProblem(reply, 422, {
          type: `${PROBLEM_BASE}/b2b-roster-csv-invalid`,
          detail: "CSV must carry a header row and at least one data row."
        });
      }
      const header = rows[0].map((h) => String(h).trim().toLowerCase());
      const missing = ROSTER_COLUMNS.filter((c) => !header.includes(c));
      const extras = header.filter((c) => !ROSTER_COLUMNS.includes(c));
      if (missing.length > 0 || extras.length > 0 || header.length !== ROSTER_COLUMNS.length) {
        return sendProblem(reply, 422, {
          type: `${PROBLEM_BASE}/b2b-roster-header-invalid`,
          detail: `Header must be exactly the columns ${ROSTER_COLUMNS.join(", ")} (any order).`
        });
      }
      rowObjects = rows.slice(1).map((r) => {
        const obj = {};
        // A data row must carry exactly the header's field count — a
        // short or long row is malformed, not silently truncated
        // (tester finding: wrong-field-count rows must be row-level
        // rejects with an explicit reason).
        if (r.length !== header.length) {
          obj.__fieldCount = r.length;
          return obj;
        }
        header.forEach((col, i) => {
          obj[col] = r[i];
        });
        return obj;
      });
    } else if (req.body && typeof req.body === "object" && Array.isArray(req.body.rows)) {
      rowObjects = req.body.rows;
    } else {
      return sendProblem(reply, 422, {
        type: `${PROBLEM_BASE}/validation`,
        detail: "Send roster rows as CSV (Content-Type: text/csv) or JSON { rows: [...] }."
      });
    }

    if (rowObjects.length > B2B_ROSTER_MAX_ROWS) {
      return sendProblem(reply, 413, {
        type: `${PROBLEM_BASE}/b2b-roster-too-large`,
        detail: `Rosters are limited to ${B2B_ROSTER_MAX_ROWS} rows per validation.`
      });
    }

    // Seat projection (READS ONLY — this stub never writes).
    const org = await orgForParent(req._balashiParentId);
    const license = org ? await activeLicenseForOrg(org.org_id) : null;
    let seatProjection = null;
    if (license) {
      const assigned = await seatCount(license.license_id);
      const remaining = Math.max(0, license.seats - assigned);
      seatProjection = {
        seatsLicensed: license.seats,
        seatsAssigned: assigned,
        seatsRemaining: remaining,
        licenseState: license.expires_at.getTime() > Date.now() ? "active" : "active-expired"
      };
    }

    const results = [];
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < rowObjects.length; i++) {
      const r = rowObjects[i];
      const row = r && typeof r === "object" && !Array.isArray(r) ? r : null;
      let reasons;
      if (row === null) {
        reasons = ["row must be an object"];
      } else if (row.__fieldCount !== undefined) {
        reasons = [`expected ${ROSTER_COLUMNS.length} fields, found ${row.__fieldCount}`];
      } else {
        reasons = rosterRowReasons(row);
      }
      if (reasons.length === 0) {
        accepted++;
        results.push({ line: i + 1, status: "accepted", reasons: [] });
      } else {
        rejected++;
        results.push({ line: i + 1, status: "rejected", reasons });
      }
    }

    const summary = {
      rowsTotal: rowObjects.length,
      accepted,
      rejected,
      seatsNeeded: accepted,
      seatsSufficient: seatProjection ? seatProjection.seatsRemaining >= accepted : null,
      seatProjection
    };

    // Log counts only — roster names/emails are PII and never logged.
    req.log.info(
      { rosterRows: rowObjects.length, rosterAccepted: accepted, rosterRejected: rejected },
      "B2B roster dry-run validation"
    );

    return {
      dryRun: true,
      validationOnly: true,
      note: "Dry run only: rows were validated, nothing was created, stored, or invited.",
      summary,
      rows: results
    };
  });
};
