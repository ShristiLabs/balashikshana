# US Curriculum & Skill-Topic-to-Unit Mapping (Pre-K to Grade 3)

This document defines the curriculum structure for **Balashikshana**, aligned with **US Common Core State Standards (CCSS)**, **Preschool/Head Start Early Learning Guidelines (`MA.1–MA.5` / NAEYC / ELOF)**, **Next Generation Science Standards (NGSS)**, and **C3 Social Studies Standards**.

The machine-readable registry containing all **130 sequential units** and **614 skill-topic mappings** is located in [`docs/us-curriculum-registry.json`](./us-curriculum-registry.json).

---

## 1. Curriculum Aggregation Philosophy

The Pre-K through 3rd Grade US curriculum spans **614 granular skill topics** (~3,000 individual micro-skills). In a game-based mastery environment for young children (ages 3–9), gating every single micro-topic individually causes assessment fatigue, while grouping an entire grade into a single exam hides sub-skill weaknesses.

**Balashikshana groups 3 to 9 closely related Skill Topics into a single "Unit of Work":**
- **130 Total Units** across Pre-K, Kindergarten, Grade 1, Grade 2, and Grade 3.
- **Strict Sequential Progression (DAG):** Within each subject track (`Math`, `ELA`, `Science`, `Social Studies`), `Unit N+1` remains locked until `Unit N`'s **Mastery Gate Assessment** is completed at or above the required **Accuracy (%)** and **Speed (Max Median Seconds/Item)** thresholds.
- **Stratified Sub-Skill Coverage:** Every Skill Topic inside a unit is treated as a mandatory sub-skill bucket during the Unit Gate Assessment.

| Grade Level | Math (Topics -> Units) | ELA (Topics -> Units) | Science (Topics -> Units) | Social Studies (Topics -> Units) | Total Grade Units |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Pre-K** | `A–AA` (27) -> **7 Units** | `A–CC` (29) -> **7 Units** | *(Integrated in Math/ELA)* | *(Integrated in Math/ELA)* | **14 Units** |
| **Kindergarten** | `A–EEE` (57) -> **10 Units** | `A–WW` (49) -> **9 Units** | `A–O` (15) -> **5 Units** | `A–L` (12) -> **4 Units** | **28 Units** |
| **Grade 1** | `A–TTT` (46) -> **9 Units** | `A–EEE` (57) -> **10 Units** | `A–P` (16) -> **5 Units** | `A–L` (12) -> **4 Units** | **28 Units** |
| **Grade 2** | `A–SSS` (45) -> **9 Units** | `A–LLL` (63) -> **10 Units** | `A–W` (23) -> **6 Units** | `A–J` (10) -> **4 Units** | **29 Units** |
| **Grade 3** | `A–GGG` (59) -> **10 Units** | `A–DDD` (56) -> **10 Units** | `A–Y` (25) -> **6 Units** | `A–M` (13) -> **5 Units** | **31 Units** |
| **Total** | **234 Topics -> 45 Units** | **254 Topics -> 46 Units** | **79 Topics -> 22 Units** | **47 Topics -> 17 Units** | **614 Topics -> 130 Units** |

---

## 2. Pre-K Curriculum Mapping

### 2.1 Pre-K Mathematics (`27 Skill Topics: A–AA` -> `7 Units`)
*Standards: Preschool `MA.1–MA.5`, NAEYC, and Head Start ELOF*

| Unit ID | Unit Name | Prerequisite | Skill Topics Included | Gate Accuracy | Gate Max Speed |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **PK-M1** | **Numbers & Counting up to 5** | None | `A` Numbers to 3 • `B` Counting to 3 • `C` Numbers to 5 • `D` Counting to 5 (includes ordinals to 5th) • `AA` Daily calendar routines, seasonal counting sets (apples on tree, buttons on snowman), number puzzles & syllable-clap counting (`MA.1–MA.4`) | **≥ 85%** (11/12) | **≤ 5.5s / item** |
| **PK-M2** | **Numbers & Counting 6 to 10** | `PK-M1` | `E` Numbers and counting to 7 • `F` Numbers and counting to 9 • `G` Numbers to 10 • `H` Counting to 10 (ten frames, rings, scattered shapes, ordinals to 10th) | **≥ 85%** (11/12) | **≤ 6.0s / item** |
| **PK-M3** | **One More/Less & Comparing** | `PK-M2` | `I` One more and one less (up to 5 & 10) • `K` Compare groups (more, fewer, same, enough) • `L` Compare numbers (larger/largest, smaller/smallest) | **≥ 85%** (11/12) | **≤ 5.5s / item** |
| **PK-M4** | **Counting to 20 & Patterns** | `PK-M3` | `J` Numbers and counting to 20 (ten frames, count up) • `M` Patterns (color, size, shape, what comes next) | **≥ 85%** (11/12) | **≤ 6.5s / item** |
| **PK-M5** | **Positions, Classification, Size & Data Graphing** | `PK-M4` | `N` Positions (inside/outside, left/right, top/middle/bottom) • `O` Classify (same/different, sort by color/shape/size) • `T` Size (long/short, tall/short, wide/narrow, light/heavy, capacity) • `Z` Opinion polls, weather graphing, object bar graphs & correcting more/fewer group spots (`MA.5`) | **≥ 85%** (11/12) | **≤ 6.0s / item** |
| **PK-M6** | **2D/3D Shapes & US Coins Intro** | `PK-M5` | `P` Flat shapes (circles, triangles, squares, rectangles, hexagons) • `Q` Describe flat shapes (sides & corners) • `R` Solid shapes (spheres, cubes, cones, cylinders) • `S` Shapes in the real world • `U` Money (pennies, nickels, dimes, quarters) | **≥ 85%** (11/12) | **≤ 6.0s / item** |
| **PK-M7** | **Beginning Addition & Subtraction** | `PK-M6` | `V` Addition up to 5 • `W` Addition up to 10 • `X` Subtraction up to 5 • `Y` Subtraction up to 10 | **≥ 85%** (12/14) | **≤ 6.5s / item** |

### 2.2 Pre-K Language Arts (`29 Skill Topics: A–CC` -> `7 Units`)

