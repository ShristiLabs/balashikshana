# Technical Architecture (iOS, Android & Cloud Sync)

**Balashikshana** is architected as an **offline-first, cross-platform mobile game and study platform** for **iOS and Android** tablets and phones, backed by a containerized microservice API for multi-device progress synchronization, parent analytics, and over-the-air (OTA) curriculum bundle delivery.

---

## 1. High-Level System Architecture

```text
┌────────────────────────────────────────────────────────────────────────────┐
│                     iOS & Android Client App (Offline-First)               │
│                                                                            │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────┐  │
│  │  Study Manipulatives │  │ 10 Game Archetype    │  │ Stage 4 Boss     │  │
│  │  & Story Reader      │  │ Engines (60/120 FPS) │  │ Assessment Gate  │  │
│  └──────────┬───────────┘  └──────────┬───────────┘  └────────┬─────────┘  │
│             └─────────────────────────┼───────────────────────┘            │
│                                       ▼                                    │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │        Mastery & Telemetry Engine (Accuracy %, Speed ms, DAG)        │  │
│  └────────────────────────────────────┬─────────────────────────────────┘  │
│                                       ▼                                    │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │     Local SQLite Store (Curriculum DAG, Progress, Spaced Queue)      │  │
│  └────────────────────────────────────┬─────────────────────────────────┘  │
└───────────────────────────────────────┼────────────────────────────────────┘
                                        │  HTTPS / Delta Sync (When Online)
                                        ▼
┌────────────────────────────────────────────────────────────────────────────┐
│                         Backend Services & CDN                             │
│                                                                            │
│  ┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────┐  │
│  │  Sync & Mastery API  │  │  PostgreSQL + Redis  │  │  OTA Asset CDN   │  │
│  │  (Auth, Profiles,    │  │  (Learner Telemetry, │  │  (Unit Audio,    │  │
│  │   Parent Analytics)  │  │   Skill Heatmaps)    │  │   Vector Sprites)│  │
│  └──────────────────────┘  └──────────────────────┘  └──────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Mobile Client Architecture (iOS & Android)

### 2.1 Cross-Platform Layer
- **Runtime:** React Native (Expo SDK 58, RN 0.88, React 19 — roadmap D1) with **React Native Skia**, **Reanimated 4**, and **Rive**.
  - **60/120 FPS Rendering:** Skia provides hardware-accelerated 2D canvas drawing for Bezier letter tracing (`trace-draw-studio`), particle effects, ten-frame physics blocks (`block-builder`), and fast-moving sprites (`bubble-pop-blitz`).
  - **Vector Animations:** Rive state machines power interactive characters and study manipulatives at `< 50 KB` per asset.
- **App Shell & Design System (M3, issue #43):** the shipped foundation every M3 screen builds on.
  - `apps/mobile/src/design/tokens.ts` — pure-data single source for color (semantic `light`/`dark`/`highContrast` themes + text-grade `statusInk`), spacing, radius, and the kid-scale type ramp; vitest-enforced invariants (>= 48pt touch targets, WCAG contrast floors per theme).
  - Primitives (`Button`, `PressableCard`, `ProgressBar`, `Badge`, `Sheet`) with the tactile 3D treatment and a global reduced-motion provider (`MotionProvider` honors the OS accessibility setting; zero-duration degradation, nothing load-bearing).
  - `expo-router` tree: launcher + the real onboarding flow (below) + a readiness-guarded `journey` + placeholder `practice` / `gate` runners; no dead ends.
  - Quality gates: ESLint (flat, `eslint-config-expo`) + Prettier + strict `tsc` + vitest, wired into the single CI job.
- **Onboarding & Consent Chain (M3, issue #44):** the client that drives the M2 parent/consent/child API end to end (`src/onboarding/`).
  - A pure state machine (`state.ts`) with a resume planner: the step snapshot (one-row `expo-sqlite` table, secret-free) plus secure-store credentials plus a read-only server reconcile (consent status + children) decide the landing step after any interruption. Duplicate safety comes from in-flight markers persisted before the create-child POST — a kill mid-submission adopts the landed child or re-submits, never both.
  - Storage seams (`storage.ts` + `nativeStores.ts`): every credential (parent session, child-device, pending verification token, draft child PIN, install device id) routes exclusively through `expo-secure-store`; the SQLite snapshot is structurally incapable of carrying a secret, and the vitest suite enforces that on serialized snapshots.
  - Client consent doctrine: consent is captured before any child-data call, re-asserted server-side before child creation, and a 409 `policy-version-mismatch` always re-renders the new policy text before re-acceptance. A policy bump re-locks child surfaces (the journey guard consults consent status; offline it falls back to the last-known accepted version while the server remains the enforcement authority).
  - Parental gate: a reusable hold-to-confirm component (3-second continuous press, timer-based — animation settings cannot affect it) guarding onboarding and every parent/settings surface.
- **Audio & Phonetics Subsystem (M3 infrastructure, issue #45):**
  - `AudioCoordinator` facade (`apps/mobile/src/audio/`): the single entry point screens consume — `speak()` (TTS narration), `sfx()` (feedback sounds by id or `{moment, topicId}`), `haptic()` (feedback patterns), `stopSpeech()` (synchronous duck restore). Every platform capability is injected (speech / SFX / haptics / bundled-narration engines, settings store, clock, accessibility probes), so the entire policy surface is node-testable; the Expo adapters are isolated in one RN-only module (`nativeAudio.ts`) and the service bootstraps at the root layout via `getAudioService()`.
  - Grade-calibrated narration rate: rates derive from the curriculum registry (`docs/us-curriculum-registry.json`, per-topic `voiceNarration.speakingRateWpm`, uniform per grade — Pre-K 110, K 120, G1 130, G2 140, G3 150) and are clamped to 110–150 WPM before conversion to the platform multiplier. SSML narration input is adapted per platform (expo-speech has no SSML: tags stripped, prosody rates honored, break pauses preserved).
  - Duck policy (`duckPolicy.ts`, pure count-based state machine): while any narration utterance speaks, SFX volume scales to 0.3; the multiplier restores only when every queued utterance reaches a terminal event (paired with its start), and cancel restores synchronously. Narration itself is never attenuated — it is the primary instructional channel for pre-readers — and narration defers while a screen reader is active so TTS never fights VoiceOver.
  - Manifest-driven SFX catalog: `assets/sounds/sounds-manifest.json` (repo root, 614 topics) references the 16 synthesized WAVs in `assets/sounds/`; the app's static asset registry is compile-time pinned to exactly those 16 stems and tests pin manifest == registry == disk in both directions. #46 (content packs) owns the on-device split and delivery of topic-to-soundpack data; until then the bundled manifest is the source.
  - Audio settings (sound effects / narration / haptics / music toggles) persist through the non-secret SQLite seam (`balashikshana_audio.db`, one-row, schema-version-guarded parse with per-field type guards) — never the secure store.
  - Pre-K fallback hook: when the device exposes no usable TTS voice, a bundled-narration seam is attempted before reporting `unsupported` (bundled audio coverage itself lands with #59).
  - Pre-packaged pure phoneme audio bank (`/m/`, `/s/`, `/a/`, `/sh/`, `/ch/`) for zero-latency phonics blending (planned with the bundled-audio milestone).
  - On-device Text-to-Speech (US English voice profile) for dynamic math word problem narration so pre-readers are tested on math reasoning rather than reading ability.

### 2.2 Procedural Question & Distractor Generator
Instead of static multiple-choice questions that children memorize after two attempts, each Skill Topic in [`us-curriculum-registry.json`](./us-curriculum-registry.json) is paired with a **Parameterized Question Generator**:
- Generates fresh numbers, visual configurations, and pedagogical distractors on every run.
- **Smart Distractor Generation:** Wrong choices are generated from common misconception models (e.g., for `52 - 18`, distractors include `46` [subtracted smaller from larger digit: `8 - 2`], `44` [forgot to borrow], and `36` [off-by-two computation error]).

### 2.3 Local-First Storage & Offline Play
- **On-Device SQLite Database:**
  - `learner_profiles`: Child UUID, avatar, current grade, motor baseline ($T_{\text{motor}}$).
  - `unit_progress`: `unit_id`, `status` (`LOCKED`, `STUDY_REQUIRED`, `GUIDED_PRACTICE`, `FLUENCY_READY`, `GATE_UNLOCKED`, `MASTERED`), `best_accuracy`, `best_median_speed_ms`, `attempts_count`.
  - `topic_mastery`: `unit_id`, `skill_topic_code`, `mastery_score` (0–100), `median_speed_ms`, `stability_days` ($S_m$), `last_reviewed_at`, `cpa_fading_stage`.
  - `assessment_telemetry`: Granular log of every gate attempt (`question_id`, `skill_topic_code`, `is_correct`, `raw_time_ms`, `cognitive_time_ms`, `fluency_grade_1_to_4`).
  - `spaced_repetition_queue`: `unit_id`, `skill_topic_code`, `retrievability_pct` ($R_m(t)$), `next_review_at`, `sleep_consolidation_key_state` (`SILVER_KEY` / `GOLD_KEY`).

### 2.4 Signed Content Pack Subsystem (M3, issue #46)
- **Compile-time (`tools/content-pipeline`):** the registry is compiled into one deterministic SQLite pack per grade — canonical JSON, fixed pragmas, single sorted transaction, `VACUUM`, no timestamps — then sealed with a detached Ed25519 signature and SHA-256 checksum in a manifest index. The same registry + key always rebuilds byte-identical artifacts, and the build refuses to publish any artifact that fails its own self-verification.
- **Serving:** the API serves the manifest index (`GET /api/content/packs`) and the signed artifacts (`GET /api/content/packs/:gradeId`, octet-stream, ETag = sha256) from the gitignored compiler output; it never verifies signatures (that is the device's job) but 503s on any index/artifact inconsistency.
- **On-device (`apps/mobile/src/content/`):** packs are verified before install — pinned public keys, size + checksum + signature, and a `pack_info` cross-check that the artifact describes exactly the grade/version the manifest promised — then published with one atomic rename and pruned under a 64 MB storage budget. Downgrades are refused; failed installs leave the previous pack active. Pack artifacts are opened read-only (`PRAGMA query_only`); content rows are never inserted on-device.
- **Trust model:** dev builds pin the committed dev key; production pins nothing until the release key is provisioned at M6 — an empty trust list fails closed (no pack installs) rather than trusting the dev key.
- **Forward schemas:** the pack lifecycle database (`balashikshana_content.db`) already carries the append-only `attempt_log` and `topic_progress` / `unit_progress` tables that the offline practice core (#47) and sync protocol (#48) populate.

### 2.5 Offline Practice Core (M3, issue #47)
- **Module layout (`apps/mobile/src/practice/`):** a pure, node-testable core — `PracticeSessionEngine` (topic / boss-gate / Gold-verification session orchestration), `AttemptRecorder` (append-only writes), `progressProjector` (attempts -> progress rows), `goldKey` (two-key state machine), `reviewQueue` (spaced-repetition due queue), `packShapes` (pack rows -> core-engine shapes, field-identical to the server's `mapQuestionRow`) — with exactly one RN adapter (`nativePractice.ts`: expo-sqlite lifecycle storage + a cached, `PRAGMA query_only` pack reader resolved through `pack_meta`) and a root-mounted `PracticeWarmup` fire-and-forget bootstrap. `packages/core-engine` is imported read-only via a `file:` workspace link and never modified (RN-side typings: `apps/mobile/src/types/core-engine.d.ts`); the Hermes export for both platforms is asserted to contain the engine.
- **Local D8 doctrine:** the attempt log is client-authoritative and append-only — INSERT is the only write, there is no UPDATE/DELETE path anywhere in the mobile tree (source-scan enforced), the AUTOINCREMENT `id` is the strictly monotonic sync cursor, and `synced` stays 0 until #48's worker flips it. Progress rows are a local projection of the log; responses are durable at submit time, projections run at session completion, so a crash mid-session loses no attempt data (the log is the recovery record; #48 re-derives server-side).
- **Equivalence contract:** the projector mirrors `services/api`'s topic-complete and gate-evaluate derivations line-for-line — same engine calls, same rounding (`toFixed(1)` accuracy, `toFixed(2)` median), same crowns rule (3/2/1/0 at >= 95% and at-target speed / >= 85% / >= 80%), same GREATEST/LEAST upsert merges, sticky `MASTERED`, key COALESCE (an existing key is never nulled). Tests run identical streams (fixed + seeded-random) through both consumption paths and assert identical projections; a source tripwire pins the server's load-bearing derivation lines so server changes break the proof loudly. Documented divergences (the complete list): (1) the local two-key machine awards `GOLD_KEY` only after `silver_awarded_at + 14 h` plus a 5-item verification with >= 4 correct, while the server's gate endpoint today promotes on any second pass — #48 must port the machine server-side when sync confirms keys; (2) topic-path cognitive time is computed with audio duration 0 exactly like the server's topic handler, while gate items use the engine's audio-aware rule; (3) gate and Gold-verification attempts are logged locally (the server persists only topic attempts today), giving #48 a strictly richer stream to reconcile. All local gate outcomes and key states carry `provisional = 1` until #48 confirms or rolls back.
- **Schema v2 (lifecycle DB):** purely additive `ALTER TABLE ... ADD COLUMN` statements plus the partial `idx_attempt_log_drain (student_id, id) WHERE synced = 0` — v1 statements are frozen, a v1 device upgrades in place with zero data movement, and the `user_version` runner never touches a database from a newer app version. `attempt_log` gains `unit_id`, `session_type` (`TOPIC_PRACTICE` / `GATE` / `GOLD_VERIFICATION`), `session_id`, `raw_time_sec`, `fluency_grade`, `misconception_tags_json`, `chosen_answer`; `topic_progress` gains the SR columns (`stability_days`, `next_review_at`, `last_review_at`, `fluency_grade`, `topic_code`, `provisional`); `unit_progress` gains the gate-projection columns (`best_median_speed_sec`, `stability_days`, `last_reviewed_at`, `cpa_stage`) plus `provisional`, `silver_awarded_at`, `gold_verified_at`.
- **Two-key sleep consolidation (registry `globalMasteryRules.twoKeySleepConsolidationGate`):** day-1 pass -> `SILVER_KEY` (provisional); Gold eligibility opens exactly 14 h after the FIRST Silver award (re-passing the gate never resets or re-arms the window); a 5-item verification with >= 4 correct upgrades to `GOLD_KEY` (provisional); transitions are forward-only — no local event revokes a held key (rollback is #48's server-authoritative concern).
- **Spaced repetition:** the review queue ranks due `topic_progress` rows by the engine's retrievability `R_m(t)` (most-forgotten first), and intervals are age-capped per grade from the pack's `sr_max_interval_days` (Pre-K 21 / K 30 / G1 45 / G2-G3 60 days) — the cap is enforced both inside `updateTopicMemoryStability` (via the per-grade policy) and again at scheduling time.
- **Question sourcing offline:** stored pack rows first (topic sessions: `difficulty ASC, question_id ASC LIMIT n`, mirroring the server's practice endpoint; gate sessions: the server's stratified round-robin across the unit's topics), with the engine's deterministic `generateTopicPracticeSet` padding any shortfall in a disjoint `-G` id space — identical items for identical seeds on both sides by construction.

---

## 3. Parent & Educator Analytics Portal

Accessible behind a COPPA-compliant Parental Gate:
1. **Unit Progression Map:** Visual view of all 130 US curriculum units across Pre-K to Grade 3 (`Math`, `ELA`, `Science`, `Social Studies`).
2. **Accuracy vs. Speed Quadrant Chart:**
   - Plots each Skill Topic on a 2D quadrant (`Accuracy %` on Y-axis, `Response Speed` on X-axis) so parents immediately see:
     - *Top-Right (Green):* Fluent Mastery (Fast & Accurate)
     - *Top-Left (Yellow):* Understands Concept, Needs Speed Practice (Accurate but Slow)
     - *Bottom-Right (Orange):* Rushing / Guessing (Fast but Inaccurate)
     - *Bottom-Left (Red):* Needs Concept Review (Slow & Inaccurate)
3. **US Standards Crosswalk:** Shows the exact Common Core / NGSS / Preschool standard code (`e.g., Grade 2 Math > 2.NBT.B.5: Fluently add and subtract within 100`) corresponding to every unit and sub-skill.

---

## 4. Child Safety, Privacy & Compliance (COPPA)

- **Zero Third-Party Behavioral Advertising:** No ad networks or external tracking SDKs in the child-facing app.
- **Parental Gate:** Pin/math verification required before accessing external links, account settings, or subscription management.
- **Verifiable Parental Consent:** every child-data-creating route (student creation, child-profile creation, legacy claim, practice completion, mastery-gate evaluation) is gated server-side on a timestamped consent record naming the current policy version; consent evidence is append-only, and a policy version bump requires re-consent before further child-data creation (see `services/api/consent.mjs` and `docs/database-migrations.md`).
- **Child Profiles & Device Sessions (roadmap D4):** children are profiles owned by a parent account — creation writes the student row, the `parent_children` binding, the devices row, and a student-scoped consent row in one transaction, so no new standalone student can appear. Legacy standalone students (migration 005's status flag) are claimed by exactly one parent — legacy-status-only eligibility, username + PIN proof-of-knowledge, an atomic row-mutex backed by a partial unique index (second claimant rejected) — or archived (removed from the login-screen listing, every session revoked, all student-scoped routes frozen). Child device tokens — the third bearer kind beside student and parent sessions — are minted by an authenticated parent per (child, device), stored hashed at rest, expire after 30 days, and are revoked parent-side with immediate effect (see `services/api/children.mjs` and migration 005).
- **Data Minimization:** Child profiles store only a first-name nickname, grade level, and learning telemetry tied to the parent's authenticated account.
