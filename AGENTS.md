# AGENTS.md — AI Agent Development & Curriculum Guide for Balashikshana

This document provides context, architectural invariants, pedagogical rules, and workflow guidelines for AI coding and curriculum agents working on **Balashikshana** (Pre-K to Grade 3 Interactive Learning Games & Study Platform for iOS and Android).

---

## 1. Project Mission & Non-Negotiable Pedagogical Rules

1. **Target Audience:** Children in **Pre-K, Kindergarten, Grade 1, Grade 2, and Grade 3 (Ages 3–9)** following the **United States Curriculum** (Preschool `MA.1–MA.5` / Head Start ELOF, Common Core Math & ELA, NGSS Science, and C3 Social Studies).
2. **No Third-Party Brand References:** Never reference external commercial platforms (such as IXL) in code, UI strings, comments, or documentation. All curriculum structures must reference official US standards (`CCSS`, `NGSS`, `ELOF`, `MA.1–MA.5`) and internal Balashikshana IDs (`PK-M1`, `G3-E10`, etc.).
3. **Strict Sequential Unit Mastery Gate (Accuracy + Speed):**
   - The curriculum is organized as a **Directed Acyclic Graph (DAG)** of **130 sequential Units of Work** covering **614 Skill Topics** (`docs/us-curriculum-registry.json`).
   - A learner **must never unlock `Unit N+1`** until `Unit N`'s **Stage 4 Boss Gate Assessment** is completed meeting **all five pass conditions**:
     1. **Overall Accuracy Threshold:** $\ge 85\%$ (Pre-K / Reading Passages / Science / Social Studies) or $\ge 90\%$ (K–3 Math & ELA Foundations).
     2. **Per-Topic Minimum Floor:** $\ge 75\%$ accuracy in *every individual Skill Topic* grouped inside the unit (no masking weak sub-skills).
     3. **Median Cognitive Response Speed:** $\text{Median}(t_{\text{cog}}) \le T_{\text{target}}$, where $t_{\text{cog}} = \max(0.5\text{s},\; t_{\text{raw}} - T_{\text{motor}} - t_{\text{audio}})$.
     4. **80th-Percentile Tail Latency Cap:** $P_{80}(t_{\text{cog}}) \le 1.30 \times T_{\text{target}}$ (prevents passing via half instant guesses + half finger-counting stalls).
     5. **Challenge Zone Final Streak & Anti-Guessing:** Final 4–5 items answered consecutively correct with zero rapid-guess errors ($t_{\text{raw}} < 1.2\text{s}$).
4. **Scientific Memory Consolidation & Spaced Repetition (Ages 3–9):**
   - **Intra-Session Expanding Retrieval:** Any missed or newly learned skill topic must be re-queued within the same session at **Lag +2, Lag +5, and Lag +10** items.
   - **Two-Key Sleep Consolidation (`Silver Key -> Gold Key`):** Passing a Unit Gate on Day 1 awards a `SILVER_KEY`. After $\ge 14$ hours (overnight sleep consolidation), a 60-second, 5-item verification check upgrades the unit to a permanent `GOLD_KEY`.
   - **Speed-Weighted Child FSRS:** Grade every response on a 4-point scale (`1: Forgot`, `2: Slow/Finger-Counted`, `3: Fluent`, `4: Automatic`). Slow correct answers ($t_{\text{cog}} > 1.25 \times T_{\text{target}}$) indicate automaticity decay and receive minimal stability growth ($1.20\times$).
   - **Age-Capped Max Review Intervals:** Never schedule review intervals beyond **21 days (Pre-K)**, **30 days (Kindergarten)**, **45 days (Grade 1)**, or **60 days (Grades 2–3)**.
   - **70 / 20 / 10 Interleaved Spiral Mix:** Stage 3 Fluency games and Stage 4 Gates must blend **70% current unit**, **20% contrastive prerequisite units**, and **10% due spaced-review units**.
   - **Concrete -> Pictorial -> Abstract (CPA) Scaffold Fading:** Visual scaffolds must fade across spaced repetitions (`CONCRETE_INTERACTIVE` -> `PICTORIAL_STATIC` -> `PICTORIAL_GHOST_FLASH_1S` -> `PURE_ABSTRACT_SYMBOLIC`).

---

## 2. Repository Map & Single Sources of Truth