| Unit ID | Unit Name | Prerequisite | Skill Topics Included | Gate Accuracy | Gate Max Speed |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **PK-E1** | **Learn Letters A–P** | None | `A` Learn letters: A–H • `B` Learn letters: I–P | **≥ 90%** (13/14) | **≤ 4.5s / item** |
| **PK-E2** | **Learn Letters Q–Z & Case Matching** | `PK-E1` | `C` Learn letters: Q–Z • `D` Letter identification (uppercase, lowercase, confused letters) • `E` Lowercase and uppercase letters | **≥ 90%** (14/15) | **≤ 4.5s / item** |
| **PK-E3** | **Word Recognition, Book Features, Rhyming & Syllables** | `PK-E2` | `F` Word recognition (word spacing, matching words) • `G` Rhyming • `H` Syllables • `T` Book features | **≥ 85%** (11/12) | **≤ 6.0s / item** |
| **PK-E4** | **Phoneme Blending & Consonant Letter-Sounds** | `PK-E3` | `I` Phoneme blending and segmenting • `J` Beginning and ending sounds • `K` Letter-sound associations: uppercase • `L` Letter-sound associations: lowercase | **≥ 90%** (14/15) | **≤ 5.0s / item** |
| **PK-E5** | **Short Vowels (`a, e, i, o, u`) & Sight Words** | `PK-E4` | `M` Vowel sounds • `N` Short a • `O` Short e • `P` Short i • `Q` Short o • `R` Short u • `S` High-frequency and irregular words | **≥ 90%** (14/15) | **≤ 5.5s / item** |
| **PK-E6** | **Vocabulary: Nouns, Verbs, Adjectives, Opposites & Categories** | `PK-E5` | `W` Color and number words • `X` Nouns • `Y` Verbs • `Z` Adjectives • `AA` Location words • `BB` Antonyms • `CC` Categories | **≥ 85%** (11/12) | **≤ 6.0s / item** |
| **PK-E7** | **Comprehension: Reality vs. Fiction & Visual Inference** | `PK-E6` | `U` Reality vs. fiction • `V` Inference and analysis | **≥ 85%** (9/10) | **≤ 8.0s / item** |

---

## 3. Kindergarten Curriculum Mapping

### 3.1 Kindergarten Mathematics (`57 Skill Topics: A–EEE` -> `10 Units`)
*Standards: `K.CC.1–7`, `K.OA.1–5`, `K.NBT.1`, `K.MD.1–3`, `K.G.1–6`*

| Unit ID | Unit Name | Prerequisite | Skill Topics Included | Gate Accuracy | Gate Max Speed |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **K-M1** | **Numbers, Counting, Writing Numerals & Comparing to 5** | `PK-M7` | `A` Numbers to 3 • `B` Counting to 3 • `C` Numbers to 5 • `D` Counting to 5 • `E` One more and one less to 5 • `F` Comparing up to 5 • `AAA` Write numerals 0–20 with `0` representing a count of no objects (`K.CC.3`) | **≥ 90%** | **≤ 4.5s / item** |
| **K-M2** | **Numbers, Cardinality, Counting Forward/Back & Comparing to 10** | `K-M1` | `G` Counting to 7 • `H` Counting to 9 • `I` Numbers to 10 • `J` Counting to 10 • `K` One more/less to 10 • `L` Counting forward and back to 10 • `M` Comparing up to 10 • `BBB` Cardinality conservation across arrangements, `+1` successive quantity growth & counting forward from any given number (`K.CC.2, K.CC.4b-c`) | **≥ 90%** | **≤ 4.5s / item** |
| **K-M3** | **Addition, Decomposing & Word Problems to 5** | `K-M2` | `N` Understand addition up to 5 • `O` Addition up to 5 • `P` Take apart numbers up to 5 • `Q` Addition word problems up to 5 | **≥ 90%** | **≤ 4.0s / item** |
| **K-M4** | **Addition, Making 10 & Word Problems to 10** | `K-M3` | `R` Understand addition up to 10 • `S` Addition up to 10 • `T` Take apart numbers up to 10 • `U` Addition word problems up to 10 • `CCC` Represent addition/subtraction with objects, fingers, sounds/claps, drawings & acting out (`K.OA.1`) | **≥ 90%** | **≤ 5.0s / item** |
| **K-M5** | **Subtraction & Word Problems to 5 and 10** | `K-M4` | `V` Understand subtraction to 5 • `W` Subtraction to 5 • `X` Subtraction WP to 5 • `Y` Understand subtraction to 10 • `Z` Subtraction to 10 • `AA` Subtraction WP to 10 | **≥ 90%** | **≤ 5.0s / item** |
| **K-M6** | **Mixed Addition & Subtraction Operations** | `K-M5` | `BB` Mixed operations • `CC` Mixed operation word problems | **≥ 90%** | **≤ 5.0s / item** |
| **K-M7** | **Numbers to 20, Comparing & Teen Numbers (`10 + n`)** | `K-M6` | `DD` Numbers to 20 • `EE` Counting to 20 (lines, arrays, circles, scattered) • `FF` One more/less to 20 • `GG` Counting forward/back to 20 • `HH` Comparing up to 20 • `II` Teen numbers (`10 ones + further ones`, `K.NBT.1`) | **≥ 90%** | **≤ 5.0s / item** |
| **K-M8** | **Counting to 30 & 100, Counting by Tens & Patterns** | `K-M7` | `JJ` Numbers and counting to 30 • `KK` Counting by tens • `LL` Numbers and counting to 100 (`K.CC.1`) • `MM` Patterns | **≥ 90%** | **≤ 5.0s / item** |
| **K-M9** | **Positions, 2D & 3D Shapes, Modeling & Fractions of Shapes** | `K-M8` | `NN` Positions • `OO` Same and different • `PP` Two-dimensional shapes • `QQ` 2D shape attributes • `RR` Three-dimensional shapes • `SS` Shapes in the real world • `TT` Fractions of shapes • `DDD` Identify shapes across orientations/sizes & build/model 2D/3D shapes from sticks, clay balls, and components (`K.G.2, K.G.5-6`) | **≥ 90%** | **≤ 5.0s / item** |
| **K-M10** | **Sorting by Count, Data Graphs, Multi-Attribute Measurement, Time & Money** | `K-M9` | `UU` Classifying and sorting • `VV` Data and graphs • `WW` Measurement • `XX` Time • `YY` Money • `ZZ` Financial literacy • `EEE` Describe multiple measurable attributes of a single object (length & weight) and sort categories by count (`K.MD.1–3`) | **≥ 90%** | **≤ 5.5s / item** |

