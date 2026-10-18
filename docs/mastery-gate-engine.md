# Mastery Gate Engine Specification (Accuracy + Speed Progression)

A core pillar of **Balashikshana** is that **a child cannot advance to `Unit N+1` until `Unit N` is mastered with both high accuracy and age-calibrated fluency speed.**

Whereas traditional practice platforms evaluate only accuracy and streak — allowing a child to pass 1st-grade addition by slowly counting on their fingers for 25 seconds per question — Balashikshana enforces a **Dual-Threshold Mastery Gate**.

---

## 1. Unit Progression State Machine

Each unit $U_k$ in a subject track exists in one of 6 states for a learner profile:

```text
[LOCKED] ──(Prereq Unit Passed)──► [STUDY_REQUIRED]
                                          │
                           (Completes Stage 1 Manipulative)
                                          ▼
                                 [GUIDED_PRACTICE]
                                          │
                        (All Skill Topics in Unit reach ≥ 80)
                                          ▼
                                  [FLUENCY_READY]
                                          │
                           (Completes Stage 3 Fluency Game)
                                          ▼
                                   [GATE_UNLOCKED]
                                    /           \
                    (Gate Passed: Acc + Speed)  (Gate Failed)
                                  /               \
                                 ▼                 ▼
                            [MASTERED]      [REMEDIATION_REQUIRED]
                         (Unlocks Unit k+1)   (Routes to Stage 1, 2, or 3)
```

---

## 2. Mathematical Formulation of the Mastery Gate

Let a Unit $U$ contain $M$ grouped Skill Topics $\{C_1, C_2, \dots, C_M\}$.
When the learner enters the **Stage 4 Unit Boss Gate**, the assessment engine generates $N$ total questions ($N \in [10, 20]$ depending on grade and subject).

### 2.1 Stratified Sub-Skill Sampling
Questions are sampled uniformly across all $M$ Skill Topics in the unit:
$$n_m = \left\lfloor \frac{N}{M} \right\rfloor \quad \text{items from topic } C_m$$
with any remainder distributed to the topics where the learner had the lowest Stage 2/3 practice scores.

### 2.2 Motor-Latency Baseline Calibration ($T_{\text{motor}}$)
Young children (especially Pre-K and Kindergarten) have varying fine-motor tap and drag speeds. At the start of a session, a 3-second "Pop 3 Stars" warm-up measures the child's median physical tap latency:
$$T_{\text{motor}} = \text{Median}(t_{\text{tap}, 1}, t_{\text{tap}, 2}, t_{\text{tap}, 3})$$
For every assessment question $i$, the child's **Cognitive Response Time** ($t_i$) is:
$$t_i = \max\left(0.5\text{s},\; t_{\text{raw}, i} - T_{\text{motor}}\right)$$

### 2.3 The 5 Mandatory Pass Conditions
Let $A_i \in \{0, 1\}$ indicate whether item $i$ was answered correctly, and let $T_{\text{target}}$ and $P_{\text{min}}$ be the unit's configured speed and accuracy thresholds from [`us-curriculum-registry.json`](./us-curriculum-registry.json).

An assessment attempt **PASSES** if and only if **all 5 conditions** hold simultaneously:

1. **Overall Accuracy Threshold:**
   $$\text{Accuracy} = \frac{100}{N} \sum_{i=1}^{N} A_i \ge P_{\text{min}} \quad (\text{typically } 85\% \text{ or } 90\%)$$

2. **Per-Topic Minimum Floor (No Hiding Weak Sub-Skills):**
   For every Skill Topic $C_m \in U$:
   $$\text{Accuracy}(C_m) = \frac{100}{|C_m|} \sum_{i \in C_m} A_i \ge 75\%$$

3. **Median Fluency Speed Threshold (Automaticity):**
   Across all correctly answered items $S_{\text{correct}} = \{t_i \mid A_i = 1\}$:
   $$T_{\text{median}} = \text{Median}(S_{\text{correct}}) \le T_{\text{target}}$$

4. **80th-Percentile Tail Latency Cap (Anti-Stalling):**
   Prevents a child from answering half the items in $1\text{s}$ and stalling for $30\text{s}$ finger-counting on the harder half:
   $$P_{80}(S_{\text{correct}}) \le 1.30 \times T_{\text{target}}$$

5. **Challenge Zone Final Streak & Anti-Guessing:**
   - The final $K$ items ($K = 4$ or $5$) must be answered **consecutively correct** ($\sum_{i=N-K+1}^{N} A_i = K$).
   - Zero rapid-guess errors ($A_i = 0$ with $t_{\text{raw}, i} < 1.2\text{s}$).

---

## 3. Age-Calibrated Gate Benchmarks by Grade & Task Type

