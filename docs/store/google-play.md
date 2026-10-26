# Google Play Console Listing — Families program (issue #69)

Ready-to-paste pack for Play Console. Bracketed `[USER-SIDE]` items
require the operator. Data Safety answers are field-by-field from
`data-safety-traceability.md`; the app already passes the program's
technical requirements (no ads SDK, no external links, parental gate —
`docs/families-kids-self-check.md`).

## App identity

| Field | Value |
|---|---|
| App name (30 chars) | Balashikshana |
| Package | com.shristilabs.balashikshana |
| Default language | en-US |
| Category | Education |
| Tags | Education, Family |
| Free/paid | Free; NO in-app purchases; NO ads (declared below) |

## Store listing copy

**Short description (80 chars):**
Offline-friendly math practice for ages 3-9. Parent-consented, ad-free,
first-party only.

**Full description:** reuse the Apple description verbatim (apple-app-store.md)
— one honest copy everywhere; Play has no conflict with it.

**Graphic assets [USER-SIDE capture]:**

| Asset | Size | Notes |
|---|---|---|
| App icon | 512×512 PNG | existing `assets/` icon set |
| Feature graphic | 1024×500 | curriculum journey motif; no third-party brands (invariant #4) |
| Phone screenshots | ≥2, up to 8; 16:9–9:16, ≥320px | same content rules as Apple slots |
| 7"/10" tablet screenshots | recommended | the app supports tablet layouts |

## Families program declarations

| Declaration | Answer | Evidence |
|---|---|---|
| App is designed for children / primarily child-directed | Yes (target ages 3-9) | grade-tier curriculum mapping |
| Target age groups | Children, all ages under 13 as audience bands the console offers for 3-9 | age-ratings.md rationale |
| Does the app contain ads? | **No** | no ad SDKs (coppa-invariants exact allowlist; vendor blocklist) |
| Advertising ID | Not used — no `AD_ID` permission (store-config pins) | apps/mobile/tests/store-config.test.ts |
| In-app purchases | No | product has none |
| Data collection consent | Verifiable parental consent before any child data | consent.mjs transactional gate + email-verified parents (#69 mailer flip) |
| Compliance with Families Policy | Yes — first-party only data flows | data-safety-traceability.md |

## Data Safety form (field-by-field)

Every row below is the Play Console question and the answer to enter;
source = traceability matrix (INV = data-flow-inventory row).

### Data collected? → Yes, then per data type:

| Console field | Entry |
|---|---|
| Personal info → Email address | **Collected** · Purposes: Account management · Linked to identity: Yes · Optional: No (required for parent account) · Ephemeral: No · Source INV:1, INV:16 |
| App activity → App interactions / Other in-app actions | **Collected** · App functionality · Linked: Yes (child profile) · Optional: No (the app IS the practice) · Ephemeral: No · INV:8-11 |
| App activity → Other user-generated content | Not collected (child answers are app-activity data, not shared UGC) |
| Diagnostics → App performance / Crash logs | **Collected** · App functionality, Safety · Linked: **No** (truncated IPs + surrogate IDs, redacted at capture) · Ephemeral: No (30-day error-event purge) · INV:17-19 |
| Identifiers → User or device IDs | **Collected** (app-internal session/device identifiers, stored hashed) · App functionality · Linked: Yes · INV:3, INV:13 |
| Files and docs / Photos and videos / Audio / Location / Contacts / SMS / Phone / Calendar / Health / Fitness / Financial / Purchase history / Web browsing / Installed apps | **Not collected** — zero such inventory class; permission posture pinned by store-config tests |

### Data shared? → **No**

Basis: the only off-device transfers are (1) to our own first-party API and
(2) transactional/digest email relayed by an SMTP **service provider**
acting on our behalf — outside Google's "sharing" definition for service
providers, and disclosed in the privacy policy regardless. [USER-SIDE:
re-read the console's current definition at filing — see traceability
matrix deviation note 2.]

### Security practices

| Console field | Entry |
|---|---|
| Data encrypted in transit | **Yes** (HTTPS everywhere; ATS strict on iOS; Android cleartext debug-only) |
| Mechanism to delete user data | **Yes — in-app** (#62 parent-authenticated export/deletion; INV:20 audit trail) |
| Data encrypted at rest | Not claimed (infrastructure-configured; do not tick) |

## Content rating questionnaire (IARC) — answers

| Question | Answer |
|---|---|
| Violence (cartoon/fantasy/realistic) | None |
| Sexual content / nudity | None |
| Language / profanity | None |
| Controlled substances | None |
| Gambling | None (no simulated gambling mini-games — gamification is XP/coins for practice only) |
| Sharing user content | No |
| User interaction (chat) | No |
| Personal info disclosure to third parties | No |
| Location sharing | No |
| Digital purchases | No |
| Ads | No |

Expected output ratings: **ESRB EC (Early Childhood) / PEGI 3 / everyone-lowest
band in other regions** — the questionnaire answers above produce the
lowest bands; verify the generated certificate at filing. [USER-SIDE]

## Target audience & content declarations

| Console field | Entry |
|---|---|
| Target age group | Include all child bands covering 3-9 (5 and under, 6-8, 9-10/upper child band per console's banding) and exclude teen/adult-only appeal |
| Appeals to children | Yes |
| Content suitability | Suitable for children (all questionnaire answers above) |
| Unwanted exposure settings | Families apps default to the strictest ad/content posture — moot (no ads) |

## Play-specific pre-launch checklist [USER-SIDE]

1. Upload the AAB from the same release build family as the traffic audit.
2. Complete Data Safety exactly as above; attach the traceability matrix
   to internal review notes (not the public listing).
3. Set the privacy policy URL (same production origin as Apple).
4. Content rating certificate generated; confirm lowest bands.
5. Create the demo parent account (review-notes.md template) and note it
   in App content → review notes.
6. Submit; track status in issue #69 until both stores resolve.