### 3.2 Kindergarten Language Arts (`49 Skill Topics: A–WW` -> `9 Units`)

| Unit ID | Unit Name | Prerequisite | Skill Topics Included | Gate Accuracy | Gate Max Speed |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **K-E1** | **Alphabet Mastery, ABC Order & Consonants/Vowels** | `PK-E7` | `A` Learn letters A–H • `B` Learn letters I–P • `C` Learn letters Q–Z • `D` Letter identification • `E` Lowercase and uppercase letters • `F` Word recognition • `G` Consonants and vowels | **≥ 90%** | **≤ 4.0s / item** |
| **K-E2** | **Rhyming, Syllables, Blending & Phoneme Manipulation** | `K-E1` | `H` Rhyming • `I` Syllables • `J` Phoneme blending and segmenting • `K` Phoneme manipulation | **≥ 90%** | **≤ 5.0s / item** |
| **K-E3** | **Consonant Sounds & Short Vowels (`a, e, i, o, u`)** | `K-E2` | `L` Beginning and ending sounds • `M` Letter-sound associations • `N` Short vowel sounds • `O` Short a • `P` Short e • `Q` Short i • `R` Short o • `S` Short u • `T` Short vowels: mixed | **≥ 90%** | **≤ 4.5s / word** |
| **K-E4** | **Consonant Digraphs, Blends & Long Vowels** | `K-E3` | `U` Consonant digraphs • `V` Consonant blends • `W` Long vowel sounds | **≥ 90%** | **≤ 5.0s / word** |
| **K-E5** | **Kindergarten Sight Words & Decodable Texts** | `K-E4` | `X` High-frequency and irregular words • `Y` Decodable texts | **≥ 90%** | **≤ 4.0s / item** |
| **K-E6** | **Reading Strategies: Main Idea, Character, Plot & Point of View** | `K-E5` | `Z` Book features • `AA` Reality vs. fiction • `BB` Main idea • `CC` Inference and theme • `DD` Author's purpose • `EE` Setting and character • `FF` Sequence and plot • `GG` Point of view • `HH` Text features | **≥ 85%** | **≤ 10.0s / item** |
| **K-E7** | **Read-Along & Read-Alone Literary and Informational Texts** | `K-E6` | `II` Read-along literary texts • `JJ` Read-alone literary texts • `KK` Read-along informational texts • `LL` Read-alone informational texts | **≥ 85%** | **≤ 12.0s / item** |
| **K-E8** | **Vocabulary: Question Words, Synonyms/Antonyms & Homonyms** | `K-E7` | `MM` Color and number words • `NN` Adjectives and verbs • `OO` Location words • `PP` Question words • `QQ` Synonyms and antonyms • `RR` Categories • `SS` Multiple-meaning words | **≥ 90%** | **≤ 5.5s / item** |
| **K-E9** | **Grammar & Mechanics: Sentences, Capitalization, Nouns & Verbs** | `K-E8` | `TT` Sentences • `UU` Capitalization • `VV` Nouns • `WW` Verbs | **≥ 90%** | **≤ 5.5s / item** |

### 3.3 Kindergarten Science (`15 Topics: A–O` -> `5 Units`) & Social Studies (`12 Topics: A–L` -> `4 Units`)
- **Science Units (`K-S1` to `K-S5`):**
  - `K-S1`: **Shapes, Materials, Comparing & States of Matter** (`A, B, C, D`) — Acc ≥ 85%, Speed ≤ 6.0s
  - `K-S2`: **Light, Sound, Force/Motion, Magnets & Engineering** (`E, F, O`) — Acc ≥ 85%, Speed ≤ 6.0s
  - `K-S3`: **Animals, Plants, Living Things & Ecosystems** (`G, H, I, J`) — Acc ≥ 85%, Speed ≤ 6.0s
  - `K-S4`: **Earth's Resources & Human Impacts (Reduce/Reuse/Recycle)** (`K, L`) — Acc ≥ 85%, Speed ≤ 6.0s
  - `K-S5`: **Weather, Severe Weather & Day/Night Sky Astronomy** (`M, N`) — Acc ≥ 85%, Speed ≤ 6.0s
- **Social Studies Units (`K-SS1` to `K-SS4`):**
  - `K-SS1`: **Community Helpers, Civics & American Symbols/Landmarks** (`A, B, C`) — Acc ≥ 85%, Speed ≤ 6.0s
  - `K-SS2`: **Physical Geography, Location Words & Community Maps** (`D, E, F`) — Acc ≥ 85%, Speed ≤ 6.0s
  - `K-SS3`: **Economics: Needs/Wants, Scarcity, Goods/Services & Money** (`G`) — Acc ≥ 85%, Speed ≤ 6.0s
  - `K-SS4`: **Then & Now, 22 Famous Americans, 14 Holidays, Sources & Timelines** (`H, I, J, K, L`) — Acc ≥ 85%, Speed ≤ 7.0s

---

## 4. Grade 1 Curriculum Mapping

### 4.1 Grade 1 Mathematics (`46 Skill Topics: A–TTT` -> `9 Units`)
*Standards: `1.OA.1–8`, `1.NBT.1–6`, `1.MD.1–4`, `1.G.1–3`*

