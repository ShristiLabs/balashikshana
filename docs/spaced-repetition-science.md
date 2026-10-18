# Scientific Memory Consolidation & Spaced Repetition System (Ages 3–9)

Children between **Pre-K and 3rd Grade (ages 3–9)** exhibit a significantly steeper **Ebbinghaus Forgetting Curve** than adolescents or adults. Due to ongoing hippocampal maturation, smaller working-memory capacity (2–4 chunks), and rapid synaptic pruning, young children can master a skill on Tuesday and lose up to **60%–70% of retrieval automaticity by Friday** if it is only practiced in a single blocked session.

To solve this, **Balashikshana** embeds **6 Cognitive Science & Memory Consolidation Mechanisms** directly into the core game loop so repetition feels like rewarding play rather than tedious drilling.

---

## 1. Why Standard Adult Spaced Repetition (SM-2 / Anki) Fails for Kids

| Cognitive Factor | Adults / Teens (Standard SM-2) | Children Ages 3–9 (Balashikshana Engine) |
| :--- | :--- | :--- |
| **Initial Decay Window** | 24–48 hours before steep drop | **20 minutes (intra-session)** and **12–24 hours (overnight sleep)** |
| **Grading Signal** | Self-reported button (*"Hard / Good / Easy"*) | **Automated Dual Telemetry:** `Accuracy (0/1)` + `Cognitive Speed (ms)` |
| **Slow Correct Answers** | Often graded as "Pass" | **Flagged as Procedural Decay:** Counting on fingers (`14s` for `7+5`) means automaticity is lost even though accuracy is 100% |
| **Max Review Interval** | 180–365+ days | **Age-Capped (21 days for Pre-K up to 60 days for Grade 3)** |
| **Review Avalanche Problem** | 100+ flashcards pile up after a missed week | **Fractional Implicit Repetition (FIRe):** Practicing advanced units automatically credits prerequisite units in the DAG |

---

## 2. The 6 Scientific Repetition Pillars in Balashikshana

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ 1. Intra-Session Expanding Retrieval (Landauer & Bjork Micro-Spacing)        │
│    Missed or newly learned skill repeats at Lag +2, Lag +5, and Lag +10      │
├──────────────────────────────────────────────────────────────────────────────┤
│ 2. Overnight Sleep-Consolidation Verification ("Silver Key -> Gold Key")     │
│    Passing a Unit Gate on Day 1 requires a 60-sec 5-item check on Day 2      │
├──────────────────────────────────────────────────────────────────────────────┤
│ 3. Speed-Weighted Half-Life Regression (Child-Calibrated FSRS)               │
│    4-point telemetry grade (Forgot / Slow-Counted / Fluent / Instant)        │
├──────────────────────────────────────────────────────────────────────────────┤
│ 4. Interleaved Spiral Practice (70% Current / 20% Recent / 10% Long-Term)    │
│    Every game mixes current unit items with prerequisite discrimination      │
├──────────────────────────────────────────────────────────────────────────────┤
│ 5. Fractional Implicit Repetition (FIRe) Across the Curriculum DAG           │
│    Practicing 2-Digit Addition implicitly refreshes 1-Digit Addition         │
├──────────────────────────────────────────────────────────────────────────────┤
│ 6. Concrete -> Pictorial -> Abstract (CPA) Scaffold Fading                   │
│    Early reviews show visual models; later reviews test pure symbolic recall │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

### Pillar 1: Intra-Session Expanding Retrieval (Micro-Spacing)
*Scientific Basis: Landauer & Bjork (1978) Expanding Retrieval Practice.*

When a child misses an item or learns a new sub-skill during a 10-minute session, immediate back-to-back repetition only uses **short-term phonological/visuospatial working memory** (which vanishes within 60 seconds).

Instead, Balashikshana uses an **Expanding Lag Queue** within the same session:
1. **Immediate Visual Scaffold (Lag 0):** Show a 10-second interactive manipulative animation explaining *why* (e.g., sliding 2 counters to fill the ten-frame for `8 + 5`).
2. **Retrieval Check 1 (Lag +2 items):** Present an isomorphic problem (`8 + 6`) after 2 intervening questions.
3. **Retrieval Check 2 (Lag +5 items):** Present another variant (`7 + 5`) after 5 intervening questions.
4. **Session Exit Ticket (Lag +10 items):** Present a final unhinted variant before the session summary screen. A sub-skill is only marked "Session Encoded" if Lags `+2`, `+5`, and `+10` are all answered accurately and within target speed.

---

### Pillar 2: Overnight Sleep-Consolidation Gate ("Two-Key Mastery")
*Scientific Basis: Walker & Stickgold (2006) Sleep-Dependent Memory Consolidation in Early Childhood.*

Synaptic consolidation—moving memories from the hippocampus to the neocortex—requires **one full night of sleep**. Children frequently achieve temporary "crammed" fluency during a 15-minute session and forget 40% of it by the next morning.

