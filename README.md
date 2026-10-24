# Balashikshana — Mastery-Gated Interactive Learning Games (Pre-K to Grade 3)

**Balashikshana** is a cross-platform mobile learning platform (**iOS & Android**) for children in **Pre-K, Kindergarten, Grade 1, Grade 2, and Grade 3 (Ages 3–9)**.

Aligned with the **United States Curriculum** (**Common Core State Standards for Math & ELA**, **Preschool/Head Start Early Learning Guidelines `MA.1–MA.5`**, **NGSS Science**, and **C3 Social Studies**), Balashikshana organizes all **614 Curriculum Skill Topics** (~3,000 micro-skills) into **130 sequential Units of Closely Related Work**.

Every single Skill Topic includes **9 complete asset categories** (**Sounds**, **Images**, **Videos**, **Interactive Elements**, **Voice Narration**, **Animations**, **Games**, **Quizzes**, and **Assessments**), culminating in a strict **Accuracy + Speed Mastery Gate** and a **Child-Calibrated Scientific Spaced Repetition System**.

---

## Core Pedagogical Loop

Every unit progresses through four stages:

```text
1. Study & Explore  ──►  2. Guided Practice  ──►  3. Fluency Zone  ──►  4. Unit Boss Gate
   (Micro-videos,           (Untimed games           (Timed speed          (Strict Accuracy % +
    interactive widgets,     with visual              mini-games for        Median Response Time
    SSML voice narration)    scaffolding)             automaticity)         to unlock Unit N+1)
```

---

## US Curriculum Summary (Pre-K to Grade 3)

| Grade Level | Target Age | Math Units (Skill Topics) | ELA Units (Skill Topics) | Science Units (Skill Topics) | Social Studies Units (Skill Topics) | Total Units |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Pre-K** | 3–4 yrs | **7 Units** (`A–AA`, 27 topics) | **7 Units** (`A–CC`, 29 topics) | *(Integrated)* | *(Integrated)* | **14 Units** |
| **Kindergarten** | 5–6 yrs | **10 Units** (`A–EEE`, 57 topics) | **9 Units** (`A–WW`, 49 topics) | **5 Units** (`A–O`, 15 topics) | **4 Units** (`A–L`, 12 topics) | **28 Units** |
| **Grade 1** | 6–7 yrs | **9 Units** (`A–TTT`, 46 topics) | **10 Units** (`A–EEE`, 57 topics) | **5 Units** (`A–P`, 16 topics) | **4 Units** (`A–L`, 12 topics) | **28 Units** |
| **Grade 2** | 7–8 yrs | **9 Units** (`A–SSS`, 45 topics) | **10 Units** (`A–LLL`, 63 topics) | **6 Units** (`A–W`, 23 topics) | **4 Units** (`A–J`, 10 topics) | **29 Units** |
| **Grade 3** | 8–9 yrs | **10 Units** (`A–GGG`, 59 topics) | **10 Units** (`A–DDD`, 56 topics) | **6 Units** (`A–Y`, 25 topics) | **5 Units** (`A–M`, 13 topics) | **31 Units** |

---

## Quick Start & Running the Project

### 1. Run Locally with One Command (`startup.sh` / `stop.sh`)
```bash
# The API serves from PostgreSQL (roadmap D2) — start it first:
docker compose -f docker/docker-compose.yml up -d postgres

# Start both the Sync/Mastery API (port 4000) and Interactive Learning App (port 4200)
./startup.sh

# Stop all running services
./stop.sh
```
- **Interactive Learning App:** `http://localhost:4200`
- **Sync & Analytics API Health:** `http://localhost:4000/api/health`
- On first boot the API runs all migrations and seeds the curriculum
  (5 grades, 130 units, 614 topics, 6,140 questions) from
  `docs/us-curriculum-registry.json` — both idempotent. Migration ledger:
  `docs/database-migrations.md`
- **Validate Curriculum DAG & Core Engine:**
  ```bash
  npm run validate:curriculum
  npm run build
  ```

