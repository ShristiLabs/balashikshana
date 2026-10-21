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
# Start both the Sync/Mastery API (port 4000) and Interactive Learning App (port 4200)
./startup.sh

# Stop all running services
./stop.sh
```
- **Interactive Learning App:** `http://localhost:4200`
- **Sync & Analytics API Health:** `http://localhost:4000/api/health`
- **Validate Curriculum DAG & Core Engine:**
  ```bash
  npm run validate:curriculum
  npm run build
  ```

### 2. Run via Docker Compose (`docker/docker-compose.yml`)
```bash
docker compose -f docker/docker-compose.yml up --build -d
```

### 3. API Authentication (Student Sessions)
- Every student-scoped route requires a session token: send `Authorization: Bearer <token>` (401 without/invalid/expired token, 403 when the token belongs to a different student)
- Obtain a token: `POST /api/auth/login` (username or studentId + 4-digit PIN, always required) or account creation via `POST /api/students` (PIN required, no default exists; demo-seed PINs are randomly generated and printed once in the API log)
- Revoke a token: `POST /api/auth/logout` (also your own token); sessions expire after 30 days
- PINs are stored as salted scrypt hashes (N=16384, r=8, p=1, keylen=64; see `services/api/db.mjs`); legacy unsalted-SHA-256 rows are rehashed transparently on next login
- Run the auth/session security tests: `npm run test:api`

---

## Repository Structure & Documentation

```text
balashikshana/
├── AGENTS.md                                 # AI Agent architecture, pedagogical & schema guide
├── README.md                                 # Project overview, curriculum summary & architecture
├── startup.sh / stop.sh                      # One-command startup and shutdown scripts
├── package.json                              # Monorepo workspaces configuration
├── GradePrekto3MathCurrGuide.pdf             # Reference Pre-K to Grade 3 Mathematics Curriculum Guide
├── .github/workflows/ci.yml                  # GitHub Actions CI for curriculum DAG & engine build
├── docker/
│   ├── docker-compose.yml                    # Postgres, Redis, API & Web container orchestration
│   ├── Dockerfile.api                        # Backend Sync & Mastery API container
│   └── Dockerfile.web                        # Interactive Mobile/Web App container
├── packages/
│   └── core-engine/                          # DAG Resolver, 5-Condition Mastery Gate, Child FSRS & Question Generator
├── services/
│   └── api/                                  # Node.js Sync, Mastery Gate Evaluation & Parent Analytics API
├── apps/
│   └── mobile/                               # Cross-Platform Expo/React Native + Web Interactive Learning App
├── docs/
│   ├── us-curriculum-registry.json           # Canonical JSON DAG of all 130 units, 614 topics & 9-asset bundles
│   ├── us-curriculum-mapping.md              # Complete Pre-K to Grade 3 unit progression & skill-topic mapping
│   ├── games-and-study-materials.md          # 10 parameterized game archetypes & interactive study manipulatives
│   ├── mastery-gate-engine.md                # Mathematical specification for Accuracy + Speed Mastery Gating
│   ├── spaced-repetition-science.md          # Child-calibrated Memory Consolidation & Spaced Repetition (Ages 3-9)
│   ├── skill-topic-assets-catalog.md         # Catalog of all 9 asset categories across all 614 skill topics
│   ├── architecture.md                       # Offline-first iOS/Android client, SQLite schema, & cloud sync architecture
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
