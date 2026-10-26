# Legal Pack (issue #68) — versioning, publishing, and re-consent semantics

DRAFT — every document in this pack requires review and approval by
qualified legal counsel before deployment. Bracketed `[PLACEHOLDERS]` are
completed by the operator. This README is engineering documentation, not
legal text.

## What ships where

| Artifact | Canonical source | Rendered surfaces |
|---|---|---|
| Privacy Policy (v1) | migration 014 seed (`legal_documents`, kind `privacy-policy`) | mobile onboarding consent screen (before the accept button), gated parent area, portal footer (all views incl. login) |
| Terms of Service (v1) | migration 014 seed (`legal_documents`, kind `terms-of-service`) | same three surfaces |
| Consent statement (v2) | migration 014 seed (`consent_policy_versions` version `2`) | mobile onboarding consent screen (the text the parent accepts) |
| Readable copies | `docs/legal/privacy-policy.md`, `docs/legal/terms-of-service.md`, the v2 statement quoted in this README | repo readability only |
| FERPA/DPA posture notes | `docs/legal/ferpa-dpa-posture.md` (issue #70) | repo/engineering review — NOT rendered in-app; the B2B seam has no user-facing surface today |

The **database rows are canonical** (the apps render from
`GET /api/legal/:kind/latest` and `GET /api/consent/policy/latest`); the
markdown files are mirrors for code review. `services/api/test/legal.test.mjs`
pins the structural invariants (draft banner present, bracketed
placeholders, single active version per kind, independence from the
consent policy version).

## Versioning model

- `legal_documents` mirrors `consent_policy_versions` (migration 004):
  append-only rows, exactly one `active` per `(kind, locale)` enforced by
  the partial unique index `uq_legal_documents_active`; versions are
  dotted-decimal text; rows are never edited or deleted at runtime.
- Each kind (`privacy-policy`, `terms-of-service`) versions independently.

## The re-consent decision (binding)

**Publishing a new privacy-policy or terms-of-service version does NOT
trigger re-consent.** `GET /api/consent/status` compares the parent's
latest consent row against `consent_policy_versions.version` ONLY;
`legal_documents` is not part of that comparison. This is tested
(`legal.test.mjs`: "publishing privacy-policy v2 leaves consent status
and policy version untouched" — and the contrast case proves a consent
policy bump DOES decurrent consent).

Rationale: re-consent is a high-friction interruption for every family;
COPPA requires it when the *collection scope described to the parent*
changes materially — which is what the consent statement text covers —
not for every editorial pass on the surrounding documents.

**Ops runbook — routine legal text update:**

```sql
BEGIN;
  UPDATE legal_documents SET active = false WHERE kind = 'privacy-policy' AND active;
  INSERT INTO legal_documents (kind, version, locale, body, active)
    VALUES ('privacy-policy', '2', 'en-US', $body..., true);
COMMIT;
```

No client release needed: every surface fetches `/latest` on render.
Existing users see the new text next time they open the surface.

**Ops runbook — MATERIAL change (collection scope, purposes, sharing,
retention, or data rights change):** bump BOTH the affected legal
document(s) AND the consent policy in one maintenance window:

```sql
BEGIN;
  UPDATE legal_documents SET active = false WHERE kind = 'privacy-policy' AND active;
  INSERT INTO legal_documents (kind, version, locale, body, active)
    VALUES ('privacy-policy', '2', 'en-US', $body..., true);
  UPDATE consent_policy_versions SET active = false WHERE active;
  INSERT INTO consent_policy_versions (version, locale, policy_text, active)
    VALUES ('3', 'en-US', $new_consent_statement..., true);
COMMIT;
```

The consent-policy bump immediately makes every older consent stale: new
child-data creation is refused with `consent-required` until the parent
re-accepts, and the mobile app surfaces the re-consent step (the existing
M2 machinery — no code changes). The in-transaction policy re-check
(migration 005-era `assertActivePolicyUnchanged`) closes the flip-during-
request race.

**Decision record — the v1 → v2 consent-policy bump shipped in migration
014 itself:** the migration-004 placeholder was explicitly NON-LEGAL and
marked "must replace before any public deployment"; #68 is that
replacement, so the production consent statement ships ACTIVE. Every
parent who consented at v1 (development-stage accounts) re-consents at v2
before creating further child data — one-time, correct, and exactly what
the machinery exists to do.

## Draft banner and placeholders

Until counsel signs off, every seeded body opens with the
`DRAFT — NOT FINAL LEGAL TEXT` banner and uses `[BRACKETED_UPPER_SNAKE]`
placeholders (`[COMPANY_LEGAL_NAME]`, `[CONTACT_EMAIL]`,
`[POSTAL_ADDRESS]`, `[JURISDICTION]`, `[EFFECTIVE_DATE]`,
`[DATA_REGION]`, `[BACKUP_RETENTION_PLACEHOLDER]`,
`[LIABILITY_CAP_PLACEHOLDER]`, `[JURISDICTION_PLACEHOLDER]`). The banner
renders in-app by construction (it is part of the document body).
`#69` (store submissions) MUST NOT ship to stores while the banner is
present — replacing placeholders + counsel signoff is a #69 entry
criterion, via a routine legal-text bump above (no consent bump unless
counsel changes the scope).

## #69 entry criteria (engineering dependencies behind the policy text)

The privacy policy describes the LAUNCH posture. Two engineering items
the text depends on are pinned here so #69 cannot ship without them:

1. **Email delivery of verification and password-reset links.** The
   policy (sections 2a and 7) states the email provider sends the
   verification link and password-reset mail. ~~Today those tokens are
   still delivered through the development response-body seam~~
   **RESOLVED by #69 (the mailer flip)**: verification/reset tokens now
   route through the #63 SMTP transport (`parent-auth.mjs` +
   `auth-emails.mjs`); production response bodies never carry tokens
   (byte-level NODE_ENV=production tests, `test/parent-auth-mail.test.mjs`),
   and the mailed credential is a plain-text copyable code with no link
   (anti-phishing; full-entropy token retained over a 6-digit code).
   Operational note: a production boot without `SMTP_HOST` logs a loud
   boot error (mail dropped honestly) — verify a real SMTP host before
   any store filing (docs/store/README.md pre-filing checklist).
2. **Backup retention answer.** `[BACKUP_RETENTION_PLACEHOLDER]` must be
   answered with the real backup window (the store forms ask it too) —
   still USER-SIDE.
