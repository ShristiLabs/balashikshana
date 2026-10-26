// V14 — COPPA legal pack (issue #68, M6 compliance).
//
// Two pieces:
// - legal_documents: the versioned, append-only catalog for the in-app
//   legal texts (privacy policy, terms of service). Same semantics as
//   consent_policy_versions (migration 004): each row is one immutable
//   document text (kind, version, locale, body, created_at); `active`
//   marks the single current version per (kind, locale), enforced by a
//   PARTIAL UNIQUE INDEX — the database itself rejects two active
//   documents of one kind. Bumping a document = insert a new row + flip
//   `active` in a transaction; versions are never edited or deleted at
//   runtime. LEGAL DOCUMENT VERSIONS ARE INDEPENDENT OF THE CONSENT
//   POLICY VERSION: re-consent is keyed solely on
//   consent_policy_versions.version (consent.mjs), so publishing a new
//   privacy-policy or terms text does NOT force every parent back through
//   the consent screen. A material legal change that SHOULD re-trigger
//   consent must also bump the consent policy (documented ops runbook in
//   docs/legal/README.md).
// - consent_policy_versions v2: replaces the migration-004 NON-LEGAL
//   placeholder with the production consent statement (the text the
//   parent accepts), which references the shipped legal documents. This
//   is a REAL policy bump: every parent whose consent was captured at v1
//   re-consents at v2 before further child-data creation (the machinery
//   migration 004 was built to exercise). The v1 row is retained
//   (append-only evidence); it is only deactivated.
//
// Seeded texts are DRAFTS carrying the "requires legal counsel review"
// banner and bracketed placeholders for entity details; they are NOT
// final legal text until counsel signs off (issue #68 scope). The same
// canonical text lives in docs/legal/ for repo readability — the
// services/api/test/legal.test.mjs suite pins the structural invariants
// (banner present, placeholders marked, version fields) against the DB.
//
// `down` reverses in dependency order: the v2 consent policy row is
// deleted and v1 re-activated (restoring the pre-014 placeholder state),
// then legal_documents is dropped (no FK depends on it).

const PRIVACY_POLICY_BODY = `
DRAFT - NOT FINAL LEGAL TEXT. This privacy policy draft requires review
and approval by qualified legal counsel before deployment. Bracketed
[PLACEHOLDERS] must be completed by the operator.

Privacy Policy for the Balashikshana learning app
Version 1 (draft) - effective [EFFECTIVE_DATE]
Operated by [COMPANY_LEGAL_NAME], [JURISDICTION]. Contact:
[CONTACT_EMAIL], [POSTAL_ADDRESS].

1. Who this policy covers
This policy explains what information the Balashikshana app and its
parent web portal collect, why, and the choices parents have. Balashikshana
is a learning app for children in pre-kindergarten through grade 3. It is
designed for a parent or legal guardian to set up and supervise. We do not
knowingly collect personal information from a child without verifiable
parental consent.

2. What we collect and why
(a) Parent account information. Email address and a password. Used to
create and secure the parent account, verify the address (a verification
link), send password-reset links, and send the optional weekly learning
summary. Passwords are stored only as salted cryptographic hashes; we
cannot read them.
(b) Parental consent records. When you accept the consent policy, we store
which policy version you accepted, the date and time, and which child
profile it covers. This is our legal record of your permission.
(c) Child learner profile. A display name (nickname), a username, an
avatar, an age band, and a school grade level, plus a 4-digit PIN chosen
by the parent that unlocks the child's profile on the device. Used to
operate the learner's journey. The PIN is stored only as a salted
cryptographic hash.
(d) Learning activity records. As your child practices: which questions
they answered, whether answers were correct, how long responses took,
learning-misconception tags the teaching engine assigns, mastery-gate and
placement results, rewards the app grants (such as stars and badges), and
streak information. Used to teach your child at the right level, compute
progress, and power the parent dashboard. These records are the "learning
data" your consent covers.
(e) Content settings. Time limits, subject restrictions, grade ceilings,
and reminder preferences a parent sets in the portal. Used to enforce the
parent's choices on every device.
(f) Device and session information. A random device identifier, the
platform (iOS/Android), and secure session tokens that keep each device
signed in. Used to bind a child's device to the profile the parent
authorized and to revoke access when the parent chooses.
(g) Technical logs and error reports. When something fails we record the
request's route, timing, a truncated network identifier, and a scrubbed
error description. Personal identifiers such as email addresses, exact IP
addresses, and tokens are removed automatically before anything is stored.
Used to keep the service reliable and secure.

3. What we do NOT do
- No advertising of any kind, and no behavioral or targeted advertising.
- No third-party analytics or tracking SDKs. Usage measurement is
  first-party and aggregate only.
- No selling, renting, or sharing of personal information with third
  parties for their own purposes.
- No push notifications to children. Reminders are local to the device and
  controlled by the parent.
- No open external links inside child-facing screens.

4. Children's privacy (COPPA)
The app is built for children under 13. Before any child learning data is
created, the app requires verifiable parental consent: a parent account
with a verified email address must accept the current consent policy. When
the policy changes materially, the app asks the parent to accept the new
version before more learning data is collected. Parents can withdraw
consent at any time by deleting the child's data (section 5). Data
minimization is a design rule: we collect only the categories in section 2,
each tied to a documented product need.

5. Parent data rights
From the parent portal you can:
(a) Export. Download a complete copy of your child's data as a readable
JSON file, covering every learning-data category.
(b) Delete. Permanently delete a child's profile and learning data. For
safety this requires re-entering your parent password. Deletions are
recorded in an internal audit ledger (the ledger stores only identifiers
and timestamps, not learning data).
(c) Refuse / withdraw. Delete the child profile or your whole account to
withdraw consent. Account deletion removes parent information.
(d) Review and correct. Nickname, avatar, grade, and settings can be
changed at any time.

6. Where data lives and how it is protected
Data is stored in a managed database in [DATA_REGION] within the United
States. In transit, connections use TLS. At rest, passwords and PINs are
stored only as salted scrypt hashes; parent and child-device session
tokens are stored only as cryptographic digests. Access to production
systems is restricted, infrastructure secrets live in a managed secret
store, and content delivered to devices is cryptographically signed.

7. Who else is involved
- Email delivery provider: sends verification, password-reset, and the
  optional weekly summary emails to parents. The provider receives the
  minimum needed to deliver email (the parent's address and message).
- App stores (Apple App Store / Google Play): distribution and billing
  relationship is between you and the store under the store's own policy.
Other than these, there are no third parties receiving personal
information. We do not use ad networks, data brokers, or analytics
vendors.

8. Retention
Learning data is retained while the child profile exists and is deleted
with it (section 5b). Parent accounts are retained until deleted. Session
tokens expire on fixed schedules and are purged by an automated sweep.
Scrubbed error records are automatically deleted after 30 days. Backup
retention: [BACKUP_RETENTION_PLACEHOLDER].

9. Changes to this policy
This policy is versioned. When we publish a new version we update the
version number and effective date, show the change to parents in the app,
and (when the change is material to consent) require re-acceptance of the
consent policy before further collection.

10. Contact
Questions or requests: [CONTACT_EMAIL], [POSTAL_ADDRESS]. You may also
contact us to exercise any right in section 5.
`;