### 2. Run via Docker Compose (`docker/docker-compose.yml`)
```bash
docker compose -f docker/docker-compose.yml up --build -d
```

### 3. API Authentication & Parental Consent
- Every student-scoped route requires a session token: send `Authorization: Bearer <token>` (401 without/invalid/expired token, 403 when the token belongs to a different student). Bearer tokens come in three kinds — **student sessions** (M1), **child device tokens** (issue #42), and **parent sessions** (issue #40) — resolved per request and checked per route (403 `wrong-token-type` on a kind mismatch)
- Obtain a student or child-device token: `POST /api/auth/login` (username or studentId + 4-digit PIN, always required), account creation via `POST /api/students` (PIN required, no default exists; demo-seed PINs are randomly generated and printed once in the API log — creation is consent-gated and, since #42, also binds the new student to the creating parent via `parent_children`), or a parent minting a child device token (see below)
- Revoke a token: `POST /api/auth/logout` (student sessions only; parent and child-device tokens get the 403 `wrong-token-type` problem — parents use `POST /api/parents/logout`) or the parent-side device-session revoke; student and child-device sessions expire after 30 days
- PINs are stored as salted scrypt hashes (N=16384, r=8, p=1, keylen=64; see `services/api/db.mjs`) — child PINs use the identical shared parameters; legacy unsalted-SHA-256 rows are rehashed transparently on next login
- **Parent accounts** (full contract in [`docs/openapi/baseline.yaml`](./docs/openapi/baseline.yaml), `parents` tag): `POST /api/parents/signup`, `verify-email`, `login`, `refresh`, `logout`, `logout-all`, `password-reset/request`, `password-reset/confirm` — scrypt passwords, hashed-at-rest session tokens (7-day TTL, 30-day refresh window, soft revoke)
- **Child profiles under parents** (`children` tag): `GET`/`POST /api/parent/children` (creation is consent-gated and writes the student row, the `parent_children` binding, a student-scoped consent row, and the `devices` row in one transaction), `POST /api/parent/children/claim` (legacy standalone students only — username + PIN proof-of-knowledge, exactly-once, second claimant `409 already-claimed`), `POST /api/parent/children/:studentId/archive` (excludes the child from the login-screen listing, freezes every student-scoped route, revokes all sessions), `POST /api/parent/children/:studentId/device-sessions` + `DELETE .../device-sessions/:sessionId` (mint/revoke child device tokens — scoped to exactly one student + one device, stored hashed at rest, 30-day expiry, revocation kills access immediately)
- **Dev dataset note:** the seeded demo students and every pre-#42 standalone dev student carry `status='legacy'` (migration 005) — claim-eligible via the claim route (username + PIN) or deliberately left unclaimed; nothing is auto-adopted. Archived students disappear from `GET /api/students` and cannot log in or mint sessions
- **Verifiable parental consent (COPPA gate):** `POST /api/students`, `POST /api/parent/children`, `POST /api/parent/children/claim`, `POST /api/practice/topic/complete`, and `POST /api/gate/evaluate` write no child data without a matching consent record — the response is `403 consent-required` (RFC 9457 problem+json carrying the current `currentPolicyVersion`) and nothing is written. Consent rows are append-only and server-timestamped; the capture method (`signup-form` or `re-consent`) is derived server-side, never asserted by the client
- Consent routes (full contract in [`docs/openapi/baseline.yaml`](./docs/openapi/baseline.yaml), `consent` tag): `GET /api/consent/policy/latest` (public — the active policy text to render before onboarding), `POST /api/consent/records` (parent bearer + verified email; records acceptance of `policyVersion`, any version other than the active one is `409 policy-version-mismatch`), `GET /api/consent/status` (parent bearer; `consentCurrent: false` after a policy bump means the parent must re-consent before further child-data creation)
- Run the auth/session security tests: `npm run test:api`

### 4. API Configuration (Edge Hardening)
All configuration is environment-driven (defaults in `services/api/server.mjs`):

| Variable | Default (dev) | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://balashikshana:balashikshana_dev@localhost:5432/balashikshana_db` | PostgreSQL connection string (matches the compose service); the server exits with a clear message if the database is unreachable |
| `SEED_DEMO_STUDENTS` | `1` | Set to `0` to skip seeding the demo student accounts on an empty database (dev-harness data with no consent records by design; the consent test suites boot with `0` so a pristine database proves the no-child-data-without-consent invariant) |
| `ALLOWED_ORIGINS` | `http://localhost:4200,http://127.0.0.1:4200` | CORS allowlist (comma-separated). Wildcards are always rejected; in `NODE_ENV=production` the server refuses to start without an explicit list |
| `RATE_LIMIT_PER_IP_MIN` | `120` | Requests per minute per client IP (429 + `Retry-After` beyond) |
| `RATE_LIMIT_PER_TOKEN_MIN` | `60` | Requests per minute per session token |
| `RATE_LIMIT_LOGIN_PER_IP_MIN` | `10` | Login attempts per minute per IP (PIN brute-force guard) |
| `RATE_LIMIT_PARENT_SIGNUP_PER_IP_MIN` | `5` | Parent signups per minute per IP |
| `RATE_LIMIT_PARENT_LOGIN_PER_IP_MIN` | `10` | Parent logins per minute per IP |
| `RATE_LIMIT_PARENT_TOKEN_PER_IP_MIN` | `10` | Parent token-presenting routes per minute per IP (verify-email, reset confirm) |
| `RATE_LIMIT_PARENT_RESET_PER_IP_MIN` | `5` | Parent password-reset requests per minute per IP |
| `RATE_LIMIT_PARENT_CLAIM_PER_IP_MIN` | `10` | Child-claim attempts per minute per IP (the claim route verifies student PINs, so it follows the login-bucket doctrine) |
| `BODY_LIMIT_BYTES` | `65536` | Request body cap (413 beyond) |
| `PORT` | `4000` | Listen port |

Every request is logged as one structured JSON line (pino) with `requestId`, method, route, status, duration, and client IP; the request ID is echoed back in the `X-Request-Id` response header for support correlation.

The API runs on Fastify v5 with per-route JSON-schema validation. Every error response is an RFC 9457 `application/problem+json` document (`type`, `title`, `status`, `detail`, `instance`; validation failures add an `errors[]` array, 429 adds `Retry-After`). The full route contract is [`docs/openapi/baseline.yaml`](./docs/openapi/baseline.yaml) (OpenAPI 3.1); CI enforces it additive-only via an oasdiff breaking-change gate on every pull request.

### 5. Run the Test Suites (vitest)
```bash
npm run test:engine   # core-engine unit specs (mastery gate, FSRS, curriculum DAG & questions) — no services required
npm run test:api      # API integration suites (auth, parent auth, consent, child profiles, edge hardening, Postgres migrations) — requires PostgreSQL
npm test              # both workspaces in sequence
```
- The API suites (`services/api/test/`) boot the real server as a child process against a throwaway PostgreSQL database created per suite (dev data is never touched). The cold start applies all migrations and reseeds the 6,140 practice questions, so `services/api/vitest.config.mjs` raises the test/hook timeouts (120s/180s) accordingly.
- PostgreSQL must be reachable at `DATABASE_URL` (the compose service from section 1 is sufficient). The core-engine specs (`packages/core-engine/test/`) run fully standalone.
- The mobile specs (`apps/mobile/tests/`) are pure-module vitest suites (design tokens, contrast/touch-target invariants, reduced-motion contract, route-tree structure, the onboarding state machine + resumability planner, hold-to-confirm gate timing, the API client's error paths with mocked fetch, and the audio policy modules — rate math cross-checked against the curriculum registry, SSML adaptation, duck policy, the manifest SFX catalog with compile-time id pinning, settings parse guards, and the coordinator) — no simulator required: `npm test --workspaces=false --prefix apps/mobile`
- CI (`.github/workflows/ci.yml`) runs the same pipeline on every push and pull request: curriculum validator -> core-engine verifier (`verify-engine.mjs`) -> engine vitest suite -> API vitest suite against a `postgres:16` service container -> mobile app-shell quality gate (lint + format-check + typecheck + design-system tests) -> live smoke test -> OpenAPI breaking-change gate (`tufin/oasdiff` pinned to `v1.34.1`). Superseded runs on the same ref are cancelled automatically.

### 6. Native App Shell (Expo, `apps/mobile`)
The product client is the Expo React Native app (roadmap D1, issue #43) on **Expo SDK 58 / React Native 0.88 / React 19** — verified by a clean `expo-doctor` run and per-platform bundle exports.

```bash
cd apps/mobile
npm ci --workspaces=false          # per-workspace install (the repo convention; uses apps/mobile/package-lock.json)
npm run ios                        # Expo dev server for an iOS simulator/device
npm run android                    # Expo dev server for an Android emulator/device
npm run web                        # DEV HARNESS ONLY: serves the static web client on :4200 (server.mjs)
npm run lint && npm run format:check && npm run typecheck && npm test
npx expo-doctor                    # SDK health check (18 checks)
npx expo export --platform ios --platform android   # prove the bundles build
```

- **Design system:** `src/design/tokens.ts` is the single source for color, spacing, radius, and the kid-scale type ramp (body >= 18pt). Screens consume semantic theme tokens only — never hardcoded colors. Three themes ship: `light`, `dark` (follows the OS setting), and `highContrast` (the WCAG escape hatch; every interactive label >= 4.5:1). Text-grade `statusInk` tokens keep small status text readable in all themes; the vitest suite enforces the contrast and >= 48pt touch-target invariants (`tests/tokens.test.ts`).
- **Primitives:** `Button`, `PressableCard`, `ProgressBar`, `Badge`, `Sheet` (`src/design/primitives/`) — tactile 3D treatment carried over from the validated web harness, all touch controls >= 48pt.
- **Reduced motion:** a global `MotionProvider` reads the OS accessibility setting; every animated primitive degrades to zero-duration/zero-offset when reduce-motion is on. No animation in the shell is load-bearing.
- **Navigation:** an `expo-router` tree — launcher; the real onboarding flow (below); a readiness-guarded `journey`; and placeholder routes for `practice` and `gate` (their runners land later in M3). Every screen offers a Home action; no dead ends.
- **Onboarding flow (issue #44):** `app/onboarding` drives the full setup chain — parental gate (hold-to-confirm) → parent signup/login → email verification → consent screens → add child (avatar + PIN) → grade selection (Pre-K–Grade 3) — against the M2 API (`/api/parents/*`, `/api/consent/*`, `/api/parent/children/*` incl. device-session mint).
  - **Parental gate:** a reusable hold-to-confirm component (3-second continuous press; any release resets; timer-based, so reduced-motion cannot affect it and tap-spam accumulates nothing). It guards onboarding step 1 and the Grown-ups area alike; behind the gate the parent area offers sign-out and switch-parent.
  - **Resumability:** the flow persists a step snapshot (one-row SQLite table via `expo-sqlite`, no secrets) plus secure-store credentials; on relaunch a read-only reconcile (consent status + children list) picks the exact landing step. Mutations are duplicate-safe: the create-child POST is preceded by a persisted in-flight marker, so a kill mid-submission either adopts the already-created child or safely re-submits — never both.
  - **Token storage:** parent session tokens, child device tokens, the pending email-verification token, and the draft child PIN live ONLY in `expo-secure-store` (`src/onboarding/storage.ts` is the sole seam); never AsyncStorage, never SQLite. Parent passwords are never persisted at all.
  - **Consent ordering:** the client captures consent before any child-data call and re-asserts consent currency server-side before creating a child; a policy-version bump surfaces the re-consent screens on next launch and keeps child surfaces (journey) locked until re-accepted.
  - **API base URL:** set `EXPO_PUBLIC_API_BASE` (defaults to `http://localhost:4000` in dev).
  - **#46 seam:** grade selection is where the content-pack download trigger will chain (see `submitChild` in `src/onboarding/OnboardingFlow.tsx`).
- **Audio services (issue #45):** `src/audio/` ships the narration / SFX / haptics infrastructure behind an `AudioCoordinator` facade, bootstrapped at the root layout via `getAudioService()` and fully dependency-injected (the Expo adapters live in one RN-only module, everything else is node-testable). Speaking rates are registry-calibrated per grade and clamped to 110–150 WPM; SFX duck to a 0.3 multiplier while narration speaks (count-based, synchronous restore on cancel); narration defers under an active screen reader and never ducks itself. The 16 feedback WAVs are catalog-driven from the repo-root `assets/sounds/sounds-manifest.json` (compile-time pinned and test-pinned against manifest and disk); #46 content packs own the on-device topic-to-soundpack delivery. Audio settings (sound / narration / haptics / music toggles) persist through the non-secret SQLite seam.
- **Tooling:** ESLint (flat config, `eslint-config-expo`) + Prettier + `tsc --noEmit` (strict) + vitest, all wired into the CI gate above.
- **Repo-level notes:** the root `package-lock.json` is advisory only — it exists so workspace-aware tooling (`expo-doctor`) finds a lockfile at the monorepo root; regenerate it with `npm install --package-lock-only` after changing any workspace manifest. CI installs per-workspace and is unaffected. `apps/mobile/.npmrc` sets `legacy-peer-deps` because the Expo SDK 58 peer tree conflicts with npm's strict resolution under per-workspace installs; the committed lockfile records the resolved set. The static web client (`apps/mobile/public/index.html`) remains untouched and served as the dev harness + web fallback until native parity (D1).

---

## Repository Structure & Documentation

```text
balashikshana/
├── AGENTS.md                                 # AI Agent architecture, pedagogical & schema guide
├── README.md                                 # Project overview, curriculum summary & architecture
├── startup.sh / stop.sh                      # One-command startup and shutdown scripts
├── package.json                              # Monorepo workspaces configuration
├── GradePrekto3MathCurrGuide.pdf             # Reference Pre-K to Grade 3 Mathematics Curriculum Guide
├── .github/workflows/ci.yml                  # GitHub Actions CI: curriculum DAG validation, engine verifier + vitest suites (postgres:16 service), mobile app-shell quality gate, live smoke & OpenAPI breaking-change gate
├── docker/
│   ├── docker-compose.yml                    # Postgres, Redis, API & Web container orchestration
│   ├── Dockerfile.api                        # Backend Sync & Mastery API container
│   └── Dockerfile.web                        # Interactive Mobile/Web App container
├── packages/
│   └── core-engine/                          # DAG Resolver, 5-Condition Mastery Gate, Child FSRS & Question Generator
├── services/
│   └── api/                                  # PostgreSQL-backed Sync, Mastery Gate Evaluation & Parent Analytics API
│       ├── migrations/                       # node-pg-migrate migrations (served datastore, PostgreSQL)
│       └── sqlite/                           # On-device SQLite schema reference (offline store, roadmap D2)
├── apps/
│   └── mobile/                               # Expo SDK 58 app shell (design system, theming, onboarding flow, expo-router) + static web dev harness (public/)
├── docs/
│   ├── us-curriculum-registry.json           # Canonical JSON DAG of all 130 units, 614 topics & 9-asset bundles
│   ├── us-curriculum-mapping.md              # Complete Pre-K to Grade 3 unit progression & skill-topic mapping
│   ├── games-and-study-materials.md          # 10 parameterized game archetypes & interactive study manipulatives
│   ├── mastery-gate-engine.md                # Mathematical specification for Accuracy + Speed Mastery Gating
│   ├── spaced-repetition-science.md          # Child-calibrated Memory Consolidation & Spaced Repetition (Ages 3-9)
│   ├── skill-topic-assets-catalog.md         # Catalog of all 9 asset categories across all 614 skill topics
│   ├── architecture.md                       # Offline-first iOS/Android client, SQLite schema, & cloud sync architecture
│   ├── database-migrations.md                # PostgreSQL migration ledger & runner guide (served datastore)
│   ├── openapi/
│   │   └── baseline.yaml                     # OpenAPI 3.1 API contract (oasdiff breaking-change baseline)
│   └── roadmap.md                            # Approved M1–M6 enterprise launch roadmap (decisions D1–D11)
└── assets/
    ├── catalogs/                             # Per-grade JSON asset catalogs (pre-k..grade-3)
    ├── sounds/                               # 16 synthesized .wav files + sounds-manifest.json (614 topics)
    ├── images/                               # 12 vector .svg illustrations + images-manifest.json (614 topics)
    ├── videos/                               # 60fps vector storyboard timelines (videos-manifest.json)
    ├── interactive/                          # Interactive manipulative widgets (interactive-elements-manifest.json)
    ├── narration/                            # Age-calibrated SSML scripts (voice-narration-manifest.json)
    ├── animations/                           # Rive/Skia state-machine specs (animations-manifest.json)
    ├── games/                                # 1,228 Guided & Fluency game bindings (games-manifest.json)
    ├── quizzes/                              # 614 formative quizzes + misconception distractors (quizzes-manifest.json)
    └── assessments/                          # 614 summative Mastery Gate specs (assessments-manifest.json)
```

### Detailed Documentation Links
1. **[AI Agent Guide (`AGENTS.md`)](./AGENTS.md)** — Non-negotiable pedagogical invariants, 9-asset schema contract, and development rules for AI agents.
2. **[Full US Curriculum & Assets JSON Registry (`docs/us-curriculum-registry.json`)](./docs/us-curriculum-registry.json)** — Complete DAG of all 130 units and 614 skill topics with embedded 9-category asset definitions.
3. **[US Curriculum & Unit Mapping (`docs/us-curriculum-mapping.md`)](./docs/us-curriculum-mapping.md)** — Grade-by-grade tables mapping every Math, ELA, Science, and Social Studies skill topic to sequential units.
4. **[Skill Topic Assets Catalog (`docs/skill-topic-assets-catalog.md`)](./docs/skill-topic-assets-catalog.md)** — Overview of the Sounds, Images, Videos, Interactive Elements, Voice Narration, Animations, Games, Quizzes, and Assessments generated for all 614 skill topics.
5. **[Interactive Study Materials & Game Archetypes (`docs/games-and-study-materials.md`)](./docs/games-and-study-materials.md)** — Specifications for the virtual manipulatives and the 10 reusable 2D game engines.
6. **[Mastery Gate Engine Specification (`docs/mastery-gate-engine.md`)](./docs/mastery-gate-engine.md)** — Equations for motor-latency calibration, cognitive speed calculation, 80th-percentile tail latency caps, and diagnostic remediation routing.
7. **[Scientific Memory Consolidation & Spaced Repetition (`docs/spaced-repetition-science.md`)](./docs/spaced-repetition-science.md)** — 6 cognitive science mechanisms tailored for ages 3–9 (`Lag +2/+5/+10`, Two-Key Overnight Sleep Consolidation, Speed-Weighted Child FSRS, `70/20/10` Interleaved Spiral Practice, Fractional Implicit Repetition, and CPA Scaffold Fading).
8. **[Technical Architecture (`docs/architecture.md`)](./docs/architecture.md)** — Cross-platform iOS/Android mobile stack, procedural question/distractor generation, offline SQLite schema, and COPPA compliance.
9. **[Enterprise Launch Roadmap (`docs/roadmap.md`)](./docs/roadmap.md)** — Approved M1–M6 roadmap: binding decisions D1–D11, the full issue tree (#27–#65), workstream details, risks, and per-milestone verification gates.
10. **[Database Migration Ledger (`docs/database-migrations.md`)](./docs/database-migrations.md)** — PostgreSQL migration history, runner usage, and the rules every schema change follows.
11. **[OpenAPI API Contract (`docs/openapi/baseline.yaml`)](./docs/openapi/baseline.yaml)** — OpenAPI 3.1 baseline for all 29 API operations including the RFC 9457 problem+json error shapes; CI blocks breaking changes via oasdiff.
