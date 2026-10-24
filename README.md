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
| `RATE_LIMIT_SYNC_PER_TOKEN_MIN` | `30` | Sync requests per minute per child-device token (issue #48 — sized for batch traffic on top of the global buckets) |
| `SYNC_MAX_ATTEMPTS_PER_BATCH` | `200` | Hard cap on attempts per sync batch (OpenAPI `maxItems`; the mobile engine clamps its drain window to the same cap) |
| `SYNC_FUTURE_CLOCK_TOLERANCE_MS` | `300000` | Client-clock future tolerance before an attempt timestamp is clamped to server receive time (issue #48 clock policy; past timestamps are accepted as-is) |
| `BALASHIKSHANA_CONTENT_PACKS_DIR` | `services/api/content-packs` | Directory the content-pack routes serve the compiled manifest index + signed artifacts from (gitignored compiler output; the routes 503 with problem+json until a build is published) |
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
- CI (`.github/workflows/ci.yml`) runs the same pipeline on every push and pull request: curriculum validator -> core-engine verifier (`verify-engine.mjs`) -> engine vitest suite -> API vitest suite against a `postgres:16` service container -> content-pack compiler gate (determinism, completeness vs registry, signed + tamper rejection) -> mobile app-shell quality gate (lint + format-check + typecheck + design-system tests) -> live smoke test -> OpenAPI breaking-change gate (`tufin/oasdiff` pinned to `v1.34.1`). Superseded runs on the same ref are cancelled automatically.

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
  - **Content-pack trigger (#46):** onboarding chains the grade's content-pack download after the completion step lands — strictly fire-and-forget (onboarding has already completed, so a slow or failed download can never strand the flow); the completion screen surfaces a one-line pack status note, and the launch-time provider retries.
- **Audio services (issue #45):** `src/audio/` ships the narration / SFX / haptics infrastructure behind an `AudioCoordinator` facade, bootstrapped at the root layout via `getAudioService()` and fully dependency-injected (the Expo adapters live in one RN-only module, everything else is node-testable). Speaking rates are registry-calibrated per grade and clamped to 110–150 WPM; SFX duck to a 0.3 multiplier while narration speaks (count-based, synchronous restore on cancel); narration defers under an active screen reader and never ducks itself. The 16 feedback WAVs are catalog-driven from the repo-root `assets/sounds/sounds-manifest.json` (compile-time pinned and test-pinned against manifest and disk); since #46, each grade's content pack carries the per-topic SFX slice (`topic_sounds`) and narration slice (`topic_narration`) that feed `{moment, topicId}` resolution on-device. Audio settings (sound / narration / haptics / music toggles) persist through the non-secret SQLite seam.
- **Tooling:** ESLint (flat config, `eslint-config-expo`) + Prettier + `tsc --noEmit` (strict) + vitest, all wired into the CI gate above.
- **Repo-level notes:** the root `package-lock.json` is advisory only — it exists so workspace-aware tooling (`expo-doctor`) finds a lockfile at the monorepo root; regenerate it with `npm install --package-lock-only` after changing any workspace manifest. CI installs per-workspace and is unaffected. `apps/mobile/.npmrc` sets `legacy-peer-deps` because the Expo SDK 58 peer tree conflicts with npm's strict resolution under per-workspace installs; the committed lockfile records the resolved set. The static web client (`apps/mobile/public/index.html`) remains untouched and served as the dev harness + web fallback until native parity (D1).

### 7. Content Packs — Signed Per-Grade Content Pipeline (`tools/content-pipeline`)
- **Compiler:** the `@balashikshana/content-pipeline` workspace (zero runtime deps: `node:sqlite` + `node:crypto`) compiles `docs/us-curriculum-registry.json` into one deterministic, Ed25519-signed SQLite pack per grade — `pack-<gradeId>-v<contentVersion>.sqlite`. Determinism comes from canonical sorted-key JSON, fixed SQLite pragmas, one write transaction with pre-sorted inserts, `VACUUM`, and no timestamps; the tests build twice (including across separate CLI processes) and compare bytes. Questions come from the same core-engine generator the API seed uses (130 units / 614 topics / 6,140 questions total), so pack content and the served PostgreSQL content agree by construction; `packages/core-engine` itself is imported read-only and never modified.
- **Scripts (repo root):** `npm run packs:keys` generates an Ed25519 keypair (the private `.key` is gitignored and chmod 600; only the `.pub.hex` is committed), `npm run packs:build` compiles + signs + fail-closed self-verifies + publishes to `services/api/content-packs/` (gitignored compiler output), and `npm run test:packs` runs the 20-test compiler gate (determinism, completeness vs registry counts, tamper rejection, node:crypto <-> @noble/ed25519 interop).
- **Serving:** `GET /api/content/packs` (manifest index: version, size, SHA-256, detached signature, key id, counts) and `GET /api/content/packs/:gradeId` (artifact bytes, `application/octet-stream`, `ETag` = the manifest sha256). The server never verifies signatures — verification is the device's fail-closed job; the server only refuses its own inconsistency, answering `503 problem+json` when the index is missing or references a missing / size-drifted / invalidly-named artifact.
- **On-device lifecycle (`apps/mobile/src/content/`):** download to staging → size + native SHA-256 + Ed25519 signature verification against pinned public keys → `pack_info` cross-check (the pack's own grade/version/counts must match the manifest, defeating a validly-signed wrong-content substitution) → storage-budget decision → one atomic rename into place → prune superseded content. Downgrades are refused, a failed or interrupted install leaves the previous pack active, and every step is fail-closed. The lifecycle database (`balashikshana_content.db`, `PRAGMA user_version` migrations) also creates the append-only attempt log and topic/unit progress schemas that #47 (offline practice core) populates.
- **Trust model:** development builds pin the committed `dev-local` public key; **production trusts no keys yet** — the release key is provisioned with the M6 store submission, so until then a production build refuses to install any pack (fail closed: an empty trust list never falls back to the dev key, since anyone can regenerate the dev keypair).
- **Measured sizes (registry v1.0.0):** 0.86–2.33 MB per grade, 9.07 MB for all five grades, against a 64 MB on-device storage budget — over 27x headroom for the largest pack. Packs carry zero media bytes: SVG/audio/video assets resolve by path reference through the bundled repo manifests, and the 16 feedback WAVs ship with the app binary.

### 8. Offline Practice Core (`apps/mobile/src/practice`, issue #47)
The engine is now in the app: `apps/mobile` consumes `@balashikshana/core-engine` as a `file:` workspace link (`packages/core-engine` itself stays zero-dependency and unmodified — the RN-side types live in `apps/mobile/src/types/core-engine.d.ts`), and the dual-platform Hermes export is asserted to contain the engine in both bundles. Everything runs offline against an installed #46 pack; there is no network code in `src/practice/`.

- **Append-only attempt log:** every answered item is INSERT-ed into `attempt_log` (lifecycle DB, schema v2 — additive `ALTER`s via `PRAGMA user_version`) the moment it is answered, with raw/cognitive time, audio duration, fluency grade 1–4, topic/unit ids, session id, motor baseline, and client timestamp. There is no UPDATE or DELETE path on `attempt_log` anywhere in the mobile tree (enforced by a source-scan test); the AUTOINCREMENT `id` is the strictly monotonic **sync cursor**, and the `synced` flag flips to 1 only after the #48 sync worker durably applies the server's authoritative snapshot (the one documented UPDATE exception; partial index `idx_attempt_log_drain` serves both the ordered drain and the beyond-window probe).
- **Local progress projection == server derivation:** topic/unit progress rows are computed by the SAME core-engine calls with the SAME rounding, crowns rule (3/2/1/0 at 95%+speed / 85% / 80%), GREATEST/LEAST merge semantics, sticky `MASTERED`, and key-COALESCE behavior as `services/api`'s `POST /api/practice/topic/complete` and `POST /api/gate/evaluate` — proven by tests that run identical attempt streams (fixed + seeded-random) through both paths and by a tripwire that pins the server's own derivation lines (`services/api/derivations.mjs`, the single source the online handlers and the sync reconciler both reuse). The #47 server-side divergence is resolved by #48: both sides now run the registry two-key machine — Silver on pass, Gold only via the frozen 14-hour window plus a 5-item verification with >= 4 correct (the server's pre-#48 any-second-pass Gold promotion is retired); topic-path cognitive time uses audio 0 exactly like the server; gate attempts are logged locally and, since migration 006, persisted server-side with session identity. All local gate outcomes and key states carry a `provisional` flag until a sync snapshot confirms or rolls them back.
- **Two-key sleep consolidation:** Day-1 gate pass awards `SILVER_KEY` (provisional); Gold becomes eligible exactly `silver_awarded_at + 14 h` and requires the verification session; transitions are forward-only (Silver -> Gold, never regress locally); the window is measured from the FIRST Silver award and never re-armed by re-passes.
- **Spaced repetition:** review queues are built from the engine's retrievability curve over the local `topic_progress` rows, with intervals age-capped per grade from the pack's `sr_max_interval_days` (Pre-K 21 / K 30 / G1 45 / G2–G3 60 days).
- **Module layout (DI doctrine):** pure node-testable core — `PracticeSessionEngine` (session orchestration), `AttemptRecorder`, `progressProjector`, `goldKey`, `reviewQueue`, `packShapes` (pack rows -> engine shapes, field-identical to the server's `mapQuestionRow`) — plus exactly one RN adapter (`nativePractice.ts`, expo-sqlite + query_only pack reader) and a root-mounted `PracticeWarmup` bootstrap that pre-opens the reader at launch. Tests: 133 tests across the ten `apps/mobile/tests/practice-*.test.ts` suites run in plain vitest (node:sqlite), including the airplane-mode end-to-end: full topic session, boss gate, and Gold verification against an installed pack fixture with zero network.

### 9. Sync Protocol (`apps/mobile/src/sync` + `services/api/sync.mjs`, issue #48)
Offline progress reaches the server as immutable facts; the server is authoritative for all derived state (roadmap D8).

- **Client loop:** drain whole sessions from `attempt_log` in id order -> upload facts only (never client-computed derivations) -> adopt the server's authoritative snapshot (confirm/rollback of provisional key states, server timestamps) -> flip `synced`. A crash at ANY step loses nothing — rows replay and the server dedupes by `(student, device, client_seq)`. Retries use exponential backoff with full jitter; fatal 400/401/403/404/413 never retry; offline runs pause the loop. The controller fires on app foregrounding, connectivity regain, and debounced post-practice nudges (no polling; `@react-native-community/netinfo` is the reachability seam — Expo SDK 58 ships no first-party connectivity module; decision documented in `nativeSync.ts`).
- **Whole-session contract:** batches carry only complete sessions. When the drain window is full, a cursor probe beyond the window defers the trailing session unless it is provably ended AND the extension fits the 200-attempt cap; a session larger than the cap fails loudly; a configured batch size above the cap is clamped client-side. Full boundary-deferral and convergence semantics: `docs/architecture.md` section 2.6.
- **Server endpoints (child-device tokens only, consent-gated):** `POST /api/sync/attempts` — idempotent batch reconciliation in ONE transaction (inserts + session replays through the shared derivations), returning reconciliation stats and the authoritative snapshot; sessions split across batches converge (union replay over previously persisted rows, exactly-once counting, transition-gated coin awards). `GET /api/sync/progress` — the snapshot plus the content-version handshake without an upload. Clock policy: past client timestamps are accepted as-is; future skew beyond tolerance (default 5 minutes) clamps to server time. Full contract: [`docs/openapi/baseline.yaml`](./docs/openapi/baseline.yaml).


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
│   └── mobile/                               # Expo SDK 58 app shell (design system, theming, onboarding flow, expo-router, offline practice core) + static web dev harness (public/)
├── tools/
│   └── content-pipeline/                     # Signed per-grade content-pack compiler (node:sqlite + node:crypto, zero runtime deps)
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
11. **[OpenAPI API Contract (`docs/openapi/baseline.yaml`)](./docs/openapi/baseline.yaml)** — OpenAPI 3.1 baseline for all 33 API operations including the RFC 9457 problem+json error shapes; CI blocks breaking changes via oasdiff.
