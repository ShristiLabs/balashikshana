# Skill Topic Assets Catalog & Specification (All 614 Skill Topics)

Every single one of the **614 Skill Topics** across all **130 Units** (Pre-K to Grade 3: Math, ELA, Science, and Social Studies) is equipped with **9 complete asset categories** in [`docs/us-curriculum-registry.json`](./us-curriculum-registry.json), per-grade catalogs in `assets/catalogs/`, and category-specific manifests in `assets/`.

---

## 1. Directory & Manifest Map

| Asset Category | Manifest / Directory Path | Contents Across All 614 Skill Topics |
| :--- | :--- | :--- |
| **Per-Grade Full Catalogs** | `assets/catalogs/<gradeId>-skill-topic-assets.json` | Complete 9-category asset bundles split by `pre-k`, `kindergarten`, `grade-1`, `grade-2`, and `grade-3` |
| **1. Sounds** | `assets/sounds/sounds-manifest.json` + `assets/sounds/*.wav` | **16 synthesized `.wav` sound files** + 614 topic sound packs (`primarySfx`, `onInteract`, `onCorrect`, `onGentleRetry`, `onStreakCombo`, `onSpeedTargetBeat`, and domain audio cues) |
| **2. Images** | `assets/images/images-manifest.json` + `assets/images/*.svg` | **12 master `.svg` vector illustrations** + 614 topic flashcard packs with Concrete, Pictorial, and 1.0s Ghost-Flash CPA layers |
| **3. Videos** | `assets/videos/videos-manifest.json` | **614 animated micro-lesson video specs** (45s–75s by grade, 60 FPS vector storyboards with 3 scenes: Real-World Hook, Manipulative Walkthrough, and Interactive Pause & Predict) |
| **4. Interactive Elements** | `assets/interactive/interactive-elements-manifest.json` | **614 manipulative widget bindings** (`widgetType`, gesture mechanics, haptic feedback, and 4-stage CPA scaffold fading schedule) |
| **5. Voice Narration** | `assets/narration/voice-narration-manifest.json` | **614 SSML voice narration scripts** with age-calibrated voice personas (110 WPM in Pre-K up to 150 WPM in Grade 3) covering intro prompts, guided hints, remediation, and praise |
| **6. Animations** | `assets/animations/animations-manifest.json` | **614 Rive/Skia 60–120 FPS state machines** (`idle_breathe`, `touch_pickup_scale`, `snap_target_confirm`, `hint_path_bezier_glow`, `gentle_bounce_back`, `mastery_badge_bloom`) |
| **7. Games** | `assets/games/games-manifest.json` | **1,228 game bindings** (614 Stage 2 Untimed Guided Practice games + 614 Stage 3 Timed Fluency Sprint games with `70/20/10` spiral interleaving) |
| **8. Quizzes** | `assets/quizzes/quizzes-manifest.json` | **614 formative quizzes** (5 items per quiz, smart misconception distractor generators, `Lag +2/+5/+10` expanding retrieval, and concrete sample items with explanations) |
| **9. Assessments** | `assets/assessments/assessments-manifest.json` | **614 summative Mastery Gate configurations** (unit gate quotas, 75% per-topic floor, 85%–90% unit accuracy, cognitive speed limit, P80 tail latency cap, Two-Key Sleep Consolidation, and FSRS schedule) |

---

## 2. Physical Media Assets Included in Repository

### 2.1 Synthesized Audio Files (`assets/sounds/*.wav`)
- `sfx_chime_correct.wav` — Rising major triad chime on accurate response
- `sfx_gentle_nudge.wav` — Warm low-stress two-tone cue on error/hint
- `sfx_star_fanfare.wav` — 4-note arpeggio fanfare for Challenge Zone streaks & mastery keys
- `sfx_pacemaker_pulse.wav` — Subtle rhythmic pulse for Stage 3 Fluency Zone speed pacing
- `sfx_count_pop.wav` — Tactile bubble pop for 1-to-1 counting and subitizing
- `sfx_block_snap.wav` — Magnetic snap for Ten-Frames and Base-10 Regrouping blocks
- `sfx_coin_clink.wav` — Metallic clink for US Penny, Nickel, Dime, and Quarter interactions
- `sfx_clock_tick.wav` — Geared analog clock hand tick
- `sfx_slice_whoosh.wav` — Equal-shares and fraction bar partition slice
- `sfx_tile_snap.wav` — Unit-square tiling and geoboard vertex lock
- `sfx_laser_zap.wav` — Multiplication/division fluency meteor defense zap
- `sfx_phoneme_slide.wav` — Continuous phoneme blending slider tone
- `sfx_bridge_lock.wav` — Grammar clause connector and timeline sequence lock
- `sfx_page_turn.wav` — Story Detective passage highlight and page turn
- `sfx_science_bubble.wav` — Virtual science lab phase-change and experiment cue
- `sfx_compass_chime.wav` — Map grid and 50 US states discovery chime

### 2.2 Vector Illustrations (`assets/images/*.svg`)
- `ten_frame_and_number_line.svg` — Interactive 10-Frame + Bidirectional Number Line
- `base_ten_place_value_blocks.svg` — 100-Flats, 10-Rods, and Unit Cubes
- `us_coins_and_bills.svg` — Penny (1¢), Nickel (5¢), Dime (10¢), Quarter (25¢) & $1 Bill
- `geared_judy_clock.svg` — Linked Hour and Minute Hand Analog Clock
- `fraction_bars_and_circles.svg` — Synchronized Fraction Strips (`1 Whole`, `1/2`, `2/4`, `4/8`)
- `geometry_shapes_and_grid.svg` — 2D Polygons, Quadrilaterals & Unit-Square Area Grid
- `multiplication_array_slicer.svg` — Distributive Property Array Slicer (`4 × (5 + 2)`)
- `elkonin_phoneme_sound_boxes.svg` — 3-Sound Elkonin Boxes & Continuous Blending Slider
- `grammar_sentence_architect.svg` — Prefix, Root & Suffix Morphology Blocks
- `interactive_story_detective.svg` — Highlighted Text Evidence & Inference Reader
- `science_virtual_lab_bench.svg` — Solid, Liquid, and Gas Phase Change Lab
- `us_geography_and_civics_map.svg` — Compass Rose & 50 US States Map Grid