| Unit ID | Unit Name | Prerequisite | Skill Topics Included | Gate Accuracy | Gate Max Speed |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **G1-M1** | **Counting to 120, Skip-Counting (2s, 5s, 10s) & Comparing** | `K-M10` | `A` Counting to 100 • `B` Counting to 120 (starting at any number, number scrolls, $10\times 10$ grids, `1.NBT.1`) • `C` Skip-counting • `D` Comparing up to 10 | **≥ 90%** | **≤ 4.5s / item** |
| **G1-M2** | **Understand Addition, Properties, Facts & Word Problems to 10** | `G1-M1` | `E` Understand addition • `F` Addition strategies up to 10 (Commutative/Associative properties, `1.OA.3`) • `G` Addition up to 10 (`1.OA.6`) • `H` Addition word problems up to 10 | **≥ 90%** | **≤ 4.0s / item** |
| **G1-M3** | **Understand Subtraction, Unknown-Addend Strategy & Facts to 10** | `G1-M2` | `I` Understand subtraction • `J` Subtraction strategies up to 10 • `K` Subtraction up to 10 • `L` Subtraction word problems up to 10 • `PPP` Understand subtraction as an unknown-addend problem (`10 - 8` via `8 + ? = 10`, `1.OA.4`) | **≥ 90%** | **≤ 4.0s / item** |
| **G1-M4** | **Mixed Addition/Subtraction & Comparison Word Problems to 10** | `G1-M3` | `M` Addition and subtraction up to 10 • `N` Comparison word problems up to 10 • `O` Addition and subtraction word problems up to 10 | **≥ 90%** | **≤ 5.0s / item** |
| **G1-M5** | **Addition Strategies (Doubles/Make-10), 3-Addends & Facts to 20** | `G1-M4` | `P` Addition strategies up to 20 (`8 + 6 = 8 + 2 + 4 = 10 + 4 = 14`) • `Q` Addition up to 20 (including 3 whole numbers, `1.OA.2`) • `R` Addition word problems up to 20 | **≥ 90%** | **≤ 4.5s / item** |
| **G1-M6** | **Subtraction (Decompose-to-10), Mixed to 20 & True/False Equations** | `G1-M5` | `S` Subtraction strategies to 20 • `T` Subtraction to 20 • `U` Subtraction WP to 20 • `V` Add & sub to 20 • `W` Comparison WP to 20 • `X` Add & sub WP to 20 • `Y` True or false equations (`1.OA.7`) • `Z` Complete the equation (`1.OA.8`) • `QQQ` Decompose leading to a ten (`13 - 4 = 13 - 3 - 1 = 9`) & word problems with unknowns in all positions (`1.OA.1, 1.OA.6`) | **≥ 90%** | **≤ 5.0s / item** |
| **G1-M7** | **Place Value (Tens & Ones), Mental +/- 10 & Two-Digit Addition** | `G1-M6` | `AA` Place value (`10` as a bundle of ten ones, `1.NBT.2`) • `BB` Comparing up to 100 (`>`, `=`, `<`, `1.NBT.3`) • `CC` Addition and subtraction: multiples of ten (`1.NBT.6`) • `DD` Addition: two digits (`1.NBT.4`) • `RRR` Mentally find 10 more or 10 less than any two-digit number without counting (`1.NBT.5`) | **≥ 90%** | **≤ 6.5s / item** |
| **G1-M8** | **Indirect & Iterated Measurement, Time, Calendar, Money & Graphs** | `G1-M7` | `EE` Measurement • `FF` Time (hours & half-hours, `1.MD.3`) • `GG` Days, months, and seasons • `HH` Money • `II` Data and graphs (up to 3 categories, `1.MD.4`) • `OO` Financial literacy • `SSS` Order 3 objects by length, compare indirectly via a third object & iterate length units end-to-end with no gaps/overlaps (`1.MD.1–2`) | **≥ 90%** | **≤ 6.0s / item** |
| **G1-M9** | **Defining Shape Attributes, Composite 2D/3D Shapes, Venn Diagrams & Equal Shares** | `G1-M8` | `JJ` Patterns • `KK` Two-dimensional shapes • `LL` Three-dimensional shapes • `MM` Venn diagrams • `NN` Fractions • `TTT` Defining vs. non-defining attributes, compose 2D/3D shapes (trapezoids, half/quarter-circles, rectangular prisms, cones, cylinders) & understand decomposing into more equal shares creates smaller shares (`1.G.1–3`) | **≥ 90%** | **≤ 5.5s / item** |

### 4.2 Grade 1 Language Arts (`57 Skill Topics: A–EEE` -> `10 Units`)

| Unit ID | Unit Name | Prerequisite | Skill Topics Included | Gate Accuracy | Gate Max Speed |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **G1-E1** | **Phoneme Manipulation & Short Vowels (`a, e, i, o, u`)** | `K-E9` | `A` Consonants and vowels • `B` Rhyming • `C` Syllables • `D` Phoneme blending and segmenting • `E` Phoneme manipulation • `F` Consonant sounds and letters • `H` Short a • `I` Short e • `J` Short i • `K` Short o • `L` Short u • `M` Short vowels: mixed | **≥ 90%** | **≤ 4.5s / word** |
| **G1-E2** | **Consonant Digraphs, Double Endings & Consonant Blends** | `G1-E1` | `G` Consonant digraphs • `N` Consonant digraphs and blends (`ch, sh, th, wh, -ss, -ll, -ff, -zz, -ck, ng, nk`, initial/final blends) | **≥ 90%** | **≤ 4.5s / word** |
| **G1-E3** | **Silent-e, Vowel Teams & Long Vowel Patterns** | `G1-E2` | `O` Short and long vowel sounds • `P` Silent e • `Q` Vowel teams • `R` Long vowel patterns • `S` Short and long vowel patterns | **≥ 90%** | **≤ 4.5s / word** |
| **G1-E4** | **R-Controlled Vowels, Diphthongs (`oi, oy, ou, ow`) & 2-Syllable Words** | `G1-E3` | `T` R-controlled vowels • `U` Diphthongs: oi, oy, ou, ow • `V` Two-syllable words | **≥ 90%** | **≤ 5.0s / word** |
| **G1-E5** | **1st Grade Sight Words & Decodable Texts** | `G1-E4` | `W` High-frequency and irregular words • `X` Decodable texts | **≥ 90%** | **≤ 4.0s / item** |
| **G1-E6** | **Reading Strategies: Main Idea, Inference, Character, Plot & POV** | `G1-E5` | `Y` Reality vs. fiction • `Z` Main idea • `AA` Inference and theme • `BB` Author's purpose • `CC` Setting and character • `DD` Sequence • `EE` Plot • `FF` Point of view • `GG` Text features | **≥ 85%** | **≤ 12.0s / item** |
| **G1-E7** | **Literary & Informational Passage Comprehension** | `G1-E6` | `HH` Read-along literary • `II` Read-alone literary • `JJ` Read-along informational • `KK` Read-alone informational | **≥ 85%** | **≤ 14.0s / item** |
| **G1-E8** | **Vocabulary: Affixes, Shades of Meaning, Context Clues & Reference** | `G1-E7` | `LL` Nouns and adjectives • `MM` Categories • `NN` Synonyms and antonyms • `OO` Multiple-meaning words • `PP` Shades of meaning • `QQ` Prefixes and suffixes • `RR` Context clues • `SS` Reference skills | **≥ 90%** | **≤ 6.0s / item** |
| **G1-E9** | **Grammar I: Sentences, Nouns, Pronouns, Verbs & Verb Tenses** | `G1-E8` | `TT` Sentences • `UU` Nouns • `VV` Pronouns • `WW` Verbs • `XX` Subject-verb agreement • `YY` Verb tense | **≥ 90%** | **≤ 6.0s / item** |
| **G1-E10** | **Grammar II: Articles, Adjectives, Prepositions, Conjunctions & Contractions** | `G1-E9` | `ZZ` Articles • `AAA` Adjectives • `BBB` Prepositions • `CCC` Linking words • `DDD` Contractions • `EEE` Capitalization | **≥ 90%** | **≤ 6.0s / item** |

