# Accessibility + Performance Audit — #67 (M6)

Audit gate before store submission (#69). Committed with the audit-driven
fixes and the enforcement that keeps the findings fixed. Every finding
carries a severity (P1 blocker .. P4 minor) and a status: FIXED in this
PR, VERIFIED (already correct, now pinned), or DEBT (recorded in the
delivery debt register with rationale).

## Method and tooling decisions

- **Mobile (Expo/RN): source analysis + pure-module tests.** No RN
  component harness exists (standing debt since M3), so mobile findings
  come from systematic source review of every screen surface, enforced
  by source-pin tests in the repo's established style
  (`apps/mobile/tests/accessibility-source-pins.test.ts` — derived
  expectations, not hand-listed).
- **Parent portal: runtime axe.** The portal already runs jsdom +
  testing-library, so axe runs for real: `jest-axe` 11 (the established
  OSS wrapper; pins axe-core 4.12.1 as its engine) as a portal-only
  devDep. Chosen over direct axe-core for its UMD interop handling and
  the standard results shape; no runtime dependencies added anywhere.
  Suite: `apps/parent-portal/src/__tests__/a11y.test.tsx`, riding the
  existing CI portal gate (no CI job added — cost doctrine). A canary
  test plants violations (missing alt, unnamed button, empty anchor)
  and proves the engine fires, so a green suite is never vacuous.
- **eslint-plugin-jsx-a11y 6.10.2** (portal-only devDep, flat-config
  recommended profile): lint-time a11y enforcement complementing the
  runtime suite. Evaluated and ADOPTED — clean ESLint 9 flat-config
  fit, zero config friction, and the entire existing portal source
  passed its recommended profile on first run.
- **a11y-react-native: evaluated and REJECTED.** The package's value is
  default a11y props on RN primitives; this codebase already sets
  explicit, context-rich a11y props on all 33 Pressable sites (pinned),
  and RN 0.88's native a11y API is sufficient. Adding a wrapper
  dependency would add supply-chain surface for zero measured gain.
- **Performance:** measured Hermes exports (this branch) +
  `scripts/measure-bundle-sizes.mjs` enforcement + static re-render /
  animation / virtualization survey. Full budget: see
  `docs/performance-budget.md` (the low-end device matrix runtime pass
  is the user-side step; the protocol and targets are fixed there).

## Mobile findings (kid flows, screen by screen)

| # | Surface | Finding | Severity | Status |
|---|---|---|---|---|
| M1 | ALL runners (practice + gate) | Dynamic changes were never announced: feedback appearing, question transitions, and the Gold-check countdown rendered silently for VoiceOver/TalkBack users (screen readers speak focus moves, not DOM changes) — a reader child got no signal that CHECK did anything | **P1** | **FIXED**: `src/a11y/announceMessages.ts` (pure builders) + `src/a11y/nativeAnnounce.ts` (AccessibilityInfo seam); wired into both runners; unit-tested (`tests/a11y-announce.test.ts`, 16 tests) + wiring pinned |
| M2 | Practice runner | Feedback bar text is readable on focus but correct-answer reveal relied on visual color shift | P3 | FIXED (folded into M1: announcement speaks the revealed answer) |
| M3 | Gate (gold check) | Countdown label existed but time pressure was invisible to screen readers | P2 | FIXED (30s/10s threshold announcements; per-second speech deliberately avoided — chatty speech drowns the question; threshold set pinned by test) |
| M4 | All interactive elements | Every `<Pressable` across src/ + app/ (33 sites) carries role/label/state | — | VERIFIED, now PINNED (a future unlabeled Pressable fails CI) |
| M5 | Labels quality | Labels are context-rich, not placeholder text ("Practice topic X. 2 crowns. Early stage", "Choice 3: seven", "Slot 2: filled") | — | VERIFIED |
| M6 | Journey map | Grade switcher exposes selected/busy state; nodes labeled with state-aware hints; scroll reveal detached under reduced motion; trailing "back to start" escape | — | VERIFIED |
| M7 | Onboarding + parental gate | Hold-to-confirm gate labeled with explicit hold-duration hint + progress label (single-tap bypass would defeat the gate); steps carry 36 a11y props incl. hints | — | VERIFIED |
| M8 | Games (4 archetypes) | Bubbles/blocks/cashier/feeder labeled per element ("Ten rod 2", "Bubble 7"), selected/disabled states exposed, replay + hint buttons labeled | — | VERIFIED |
| M9 | Placement offer + screen | Card never blocks the map; accept/decline labeled | — | VERIFIED |
| M10 | Mascot | Decorative: entire subtree hidden (`no-hide-descendants` + `accessibilityElementsHidden`) | — | VERIFIED, PINNED |
| M11 | Reduced motion | Two verified mechanisms: `animationsEnabled` guards (mascot, badge bloom, key ceremony) and profile-collapsed durations (`motion.durationMs` = 0, sheet slide). Repo-wide scan: NO ungated `Animated.*` site | — | VERIFIED, PINNED (new animated components must join the audited set or the pin fails) |
| M12 | TTS + screen reader interplay | Narration defers when a screen reader is active (`deferred-screen-reader` outcome) — no double-speech; with M1 the announcement seam now carries the feedback the TTS would have spoken | — | VERIFIED (unit-tested since #59) |
| M13 | Haptics | Suppressed when the user disables haptics OR OS reduced-motion is on (coordinator `haptic()`); patterns are calm success/retry pulses appropriate for ages 3-9; no haptic fires on decorative events | — | VERIFIED |
| M14 | Touch targets + type scale | >=48pt enforced at the primitive level (Button hitSlop + MIN_TOUCH_TARGET; journey node size pinned); kid-scale ramp + WCAG contrast pinned in `tests/design-invariants.test.ts` incl. highContrast theme | — | VERIFIED (pre-existing tests) |
| M15 | Focus order + swipe semantics | Screens are linear layouts (RN focus order follows layout order); no custom swipe gestures exist (no PanResponder/gesture-handler) — swipe = native scroll, semantics free | — | VERIFIED |
| M16 | Celebration/ceremony | KeyCeremony carries its copy as text (focusable), badges bloom (gated), TTS celebration defers to screen reader (see M1/M12) | — | VERIFIED |
| M17 | No RN component harness | Runtime VoiceOver/TalkBack automation impossible in-repo today | P3 | DEBT (standing since M3; the matrix run in performance-budget.md §4 is the runtime complement) |

## Parent portal findings

| # | View | Finding | Severity | Status |
|---|---|---|---|---|
| P1 | All views | No automated a11y enforcement existed for the portal | P2 | **FIXED**: axe suite (8 tests, all views incl. shell/skip-link) wired into the CI portal gate; canary proves violations fail CI |
| P2 | Shell | Skip link present on every view; main heading focused on view change (deliberate landing); notices are `role=status` | — | VERIFIED (now under axe + jsx-a11y lint) |
| P3 | Charts | Quadrant chart svg exposes an accessible name; weekly chart is a real data table with visually-hidden caption and scoped headers | — | VERIFIED |
| P4 | Forms | Login/settings/email-prefs inputs labeled; validation alerts are `role=alert`; COPPA notes in plain text | — | VERIFIED |
| P5 | Reduced motion | Global `prefers-reduced-motion: reduce` kill-switch for transitions/animations (tokens.css) | — | VERIFIED |
| P6 | Keyboard navigation | All interactive elements are native button/input/anchor; no focus traps (single-page state views); no keyboard dead ends found | — | VERIFIED |
| P7 | Data rights | Hold-to-confirm delete carries the same labeled-hold treatment as the mobile parental gate | — | VERIFIED |

## Performance findings

| # | Area | Finding | Severity | Status |
|---|---|---|---|---|
| F1 | Bundle budget | No measured budget or enforcement existed; sizes were recorded ad-hoc per delivery | P2 | **FIXED**: `docs/performance-budget.md` + `scripts/measure-bundle-sizes.mjs --check` (5.5 MiB/platform ceiling; measured 4.995/5.005 MiB = ~91%) |
| F2 | Animation frame cost | All animation transform-only (compositor); scroll-linked reanimated reveal detached under reduced motion; animated-component set closed (pin) | — | VERIFIED |
| F3 | List virtualization | Journey map ~26-30 nodes per grade in ScrollView — virtualization not warranted; threshold documented (revisit > 60 nodes) | P4 | VERIFIED (documented decision) |
| F4 | Re-render discipline | Hot paths memoize (12 sites each in practice/gate); no React.memo on small widget sets (<= 8 children) — deliberate, documented | P4 | VERIFIED (documented decision) |
| F5 | Asset weight | SVG-only + Rive < 50 KB + zero raster enforced in CI since M4; export assets 312 KB | — | VERIFIED |
| F6 | 60fps on low-end matrix | Runtime measurement is device-side; protocol + targets fixed (budget doc §4) | P3 | DEBT (user-side run before #69; template in budget doc) |
| F7 | TTS variance | Engine fallback to bundled Pre-K audio unit-tested; spot-check protocol fixed (budget doc §5) | P3 | DEBT (user-side matrix run; fallback logic VERIFIED) |
| F8 | Cold start / memory | Not locally measurable without the matrix; targets + protocol fixed (budget doc §4) | P3 | DEBT (user-side run) |

## Totals

- Findings: 1 P1 (fixed), 3 P2 (all fixed), 5 P3 (1 fixed, 4 user-side
  matrix debt), 2 P4 (verified-documented), 21 verified-good.
- Launch blockers (P1/P2): ZERO open — all fixed in this PR.
- New tests: 26 mobile (16 announcer + 10 source-pins), 8 portal axe
  (incl. canary). Suites: mobile 1040, portal 40.
- New dependencies: `jest-axe` 11 + `eslint-plugin-jsx-a11y` 6.10.2 —
  both devDeps, portal-only, zero runtime deps (core-engine untouched).
