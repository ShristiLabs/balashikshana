// V15 — B2B licensing seam (issue #70, M6 roadmap D10).
//
// Three tables backing the school/district SEAM (deliberately not a
// product — no school admin UI, no billing, no teacher portal):
//
// - organizations: the school/district account. ONE per parent owner
//   (uq_organizations_owner) for the seam's lifetime — the activating
//   parent account IS the org's administrative surface today (the #40
//   parent-session token kind gates every /api/b2b/* route; no new token
//   kind was added because the issue body demands no teacher UX). `name`
//   is the customer name from the license claims at FIRST activation.
// - organization_licenses: activated license files, keyed by the claims'
//   license_id (GLOBALLY unique — the same issued license can never bind
//   to two orgs; re-activating a known license_id is a 409). Append-only
//   audit posture: a row is never edited or deleted; renewal SUPERSEDES
//   (status flip) and the partial unique index uq_org_licenses_active
//   enforces at most ONE active license per org. `signature` (the base64
//   Ed25519 detached signature from the license file) and the full claims
//   are retained as activation evidence. Revocation is LOCAL
//   (status='revoked'): offline licenses cannot be remotely revoked —
//   expires_at windows + local revoke are the documented mitigation
//   (docs/b2b/licensing-seam.md).
// - organization_seats: seat assignments against a license. `subject` is
//   an opaque caller-chosen identifier (a teacher/staff label at the
//   org's discretion — adult-provided, akin to parents.email; roster
//   intake itself is NEVER persisted, see below). UNIQUE (org_id,
//   subject). Seats belong to their license: structural deletes cascade,
//   and seat accounting counts only rows on the org's ACTIVE license.
//
// COPPA/data-flow posture (docs/data-flow-inventory.md rows 22-24): these
// are B2B account/entitlement records — ADULT-provided organizational
// data, not child data. No child-data class is created by this migration;
// the roster-import STUB (POST /api/b2b/roster/validate) performs
// validation-only dry-runs and writes NOTHING (test-enforced), so student
// names/guardian emails submitted for validation are transient request
// bodies — never persisted, never logged (row counts only).
//
// `down` drops additively in reverse dependency order.

exports.up = (pgm) => {
  pgm.createTable("organizations", {
    org_id: { type: "text", notNull: true, primaryKey: true },
    owner_parent_id: { type: "text", notNull: true, references: "parents(parent_id)", onDelete: "cascade" },
    name: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  }, { ifNotExists: true });
  // Seam decision: one organization per parent owner.
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS uq_organizations_owner ON organizations (owner_parent_id)`);

  pgm.createTable("organization_licenses", {
    // The claims' license_id — globally unique across orgs by issuance.
    license_id: { type: "text", notNull: true, primaryKey: true },
    org_id: { type: "text", notNull: true, references: "organizations(org_id)", onDelete: "cascade" },
    product_id: { type: "text", notNull: true },
    customer: { type: "text", notNull: true },
    plan: { type: "text", notNull: true },
    seats: { type: "integer", notNull: true },
    instance_id: { type: "text", notNull: true },
    issued_at: { type: "timestamptz", notNull: true },
    expires_at: { type: "timestamptz", notNull: true },
    // features JSON array as TEXT (the repo's JSON-in-text convention).
    features: { type: "text", notNull: true },
    // Activation evidence: the Ed25519 detached signature base64.
    signature: { type: "text", notNull: true },
    status: { type: "text", notNull: true, default: "active" },
    activated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  }, { ifNotExists: true });
  pgm.sql(`ALTER TABLE organization_licenses
           ADD CONSTRAINT organization_licenses_seats_ck CHECK (seats >= 0)`);
  pgm.sql(`ALTER TABLE organization_licenses
           ADD CONSTRAINT organization_licenses_status_ck CHECK (status IN ('active', 'revoked', 'superseded'))`);
  // At most ONE active license per organization (renewal supersedes).
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS uq_org_licenses_active
           ON organization_licenses (org_id) WHERE status = 'active'`);

  pgm.createTable("organization_seats", {
    seat_id: { type: "text", notNull: true, primaryKey: true },
    org_id: { type: "text", notNull: true, references: "organizations(org_id)", onDelete: "cascade" },
    license_id: { type: "text", notNull: true, references: "organization_licenses(license_id)", onDelete: "cascade" },
    subject: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  }, { ifNotExists: true });
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS uq_org_seats_subject ON organization_seats (org_id, subject)`);
  pgm.createIndex("organization_seats", ["org_id", "license_id"], { ifNotExists: true, name: "idx_org_seats_license" });
};

exports.down = (pgm) => {
  pgm.dropTable("organization_seats", { ifExists: true });
  pgm.dropTable("organization_licenses", { ifExists: true });
  pgm.dropTable("organizations", { ifExists: true });
};
