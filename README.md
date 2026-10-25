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
- **Navigation:** an `expo-router` tree — launcher; the real onboarding flow (below); the readiness-guarded real `journey` map (section 10); the practice runner (section 11; the journey routes into it with `{ gradeId, unitId }` params and an optional `topicCode` deep link); the boss gate runner (section 12; the journey routes gate-adjacent units into it with `{ gradeId, unitId }`); and the game framework host (section 13; the practice picker's per-topic Play affordance routes into it with `{ gradeId, unitId, topicCode }` and an optional `stage`) whose real archetype renderers ship per pack: Block Builder + Market Cashier with issue #53 (section 14) and Bubble Pop Blitz + Monster Phoneme Feeder with issue #54 (section 15). Every screen offers a Home action; no dead ends.
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

### 10. Journey Map (`apps/mobile/src/journey`, issue #49)
The winding-path home screen every session starts from: unit nodes down a deterministic SVG path, the garden-health header, and the grade switcher — all derived, nothing hardcoded.

- **Pure derivation layer:** `model.ts` computes every unit's state from the installed pack (#46, query_only reader) plus progress rows (#47) — all seven engine `UNIT_STATES`, prerequisite-DAG locking, Silver/Gold keys with the provisional distinction and the 14-hour Gold countdown, and garden health as a pure aggregate. The documented FLUENCY_READY / GATE_UNLOCKED split sits exactly at the projector's crowns tier boundary (all topics complete: avg crowns < 2 = fluency ready, >= 2 = boss gate open) and is matrix-tested at the boundary. `store.ts` (grade switching, pack currency, hydration, active-grade guard), `loader.ts`, and `art.ts` are equally pure; only `nativeJourney.ts` touches native seams. Zero curriculum data in the module (source-scan enforced).
- **Hydration + grade switching:** the screen renders the local model immediately (offline-first), then kicks one sync run through the shared controller and re-derives with fresh post-snapshot data; the post-adoption reload targets the live grade and the store ignores models for a non-active grade, so a mid-hydration grade switch can never mix grades. Switching persists via the onboarding snapshot's `gradeId`; per-grade progress survives by construction (unit ids are globally unique). The switcher's pack currency (`installed` / `downloading` / `missing` / `stale`) runs missing/stale grades through the #46 `ensurePack` lifecycle — the previously-dormant #48 `clientPacks` handshake now flags stale grades (wired in `SyncBootstrap`; downgrades refused, last-good pack keeps serving until an update resolves).
- **Accessibility:** state encodings are shape+color redundant (unique glyph per state; Silver badge = circle, Gold = hexagon), node targets are >= 48pt, and spoken labels carry state, key, provisional status, countdown, and "you are here"; the scroll-linked reveal degrades to a static reveal under reduced motion.
- **Dependency note:** `react-native-svg` 15.16.0 — chosen over Skia because it is the established OSS standard for static vector art, lighter, and sufficient for the winding path (reanimated already covers motion).
- **Nav seam for #50/#51:** node taps route to `/practice` and `/gate` with `{ gradeId, unitId }`. Harness comparison feeding the D1 retirement decision: [`docs/journey-harness-parity.md`](./docs/journey-harness-parity.md). Architecture detail: `docs/architecture.md` section 2.7.

### 11. Practice Session Runner (`apps/mobile/src/runner`, issue #50)
The child-facing practice loop the journey map routes into: pick a topic in the unit, tap through a 3-finger warm-up, answer questions rendered per interaction type and CPA scaffold stage, with in-session spaced re-queues and a gentle summary — fully offline against the installed pack.

- **All seeded interaction types, data-enforced:** the packs contain exactly three (`multiple-choice`, `tile-builder`, `interactive-counter`), and a vitest suite re-derives that inventory the same way the #46 compiler seeds it, failing if any type lacks a renderer — the checklist lives in [`docs/runner-interaction-coverage.md`](./docs/runner-interaction-coverage.md) and is pinned to the test, so it cannot drift.
- **CPA scaffold fading, engine-owned:** each topic's stage (`CONCRETE_INTERACTIVE -> PICTORIAL_STATIC -> PICTORIAL_GHOST_FLASH_1S -> PURE_ABSTRACT_SYMBOLIC`) is derived from the engine's memory-stability thresholds (pinned against `packages/core-engine` by test), never from UI heuristics. The interactive manipulative answers only at the concrete stage; later stages fade to the choice grid with less and less visual scaffold.
- **Manipulative widget kit v1:** `CounterFrame` (tap-to-toggle counting frame), `TileBuilder` (tap-to-place tile bank — tap, never drag, for little hands), `ChoiceGrid` (the universal answer surface, shape+color redundant selection), `VisualScaffold` (pictorial row + 1-second ghost-flash peek). Presentational, >= 48pt targets, all three themes including highContrast, animation-free under reduced motion, and reusable by the M4 game framework (#52).
- **Lag +2/+5/+10 re-queue:** a missed or slow ORIGINAL item re-presents the same question three more times at expanding lags (constants pinned to the engine's), the +10 clamping into a final "exit ticket"; re-queues show a SPACED REPLAY badge and the session is capped at 16 items.
- **Motor warm-up + fair timing:** three timed taps calibrate the session's motor baseline (engine math, clamped); topic cognitive time subtracts it exactly like the server's topic handler (audio duration 0 on this path — narration is client-side and never billed into topic timing).
- **Offline-first with sync-safe errors:** every answer is durably recorded the moment it is checked (#47 append-only log); if submit or completion fails, the session is explicitly abandoned so #48's whole-session upload batching can never wedge, and the recorded attempts still sync. Progress rows are re-read before every session so back-to-back sessions never see a stale CPA stage.
- **Route:** `/practice` is consent-guarded like the journey; the journey passes `{ gradeId, unitId }` (plus an optional `topicCode` deep link), and the topic picker's Play affordance routes into the game framework (section 13). Architecture detail: `docs/architecture.md` section 2.8. Still deferred to the later M4 packs: full SVG manipulative art parity for the concrete stage (#53/#54 shipped RN surfaces over the widget kit).

### 12. Boss Gate Runner (`apps/mobile/src/gate`, issue #51)
The five-condition unit mastery gate as a child-facing flow: entry status (key state + the 14-hour Gold countdown), a 3-tap warm-up, the spiral-mixed gate session with anti-guess freeze, the per-condition results screen with remediation routing, the Silver/Gold key ceremony, and the 60-second Gold verification check — fully offline against the installed pack.

- **Five-condition evaluation, engine-owned:** completion runs the SAME `evaluateMasteryGateAttempt` call the server's `/api/gate/evaluate` and the #48 sync replay run (D3 parity) — accuracy >= the unit threshold, every topic >= 75%, median cognitive speed <= target, P80 tail <= 1.3x target, final challenge streak with zero rapid guesses. No threshold is re-implemented client-side; the pins are tripwired against the engine, the registry's `globalMasteryRules`, and `services/api/derivations.mjs`.
- **70/20/10 interleaved spiral mix (AGENTS.md binding on Stage 4 gates):** the session blends 70% current unit (the server's stratified round-robin builder, unchanged), 20% contrastive prerequisite units (same builder, prerequisite order), and 10% due spaced review (#47 review queue, most-forgotten first, one question per due topic, current unit excluded). Allocation is deterministic largest-remainder; interleaving is deterministic; a missing source's share flows back to the current unit, so a pack with no prerequisites and nothing due composes exactly the pre-#51 selection. The Gold check opts OUT of the mix — it is a pure current-unit retention probe.
- **Foreign-topic attribution stays server-identical:** prerequisite/review questions belong to other units, so their topic codes are namespaced to full topic ids — the exact rule the #48 server replay applies (pinned by test): same-unit responses keep short codes, foreign ones use the full id, and the per-topic floor covers them all. A parity test runs the same mixed responses through the native path and a direct engine call under the server's mapping and proves identical verdicts.
- **Anti-guess freeze:** an INCORRECT answer under 1.2 s raw (the engine's exact counting rule, mirrored — a fast correct answer is fluency, never guessing) triggers a 2-second gentle think-first freeze before CHECK/CONTINUE unlocks (registry `antiGuessingFreezePenaltySec`).
- **Results screen:** all five conditions shown individually with metric and threshold text, the per-topic table against the 75% floor, and next-step routing by the engine's `REMEDIATION_MODE` into focused practice (a same-unit blindspot deep-links the failed topic) — gentle copy throughout (no loss framing).
- **Key ceremony + 14-hour Gold verification check:** a pass celebrates with the key ceremony — the journey's badge silhouettes (Silver circle / Gold hexagon), star fanfare, celebration narration, and haptics — marked provisional until #48 sync confirms (the server snapshot can also roll it back to a gentle retry). The entry screen counts down the 14-hour window; when it opens, the Gold check offers 5 questions under a 60-second budget with >= 4 correct upgrading to Gold (exactly-4 passes, exactly-3 keeps Silver; a missed check simply retries). The deadline auto-complete counts only answered responses — the same evidence the server replay counts — and is race-guarded against an in-flight answer.
- **Liveness + a11y:** every error path (submit, completion, deadline, exit) abandons the session so #48's whole-session upload batching never wedges; attempts stay durable in the append-only log. Targets >= 48pt, results are shape+color+text redundant, and the ceremony's animation is decorative — under reduced motion the reveal is instant. Architecture detail: `docs/architecture.md` section 2.9.

### 13. Game Framework (`apps/mobile/src/games`, issue #52)
The M4 data-driven runner that plays ANY of the registry's game archetypes: the topic's own `assets.games` block (already riding #46 packs verbatim — zero pack-schema change) names the archetype and stage, and a registered renderer draws the answer surface. The pipeline was proven by a stub `block-builder` renderer in #52; pack A (math — section 14) and pack B (reflex/ELA — section 15) shipped the real renderers, and the retired stub is gone.

- **Data-driven routing, never a dead end:** every one of the 614 topics carries BOTH game configs (guided untimed explorer + fluency timed sprint; 1,228 bindings). `resolveGameRoute` decides before any session opens: archetype installed -> the game session screen; anything else (no games block, stage missing, archetype not installed) -> the SAME topic in the #50 practice runner, transparent to the child, with a fallback marker (`game_fallback = 1` + the intended archetype) on every attempt row. The installed-vs-fallback checklist lives in [`docs/games-coverage.md`](./docs/games-coverage.md) and the inventory (11 registry archetype ids) is data-enforced by `tests/games-registry-catalog.test.ts`.
- **One renderer contract (`GameRendererProps`):** the framework screen owns timing, durable recording, feedback, and the re-queue ladder; the renderer owns only the answer surface (question, CPA stage, game stage, speed target, draft callbacks, prompt replay). Archetype packs register exactly one component per archetype id in `ARCHETYPE_RENDERERS` (`archetypeRegistry.ts`) — "supported" is simply the map's keys.
- **70/20/10 as data:** the fluency sprint composes its item stream from the topic's OWN `spiralMix` through the #51 allocator, parameterized once (the boss gate keeps the registry default — #51 behavior unchanged); missing pools' shares flow back to the current topic, and the #50 Lag +2/+5/+10 re-queue ladder is reused verbatim. Guided composes current-topic only; both stages run `minQuestionsToComplete` items.
- **GAME sessions count as practice, per topic:** the session type union gains `GAME`; completion groups responses BY THEIR OWN TOPIC and projects each with the same `deriveTopicSession` the server's GAME replay runs per topic group (`services/api/sync.mjs` `replayGameSession`, additive enum — older clients never send it), so a game's prerequisite/review items credit their own topics on both sides. Derivation target speed is the unit gate speed exactly like practice; the registry's `targetResponseSpeedSec` paces the sprint and feeds telemetry only.
- **Telemetry is local-only (COPPA):** local migration 4 adds four additive `attempt_log` columns (spiral provenance, target speed, archetype, fallback marker); the #48 sync wire is unchanged (facts only) — the server re-derives progress from the same attempt facts, and game provenance never leaves the device. No PII. Architecture detail: `docs/architecture.md` section 2.10.

### 14. Archetype Pack A — Math Renderers (issue #53)
The first two REAL archetype renderers on the #52 framework, registered in `ARCHETYPE_RENDERERS` (`archetypeRegistry.ts`): the guided stage of 136 `block-builder` topics and 32 `market-cashier` topics (data-derived counts) now plays as a game instead of falling back to the practice runner; those topics' fluency sprint was `bubble-pop-blitz` (120 — flipped by #54's pack B) or `bridge-builder` (48 — still fallback until its pack lands).

- **Block Builder (`blockBuilder.ts` + `BlockBuilderGame.tsx`):** three item-data-driven surfaces — count-build (tap +1 cubes and +10 ten rods; the rail auto-bundles loose ones into rods; the bank offers the rod once a target of 11+ makes a ten reachable), tile-sequence (the shared TileBuilder over the item's tile bank), or the shared QuestionBody substrate. Guided mode walks a deterministic step-by-step hint chain (including the bundling hint); fluency suppresses hints.
- **Market Cashier (`marketCashier.ts` + `MarketCashierGame.tsx`):** a checkout scene — coin pad (1/5/10/25 cents, plus the $1 bill only when the item's own data spans a dollar), grouped coin tray with a running total in the item's own money style, a price chip when the item's prompt names one, and a guided-only paid/needed/change hint chain. Non-money or ambiguous items ride the substrate; spiral-mixed foreign items grade correctly through the universal choice grid.
- **Grading by construction:** the cashier matches the built total back to the item's EXACT choice label and the builder drafts the built count — both string-equal the framework's `draft === correctAnswer` check; no renderer ever grades or records.
- **Zero curriculum hardcoding (test-enforced):** every surface, bank, pad, hint, and money format derives from the item's own data or universal US-currency facts — `tests/market-cashier.test.ts`, `tests/block-builder.test.ts`, and `tests/archetype-pack-a.test.ts` pin the matrices, and the registry catalog test pins the route flip.
- **#52 review carry-overs landed:** explicit stage affordance at the session door (single-stage never auto-starts), summary topic row selected by topic id, Play-again re-enters through the stage affordance and the motor warm-up's calibrated baseline (one shared `DEFAULT_MOTOR_BASELINE_SEC` constant), dead conditionals removed. Architecture detail: `docs/architecture.md` section 2.10; coverage checklist: [`docs/games-coverage.md`](./docs/games-coverage.md).

### 15. Archetype Pack B — Reflex + ELA Renderers (issue #54)
The reflex and phonics pack: `BubblePopBlitzGame` + `MonsterPhonemeFeederGame` registered in `ARCHETYPE_RENDERERS`. The fluency stage of all 250 `bubble-pop-blitz` topics (every grade, `targetResponseSpeedSec` 3.0-14.0 from the registry) and the guided stage of all 102 `monster-phoneme-feeder` topics (22 ELA units — the framework's first ELA surface) now play as games; every feeder topic's fluency sprint is itself a blitz, so the 102 ELA topics flip BOTH stages (data-derived, pinned by the registry catalog test).

- **Bubble Pop Blitz (`bubblePopBlitz.ts` + `BubblePopBlitzGame.tsx`):** a seeded bubble-per-choice field (the same item presents the identical field on every device and every re-queued repeat); tapping a bubble publishes the choice label verbatim and submits on the same tap through the contract's optional `onSubmitAnswer` reflex seam — a build-then-Check flow would break `targetResponseSpeedSec` pacing. Timer pressure is D6 age-tiered off the structural topic prefix: Pre-K/K/G1 (and unrecognized grades) get the gentle tier that structurally cannot show the urgent phase; only G2-G3 see sprint copy. Elapsed clamps at the target, pressure paces (there is no per-item deadline — the win rule is median-based), and the input-vs-visual drift bound is test-pinned. All clock access stays inside one presentational 250 ms tick; no pure module carries a clock.
- **Monster Phoneme Feeder (`monsterPhonemeFeeder.ts` + `MonsterPhonemeFeederGame.tsx`):** audio-first — a prominent "Hear the word" affordance rides the framework's `onReplayPrompt` narration seam (the #45 coordinator owns SSML pacing, ducking, and interruption; the renderer never touches audio and never blocks). The item's own tile bank becomes the food tiles; feeding the target order drafts the segments joined with single spaces — EXACTLY the pack's choice-label shape ("f a n"), so grading is by construction. The parser is anchored to the phoneme vocabulary (1-4 lowercase letters per token, multiset bank cover); whole-word multiple-choice rows and digit-tile math rows correctly degrade to the shared substrate.
- **Real-data proof:** `tests/archetype-pack-b.test.ts` reads all five content-pack databases and proves EVERY live row fields a bubble surface (exact choice permutation) and every phoneme-shaped tile row assembles to its row's exact `correct_answer`.
- **Single-flight submits:** the session screen's check path carries an in-flight guard — a reflex double-tap inside the submit window can no longer double-record an item.
- Architecture detail: `docs/architecture.md` section 2.10; coverage checklist: [`docs/games-coverage.md`](./docs/games-coverage.md).

### 16. Gamification Ledger — XP, Levels, Badges, Crowns/Coins, Streaks (issue #55)
The roadmap D9 reward layer: all reward math lives in `packages/core-engine` (`src/rewards.mjs`, zero-dependency pure functions + the badge catalog as frozen data), so the server's authoritative ledger and the client's optimistic local projection compute IDENTICAL rewards from the same append-only attempt stream — offline and online agree by construction, and no reward is ever lost to a network failure (rewards ride the existing #48 enqueue/replay queue; a replayed batch credits nothing twice, DB-enforced).

- **What a child earns:** per-attempt XP fluency-weighted by the engine's 4-point grade scale (correct answers earn 1-3 XP by grade; incorrect answers earn nothing, never a penalty), a pass bonus for every passed topic/game session (`10 + 5 per crown`), a flat gate-pass bonus (25 XP + 50 coins), and a Gold-key upgrade bonus (20 XP). Coins keep their historical formulas (`15 + 5 per crown` topic pass; 50 gate pass) — now engine-owned. The level curve (`25 x level x (level-1)` cumulative XP, cap 50) makes early levels arrive within a session or two.
- **Badges:** a 14-badge catalog as engine DATA (threshold specs over nine aggregate metrics — sessions, topics, three-crown topics, perfect topics, earned Silver/Gold keys, best beat-the-target share, coins, streak days). The speed badge ("Lightning Learner") consumes `beatTargetSharePct` — the share of a PASSING topic group's CORRECT answers at-or-below the topic's own registry fluency target (fast-wrong answers carry no speed credit). Key badges count only keys the child's own gate/verification sessions earned — prerequisite placement credit never awards badges.
- **Server surface (additive):** migration 007 (`student_xp_events` with a per-student dedupe key, `student_badge_awards`, `student_gamification_state`; ledger rows in [`docs/database-migrations.md`](./docs/database-migrations.md)), reward writers wired into BOTH the online completions and the #48 sync replays in one transaction, and the kid-facing read `GET /api/students/{studentId}/gamification/ledger` (XP total, level shape, coins, streak, badges with catalog metadata, crown summary, recent XP events).
- **Client:** local migration 5 (one `gamification_state` row — the optimistic ledger, provisional until the server confirms), the pure projector wired into all four session completions (summaries now carry `xpAwarded`/`coinsAwarded`), and the journey home's `GamificationHeaderStrip` (level + XP bar + coins + day streak + badge count; "Syncing" while provisional; design tokens, no emoji, reduced-motion safe). Badge displays and celebrations land with #56-#58.
- Architecture detail: `docs/architecture.md` section 2.11.

### 17. Hearts — Grade-Tiered Effort Policy (issue #56)
Roadmap decision D6: heart depletion exists ONLY in Grade 2–3 fluency sprints. Pre-K–Grade 1 is no-fail with gentle retry — punishing a 4-year-old for wrong answers contradicts the project's own `onGentleRetry` pedagogy, so for the youngest grades the hearts UI cannot even mount.

- **Rules single-sourced in the engine:** `packages/core-engine/src/hearts.mjs` (zero-dependency pure functions) owns the tier rule — `shouldMountHearts(gradeId, stage)` is true only for a grade-2/grade-3 FLUENCY sprint, fail-closed for unrecognized grades — plus the bounded count (`HEART_COUNT` = 5), the loss transition, the end-reason taxonomy, and the shared wire validation (`heartsOutcomeProblem`). The mobile UI gate and the server telemetry validation import the same module; the contract cannot fork.
- **Structural no-fail:** the practice engine resolves heart state exactly once at session start — full count when the predicate is true, `null` otherwise — and `null` means no hearts UI, no loss transitions, no outcome rows, no code path at all (the M4 verification gate: "hearts UI absent in Pre-K–G1 builds"). Guided (untimed) sessions never carry hearts either.
- **Loss rules are kid-safe:** only a FIRST-answer miss costs a heart — re-queued repeats (the Lag +2/+5/+10 second-chance ladder) never double-penalize — the count never rises mid-session, and invalid engine input resolves to FULL hearts (a bug never costs a child a heart). The loss transition runs only AFTER the attempt is durable in the append-only log: heart state is UI derived from recorded facts.
- **Empty hearts end the sprint with a growth reframe — never a fail:** the session completes early with a positive growth-mindset summary (mistakes grow your brain; no punitive copy, no dead ends), and the next session always starts with full hearts — no cross-session persistence, no gate, no cooldown; hearts can never block content. The reframe screen's "hearts grow back while you rest" indicator is presentation-only (injected clock; the engine never reads wall time).
- **Outcome telemetry is exactly-once:** each hearts session writes one append-only `session_outcomes` row (local schema v6, `UNIQUE (student_id, session_id)`) that rides the #48 sync wire as an additive optional `sessionOutcomes` batch — a pre-#56 server ignores it; the ack (`ackedOutcomeIds`) flips the row `synced` only after server confirmation (no-loss ack). Server migration 008 (`student_session_outcomes`, ledger in [`docs/database-migrations.md`](./docs/database-migrations.md)) re-applies the same UNIQUE + in-transaction `ON CONFLICT DO NOTHING`, validating the whole batch through the same engine rule — replayed batches insert nothing. Counts and an enum end reason only (COPPA — no PII), and hearts never feed the #55 reward math: they are session-scoped UI, not a currency. The legacy `students.hearts` counter (migration 001) stays unwired.
- Architecture detail: `docs/architecture.md` section 2.12.

### 18. Streaks + Local Practice Reminders (issue #57)
Roadmap decision D5: reminders are COPPA-safe by design — LOCAL ONLY via `expo-notifications` calendar triggers, DEFAULT OFF, parent-configured behind the #44 gate; no push, no remote endpoints, no third-party SDKs (the AGENTS.md invariant — `expo-notifications` is first-party Expo OSS and the app's only notification library).

- **Scheduling rules single-sourced in the engine:** `packages/core-engine/src/reminders.mjs` (zero-dependency, no clocks — time is a parameter) owns validation/coercion (`normalizeReminderSettings` fails CLOSED: a corrupt or missing row is always disabled), the next-occurrence rule (fixed-offset local-day model, midnight-crossing cases pinned by tests), and `reminderPlan` — the decision table the shell executes: invalid -> cancel, disabled -> cancel, enabled + OS permission granted -> schedule, enabled without a grant -> hold (setting survives, nothing schedules).
- **Local-only shell:** `apps/mobile/src/notifications/localReminders.ts` uses ONLY local APIs — daily repeating calendar trigger at the parent's device-local time (the OS keeps the wall-clock meaning across DST), permission query, one parent-named request wrapper, cancel-then-schedule replace under a single identifier. No push registration, no token fetch, no network path at all — source-scanned by tests across every app file, and the app manifest carries no remote-notification config.
- **Parent-gated, child-locked:** the settings seam lives ONLY in `app/parent` behind the hold-to-confirm gate — the sole writer of settings and the sole OS-permission prompter (both test-pinned; child surfaces cannot reach the seam). The OS prompt fires only when a parent enables reminders; denial keeps the saved choice unscheduled with recovery copy.
- **Device-local, never synced:** the settings are one sqlite singleton row (content schema v7 `reminder_settings`, `CHECK (id = 1)`) — no student id, no sync wire field, no server table; reminders are per-device. A root-layout bootstrap re-applies the plan at every app start (Android alarms do not survive reboot) without ever prompting or writing.
- **No PII anywhere:** the notification payload is two static encouraging literals — no child name, no streak value, no derived data; the settings row is a boolean + a time. Kid-facing streak surfacing is the new `useStreak` hook over the same ledger summary the journey strip shows, with a D9 agreement test proving offline and after-sync values are identical (same-day idempotence, gap resets, late out-of-order arrivals included).
- Architecture detail: `docs/architecture.md` section 2.13.

### 19. Mascot + Celebrations (issue #58)
Roadmap decision D7: the animations vocabulary is procedural — the registry's `stateMachineStates` names rendered on-device — under the 50 KB-per-Rive-asset budget with zero raster media. The mascot is one character with three moods (idle / react / celebrate); his pose set is EXACTLY the registry vocabulary, so the animation contract and the code cannot drift.

- **Zero new dependencies (the Rive decision):** the issue names Rive, but no `.riv` assets exist and the binary editor format cannot be authored here — so the mascot ships as first-party SVG art (`react-native-svg`, already a dependency) driven by the pose state machine, and the `.riv` swap is a real seam: pose names + motion tokens map 1:1 to the registry `stateMachineStates`, ready for a future adapter over real art. The budget acceptance is enforced today: `scripts/check-animation-assets.mjs` in CI fails any `assets/animations/*.riv` at 50 KB or more and any raster media (green at zero `.riv` files; standing guard for real art).
- **Pure machine, thin view:** the transition logic is pure TypeScript (celebrations lock out reactions for the bloom window; transient poses expire back to idle on a tick) with the registry's own durations/springs/burst counts as motion tokens — uniformity across all 614 topics is test-pinned. The view layer is decorative by construction: a11y-hidden, `pointerEvents="none"` (the mascot can never block a touch target or introduce a sub-48pt affordance — nothing about him is pressable), transform-only native-driver animation for the 60 fps target, and the identical end-state frame rendered statically under reduced motion (no meaning depends on motion).
- **Celebrations derive from the reward ledger:** every session summary carries a celebration report — badges newly earned, level-up (the engine level curve), streak transition — and the planner orders the moments concrete-before-abstract (mastery, badges, level-up, streak milestone at the catalog's own 3/7-day thresholds). Copy is positive-only and PII-free (counts and catalog titles only, a11y labels for every moment); the heart-loss reaction is the warm bounce-back pose (#56 growth framing — empathetic, never sad).
- **Mastery badge bloom + ceremonies:** the bloom fires on a topic's FIRST mastery with the #55 catalog badge rendered tier-shape-redundant (bronze circle / silver pentagon / gold hexagon) inside the 12-star burst, the badge title visible as text. The unit-complete moment IS the key ceremony: the #51 Silver/Gold ceremony composes the celebrating mascot and blooms the session's badges (Gold ceremonies source the verification's report; a hearts-empty game end keeps the growth reframe only — no goal fanfare).
- **Registry celebration lines, voiced:** mastery and goal-met celebrations speak the topic's own `celebrationPrompts` line through the #45 TTS coordinator, from a compact derived asset (`assets/narration/celebration-lines.json`, generator script, pinned 1:1 against the narration manifest by test) instead of bundling the full SSML manifest.
- Architecture detail: `docs/architecture.md` section 2.14.


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
12. **[Game Archetype Coverage Checklist (`docs/games-coverage.md`)](./docs/games-coverage.md)** — Which of the registry's 11 game archetypes have installed renderers vs. practice fallback (pack A — block-builder + market-cashier — issue #53; pack B — bubble-pop-blitz + monster-phoneme-feeder — issue #54), the fallback semantics, the guided/fluency stage model, and the data-derived per-pack coverage footprint (data-enforced by the games-registry catalog test).