```text
balashikshana/
├── AGENTS.md                                 # This agent guide (invariants, schemas & workflows)
├── README.md                                 # Project overview & documentation index
├── GradePrekto3MathCurrGuide.pdf             # Reference Pre-K to Grade 3 Math Curriculum Guide
├── docs/
│   ├── us-curriculum-registry.json           # Canonical DAG of 130 units & 614 skill topics + assets
│   ├── us-curriculum-mapping.md              # Human-readable grade/subject/unit tables
│   ├── games-and-study-materials.md          # 10 parameterized game archetypes & study manipulatives
│   ├── mastery-gate-engine.md                # Mathematical spec for Accuracy + Speed Mastery Gating
│   ├── spaced-repetition-science.md          # Child-calibrated FSRS, Lag +2/+5/+10 & CPA fading spec
│   ├── skill-topic-assets-catalog.md         # Specification for all 9 asset types per skill topic
│   ├── architecture.md                       # Mobile (iOS/Android), offline SQLite & cloud sync spec
│   └── roadmap.md                            # Approved M1–M6 enterprise launch roadmap (binding decisions D1–D11)
└── assets/
    ├── catalogs/                             # Per-grade JSON asset catalogs (pre-k..grade-3)
    ├── sounds/                               # Synthesized WAV audio files & sounds-manifest.json
    ├── images/                               # Vector SVG manipulatives/cards & images-manifest.json
    ├── videos/                               # 60fps vector storyboard timelines & videos-manifest.json
    ├── interactive/                          # Interactive widget configs & interactive-elements-manifest.json
    ├── narration/                            # Age-calibrated SSML scripts & voice-narration-manifest.json
    ├── animations/                           # Rive/Skia state-machine specs & animations-manifest.json
    ├── games/                                # Guided & Fluency game configs & games-manifest.json
    ├── quizzes/                              # Parameterized quizzes + misconception distractors
    └── assessments/                          # Unit Boss Gate quotas, speed targets & FSRS schedules
```

---

## 3. Mandatory 9-Asset Contract for Every Skill Topic

Whenever an agent adds or modifies a Skill Topic in `docs/us-curriculum-registry.json` or `assets/catalogs/`, that topic **must** include all **9 asset blocks**:

1. **`sounds`**: `primarySfx` (`.wav`), `feedbackSounds` (`onInteract`, `onCorrect`, `onGentleRetry`, `onStreakCombo`, `onSpeedTargetBeat`), and `domainAudioCues`.
2. **`images`**: `primaryIllustrationSvg` (`.svg`), `topicFlashcardSvgs` (array of `.svg` cards), and `cpaVisualModes` (`concrete`, `pictorial`, `ghostFlash`).
3. **`videos`**: `videoId`, `title`, `durationSec` (45s–75s by grade), `resolution`, and 3 structured `storyboardScenes` (Hook, Manipulative Walkthrough, Interactive Pause & Predict).
4. **`interactiveElements`**: `widgetId`, `widgetType`, `interactionGesture`, `hapticFeedback`, and 4-stage `cpaFadingSchedule`.
5. **`voiceNarration`**: Age-calibrated `voicePersona`, `speakingRateWpm` (110–150 WPM), `introPromptSsml`, `guidedHintSsml`, `remediationSsml`, and `celebrationPrompts`.
6. **`animations`**: `animationId`, `engine`, and `stateMachineStates` (`idle_breathe`, `touch_pickup_scale`, `snap_target_confirm`, `hint_path_bezier_glow`, `gentle_bounce_back`, `mastery_badge_bloom`).
7. **`games`**: Both `guidedPracticeGame` (Stage 2 untimed explorer) and `fluencySprintGame` (Stage 3 timed automaticity game mapped to one of the 10 core archetypes with `70/20/10` spiral mix).
8. **`quizzes`**: `quizId`, `itemCount` (5), `smartDistractorStrategy`, `intraSessionExpandingLagsOnMiss` (`[2, 5, 10]`), and concrete `sampleQuestions` with `misconceptionTags` and `explanation`.
9. **`assessments`**: `assessmentId`, `unitBossGateQuotaItems`, `minTopicAccuracyFloorPercent` (`75`), `unitOverallMinAccuracyPercent` (`85` or `90`), `maxMedianCognitiveSpeedSec`, `maxTailLatencyP80Sec`, `twoKeySleepConsolidation`, and `spacedRepetitionScheduleDays`.

---

## 4. Engineering & Quality Standards for Agents

- **Scalability & Data-Driven Design:** Never hardcode one-off game screens for individual lessons. All 130 units and 614 skill topics must be rendered by the **10 parameterized game archetypes** and **modular manipulative widgets** consuming `docs/us-curriculum-registry.json`.
- **Offline-First Mobile Performance:**
  - Target **60/120 FPS** on iOS and Android devices.
  - Prefer lightweight vector graphics (**SVG / Rive `< 50 KB`**) and synthesized/compressed audio over heavy raster textures or large video blobs.
  - All curriculum DAG state, mastery telemetry (`raw_time_ms`, `cognitive_time_ms`, `fluency_grade_1_to_4`), and spaced-repetition queues must persist locally in on-device SQLite before background cloud sync.
- **Child Privacy (COPPA Compliance):**
  - Never add third-party behavioral ad SDKs, external analytics trackers, or unauthenticated external links in child-facing views.
  - Always gate parent/settings routes behind the Parental Verification Gate.
- **Testing & Verification Rules:**
  - Do not create test cases unless explicitly prompted by the user.
  - Whenever modifying JSON registries or manifests, validate JSON syntax and verify that zero external brand references exist:
    ```bash
    python3 -c 'import json; json.load(open("docs/us-curriculum-registry.json"))'
    ```