### 4.3 Grade 1 Science (`16 Topics: A–P` -> `5 Units`) & Social Studies (`12 Topics: A–L` -> `4 Units`)
- **Science Units (`G1-S1` to `G1-S5`):**
  - `G1-S1`: **Materials, Comparing, States of Matter & Heating/Cooling** (`A, B, C, D, E`)
  - `G1-S2`: **Light, Shadows, Sound Communication & Forces/Magnets** (`F, G`)
  - `G1-S3`: **Animals, Baby Survival Behaviors & Animal Life Cycles** (`H, J`)
  - `G1-S4`: **Plants, Habitats & Food Chains** (`I, K`)
  - `G1-S5`: **Earth's Resources, Bodies of Water, Weather, Astronomy & Engineering** (`L, M, N, O, P`)
- **Social Studies Units (`G1-SS1` to `G1-SS4`):**
  - `G1-SS1`: **Civics, American Symbols/Landmarks & Community** (`A, B, C`)
  - `G1-SS2`: **Holidays, Then & Now and 22 Famous Americans** (`D, E, F`)
  - `G1-SS3`: **Physical Geography, Location Words & Map Skills** (`G, H, I`)
  - `G1-SS4`: **Economics, Evaluate Sources & Order Events/Timelines** (`J, K, L`)

---

## 5. Grade 2 Curriculum Mapping

### 5.1 Grade 2 Mathematics (`45 Skill Topics: A–SSS` -> `9 Units`)
*Standards: `2.OA.1–4`, `2.NBT.1–9`, `2.MD.1–10`, `2.G.1–3`*

| Unit ID | Unit Name | Prerequisite | Skill Topics Included | Gate Accuracy | Gate Max Speed |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **G2-M1** | **Counting, Ordering, Skip-Counting, Even/Odd Equations & Place Value to 1,000** | `G1-M9` | `A` Counting • `B` Comparing and ordering (`2.NBT.4`) • `C` Skip-counting by 5s, 10s, 100s (`2.NBT.2`) • `D` Names of numbers & expanded form (`2.NBT.3`) • `E` Even and odd • `L` Place value (`100` as ten tens, `2.NBT.1`) • `NNN` Pair objects for odd/even & express an even number as a sum of two equal addends (`2.OA.3`) | **≥ 90%** | **≤ 5.0s / item** |
| **G2-M2** | **1-Digit Addition & Subtraction Memory Automaticity (Sums to 20)** | `G2-M1` | `F` Addition strategies: 1-digit • `G` Addition: 1-digit (`2.OA.2`) • `H` Subtraction strategies: 1-digit • `I` Subtraction: 1-digit • `J` Mixed operations: 1-digit • `K` Mixed operations WP: 1-digit | **≥ 90%** | **≤ 3.5s / item** |
| **G2-M3** | **2-Digit Addition Strategies, Partial Sums & Regrouping** | `G2-M2` | `M` Addition strategies: two digits • `N` Addition: two digits (`2.NBT.5`) • `OOO` Add up to four two-digit numbers using partial sums, expanded form & empty number lines (`2.NBT.6`) | **≥ 90%** | **≤ 10.0s / item** |
| **G2-M4** | **2-Digit Subtraction (Borrowing) & 1- and 2-Step Word Problems** | `G2-M3` | `O` Subtraction strategies: two digits • `P` Subtraction: two digits (`2.NBT.5`) • `Q` Mixed operations: two digits • `R` Mixed 1- and 2-step word problems within 100 with unknowns in all positions (`2.OA.1`) | **≥ 90%** | **≤ 12.0s / item** |
| **G2-M5** | **3-Digit Addition/Subtraction (Within 1,000), Mental +/- 10 or 100 & Strategy Proofs** | `G2-M4` | `S` Addition strategies: 3-digits • `T` Addition: 3-digits • `U` Subtraction strategies: 3-digits • `V` Subtraction: 3-digits • `W` Mixed operations: 3-digits (`2.NBT.7`) • `PPP` Mentally add/subtract 10 or 100 (`100–900`) & explain why strategies work using place value and properties of operations (`2.NBT.8–9`) | **≥ 90%** | **≤ 14.0s / item** |
| **G2-M6** | **Repeated Addition ($5 \times 5$ Arrays), Properties & Estimation/Rounding** | `G2-M5` | `X` Repeated addition (`2.OA.4`) • `Y` Properties (Commutative, Associative, Zero/Identity) • `Z` Estimation and rounding | **≥ 90%** | **≤ 6.5s / item** |
| **G2-M7** | **US Money (Heads/Tails, Up to $1 and $100), Making Change & Word Problems** | `G2-M6` | `AA` Money up to $1 • `BB` Add and subtract money up to $1 • `CC` Money up to $100 • `MM` Financial literacy • `QQQ` Identify both sides (heads/tails) of US currency & solve mixed word problems with `$` and `¢` (`2.MD.8`) | **≥ 90%** | **≤ 8.0s / item** |
| **G2-M8** | **Time (5-Min & Time Relationships), Dual-Unit Length, Number-Line Sums & Graphs** | `G2-M7` | `DD` Time • `EE` Calendars • `FF` Data and graphs (line plots & 4-category bar/picture graphs, `2.MD.9–10`) • `GG` Customary units of length (`2.MD.1, 3, 4`) • `HH` Metric units of length • `RRR` Measure objects twice with different units (`12 in = 1 ft`, `100 cm = 1 m`), represent sums/differences on number lines with anchor midpoints (`5, 10, 25, 50, 75`) & know time unit relationships (`60 sec/min`, `60 min/hr`, `24 hr/day`, `12 hr AM/PM`, days/weeks in month/year) (`2.MD.2, 2.MD.5–7a`) | **≥ 90%** | **≤ 7.5s / item** |
| **G2-M9** | **2D Polygons, 3D Solids, Rectangular Tiling & Equal Shares of Identical Wholes** | `G2-M8` | `II` Two-dimensional shapes (`2.G.1`) • `JJ` Three-dimensional shapes • `KK` Area and perimeter (`2.G.2`) • `LL` Fractions (`halves, thirds, fourths`) • `SSS` Recognize that equal shares of identical wholes need not have the same shape (`2.G.3`) | **≥ 90%** | **≤ 6.0s / item** |

