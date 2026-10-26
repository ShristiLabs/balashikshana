# Families / Kids Policy Self-Check — issue #68 (M6 compliance)

Verification-method-first self-check of Balashikshana against the two
program requirements that govern kids apps: **Apple Kids Category** and
**Google Play Families**. Every row cites the verification METHOD (a
committed, rerunnable scan or test) — nothing here is assertion-only.
Run all evidence layers with:
`npm test --workspaces=false --prefix apps/mobile` (the scans live in
`tests/coppa-invariants.test.ts` and `tests/legal-pack.test.ts`).

## 1. No third-party advertising or analytics SDKs

**Requirement.** Both programs reject kids apps that ship third-party
ad/analytics/tracking SDKs (and the AGENTS.md invariant D5 forbids them).

**Method (evidence layer 1 — SDK scan).** `coppa-invariants.test.ts`
enforces TWO independent layers over every workspace manifest:
1. An exact per-manifest COPPA allowlist of runtime dependencies — adding
   ANY dependency to ANY workspace fails CI until the allowlist is
   consciously extended in the same PR (the store Data Safety forms are
   regenerated from that inventory).
2. A vendor-pattern blocklist (`admob|adsense|doubleclick|facebook|
   firebase|amplitude|mixpanel|segment|appsflyer|adjust|branch|kochava|
   braze|clevertap|sentry|datadog|...`) over every dependency name,
   runtime AND dev, in every workspace.

**Result (2026-10-26 run).** PASS. Inventory: API 8 runtime deps
(fastify + 3 @fastify plugins, pg, node-pg-migrate, nodemailer, pino),
mobile 24 (expo/RN/react + @noble crypto + netinfo), portal 2 (react,
react-dom), core-engine 0 (zero-dependency invariant also pinned),
content-pipeline 0. Usage measurement is first-party (the #66 metrics
registry) with redaction at capture; there is no third-party telemetry
path.

## 2. No un-gated external links in child-facing views

**Requirement.** Apple Kids Category: apps must not include external
links unless behind a parental gate; Play Families: no un-gated
commercial links.

**Method (evidence layer 2 — link audit).** `coppa-invariants.test.ts`
scans every shipped mobile source file (src/ + app/, 100+ files) for
external-link escape hatches (`Linking.openURL`, `openURL(`, `<a href`)
and for remote-push surfaces (`getDevicePushToken`, `getExpoPushToken`,
`registerDeviceForRemoteMessages`, `useLastNotificationResponse`). The
legal pack itself renders in-app text only
(`tests/legal-pack.test.ts` pins no-Linking/no-href on the legal
component).

**Result (2026-10-26 run).** PASS — zero external-link call sites exist
anywhere in shipped mobile source (all content, including the Privacy
Policy and Terms of Service, renders from the versioned in-app catalog).
Zero remote-push surfaces: notifications are device-local reminders only
(#57 doctrine; `setNotificationHandler`/`scheduleNotificationAsync` are
the local surface and are excluded from the ban pattern deliberately).

## 3. Parental-gate bypass audit (hold-to-confirm)

**Requirement.** Parent/settings surfaces must sit behind an age-gate
resistant to child bypass; the gate itself must meet platform parental-
gate conventions.

**Method (evidence layer 3 — timing-model tests + placement scans).**
The gate's timing model is the pure module `src/onboarding/gateTimer.ts`
(unit-tested in `tests/onboarding-gate-timer.test.ts`); placement is
pinned by `tests/coppa-invariants.test.ts`.

**Bypass matrix (vector → mechanism → evidence):**

