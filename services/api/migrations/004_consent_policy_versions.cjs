// V4 — verifiable parental consent (issue #41, roadmap D5 / M2 hard gate).
//
// Three pieces:
// - consent_policy_versions: the versioned, append-only policy catalog. Each
//   row is one immutable policy text (version, locale, text, created_at);
//   `active` marks the single current version per locale, enforced by a
//   PARTIAL UNIQUE INDEX on (locale) WHERE active — the database itself
//   rejects two active policies for a locale. Seeded here with a v1
//   placeholder clearly marked NON-LEGAL: the real policy text is the M6
//   compliance pack (#62); until then the machinery (versioned policy,
//   timestamped capture, re-consent) ships and is exercised with this
//   placeholder. Bumping the policy = insert a new row + flip `active` in a
//   transaction (see #62 ops notes); versions are never edited or deleted.
// - consent_records.method CHECK: the value set deferred by 002 ("#41 fixes
//   the value set"): 'signup-form' (first acceptance) and 're-consent'
//   (acceptance after a policy bump), both derived server-side — the client
//   never asserts a capture method. The table is empty in every environment
//   pre-#41 (no capture path existed), so the constraint validates trivially.
// - consent_records.policy_version FK -> consent_policy_versions(version) ON
//   DELETE RESTRICT: a consent-evidence row can never reference a policy
//   version that does not exist, and policy rows cannot be deleted while
//   evidence cites them (#62 retention must handle both explicitly).
//
// `down` drops the FK before the catalog table (dropping the FK removes the
// dependency; consent rows keep their text values), then the CHECK, then the
// table — reversible on production-shaped data without touching evidence.

exports.up = (pgm) => {
  pgm.createTable("consent_policy_versions", {
    // Dotted-decimal string ('1', '1.1', '2'); ordering is by created_at, not
    // semver parsing — versions are an immutable audit trail.
    version: { type: "text", notNull: true, primaryKey: true },
    locale: { type: "text", notNull: true, default: "'en-US'" },
    policy_text: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    // Exactly one active row per locale (partial unique index below).
    active: { type: "boolean", notNull: true, default: false }
  }, { ifNotExists: true });
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS uq_consent_policy_active
           ON consent_policy_versions (locale) WHERE active`);

  // v1 placeholder seed (idempotent). NON-LEGAL placeholder text by design.
  pgm.sql(`
    INSERT INTO consent_policy_versions (version, locale, policy_text, active)
    VALUES ('1', 'en-US', $q$
PLACEHOLDER CONSENT POLICY TEXT - NOT LEGAL ADVICE.

This v1 policy text is a placeholder that ships with the verifiable parental
consent machinery (versioned policy, timestamped capture, re-consent on
bump). The production privacy-policy text arrives with the M6 compliance
pack and must replace this placeholder before any public deployment.

Scope of consent: collection of the child's learning data (profiles,
practice attempts, progress, mastery-gate results) under verifiable parental
consent, first-party use only. No third-party ads, analytics, or tracking
(AGENTS.md COPPA invariant).
    $q$, true)
    ON CONFLICT (version) DO NOTHING
  `);

  pgm.addConstraint("consent_records", "consent_records_method_ck",
    `CHECK (method IN ('signup-form', 're-consent'))`);
  pgm.addConstraint("consent_records", "consent_records_policy_version_fk",
    "FOREIGN KEY (policy_version) REFERENCES consent_policy_versions(version) ON DELETE RESTRICT");
};

exports.down = (pgm) => {
  pgm.dropConstraint("consent_records", "consent_records_policy_version_fk", { ifExists: true });
  pgm.dropConstraint("consent_records", "consent_records_method_ck", { ifExists: true });
  pgm.dropTable("consent_policy_versions", { ifExists: true });
};
