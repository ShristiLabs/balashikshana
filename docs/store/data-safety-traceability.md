# Store-Form Traceability Matrix — issue #69

contracts: chain of custody = **form answer → inventory claim → code evidence**

Every Data Safety / Privacy Nutrition answer filed with Apple or Google
MUST trace to a numbered row in `docs/data-flow-inventory.md` (the #68
source of truth, itself code-verified), and each inventory claim cites the
code that makes it true. A form row that cannot be traced is wrong by
definition. This matrix is test-enforced: `services/api/test/store-pack.test.mjs`
fails CI when a row references a nonexistent inventory class, a required
section is missing, or a Play data-type row lacks evidence.

Notation: `INV:n` = row n of the data-flow inventory table. Evidence paths
are repo-relative and point at the enforcing code/tests, not prose.

## Google Play Data Safety — Data collected

| Play data type | Answer | Inventory | Code evidence |
|---|---|---|---|
| Personal info → Email address | Collected | INV:1 (parent signup) | `services/api/parent-auth.mjs` (signup stores `parents.email`); weekly digest opt-in INV:16 (`services/api/weekly-digest.mjs`) |
| App activity → App interactions and other user actions | Collected | INV:8, INV:9, INV:10, INV:11 (attempts, progress, gamification, placement) | `student_question_attempts` append-only writes; export coverage in `services/api/data-rights.mjs`; consent gate in `services/api/consent.mjs` (no C-row without current consent) |
| Diagnostics → App performance / crash logs | Collected | INV:17, INV:18, INV:19 (request logs, metrics, error events) | `services/api/observability/redact.mjs` (PII scrubbed at capture); PII-scan test in `services/api/test/observability*.test.mjs` |
| User IDs | Collected (app-internal identifiers) | INV:3, INV:12, INV:13, INV:14 (token digests + raw M1 student sessions, bindings, device sessions) | `parent_sessions`/`child_device_sessions` store SHA-256 digests (`parent-auth.mjs sha256Hex`); honesty note: M1 `student_sessions` tokens are stored RAW at rest — tracked as security-review SR-3 debt; the COLLECTED answer is unchanged either way (at-rest format is not a form question), but this row deliberately does not claim hashing for student tokens |
| Personal info → Name | Collected (child nickname, parent-chosen) | INV:6 (learner profile) | `students` profile fields created by parent; never in telemetry (INV:6 "NEVER in telemetry", enforced by redact tests) |
| Purchase history / Financial info / Photos / Videos / Audio files / Music files / Files and docs / Calendar / Contacts / SMS / Phone call log / Location / Health / Fitness / Web browsing history / Installed apps | NOT collected | INV:21-adjacent: inventory contains NO such class; "Photos/videos/audio: none collected" mapping hint | Zero-permission posture: `apps/mobile/tests/store-config.test.ts` (no location/contacts/camera/storage permissions); audio playback-only (`nativeAudio.ts` allowsRecording:false); device TTS generated not stored |
| Photos and videos (Play) | NOT collected | mapping hint (audio duration metadata only, INV:8) | gate audio accounting uses `audioDurationSec` metadata, no audio bytes stored |

Purposes declared: Email → **Account management** (verification, login, reset, opt-in digest). App activity → **App functionality** (the teaching engine and parent progress views). Diagnostics → **App functionality / Safety** (reliability). All child-data collection is **parental-consented** before any row exists (`consent.mjs` transactional gate; tested).

## Google Play Data Safety — Data shared