| Grade | Mental Recall / Phonics / Sight Words | Conceptual / 1-Step Operations | Multi-Digit Regrouping / 2-Step / Reading Passages | Min Accuracy |
| :--- | :--- | :--- | :--- | :--- |
| **Pre-K** | $\le 4.5\text{s} - 5.5\text{s}$ | $\le 6.0\text{s} - 6.5\text{s}$ | $\le 8.0\text{s}$ (Visual story inference) | **85% – 90%** |
| **Kindergarten** | $\le 3.5\text{s} - 4.5\text{s}$ | $\le 5.0\text{s} - 5.5\text{s}$ | $\le 10.0\text{s} - 12.0\text{s}$ (Decodable passages) | **85% – 90%** |
| **Grade 1** | $\le 3.5\text{s} - 4.5\text{s}$ | $\le 5.0\text{s} - 6.5\text{s}$ | $\le 12.0\text{s} - 14.0\text{s}$ (Passages & WP) | **85% – 90%** |
| **Grade 2** | $\le 3.0\text{s} - 4.5\text{s}$ | $\le 6.0\text{s} - 8.0\text{s}$ | $\le 10.0\text{s} - 15.0\text{s}$ (2/3-digit regrouping & passages) | **85% – 90%** |
| **Grade 3** | $\le 3.0\text{s} - 3.5\text{s}$ (Tables 0–12) | $\le 6.5\text{s} - 9.0\text{s}$ | $\le 12.0\text{s} - 16.0\text{s}$ (Multi-step WP & passages) | **85% – 90%** |

---

## 4. Diagnostic Remediation Router (When a Gate Attempt Fails)

When a child does not pass the Stage 4 Gate, the engine diagnoses the failure mode from the $(Accuracy, T_{\text{median}})$ telemetry vector and prescribes a targeted 5-minute remediation activity before re-unlocking the Gate:

| Failure Mode | Telemetry Signature | Root Cause Diagnosis | Prescribed Remediation Path |
| :--- | :--- | :--- | :--- |
| **Mode 1: Conceptual Gap** | $\text{Acc} < P_{\text{min}}$ AND $T_{\text{median}} > T_{\text{target}}$ | Child does not yet understand the underlying rule or representation. | Routes back to **Stage 1 Interactive Manipulative** + **5 Guided Practice items** specifically for the failed Skill Topic $C_m$. |
| **Mode 2: Impulsive Rushing** | $\text{Acc} < P_{\text{min}}$ AND $T_{\text{median}} < 0.5 \times T_{\text{target}}$ (or rapid-guess errors) | Child is tapping impulsively without reading/listening carefully. | Enables **"Think-First Turtle" Mode** in Stage 2: choices appear $1.5\text{s}$ after the question prompt and audio finish playing. |
| **Mode 3: Low Automaticity** | $\text{Acc} \ge P_{\text{min}}$ AND $T_{\text{median}} > T_{\text{target}}$ | Child understands the concept (100% accurate) but relies on slow counting/decoding. | Skips Stage 1/2 and unlocks **Stage 3 Fluency Zone Sprint** (`bubble-pop-blitz`) with a progressive speed pacemaker. |
| **Mode 4: Single Sub-Skill Blindspot** | Overall $\text{Acc} \ge P_{\text{min}}$ AND Speed OK, but one topic $\text{Acc}(C_m) < 75\%$ | Child mastered 4 of 5 topics in the unit but missed one specific topic. | Runs a **6-question Micro-Boost** focused 100% on topic $C_m$, then immediately re-opens the Gate. |

---

## 5. Scientific Memory Consolidation & Spaced Repetition

Passing a Unit Gate on Day 1 awards a **Silver Mastery Key**, which upgrades to a permanent **Gold Mastery Key** after a 60-second **Next-Day Sleep-Consolidation Check** ($\ge 14$ hours later):
- **Intra-Session Expanding Retrieval:** Missed or newly introduced skills repeat within the same session at **Lag +2, Lag +5, and Lag +10** items.
- **Speed-Weighted Child FSRS (Half-Life Regression):** Each topic tracks continuous memory stability $S_m$ and retrievability $R_m(\Delta t) = 0.8^{\Delta t / S_m}$, graded on a 4-point telemetry scale (`1: Forgot`, `2: Slow/Finger-Counted`, `3: Fluent`, `4: Automatic`) with age-calibrated maximum interval caps (**21d** in Pre-K, **30d** in K, **45d** in G1, **60d** in G2–G3).
- **70 / 20 / 10 Interleaved Spiral Mix:** Stage 3 & 4 sessions weave **70% current unit**, **20% contrastive prerequisite units**, and **10% due spaced-review units**.
- **Fractional Implicit Repetition (FIRe):** Practicing advanced units in the DAG automatically grants $0.40\times$ stability credit to direct prerequisite units.
- **Concrete -> Pictorial -> Abstract (CPA) Scaffold Fading:** Visual aids gradually fade across repetitions until the child demonstrates pure symbolic recall.

For the complete cognitive science and mathematical specification, see **[`docs/spaced-repetition-science.md`](./spaced-repetition-science.md)**.