const TERMS_OF_SERVICE_BODY = `
DRAFT - NOT FINAL LEGAL TEXT. These terms of service require review and
approval by qualified legal counsel before deployment. Bracketed
[PLACEHOLDERS] must be completed by the operator.

Terms of Service for the Balashikshana learning app
Version 1 (draft) - effective [EFFECTIVE_DATE]
Operated by [COMPANY_LEGAL_NAME], [JURISDICTION]. Contact:
[CONTACT_EMAIL], [POSTAL_ADDRESS].

1. Agreement
These terms govern your use of the Balashikshana app, parent portal, and
related service. By creating a parent account you accept them. A parent or
legal guardian must own the account; children use learner profiles created
and supervised by that parent.

2. The service
Balashikshana provides mastery-gated learning games and practice for
pre-kindergarten through grade 3, a parent portal for oversight
(progress, time limits, content controls), and offline practice that
synchronizes when the device is online.

3. Accounts and security
You are responsible for your parent password and for the 4-digit PINs you
assign to learner profiles. Tell us promptly about unauthorized access.
We may suspend accounts that abuse the service or attempt unauthorized
access.

4. Acceptable use
Do not probe, scan, or test the service for vulnerabilities, circumvent
rate limits, scrape, or attempt to access another family's data. Do not
use the service to transmit unlawful content.

5. Parental consent and child data
Child learning data is created only after verifiable parental consent as
described in the Privacy Policy (also versioned and reachable in-app). You
may withdraw consent by deleting the relevant data from the portal.

6. Purchases
Optional purchases, if offered, are processed by Apple App Store or Google
Play under the store's terms. We do not store payment card data.

7. Availability
We aim for reliable availability but do not promise uninterrupted service.
The service may be modified, suspended, or discontinued; material changes
to learning-data handling will follow the Privacy Policy change process.

8. Intellectual property
The operator retains all rights in the app, curriculum, and content.
Signatures inside the app protect content integrity; do not remove,
alter, or circumvent them. You receive a personal, non-exclusive license
to use the app for its intended purpose.

9. Disclaimer of warranties
THE SERVICE IS PROVIDED "AS IS" WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND
NON-INFRINGEMENT.

10. Limitation of liability
TO THE MAXIMUM EXTENT PERMITTED BY LAW, THE OPERATOR IS NOT LIABLE FOR
INDIRECT, INCIDENTAL, SPECIAL, OR CONSEQUENTIAL DAMAGES. TOTAL LIABILITY
IS LIMITED TO [LIABILITY_CAP_PLACEHOLDER].

11. Termination
You may stop using the service and delete your account at any time. We may
terminate access for material breach of these terms.

12. Governing law
[JURISDICTION_PLACEHOLDER].

13. Changes to these terms
These terms are versioned. When we publish a new version we update the
version number and effective date and show the change in the app.

14. Contact
[CONTACT_EMAIL], [POSTAL_ADDRESS].
`;