### 5.2 Grade 2 Language Arts (`63 Skill Topics: A–LLL` -> `10 Units`)

| Unit ID | Unit Name | Prerequisite | Skill Topics Included | Gate Accuracy | Gate Max Speed |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **G2-E1** | **Digraphs, Trigraphs (`-dge, -tch`), 3-Letter Blends & Silent Letters** | `G1-E10` | `A` Rhyming • `B` Syllables • `C` Phoneme manipulation • `D` Consonant digraphs, trigraphs, and silent letters • `E` Consonant digraphs and blends • `F` Short vowels | **≥ 90%** | **≤ 4.5s / word** |
| **G2-E2** | **Silent-e, Vowel Teams & Long Vowel Spelling Patterns** | `G2-E1` | `G` Silent e • `H` Vowel teams • `I` Short and long vowel patterns • `J` Long vowel patterns | **≥ 90%** | **≤ 4.5s / word** |
| **G2-E3** | **R-Controlled, Diphthongs, Variant Vowels & Soft/Hard `c` and `g`** | `G2-E2` | `K` R-controlled vowels • `L` Diphthongs: oi, oy, ou, ow • `M` Variant vowels • `N` Soft g and c | **≥ 90%** | **≤ 4.5s / word** |
| **G2-E4** | **Open/Closed/Consonant-le Syllables, Multisyllabic & Sight Words** | `G2-E3` | `O` Open and closed syllables • `P` Advanced syllables • `Q` Multisyllabic words • `R` Affixed words • `S` High-frequency and irregular words • `T` Decodable texts | **≥ 90%** | **≤ 5.0s / word** |
| **G2-E5** | **Reading Strategies: Main Idea, Theme, Cause/Effect & Compare/Contrast** | `G2-E4` | `U` Main idea • `V` Inference and theme • `W` Author's purpose • `X` Setting and character • `Y` Sequence • `Z` Plot • `AA` Cause and effect • `BB` Compare and contrast • `CC` Text features | **≥ 85%** | **≤ 12.0s / item** |
| **G2-E6** | **Literary & Informational Passage Comprehension** | `G2-E5` | `DD` Read-along literary • `EE` Read-alone literary • `FF` Read-along informational • `GG` Read-alone informational | **≥ 85%** | **≤ 15.0s / item** |
| **G2-E7** | **Writing Strategies: Organization, Topic Sentences, Linking Words & Opinion** | `G2-E6` | `HH` Organizing writing • `II` Topic sentences • `JJ` Linking words • `KK` Author's purpose • `LL` Opinion writing • `MM` Descriptive details • `NN` Sentence variety | **≥ 90%** | **≤ 9.0s / item** |
| **G2-E8** | **Vocabulary: Affixes, Compound Words, Homophones, Idioms & Reference** | `G2-E7` | `OO` Prefixes and suffixes • `PP` Compound words • `QQ` Categories • `RR` Synonyms and antonyms • `SS` Homophones and homonyms • `TT` Shades of meaning • `UU` Idioms • `VV` Context clues • `WW` Reference skills • `XX` Spelling | **≥ 90%** | **≤ 6.0s / item** |
| **G2-E9** | **Grammar I: Sentences/Fragments/Run-Ons, Collective/Irregular Nouns & Verbs** | `G2-E8` | `YY` Sentences, fragments, and run-ons • `ZZ` Nouns • `AAA` Pronouns • `BBB` Verb types • `CCC` Subject-verb agreement • `DDD` Verb tense | **≥ 90%** | **≤ 6.0s / item** |
| **G2-E10** | **Grammar II: Articles, Adjectives/Adverbs, Contractions, Punctuation & Abbreviations** | `G2-E9` | `EEE` Articles • `FFF` Adjectives and adverbs • `GGG` Prepositions • `HHH` Contractions • `III` Punctuation • `JJJ` Capitalization • `LLL` Abbreviations | **≥ 90%** | **≤ 6.0s / item** |

### 5.3 Grade 2 Science (`23 Topics: A–W` -> `6 Units`) & Social Studies (`10 Topics: A–J` -> `4 Units`)
- **Science Units (`G2-S1` to `G2-S6`):**
  - `G2-S1`: **Materials, States of Matter (Solid/Liquid/Gas), Phase Changes & Mixtures** (`A, B, C, D, E, F`)
  - `G2-S2`: **Force, Mass, Motion & Magnetic Attraction/Repulsion** (`G, H`)
  - `G2-S3`: **Vertebrate/Invertebrate Classification, Animal Life Cycles, Traits & Group Behavior** (`I, J, L, M`)
  - `G2-S4`: **Flowering Plant Life Cycles, Pollinators, Seed Dispersers & Food Chains** (`K, N, O`)
  - `G2-S5`: **Rocks, Thermometers, Landforms & Earth Events (Earthquakes, Volcanoes, Erosion)** (`P, Q, R, S, T`)
  - `G2-S6`: **Erosion Engineering, Customary/Metric Measurement Units & Astronomy** (`U, V, W`)
