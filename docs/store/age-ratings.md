# Age Ratings Rationale — issue #69 (Apple Kids Category + Google Play/IARC)

Both stores ask "what ages is this for?" in their own taxonomies. The
answers must match the product's actual audience — the curriculum — not
marketing ambition. This note is the rationale reviewers (and future
maintainers) can check the answers against.

## The served range: ages 3-9 (Pre-K through Grade 3)

- The curriculum registry (`docs/us-curriculum-mapping.md`,
  `docs/us-curriculum-registry.json`) defines five grade tiers: Pre-K,
  Kindergarten, Grade 1, Grade 2, Grade 3 — US-common-core-mapped.
- Typical ages: Pre-K 3-5, K 5-6, G1 6-7, G2 7-8, G3 8-9.
- Reading independence is NOT assumed: pre-reader tiers receive spoken
  narration on every question (`src/audio/`, TTS with bundled fallback),
  which is why the youngest band is genuinely served, not aspirational.

## Store taxonomy mapping

| Store | Mechanism | Answer |
|---|---|---|
| Apple Kids Category | Age band selection | **5 and under, 6-8, 9-11** (all three; 9-year-olds fall in Apple's 9-11 band — selecting it is the honest statement, and the youngest band's stricter obligations govern) |
| Apple general age rating | Questionnaire | **4+** (all answers "None"/"No" — see apple-app-store.md) |
| Google Play | IARC questionnaire | Lowest bands: **ESRB EC / PEGI 3** equivalents (generated at filing from the answers in google-play.md) |
| Google Play | Target audience | Child-directed; target age bands covering 3-9 only; does NOT target teens or adults as the audience (parents are the account holders, not the audience) |

## Why the ratings are defensible under review

1. **No interactive risk surface**: no chat, no UGC sharing, no external
   links (coppa-invariants link audit), no web view, no ads.
2. **Content is math practice**: 614 topics across 130 units — no media
   that could carry rating-relevant content; questions are generated from
   the signed first-party packs (`docs/games-and-study-materials.md`).
3. **Parent surfaces are gated**: hold-to-confirm parental gate with a
   documented bypass matrix (docs/families-kids-self-check.md).
4. **Gamification is practice-feedback, not gambling-shaped**: coins/XP
   accrue from correct practice; no loot boxes, no random paid rewards, no
   simulated casino mechanics.
5. **Data posture matches the youngest band's stricter rules**: no data
   sold/shared, verifiable parental consent, in-app deletion
   (data-safety-traceability.md).

## Edge considerations (documented honestly)

- A 9-year-old is in Apple's "9-11" band; the app does not target 10-11
  year olds specifically. If App Review questions the upper band, the
  fallback is dropping to "5 and under, 6-8" + noting Grade 3 support in
  the description — a filing-time judgment, recorded here so the operator
  knows it is pre-analyzed. [USER-SIDE decision at filing]
- Google's target-audience bands shift with console updates; the invariant
  is "all bands covering 3-9, nothing above", not a fixed band list.