const CONSENT_POLICY_V2_TEXT = `
CONSENT TO COLLECTION OF YOUR CHILD'S LEARNING DATA
DRAFT - PENDING LEGAL COUNSEL REVIEW. [PLACEHOLDERS] to be completed by
the operator before finalization.

By accepting, you the parent or legal guardian consent to
[COMPANY_LEGAL_NAME] collecting and using your child's learning data for
one purpose: operating and improving your child's learning experience in
this app, including progress tracking, mastery placement, rewards, the
parent dashboard, and the optional weekly summary email.

What this covers: learner profile (nickname, username, avatar, age band,
grade), practice answers and results, mastery-gate and placement outcomes,
learning rewards, and the device sessions that keep your child's device
connected to the profile you authorized.

What this never includes: advertising, sale, or sharing of your child's
data with third parties for their own purposes; there are no third-party
advertising or analytics SDKs in this app.

Before accepting, please read the Privacy Policy and Terms of Service
(versioned; both are reachable on this screen and in the parent area).
You may withdraw consent at any time by deleting your child's data in the
parent portal, and you can export or delete everything we hold from the
same place. Questions: [CONTACT_EMAIL].
`;

exports.up = (pgm) => {
  pgm.createTable("legal_documents", {
    kind: { type: "text", notNull: true },
    version: { type: "text", notNull: true },
    locale: { type: "text", notNull: true, default: "'en-US'" },
    body: { type: "text", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") },
    active: { type: "boolean", notNull: true, default: false }
  }, { ifNotExists: true });
  pgm.addConstraint("legal_documents", "legal_documents_pk", "PRIMARY KEY (kind, version)");
  pgm.sql(`CREATE UNIQUE INDEX IF NOT EXISTS uq_legal_documents_active
           ON legal_documents (kind, locale) WHERE active`);
  pgm.sql(`ALTER TABLE legal_documents
           ADD CONSTRAINT legal_documents_kind_ck CHECK (kind IN ('privacy-policy', 'terms-of-service'))`);

  // v1 seeds (idempotent). The canonical text also lives in docs/legal/.
  pgm.sql(`
    INSERT INTO legal_documents (kind, version, locale, body, active)
    VALUES ('privacy-policy', '1', 'en-US', $q$${PRIVACY_POLICY_BODY}$q$, true)
    ON CONFLICT DO NOTHING
  `);
  pgm.sql(`
    INSERT INTO legal_documents (kind, version, locale, body, active)
    VALUES ('terms-of-service', '1', 'en-US', $q$${TERMS_OF_SERVICE_BODY}$q$, true)
    ON CONFLICT DO NOTHING
  `);

  // The real policy bump: deactivate the NON-LEGAL v1 placeholder FIRST
  // (the partial unique index would reject two active rows), then seed the
  // production consent statement v2.
  pgm.sql("UPDATE consent_policy_versions SET active = false WHERE version = '1' AND active = true");
  pgm.sql(`
    INSERT INTO consent_policy_versions (version, locale, policy_text, active)
    VALUES ('2', 'en-US', $q$${CONSENT_POLICY_V2_TEXT}$q$, true)
    ON CONFLICT (version) DO NOTHING
  `);
};

exports.down = (pgm) => {
  // Restore the pre-014 state: v2 removed first (the partial unique index
  // would reject two active rows), then the placeholder v1 reactivated,
  // then the legal catalog dropped. (Runtime doctrine never edits these
  // rows; a migration down is the schema lifecycle, as with migration 004.)
  // NOTE: once consent evidence cites v2, the DELETE fails on the
  // consent_records FK (ON DELETE RESTRICT) — deliberate fail-safe,
  // identical to migration 004's down on a database with evidence.
  pgm.sql("DELETE FROM consent_policy_versions WHERE version = '2'");
  pgm.sql("UPDATE consent_policy_versions SET active = true WHERE version = '1' AND active = false");
  pgm.sql("ALTER TABLE legal_documents DROP CONSTRAINT IF EXISTS legal_documents_kind_ck");
  pgm.dropTable("legal_documents", { ifExists: true });
};
