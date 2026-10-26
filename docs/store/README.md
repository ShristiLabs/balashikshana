# Store Submissions Pack — issue #69

Everything needed to file the Apple App Store (Kids Category) and Google
Play (Families) listings. The submissions themselves are console
operations ([USER-SIDE], tier 3); this directory is the complete,
ready-to-paste, code-traced pack.

## Contents

| File | What it is |
|---|---|
| `data-safety-traceability.md` | The chain of custody: every store answer → `docs/data-flow-inventory.md` row → enforcing code. Test-enforced (`services/api/test/store-pack.test.mjs`) |
| `apple-app-store.md` | App Store Connect listing: identity, age bands, questionnaire, privacy labels, Kids self-check, screenshots spec, copy |
| `google-play.md` | Play Console listing: Families declarations, Data Safety form field-by-field, IARC answers, target audience, pre-launch checklist |
| `age-ratings.md` | Rationale for both stores' age/rating answers (ages 3-9, grade tiers) |
| `review-notes.md` | Reviewer pack: demo-account template, walkthrough, COPPA summary, live traffic-audit protocol, contacts, submission tracking |

## Engineering changes that make the pack honest (this issue)

1. **Mailer flip** (`services/api/parent-auth.mjs` + `auth-emails.mjs`):
   verification and password-reset tokens are DELIVERED BY EMAIL through
   the #63 SMTP seam — production response bodies never carry tokens
   (byte-level production-mode tests). Without this, the privacy policy's
   email-delivery claims and the consent posture were false. The mailed
   credential is a plain-text copyable code with NO link (anti-phishing;
   the full-entropy token is kept over a 6-digit code — guess space
   matters more than typing convenience).
2. **Native config audit** (`apps/mobile/app.json` + prebuild
   verification): the expo-audio plugin defaults merged mic/record,
   background-audio, storage, and overlay permissions the app never uses
   (playback-only runtime). All stripped; `apps/mobile/tests/store-config.test.ts`
   pins the config so drift fails CI.
3. **Endpoint disclosure**: shipped sources egress to exactly one
   configurable first-party origin — test-enforced.

## Pre-filing checklist (BLOCKERS are user-side, per docs/legal/README.md)

- [ ] Counsel review of privacy policy + terms + consent statement
      (draft banners + bracketed placeholders must be gone)
- [ ] `[BACKUP_RETENTION_PLACEHOLDER]` answered (Play security practices ask)
- [ ] Real `SMTP_HOST` (+ SSM credentials) verified in the production
      environment — verification mail MUST flow (the API logs a loud boot
      error if a production boot lacks it)
- [ ] Legal-text bump shipped (routine ops runbook in docs/legal/README.md;
      no consent-policy bump unless counsel changes scope)
- [ ] Privacy policy URL: confirm the public production origin
- [ ] Screenshots captured per specs (apple-app-store.md, google-play.md)
- [ ] Demo parent account created (review-notes.md template)
- [ ] Live network-traffic audit run on the release build (protocol in
      review-notes.md)
- [ ] #67 P3 user-side device-matrix runs (docs/performance-budget.md §4-5)
- [ ] Console uploads filed; statuses tracked in issue #69

The forms must not be filed while the legal texts still carry the DRAFT
banner (docs/legal/README.md #69 entry criteria) — store reviewers read
the linked policy.
