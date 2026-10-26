# Apple App Store Listing — Kids Category (issue #69)

Ready-to-paste pack for App Store Connect. Bracketed `[USER-SIDE]` items
require the operator in the store console. Every privacy answer comes from
`data-safety-traceability.md` (inventory-traced). Kids Category is the
strictest review: no ads, no external links, parent gates on
age-appropriate surfaces — all verified by `apps/mobile/tests/coppa-invariants.test.ts`
and documented in `docs/families-kids-self-check.md`.

## App identity

| Field | Value |
|---|---|
| Name | Balashikshana (30-char limit; fits) |
| Subtitle (30 chars) | Math practice for ages 3-9 |
| Primary language | en-US |
| Bundle ID | com.shristilabs.balashikshana (prebuild-verified) |
| Version | 1.0.0 |
| Primary category | Education |
| Secondary category | [USER-SIDE: recommended Games (skill practice loop); leave Education primary] |
| Kids Category | **Yes** — age bands: **5 and under, 6-8, 9-11** (all three; rationale below) |
| Age rating | 4+ (questionnaire answers below) |
| Price | Free [USER-SIDE: confirm — no in-app purchases exist in the product] |

**Age-band rationale:** the curriculum spans Pre-K through Grade 3
(roughly ages 3-9; `docs/us-curriculum-mapping.md`). Apple's bands are the
store's own taxonomy: 3-5 falls in "5 and under", 6-8 in "6-8", and
9-year-olds (Grade 3) in "9-11". Selecting all three is the honest
statement of the served range; every Kids Category obligation (no ads, no
links out, gated parent surfaces, privacy nutrition) is met at the
youngest band, so the strictest bar governs and passes. [USER-SIDE: bands
are chosen in App Store Connect at submission; the default recommendation
is all three.]

## Age-rating questionnaire (Apple)

| Question | Answer |
|---|---|
| Cartoon violence | None |
| Realistic violence | None |
| Fantasy violence | None |
| Sexual content/nudity | None |
| Profanity/crude humor | None |
| Alcohol/tobacco/drugs | None |
| Medical/treatment info | None |
| Unrestricted web access | **No** (the app renders all content in-app; no external links — link audit) |
| Gambling | None |
| Contests | No |
| User-generated content | Not shared with others (profiles are created by the parent, stored first-party, never shared) |
| Mature/suggestive themes | None |

Result: **4+** automatically.

## Privacy Nutrition Labels

From `data-safety-traceability.md` (do not retype from memory):

- Contact Info → Email Address: Data Linked to You — App Functionality
- App Activity → App Interactions, Other Activity: Data Linked to You — App Functionality
- Identifiers → User ID: Data Linked to You — App Functionality
- Diagnostics → Crash Data, Performance Data, Other Diagnostic Data: Data Not Linked to You — App Functionality
- Tracking: **No data collected for tracking**
- All other categories: Not Collected
- Privacy Policy URL: [USER-SIDE: the production origin serving `GET /api/legal/privacy-policy/latest`, e.g. `https://api.<production-domain>/api/legal/privacy-policy/latest` — confirm the public origin before filing]

## Kids Category requirements self-check

| Requirement | Status | Evidence |
|---|---|---|
| No third-party ads or advertising SDKs | Pass | coppa-invariants SDK scan (exact allowlist + vendor blocklist) |
| No external links in child-facing UI | Pass | coppa-invariants link audit; legal pack rendered in-app |
| Parental gate before parent surfaces | Pass | hold-to-confirm 3s gate; placement scan + bypass matrix in docs/families-kids-self-check.md |
| No data sale/sharing | Pass | traceability matrix "Data shared: No" |
| Privacy policy reachable | Pass | pre-consent in onboarding, gated parent area, portal footer |
| Requires Apple to review with demo access | [USER-SIDE] | review-notes.md credentials template |

## Screenshots spec [USER-SIDE capture]

Required device sizes (App Store Connect current):

| Slot | Size (px) | Count | Suggested content |
|---|---|---|---|
| 6.9" / 6.7" iPhone | 1320×2868 / 1290×2796 | up to 10, ≥1 | Real screens only: child practice view, audio-supported question, progress celebration, parent portal dashboard, consent screen |
| 12.9" iPad (REQUIRED — supportsTablet is true) | 2048×2732 | ≥1 | Practice + portal on tablet layout |
| App icon | 1024×1024 | 1 | [USER-SIDE: existing `assets/` icon set] |

Capture rules: real screens (no mock testimonials), no brand references to
other products (repo invariant #4), no dark-pattern copy, narration/audio
states shown honestly.

## Description (ready to paste)

**Promotional text (170 chars):**
Offline-friendly math practice for ages 3-9. Parent-consented, ad-free,
and built around a real Pre-K to Grade 3 curriculum.

**Description:**
Balashikshana is a first-party math learning app for children in Pre-K
through Grade 3 (ages 3-9). A parent creates the account, provides
verifiable consent, and adds each child's profile; the child then
practices a structured, curriculum-mapped journey of units and topics with
spoken instruction for pre-readers, mastery gates, and gentle
gamification.

What is in the app:
- A complete Pre-K to Grade 3 math curriculum progression (130 units, 600+ topics)
- Kid-first design: no ads, no chat, no external links, no tracking
- Works offline: content packs download to the device and verify
  cryptographically before use
- Spoken narration supports pre-readers; every question is read aloud
- A parent portal with progress, weekly summaries (opt-in), time limits,
  and full data export and deletion rights

What is not in the app:
- No advertising of any kind
- No third-party analytics or tracking
- No social features or user-generated content sharing
- No links out of the app for children

Parents control the data: consent is captured before any learning data is
created, can be reviewed in the parent area, and every child's data can be
exported or deleted from the parent portal at any time.

**Keywords (100 chars):**
math,kids,counting,addition,subtraction,shapes,curriculum,preschool,grade,offline

## Review notes

See `review-notes.md` — demo account instructions, walkthrough, COPPA
posture summary, and contact placeholders go into App Store Connect's
review-notes field (4000 chars) largely verbatim.