- **Day 1 — Silver Mastery Key (Immediate Progression):**
  When a child passes `Unit N`'s Boss Gate (meeting both Accuracy and Speed thresholds), they celebrate, earn the **Silver Key**, and unlock `Unit N+1` Stage 1 (Study & Explore) so their momentum is never blocked on the same day.
- **Day 2 (≥ 14 Hours Later) — Gold Mastery Key (Sleep-Consolidated Lock):**
  At the start of their next day's session, the child plays a **60-second, 5-question "Gold Key Verification"** on `Unit N`:
  - **If Passed ($\ge 4/5$ accurate within speed target):** `Unit N` upgrades permanently to a **Gold Mastery Key** and enters the long-term Spaced Repetition schedule.
  - **If Failed:** The engine detects overnight decay before the child gets frustrated in `Unit N+1`, routing them to a 2-minute `Unit N` Fluency Refresher game first.

---

### Pillar 3: Speed-Weighted Memory Half-Life Model (Child-FSRS)
*Scientific Basis: Ebbinghaus Exponential Decay + Settles & Meeder (2016) Half-Life Regression + Bjork Desirable Difficulties.*

For each skill topic $m$ and learner, the engine tracks two continuous variables:
- **Stability ($S_m$, in days):** The time required for retrieval probability to decay from $100\%$ to **$80\%$** (the child's target retention threshold).
- **Retrievability ($R_m(t)$):** The probability of fluent recall after $\Delta t$ days have elapsed since the last review:
  $$R_m(\Delta t) = 0.8^{\left(\frac{\Delta t}{S_m}\right)}$$

When $R_m(\Delta t)$ drops to **$80\%$** ($\Delta t \ge S_m$), topic $m$ becomes **Due for Review**.

#### Automatic 4-Point Fluency Grading (No Self-Reporting)
Children cannot reliably self-grade "Easy" vs. "Hard". Instead, the engine grades each response $i$ using **Accuracy ($A_i$)** and **Cognitive Speed Ratio ($r_i = t_{\text{cog}, i} / T_{\text{target}}$)**:

| Fluency Grade ($G$) | Telemetry Condition | Cognitive Diagnosis | Stability Update ($S_{\text{new}}$) |
| :--- | :--- | :--- | :--- |
| **1 — Forgot** | $A_i = 0$ | Retrieval failure or misconception | Reset stability: $S_{\text{new}} = \max(0.5\text{d},\; 0.25 \times S_{\text{old}})$ + Intra-session Lag `+2, +5, +10` |
| **2 — Effortful / Slow** | $A_i = 1$ AND $r_i > 1.25$ | Remembered concept, but lost automaticity (e.g., finger-counting) | Minimal growth: $S_{\text{new}} = S_{\text{old}} \times 1.20$ |
| **3 — Fluent** | $A_i = 1$ AND $0.75 < r_i \le 1.25$ | Solid recall at grade-level fluency | Standard growth: $S_{\text{new}} = \min(S_{\max},\; S_{\text{old}} \times \gamma_{\text{grade}})$ |
| **4 — Automatic** | $A_i = 1$ AND $r_i \le 0.75$ | Instantaneous long-term memory retrieval | Accelerated growth: $S_{\text{new}} = \min(S_{\max},\; S_{\text{old}} \times (\gamma_{\text{grade}} + 0.35))$ |

#### Age-Calibrated Interval Progression Table
Because younger children forget faster, both the **initial stability ($S_0$)**, **growth multiplier ($\gamma_{\text{grade}}$)**, and **maximum interval cap ($S_{\max}$)** scale strictly by grade:

| Grade Level | Target Age | Growth Factor ($\gamma_{\text{grade}}$) | Typical Fluent Review Schedule ($G=3$) | Maximum Interval Cap ($S_{\max}$) |
| :--- | :--- | :--- | :--- | :--- |
| **Pre-K** | 3–4 yrs | $1.7\times$ | **Same Day (+4h) -> 1d -> 2d -> 4d -> 7d -> 12d -> 21d** | **21 days** (Never >3 weeks unpracticed) |
| **Kindergarten** | 5–6 yrs | $1.85\times$ | **1d -> 2d -> 4d -> 8d -> 15d -> 30d** | **30 days** |
| **Grade 1** | 6–7 yrs | $2.0\times$ | **1d -> 3d -> 6d -> 12d -> 24d -> 45d** | **45 days** |
| **Grade 2** | 7–8 yrs | $2.15\times$ | **1d -> 3d -> 7d -> 15d -> 32d -> 60d** | **60 days** |
| **Grade 3** | 8–9 yrs | $2.25\times$ | **1d -> 3d -> 7d -> 16d -> 36d -> 60d** | **60 days** |

---

### Pillar 4: Interleaved Spiral Practice (`70 / 20 / 10` Rule)
*Scientific Basis: Rohrer & Taylor (2007) Interleaved Practice in Mathematics.*

Blocked practice—solving 20 subtraction problems in a row—allows children to stop reading the operation sign and mechanically repeat the same action. When tested a week later, they confuse addition vs. subtraction or area vs. perimeter.

Every **Stage 3 Fluency Game** and **Stage 4 Unit Gate** in Balashikshana uses a **70 / 20 / 10 Interleaved Spiral Generator**:
- **70% Current Unit (`Unit N`) Topics:** Shuffled so two consecutive questions never test the exact same micro-skill.
- **20% Contrastive Prerequisite Topics (`Unit N-1` & `Unit N-2`):** Deliberately pairs easily confused operations (e.g., mixing `+` and `-` word problems in `G1-M3`, mixing `Area` and `Perimeter` in `G3-M9`, or mixing short `a` and silent-`e` long `a` words in `G1-E3`).
- **10% Due Long-Term Spaced Reviews (`Unit 1 .. N-3`):** Seamlessly weaves 2–3 due review questions into the current arcade game so the child is constantly refreshing older units without realizing they are taking a review test.

---

### Pillar 5: Fractional Implicit Repetition (FIRe) Across the Curriculum DAG
*Scientific Basis: Hierarchical Knowledge Tracing & Fractional Implicit Repetition.*

By Grade 3, a child may have completed 80+ units. If every unit required an independent review every few weeks, the child would spend 100% of their time reviewing Pre-K and Kindergarten skills.

Because our 130 units form a **Directed Acyclic Graph (DAG)** where advanced units encompass foundational ones:
1. **Downward Implicit Credit (Preventing Review Fatigue):**
   When a child fluently completes an exercise in a higher node $U_{\text{child}}$ (e.g., `G2-M3: 2-Digit Addition with Regrouping`), its direct prerequisite nodes $U_{\text{parent}}$ (e.g., `G1-M5: Addition within 20` and `G1-M7: Place Value`) automatically receive **Fractional Implicit Stability Credit ($w = 0.40$)**:
   $$\Delta S_{\text{parent}} = 0.40 \times \Delta S_{\text{child}}$$
   This naturally pushes back the review date of mastered foundational skills that are actively being used inside harder skills.
2. **Downward Root-Cause Regression (When a Child Struggles):**
   If a child fails `G3-M5: Division Fluency`, the engine checks the retrievability $R(t)$ of its prerequisite `G3-M3: Multiplication Fluency`. If multiplication fluency has decayed, the engine automatically schedules a 2-minute Multiplication Blitz before resuming Division.

---

### Pillar 6: Concrete -> Pictorial -> Abstract (CPA) Scaffold Fading
*Scientific Basis: Jerome Bruner's CPA Progression & Pashler et al. (2007) Fading Worked Examples.*

As a skill's stability $S_m$ grows across spaced repetitions, the visual representation automatically transitions from **Concrete** to **Pictorial** to **Abstract** so the child builds mental imagery rather than visual dependency:

| Repetition Stage | Stability ($S_m$) | Representation Mode | Example (`8 + 5 = 13`) |
| :--- | :--- | :--- | :--- |
| **Rep 0 (Initial Study & Guided)** | $S_m < 1\text{d}$ | **Concrete Interactive** | Child physically drags 2 cubes from the `5` stack to complete the `10`-frame (`10 + 3`). |
| **Rep 1 (First Spaced Review, ~Day 1–2)** | $1\text{d} \le S_m < 4\text{d}$ | **Pictorial Static** | Static ten-frame illustration is shown alongside `8 + 5 = ?`. |
| **Rep 2 (Second Spaced Review, ~Day 4–7)** | $4\text{d} \le S_m < 10\text{d}$ | **Pictorial Ghost Flash** | Ten-frame flashes for $1.0\text{s}$ to trigger mental visualization, then fades to `8 + 5 = ?`. |
| **Rep 3+ (Long-Term Mastery, Day 10+)** | $S_m \ge 10\text{d}$ | **Pure Abstract / Symbolic & Word Context** | Pure numeral equation `8 + 5 = ?` or audio word problem with $\le 3.5\text{s}$ speed target. |

---

## 3. Gamified Daily Rituals (Making Repetition Exciting for Kids)

To ensure children *want* to complete their spaced repetitions every day:

1. **The 3-Minute "Morning Brain Boost" (Daily Warm-Up Chest):**
   - Every daily session begins with a 3-minute **Daily Treasure Chest Run** (8–10 questions pulled from the highest-priority due spaced-repetition topics across Math, ELA, Science, and Social Studies).
   - Completing the Daily Brain Boost feeds the child's virtual companion pet and awards a **Streak Shield**.
2. **"Keep Your Knowledge Garden Blooming" (Visual Memory Decay Indicator):**
   - On the World Map, every mastered unit grows a vibrant **Mastery Flower / Crystal Tower**.
   - When a unit's Retrievability $R(t)$ decays below **$80\%$**, the flower gently droops or shimmers with water droplets (*"Water Me!"*).
   - Playing a 90-second **Watering Blitz** (6 rapid review questions on that unit) restores the flower to full bloom, doubles its star coins, and boosts its memory stability $S_m$ to the next interval tier.
3. **Friday "Time-Travel Boss Remix" (Weekly Cumulative Spiral):**
   - Once a week (or every 5th session), a fun **Time-Travel Boss** challenges the child with a 12-question remix drawn exclusively from units mastered 1 to 8 weeks ago.
