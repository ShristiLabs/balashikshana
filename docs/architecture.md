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
- **Audio & Phonetics Subsystem:**
  - Pre-packaged pure phoneme audio bank (`/m/`, `/s/`, `/a/`, `/sh/`, `/ch/`) for zero-latency phonics blending.
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