- **Social Studies Units (`G2-SS1` to `G2-SS4`):**
  - `G2-SS1`: **Map Grids, Landforms, Continents/Oceans & Urban/Suburban/Rural Geography** (`A, B, C`)
  - `G2-SS2`: **Local, State & Federal Government and US Landmarks/Monuments** (`D, E`)
  - `G2-SS3`: **Economics: Scarcity, Natural Resources, Goods/Services & Producers/Consumers** (`F`)
  - `G2-SS4`: **Cultural Holidays, 21 Historical Figures, Sources & Timelines/Causation** (`G, H, I, J`)

---

## 6. Grade 3 Curriculum Mapping

### 6.1 Grade 3 Mathematics (`59 Skill Topics: A–GGG` -> `10 Units`)
*Standards: `3.OA.1–9`, `3.NBT.1–3`, `3.NF.1–3`, `3.MD.1–8`, `3.G.1–2`*

| Unit ID | Unit Name | Prerequisite | Skill Topics Included | Gate Accuracy | Gate Max Speed |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **G3-M1** | **Place Value (to 10,000s), Ordering, Rounding & Estimation** | `G2-M9` | `A` Place value • `B` Comparing and ordering • `C` Rounding to nearest 10 or 100 (`3.NBT.1`) • `D` Estimate sums • `E` Estimate differences • `F` Estimate sums and differences | **≥ 90%** | **≤ 6.5s / item** |
| **G3-M2** | **3-, 4- & 5-Digit Addition/Subtraction (Including Across Zeros)** | `G3-M1` | `G` Addition: three digits (`3.NBT.2`) • `H` Subtraction: three digits (across zeros) • `I` Addition: four or five digits • `J` Subtraction: four or five digits • `K` Mixed operations: addition and subtraction • `L` Addition properties | **≥ 90%** | **≤ 12.0s / item** |
| **G3-M3** | **Understand Multiplication, Skill Builders & Memory Fluency up to 10 & 12** | `G3-M2` | `M` Skip-counting • `N` Understand multiplication (`3.OA.1`) • `O` Multiplication skill builders up to 10 • `P` Multiplication fluency up to 10 (`3.OA.7`) • `Q` Multiplication skill builders up to 12 • `R` Multiplication fluency up to 12 | **≥ 90%** | **≤ 3.0s / fact** |
| **G3-M4** | **Multiplication Properties, Table Patterns, Word Problems & Multiples of 10** | `G3-M3` | `S` Multiplication properties (Commutative, Associative, Distributive, `3.OA.5`) • `T` Multiplication word problems (`3.OA.3`) • `U` Two-digit multiplication & multiples of 10 (`10–90`, `3.NBT.3`) • `BBB` Multiply 3 factors & identify/explain arithmetic patterns in addition and multiplication tables (`3.OA.5, 3.OA.9`) | **≥ 90%** | **≤ 7.0s / item** |
| **G3-M5** | **Understand Division, Skill Builders, Fluency up to 10/12 & Word Problems** | `G3-M4` | `V` Understand division (`3.OA.2`) • `W` Division skill builders up to 10 • `X` Division fluency up to 10 (`3.OA.7`) • `Y` Division skill builders up to 12 • `Z` Division fluency up to 12 • `AA` Division word problems (`3.OA.3`) | **≥ 90%** | **≤ 3.5s / fact** |
| **G3-M6** | **Unknown-Factor Division, 2-Step All-Operation Word Problems, Variables & Reasonableness** | `G3-M5` | `BB` Mixed operations: multiplication and division • `CC` Mixed operations • `DD` Two-step word problems (`3.OA.8`) • `EE` Equations with unknown numbers (`3.OA.4`) • `CCC` Understand division as an unknown-factor problem & assess reasonableness of 2-step word problem answers using mental computation and rounding (`3.OA.6, 3.OA.8`) | **≥ 90%** | **≤ 14.0s / item** |
| **G3-M7** | **Understand Fractions, Number Lines, Ruler Fractions & Equivalence** | `G3-M6` | `FF` Understand fractions ($1/b$ and $a/b$, `3.NF.1`) • `GG` Fractions on number lines (`3.NF.2`) • `HH` Fraction word problems • `II` Equivalent fractions (`3.NF.3a–b`) • `JJ` Fractions equivalent to whole numbers • `DDD` Ruler fractions, paper-folding equivalence & express whole numbers as fractions (`3 = 3/1`, `4/4 = 1`, `3.NF.2b, 3.NF.3b–c`) | **≥ 90%** | **≤ 6.5s / item** |
| **G3-M8** | **Comparing & Ordering Fractions (Same Whole Validation, Like Numerators/Denominators)** | `G3-M7` | `KK` Compare fractions with like denominators • `LL` Compare fractions with like numerators • `MM` Compare fractions • `NN` Order fractions • `EEE` Recognize fraction comparisons are valid only when referring to the same whole (`3.NF.3d`) | **≥ 90%** | **≤ 6.5s / item** |
| **G3-M9** | **Area (Tiling, Distributive & Rectilinear), Perimeter, Quadrilaterals & Unit-Fraction Areas** | `G3-M8` | `OO` Area (`3.MD.5–7`) • `PP` Perimeter (`3.MD.8`) • `QQ` Area and perimeter • `RR` Lines and angles • `SS` Polygons • `TT` Quadrilaterals (`3.G.1`) • `FFF` Tiling Distributive Property $a \times (b + c)$, rectilinear decomposition, unknown perimeter side lengths, same-perimeter/different-area & same-area/different-perimeter rectangles, non-subcategory quadrilaterals & unit-fraction shape areas (`3.MD.7c–d, 3.MD.8, 3.G.1–2`) | **≥ 90%** | **≤ 8.5s / item** |
| **G3-M10** | **Time to the Minute, Elapsed Time, Mass/Volume (g, kg, L), Fractional Line Plots & Scaled Graphs** | `G3-M9` | `UU` Read and write times • `VV` Elapsed time on number lines (`3.MD.1`) • `WW` Customary units of measurement • `XX` Metric units of mass and liquid volume (`g, kg, L`, `3.MD.2`) • `YY` Data and graphs • `ZZ` Money • `AAA` Financial literacy • `GGG` Measure lengths to $1/2$ and $1/4$ inch on fractional line plots & solve 1- and 2-step problems on scaled picture/bar graphs (`3.MD.3–4`) | **≥ 90%** | **≤ 9.0s / item** |