| Vector | Why it fails | Evidence |
|---|---|---|
| Tap-spam (rapid repeated taps) | Every release fully resets accumulated time; only a single continuous ≥3 s press completes. Press-tracks cannot accumulate across attempts. | `onboarding-gate-timer.test.ts` "tap-spamming never accumulates hold time", "a release at any point resets accumulated time" |
| Hold-splitting (short holds, resume) | No carry-over state exists: `holdRelease` zeroes progress; a new press starts a fresh `pressStartedAt`. | same suite, "completes only after a full continuous hold" |
| Keyboard / assistive-tech activation | Hardware-key or switch activation produces a press-in + press-out pair — indistinguishable from a tap: reset before 3 s. (A keyboard user completing the gate does so by holding the key 3 s — the intended gesture.) | Structural: `ParentalGate.tsx` wires only `onPressIn`/`onPressOut`; no activation shortcut is registered |
| Accessibility-action bypass | No tap-to-pass accessibility action exists (deliberately — a single-tap bypass would defeat the gate for every screen-reader user); the control is announced as a button with a hold hint. | `coppa-invariants.test.ts` gate test (no `accessibilityAction`); `ParentalGate.tsx` header comment |
| Reduced-motion / animation tricks | The gate is a setInterval timer, not an animation API; reduced-motion may suppress the progress-bar visual but cannot affect timing. | `ParentalGate.tsx` doctrine comment; `onboarding-gate-timer.test.ts` (pure model, clock injected) |
| Clock manipulation (client time) | The pure model derives completion from elapsed wall-clock deltas (`now - pressStartedAt`), not absolute time or progress fraction; moving the device clock cannot shorten a live hold. | `gateTimer.ts` `holdTick` (only `holdPress` sets `pressStartedAt`, from the same injected clock) |
| Gesture-cancel (system interruption) | A system gesture/navigation interruption delivers press-out → full reset. The #62 fix hardened this path; the behavior is re-pinned. | `coppa-invariants.test.ts` gate-placement suite + `ParentalGate.tsx` wiring (press-out always routes through `holdRelease`) |
| Forgetting to gate a surface | Placement scan: every parent-content RENDER in the parent area must sit after the gate branch, and parent-surface modules (ReminderSettingsSection, LegalDocuments, ParentalGate) must not be imported by child-facing route files. | `coppa-invariants.test.ts` "the parent area gates ALL of its content", "parent-surface modules do not leak" |
| Latch abuse (completed state persisting) | `onPassed` fires exactly once (passedRef latch); completion latches only until the gate remounts per protected surface. | `onboarding-gate-timer.test.ts` latch tests |

**Result.** PASS. Zero un-gated parent/settings routes reachable from
child-facing views (automated); the gate implements the platform
conventions (multi-second hold, announced to screen readers, no
single-tap path).

## 4. Data minimization and parental consent flows

**Requirement.** Kids programs expect collection limited to disclosed,
consented purposes with verifiable parental consent before child data
collection.

**Method.** Cross-checked against code + the running suite: consent gates
on every child-data-creating route (`consent.test.mjs` exercises every
gated route and every refusal path; the suite-end invariant asserts the
audit view is empty); versioned consent with re-consent on policy bump
(end-to-end test); the consent statement now references the shipped
Privacy Policy and Terms of Service (reachable on the consent screen
BEFORE the accept button — pinned in `tests/legal-pack.test.ts`); SR-1
of `docs/security-review.md` removed the one unauthenticated child-PII
surface. The complete collection inventory with storage, flows-out, and
retention per class: `docs/data-flow-inventory.md`.

**Result.** PASS (with the standing draft caveats in
`docs/legal/README.md` — counsel review + placeholder completion are #69
entry criteria).

## 5. Age-appropriate design (design-level checks)

- Age gates: learner profiles are created ONLY by a verified parent
  (post-#42 every creation path binds a parent); age band 3–10 enforced
  at the schema (`ageYears` 3..10), grade enum pre-k..grade-3.
- No user-generated content surfaces, no chat, no open web views.
- No purchases inside child-facing views (purchases, if any, are store-
  side per the Terms draft).
- COPPA-safe defaults: reminders OFF by default (#57), weekly digest
  opt-in (#63).

## Regeneration

Every claim above regenerates from:
`npm test --workspaces=false --prefix apps/mobile` (scans + pins) and
`npm test --workspace @balashikshana/api` (consent machinery + SR-1
production posture). The self-check should be re-run (and this document
re-dated) whenever the dependency allowlist changes or a new
child-facing surface lands.