| Question | Answer | Basis |
|---|---|---|
| Is user data shared with third parties? | **No** | INV cross-check 3: "flows out are exactly two third parties + stores". The two: (a) app-store distribution; (b) the SMTP provider relays transactional/digest mail **as a service provider acting on our behalf** — Google's Data Safety guidance excludes transfers to service providers that process data on the developer's behalf and under the developer's instructions from the "sharing" definition (analogous to hosting). The privacy policy (docs/legal) discloses the provider regardless. **User-side verification step:** re-read the Play Console's current "sharing" definition at filing time — Google updates this guidance; if the console's wording no longer exempts service providers, declare email as shared with "email delivery provider, service provider, app functionality". |
| Data transferred off-device? | Yes — to our own first-party API only | Single-endpoint posture: `apps/mobile/tests/store-config.test.ts` endpoint-disclosure scan (only absolute URL in shipped src is the `EXPO_PUBLIC_API_BASE` dev default); no third-party SDKs (`apps/mobile/tests/coppa-invariants.test.ts` dual-layer SDK scan) |

## Google Play Data Safety — Security practices

| Question | Answer | Evidence |
|---|---|---|
| Is all user data encrypted in transit? | Yes | TLS on every network path (API behind HTTPS at the edge — docs/gateway.md, deploy/dwara); iOS ATS `NSAllowsArbitraryLoads=false` (prebuild-verified Info.plist); Android cleartext only in the debug overlay |
| Can users request data deletion? | Yes — in-app self-serve | INV:20 + `services/api/data-rights.mjs` (#62 routes, password re-auth, append-only audit) |
| Is data encrypted at rest? | Not claimed | Honest posture: DB-level at-rest encryption is infrastructure-configured, not code-guaranteed — we do NOT tick Play's at-rest encryption box |

## Apple Privacy Nutrition Labels (Kids Category)

| Apple label | Answer | Inventory | Evidence |
|---|---|---|---|
| Contact Info → Email Address | **Data Linked to You** — App Functionality | INV:1 | parent-auth account/verification/reset/digest |
| App Activity → App Interactions, Other Activity | **Data Linked to You** — App Functionality (child learning data, parental consent) | INV:8-11 | consent-gated writes; portal export parity |
| Identifiers → User ID | **Data Linked to You** — App Functionality | INV:3, INV:12, INV:13 | token digests + bindings |
| Diagnostics → Crash Data, Performance Data, Other Diagnostic Data | **Data Not Linked to You** — App Functionality/Analytics (first-party only) | INV:17-19 | redaction-at-capture + PII-scan tests |
| Everything else (Photos, Audio, Location, Contacts, Financial, Purchases, Browsing, Search History, Sensitive info, Health...) | **Not Collected** | no inventory class | store-config permission pins + coppa-invariants |

Apple "Track you" across other companies' apps and websites: **No data collected for tracking** — no ad networks, no analytics vendors, no tracking SDKs, no links out of the app (coppa-invariants link audit).

## Age ratings traceability

Target ages **3-9** (Pre-K through Grade 3 — `docs/us-curriculum-mapping.md`, 5 grade tiers). Both stores' ratings answers derive from content facts: no violence, no chat, no user-generated content sharing, no simulated gambling, no ads, offline-capable skill practice. See `age-ratings.md`.

## Deviations / user-side verification steps (honest)

1. `[BACKUP_RETENTION_PLACEHOLDER]` in the privacy policy is unanswered — Play's security-practices section asks about backup windows; answer before filing (docs/legal/README.md entry criterion 2).
2. Google's "sharing"/service-provider wording: re-verify at filing (above).
3. Apple's console taxonomy (label names) shifts between App Store Connect releases: re-map using this matrix's inventory column at filing.
4. A live on-device network-traffic capture against a release build remains the final human check (protocol in `review-notes.md`); the code-level disclosure audits are the committed half.
5. Local notifications on Android 13+ (#57 reminders are local-only): the verified prebuild manifest carries no `POST_NOTIFICATIONS` permission, and Android 13+ requires it to DISPLAY notifications at runtime. This is a product-visibility question, NOT a data honesty one (no notification data is collected or transmitted). [USER-SIDE: verify reminder visibility on an API 33+ device; if reminders must appear there, adding the permission is a conscious future change (config + store-config pin) with no Data Safety form impact.]
