# Balashikshana — Enterprise Launch Roadmap (M1–M6)

Status: **approved** (2026-10-21) — M1 in delivery. Issue numbers assume
sequential GitHub creation from **#27** (issues #1–#26 are closed: curriculum
content + core engine + API + web client, the "M0 foundation").

Mission: take the existing foundation (130-unit curriculum DAG, 614 topics,
6,140 questions, mastery-gate + child-FSRS engine, working API and web client)
to a production kids app (Pre-K–Grade 3, ages 3–9) usable by children across
the USA on iOS and Android, with a parent layer, COPPA compliance, and
enterprise operations.

- [Decisions](#decisions)
- [Milestone overview](#milestone-overview)
- [Issue tree](#issue-tree)
- [Workstream details](#workstream-details)
- [Key reuse map](#key-reuse-map)
- [Risks / launch gates](#risks--launch-gates)
- [Verification](#verification)

## Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | The product client is the **Expo React Native app** (already scaffolded at `apps/mobile`); the static HTML client (`apps/mobile/public/index.html`) is demoted to a **dev harness** through M3 and retired once native parity lands. Chromebook/web reach is a launch milestone item via Expo web export (#65), not a parallel client | One codebase, offline-first native, app-store path; US classrooms are Chromebook-heavy so web reach matters, but only after the native product is real |
| D2 | Server datastore moves to **PostgreSQL** (schema header already declares SQLite/Postgres portability); **SQLite remains the on-device offline store only**. Redis stays out until multi-instance (#58 revisits) | Single-file SQLite will not carry a multi-region kids service; the compose Postgres is currently provisioned but unused — this activates it |
| D3 | `services/api` adopts **Fastify + schema validation + `application/problem+json` errors + OpenAPI baseline with an oasdiff breaking gate** (shipperdog conventions). `packages/core-engine` stays **zero-dependency ESM** forever — it is shared isomorphic code: the server imports it as the authoritative evaluator, and the RN client imports it for offline evaluation | Hand-rolled `http` routing/validation does not meet the enterprise bar; but the engine's zero-dep purity is exactly what makes offline-first possible — never break it |
| D4 | Account model: **parent accounts (email + password) own child profiles**; children sign in per-device with **avatar + PIN** (scrypt-hashed). Legacy standalone students are claimed under a parent during onboarding or archived | Matches Khan Kids / Duolingo ABC pattern; COPPA needs a verifiable guardian as the accountable actor |
| D5 | COPPA posture: **no third-party ad/analytics/tracking SDKs ever** in child surfaces (AGENTS.md invariant); observability is first-party only; verifiable parental consent = **email verification + parental gate (hold-to-confirm / math challenge)** for v1 direct-to-parent; school context (FERPA/DPA) is scoped to the B2B seam (#64) | Internal-collection-only (no third-party disclosure) keeps the consent method proportionate; the schools' paperwork is a distinct channel |
| D6 | **Hearts are grade-tiered**: Pre-K–Grade 1 is no-fail with gentle retry (AGENTS.md pedagogy); hearts depletion exists **only in Grade 2–3 fluency sprints** | Punishing a 4-year-old for wrong answers contradicts the project's own `onGentleRetry` doctrine; fluency pressure is age-appropriate only for older kids |
| D7 | Media strategy: **no per-topic video files**. The 9-asset contract's `videos`/`animations` blocks are realized as **template-driven procedural micro-lessons** — Rive state machines + the manipulative widget kit rendering from registry data on-device | 614 topics × 45–75s video is an unbundlable storage cost and breaks offline-first; procedural rendering satisfies the asset contract, offline, and the <50KB Rive budget in AGENTS.md |
| D8 | Sync doctrine: **client-authoritative append-only attempt log; server-authoritative progress** — the server recomputes topic/unit/gate state via core-engine from the attempt stream; last-write-wins only for cosmetic state (theme, sound settings) | Eliminates conflict resolution guesswork; the engine is deterministic and shared, so both sides agree by construction |
| D9 | Gamification ledger (XP, levels, badges, streaks, coins) is **server-owned with an offline enqueue/replay queue**; all reward rules live in core-engine (shared + unit-testable) | Kids must never lose a reward to a network failure, and rules must not fork between offline/online paths |
| D10 | **Dwara fronts the public API** in production (consumers, rate limits, TLS); **licensing-core** provides school/district seat licensing at the B2B seam | In-house infrastructure; replaces hand-rolled edge middleware with the gateway built for exactly this |
| D11 | Delivery follows the shipperdog mandate: **one issue = one PR** through the delivery pipeline (developer → tester → reviewer → docs → regression → committer → PR); every API-touching issue updates the OpenAPI baseline inside the same PR | Proven pattern from ShipperDog's 73-issue run; keeps the oasdiff gate green per PR |

## Milestone overview

| Milestone | Epics | Issues | Outcome |
|---|---|---|---|
| **M1 — Security & Backend Foundations** | E1 Hygiene & hardening, E2 Platform | #27–#32 | Repo clean; IDOR/PIN/CORS fixed; Postgres + Fastify + OpenAPI + tests in CI |
| **M2 — Parent Accounts & COPPA Core** | E3 Accounts, E4 Consent & child sessions | #33–#36 | Guardian-anchored account model with consent records gating all child-data creation |
| **M3 — Native Client Platform** | E5 App shell, E6 Offline core, E7 Learning flows | #37–#45 | Real Expo app: onboarding, offline practice, sync, journey/practice/gate parity with the web client |
| **M4 — Kid Experience & Retention** | E8 Games, E9 Gamification, E10 Audio & placement | #46–#54 | Game archetypes, XP/badges/streaks/mascot, full TTS narration, placement diagnostic |
| **M5 — Parent Portal & Data Rights** | E11 Portal | #55–#57 | Parent web portal with quadrant analytics, COPPA export/delete, weekly email summaries |
| **M6 — Enterprise Launch** | E12 Ops, E13 Compliance & stores, E14 Reach & B2B | #58–#65 | IaC + Dwara + observability; COPPA legal pack; Apple Kids / Google Families submissions; licensing seam; Chromebook reach |

Total: **39 issues** across 14 epics.

## Issue tree

Ordered; each issue lists dependencies. OpenAPI baseline updates land inside
each API-touching issue (#31–#36, #49–#51, #54–#57, #64) so the oasdiff gate
stays green per PR (D11).

| # | Issue | Epic | Depends on |
|---|-------|------|-----------|
| **M1** | | | |
| #27 | Repo hygiene: restore README (from `.0.md`), remove `.0.md`, push the 6-commit backlog, document startup in README | E1 | — |
| #28 | Auth & session hardening: scrypt-salted PINs, eliminate default `1234`, session-validation middleware on every student-scoped route (IDOR fix), token expiry + revocation | E1 | 27 |
| #29 | Edge hardening: CORS allowlist, per-IP + per-token rate limiting, request size caps, structured request logging with request IDs | E1 | 28 |
| #30 | Postgres migration: migrations runner + ledger doc, port `001_schema.sql`, seed-from-registry, CI adds a Postgres service container; SQLite stays on-device-only | E2 | 29 |
| #31 | API platform: Fastify + schema validation, `problem+json` error envelope, request-correlation IDs, OpenAPI **baseline.yaml** + oasdiff breaking gate in CI | E2 | 30 |
| #32 | Test foundation: vitest for core-engine (port `verify-engine.mjs` assertions), API integration tests (auth, practice, gate, progress), CI runs the full suite | E2 | 31 |
| **M2** | | | |
| #33 | Schema: `parents`, `parent_children`, `consent_records`, `devices` tables + migrations + ledger entries | E3 | 31 |
| #34 | Parent auth API: signup/login (email + password, scrypt), email-verification tokens, password reset; dual-token doctrine (parent session vs child device token) | E3 | 33 |
| #35 | Verifiable parental consent: versioned policy text, timestamped consent capture, re-consent trigger on policy version bump; **consent-required middleware** — no child-data row can be created without a matching consent record | E4 | 34 |
| #36 | Child profiles under parents: avatar + PIN creation bound to parent + device, legacy standalone-student claim/archive migration, child device-session mint/revoke | E4 | 35 |
| **M3** | | | |
| #37 | Expo app shell: design system (kid-scale type, ≥48pt touch targets, reduced-motion support), theming, navigation skeleton (expo-router), lint/format config | E5 | 36 |
| #38 | Onboarding flow: parental gate (hold-to-confirm) → parent signup/login → consent screens → add child → grade selection; resumes correctly after interruption | E5 | 37 |
| #39 | Audio infrastructure: TTS service wrapping expo-speech (grade-calibrated 110–150 WPM from registry), SFX manager (16 existing WAVs), haptics, audio ducking | E5 | 37 |
| #40 | Content pipeline: grade content packs compiled from the registry (questions + topic assets), on-device SQLite schema, pack download/versioning/pruning | E6 | 38 |
| #41 | Offline practice core: import `packages/core-engine` into RN, local append-only attempt log, local topic/unit progress, offline gate evaluation with Silver/Gold key state | E6 | 40 |
| #42 | Sync protocol: delta upload of attempts, server reconciliation (recompute via core-engine), conflict rules per D8, retry/backoff, connectivity awareness | E6 | 41 |
| #43 | Journey map screen: winding path with unit nodes, lock/Silver/Gold key states, garden health, grade switcher | E7 | 42 |
| #44 | Practice session runner: all seeded interaction types (tap-count, drag-tile, choice, …), CPA scaffold rendering, in-session Lag +2/+5/+10 re-queue UI, manipulative widget kit v1 | E7 | 42 |
| #45 | Boss gate runner: 5-condition gate session, results screen (per-condition breakdown), key ceremony + 14-hour Gold verification check | E7 | 44 |
| **M4** | | | |
| #46 | Game framework: parameterized archetype runner consuming `games` asset blocks, game-session telemetry (accuracy, speed, spiral-mix provenance), graceful fallback to the practice runner for unsupported archetypes | E8 | 44 |
| #47 | Archetype pack A (math): Block Builder + Market Cashier, wired to their registry game configs, Stage 2 guided + Stage 3 fluency variants | E8 | 46 |
| #48 | Archetype pack B (reflex/ELA): Bubble Pop Blitz + Monster Phoneme Feeder | E8 | 46 |
| #49 | Gamification ledger: XP + levels, badge/achievement catalog + award rules in core-engine, crowns/coins surfacing, offline enqueue/replay (D9) | E9 | 42 |
| #50 | Hearts policy per D6: G2–G3 fluency-sprint hearts with refill/reframe UX; Pre-K–G1 gentle-retry no-fail mode | E9 | 49 |
| #51 | Streaks + local notifications: streak tracking, parent-controlled reminder scheduling (COPPA-safe: local only, default off, configured in parent portal) | E9 | 49 |
| #52 | Mascot + celebrations: mascot character system (idle/react/celebrate states via Rive), mastery badge bloom, unit-complete and key ceremonies | E8 | 46 |
| #53 | TTS narration coverage: 100% of prompts, instructions, hints, remediation, and celebration lines across all grades, driven by the narration SSML manifests | E10 | 39 |
| #54 | Placement diagnostic: short adaptive placement on first grade entry, DAG-credit start-point recommendation (engine `propagateImplicitDagCredit`), skip-ahead within guardrails | E10 | 42 |
| **M5** | | | |
| #55 | Parent portal web app (React): children overview, accuracy-vs-speed quadrant per child (architecture doc §parent analytics), weekly time/progress, time limits, content controls, notification settings | E11 | 35 |
| #56 | COPPA data rights: account export (JSON), child-data deletion API + portal self-serve, retention/cleanup job, deletion audit trail | E11 | 55 |
| #57 | Weekly email progress summaries (parent-facing only; SMTP seam pattern) | E11 | 55 |
| **M6** | | | |
| #58 | Deployment: Terraform IaC, dev/staging/prod environments, secrets management, migrations-on-deploy, post-deploy smoke tests; revisit Redis/multi-instance | E12 | 32 |
| #59 | Dwara gateway fronting: consumers + credentials for parent/child-device/portal, rate limits, TLS termination, mTLS admin surface | E12 | 58 |
| #60 | Observability: first-party structured logs, metrics (p95 latency, gate pass rates, sync success), alerting, self-hosted error tracking (no child PII in telemetry) | E12 | 58 |
| #61 | Accessibility + performance audit: screen-reader pass on all kid + parent flows, 60fps budget verification on low-end device matrix, reduced-motion/haptics coverage | E13 | 54 |
| #62 | Security review + COPPA legal pack: external-style security review of auth/consent/sync, privacy policy + terms shipped in-app, parental-gate audit, Families/Kids policy self-check | E13 | 56, 60 |
| #63 | Store submissions: Apple Kids Category + Google Play Families program listings, Data Safety / privacy nutrition forms matching reality, age ratings, review-notes pack | E13 | 62 |
| #64 | B2B seam: licensing-core seat-license validation for school/district accounts, teacher roster-import stub, FERPA/DPA posture notes | E14 | 63 |
| #65 | Chromebook/PWA reach: Expo web export of the client app, keyboard/mouse input parity, offline via browser storage where available | E14 | 63 |

## Workstream details

### M1 — Security & Backend Foundations

1. **#28 is the launch-blocking fix.** Every `/api/students/:id/*` route
   currently trusts the path parameter — any caller can read or mutate any
   child's progress. Sessions exist but are never checked. The middleware
   must bind `studentId` to the session token; tests cover cross-student
   access denial.
2. **#30–#31 replatform** `server.mjs` (735 lines) onto Fastify with the
   route inventory unchanged (health, students, auth/login, calibrate,
   curriculum summary/unit, practice fetch/complete, gate/evaluate) — no
   behavior changes beyond validation/errors. The migration ledger doc
   follows shipperdog's `database-migrations.md` pattern. Dev flows may keep
   SQLite via `NODE_ENV` or the seed script; the **served** database is
   Postgres.
3. **#32** ports `verify-engine.mjs` assertions into vitest specs and adds
   API integration tests hitting a real Postgres (CI service container);
   the existing curl smoke steps remain as a final gate.

### M2 — Parent Accounts & COPPA Core

1. **Order is load-bearing**: the consent-required middleware (#35) must
   exist before any child-data creation path ships to production. The
   invariant to test: **no row in `students`/progress tables without a
   `consent_record`** (enforced by the middleware + a schema-level audit
   check).
2. **#34 token doctrine**: parent sessions (long-lived, refreshable,
   revocable) vs child device tokens (scoped to device + child, minted
   during onboarding, revocable from the parent portal). The M1 session
   middleware extends with token-type awareness.
3. **#36 legacy migration**: existing standalone students (local dev data)
   are either claimed by the first parent on the device or archived;
   no silent auto-adoption.

### M3 — Native Client Platform

1. **#40 content packs**: compiler script turns the 164K-line registry into
   per-grade packs (JSON → SQLite), each with a content version; the client
   downloads on grade selection and prunes on grade completion. Packs are
   signed + checksummed.
2. **#41 is where D3 pays off** — the RN bundle imports
   `packages/core-engine` directly; the same `evaluateMasteryGateAttempt`
   that runs server-side runs on-device. Offline gate results are marked
   provisional until #42 sync confirms.
3. **#44 interaction types**: enumerated from the 6,140 seeded questions
   (`interaction_type`, `visual_objects`, `tile_bank_json`, `choices_json`
   columns); the widget kit renders each type with CPA-stage awareness.

### M4 — Kid Experience & Retention

1. **#46 game framework** honors the 70/20/10 spiral mix and
   intra-session lags from AGENTS.md; archetype coverage gaps fall back to
   the practice runner so no topic is ever blocked on a missing game.
2. **#49–#50 gamification** implements D6/D9: reward math in core-engine
   (`awardXp`, `evaluateBadge`) so offline and server agree; hearts UI only
   mounts for G2–G3 fluency sprint contexts.
3. **#53** treats narration manifests as the source of truth — SSML is
   adapted per platform TTS; a coverage test enumerates registry topics
   and fails on missing narration bindings.

### M5 — Parent Portal & Data Rights

1. **#55** is a separate lightweight React app (`apps/parent-portal`),
   parent-token-authenticated, never linked from child surfaces.
2. **#56 deletion** must cascade attempts → progress → child profile and
   write an audit row; export produces a single JSON document per child.

### M6 — Enterprise Launch

1. **#59 Dwara**: the Fastify origin keeps its own auth; Dwara adds
   consumer keys, quotas, and TLS at the edge — mirroring the dwara-security
   authorization chain (consumer > route > listener).
2. **#62 → #63 is the legal-critical path**: the Data Safety forms must
   match the #56/#60 reality (first-party only). Apple Kids Category and
   Google Families both reject third-party SDKs and un-gated external
   links — the AGENTS.md invariants exist for this review.
3. **#64** deliberately ships a **seam**, not a product: seat validation
   via licensing-core plus a roster-import stub; the full schools platform
   is a future milestone.

## Key reuse map

- `packages/core-engine` (zero-dep ESM) → imported by **both** the Fastify
  server (authoritative evaluation) and the RN client (offline evaluation);
  all gamification math lands here too (#49)
- `001_schema.sql` (already SQLite/PostgreSQL-portable) → Postgres baseline
  for #30
- The 16 WAV SFX + 12 SVG manipulatives → #39/#44 directly
- `apps/mobile/public/index.html` → dev harness + interaction-type
  reference for #44 until native parity, then retired
- ShipperDog conventions → problem+json, OpenAPI baseline + oasdiff gate,
  migration ledger, SMTP seam, one-issue-one-PR delivery pipeline
- Dwara → edge gateway (#59); licensing-core → B2B seats (#64)

## Risks / launch gates

1. **COPPA ordering** — no production child data before #35's
   consent-required middleware; treated as a hard gate between M2 and any
   public deployment.
2. **Store kids-category review** (Apple Kids, Google Families) — the
   strictest gate; #62's self-check and #63's forms must match the app's
   actual data flows (first-party only, parental gate, no external links).
3. **Offline sync divergence** — mitigated by D8 (server recomputes from
   the attempt stream); regression tests replay randomized offline
   attempt logs and assert deterministic convergence.
4. **Content pack size** on low-end Androids — per-grade packs, lazy
   media, SVG/Rive-only (no rasters) per AGENTS.md performance rules.
5. **TTS variance across devices** — grade-calibrated rates with
   runtime caps; worst-case fallback to bundled audio for Pre-K
   instruction lines.
6. **Dependency currency** — Expo ~52 / RN 0.76 will need a bump during
   M3; schedule it inside #37 before screens multiply.
7. **Legacy data migration** (#36) — existing SQLite students are dev
   data; claim-or-archive keeps it honest without a complex migration.

## Verification

- **Per-PR (all milestones)**: vitest engine + API suites, oasdiff
  additive-only, curriculum validator, engine verifier — CI green.
- **M1**: cross-student access tests fail-open check; Postgres CI service
  passes the full route inventory.
- **M2**: consent-invariant test (no child data without consent record);
  token-type confusion attempts rejected.
- **M3**: airplane-mode E2E — full lesson + gate offline, then sync
  converges; pack download/prune verified on device.
- **M4**: narration coverage test over all 614 topics; hearts UI absent
  in Pre-K–G1 builds; reward convergence offline→online.
- **M5**: export contains all child data classes; deletion cascades
  verified at the schema level.
- **M6**: Dwara-fronted smoke in staging; Data Safety form cross-checked
  against a live network-traffic audit of the app; store review packs
  submitted.