### 6.2 Grade 3 Language Arts (`56 Skill Topics: A–DDD` -> `10 Units`)

| Unit ID | Unit Name | Prerequisite | Skill Topics Included | Gate Accuracy | Gate Max Speed |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **G3-E1** | **Advanced Vowels, Trigraphs, 6 Syllable Types & Multisyllabic Words** | `G2-E10` | `A` Short and long vowels • `B` Blends, digraphs, and trigraphs • `C` Variant, diphthong, and r vowel patterns • `D` Multisyllabic words • `E` Affixed words • `F` High-frequency and irregular words • `G` Decodable texts | **≥ 90%** | **≤ 5.0s / word** |
| **G3-E2** | **Reading Strategies I: Main Idea, Inference, Theme & Author's Perspective** | `G3-E1` | `H` Main idea • `I` Inference and theme • `J` Author's purpose and perspective | **≥ 85%** | **≤ 14.0s / item** |
| **G3-E3** | **Reading Strategies II: Character, Text Structure, Similes & Poetry** | `G3-E2` | `K` Character • `L` Story elements • `M` Text structure • `N` Sensory details • `O` Literary devices • `P` Visual elements • `Q` Text features • `R` Poetry elements | **≥ 90%** | **≤ 10.0s / item** |
| **G3-E4** | **Literary Texts (Levels 1 & 2): Fantasy, Historical, Realistic & Poetry** | `G3-E3` | `S` Literary texts: level 1 • `T` Literary texts: level 2 | **≥ 85%** | **≤ 16.0s / item** |
| **G3-E5** | **Informational Texts (Levels 1 & 2): Nature, Biographies, Tech & History** | `G3-E4` | `U` Informational texts: level 1 • `V` Informational texts: level 2 | **≥ 85%** | **≤ 16.0s / item** |
| **G3-E6** | **Writing Strategies: Organization, Topic Sentences, Opinion & Revising** | `G3-E5` | `W` Organizing writing • `X` Topic sentences • `Y` Writer's purpose • `Z` Linking words • `AA` Opinion writing • `BB` Descriptive details • `CC` Sentence variety • `DD` Editing and revising | **≥ 90%** | **≤ 9.0s / item** |
| **G3-E7** | **Morphology: Prefixes/Suffixes, Greek & Latin Roots & Homophones** | `G3-E6` | `EE` Prefixes and suffixes • `FF` Greek and Latin roots • `GG` Compound words • `HH` Categories • `II` Synonyms and antonyms • `JJ` Homophones and homonyms | **≥ 90%** | **≤ 5.5s / item** |
| **G3-E8** | **Shades of Meaning, Idioms, Context Clues, Reference & Spelling** | `G3-E7` | `KK` Shades of meaning • `LL` Idioms • `MM` Context clues • `NN` Reference skills • `OO` Spelling | **≥ 90%** | **≤ 6.5s / item** |
| **G3-E9** | **Grammar I: Sentences/Run-Ons, Abstract Nouns, Pronouns & Verb Tenses** | `G3-E8` | `PP` Sentences, fragments, and run-ons • `QQ` Nouns • `RR` Pronouns • `SS` Verb types • `TT` Subject-verb agreement • `UU` Verb tense | **≥ 90%** | **≤ 6.0s / item** |
| **G3-E10** | **Grammar II: Adjectives/Adverbs, Conjunctions, Commas & Formatting** | `G3-E9` | `VV` Articles • `WW` Adjectives and adverbs • `XX` Prepositions • `YY` Conjunctions • `ZZ` Contractions • `AAA` Commas • `BBB` Capitalization • `CCC` Abbreviations • `DDD` Formatting | **≥ 90%** | **≤ 6.5s / item** |

### 6.3 Grade 3 Science (`25 Topics: A–Y` -> `6 Units`) & Social Studies (`13 Topics: A–M` -> `5 Units`)
- **Science Units (`G3-S1` to `G3-S6`):**
  - `G3-S1`: **Materials, States of Matter, Phase Changes, Thermal Energy & Chemical Change** (`A, B, C, D, E, F`)
  - `G3-S2`: **Balanced/Unbalanced Forces, Light, Static Electricity & Magnetic Strength** (`G, H, I, J`)
  - `G3-S3`: **Vertebrates/Invertebrates, Animal & Plant Life Cycles, Human Organs & Photosynthesis** (`K, L, M`)
  - `G3-S4`: **Traits, Animal Adaptations, Heredity (Pedigrees) & Ecosystems/Food Webs** (`N, O, P, Q`)
  - `G3-S5`: **Igneous/Sedimentary/Metamorphic Rocks, Fossils & Earth Events** (`R, S, U, V`)
  - `G3-S6`: **Weather vs. Climate Data, Solar System Planets, Hazard Engineering & Measurement** (`T, W, X, Y`)
- **Social Studies Units (`G3-SS1` to `G3-SS5`):**
  - `G3-SS1`: **Map Grids, Continents/Oceans, Major US Cities & Modifying the Environment** (`A, B, C`)
  - `G3-SS2`: **All 50 US States & 50 State Capitals (West, Midwest, Southeast, Northeast)** (`D, E`)
  - `G3-SS3`: **US Government, Constitution, Bill of Rights, Checks & Balances & Landmarks** (`F, G`)
  - `G3-SS4`: **Economic Principles & Supply and Demand Curves (Shortage vs. Surplus)** (`H, I`)
  - `G3-SS5`: **Cultural Holidays, 21 Historical Figures, Sources & Chronology/Causation** (`J, K, L, M`)
