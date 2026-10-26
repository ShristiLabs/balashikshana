# Reviewer Notes Pack — issue #69 (Apple + Google store reviewers)

The paste-into-console pack plus the evidence pointers reviewers ask for.
Honesty bar: a reviewer must be able to reach EVERY gated surface with the
instructions below; nothing is hidden behind unexplained friction.

## Demo parent account [USER-SIDE to create before filing]

Create with the production API (or the store-review staging deployment):

| Field | Value |
|---|---|
| Parent email | balashikshana-review+[store]@[operator-domain] |
| Parent password | [USER-SIDE: generate + store in the console's secure notes field, NOT in this repo] |
| Child profile 1 | nickname "Demo Kid", age band Pre-K (tests narration) |
| Child profile 2 | nickname "Demo Kid 2", Grade 3 (tests hardest tier + gate) |
| Child PIN | [USER-SIDE: 4 digits, same secure field] |

Note for reviewers: email verification and password reset deliver a
copyable CODE by email (no links, by anti-phishing design). For the review
account, either provide the mailbox or pre-verify the account before
submitting — both work; the app never blocks a reviewer at the gate.

## Guided walkthrough (paste into review notes)

1. **Onboarding**: sign up as the demo parent. A verification CODE arrives
   by email; paste it into the app (no link, by design).
2. **Consent**: the consent statement, Privacy Policy, and Terms render
   IN-APP before the accept button — nothing opens a browser.
3. **Parental gate**: reaching parent surfaces requires a 3-second
   hold-to-confirm gate (tap-spam does not pass; accessibility actions do
   not bypass; the bypass matrix is documented in our compliance docs).
4. **Add a child**: parent creates the child profile (nickname, avatar,
   4-digit PIN) and picks the grade. No child-identifying data is entered
   by the child.
5. **Child session**: the child signs in with avatar + PIN and practices:
   spoken questions, touch interactions, mastery gates, celebratory
   feedback. All content is offline-capable and cryptographically
   verified first-party packs.
6. **Offline**: enable airplane mode mid-session — practice continues from
   the device packs; progress syncs when back online.
7. **Parent portal** (web, same account): progress dashboard, weekly
   digest opt-in, time limits, legal documents, and full data
   **export** and **deletion** (deletion requires password re-entry and is
   audited).
8. **No exit ramps**: at no point can a child reach a browser, an ad, a
   chat, or a store page — verified by automated link/SDK audits that run
   in CI.

## COPPA posture summary (for the reviewer)

- Verifiable parental consent is required and captured BEFORE any
  learning data exists (server-enforced, not UI-enforced; append-only
  consent records with versioning).
- Parents are email-verified; verification/reset codes are delivered by
  email only — never in API response bodies in production (byte-level
  test-enforced).
- First-party only: no advertising, analytics, or tracking SDKs (exact
  dependency allowlist enforced in CI); the only off-device data flows are
  to our own API and transactional email via our email provider.
- Full data rights: export (complete) and deletion (audited) from the
  parent portal.
- Data Safety / Privacy Nutrition answers are generated from a
  code-verified data-flow inventory (docs/data-flow-inventory.md) — a
  traceability matrix maps every store answer to the inventory row and the
  enforcing code.

## Network-traffic audit (live evidence) [USER-SIDE run; protocol here]

The committed half: endpoint-disclosure and SDK scans run in CI
(`apps/mobile/tests/store-config.test.ts`,
`apps/mobile/tests/coppa-invariants.test.ts`) — every network call in
shipped sources targets the single configurable first-party API origin.

The live half (run before filing, per roadmap M6 verification):

1. Build the release candidate (same build family you upload).
2. Proxy the device (iOS: Mac network proxy + trust CA on a test device;
   Android: emulator + Android Studio proxy or Charles).
3. Complete the full walkthrough above, including offline/online
   transitions and a content-pack download.
4. Assert the capture contains ONLY the first-party API origin
   (and, during pack download, the same origin). No ads/analytics/crash
   domains. No unexpected TLS SNI.
5. File the capture summary (domains list + walkthrough checklist) with
   the submission records; update docs/families-kids-self-check.md's
   evidence section if anything new appears (nothing should).

## Contacts [USER-SIDE: fill before submitting]

| Role | Contact |
|---|---|
| Compliance contact for reviewer inquiries | [CONTACT_EMAIL] |
| Phone (some consoles require) | [CONTACT_PHONE] |
| DPA/legal escalation | [LEGAL_CONTACT] |

## Submission tracking (update issue #69 until resolution)

| Store | Filed (date) | State | Reviewer feedback | Response |
|---|---|---|---|---|
| Apple App Store (Kids Category) | - | not filed | - | - |
| Google Play (Families + Data Safety) | - | not filed | - | - |

Reviewer feedback handling: record verbatim, answer with inventory-traced
facts, never with new claims not backed by code evidence; if a fix is
required, it ships as a normal issue first, then the form changes.
