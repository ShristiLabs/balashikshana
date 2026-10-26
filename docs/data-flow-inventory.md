# Data-Flow Inventory — issue #68 (source of truth for #69 store forms)

Every personal-information class the service collects, where it lives,
where it goes, and its retention — cross-checked against code (not
marketing claims). This file is the input for the Apple App Store
Privacy Nutrition Labels and Google Play Data Safety forms in #69: if a
form row cannot be traced to a row here, the form is wrong.

Collections are grouped by data subject: P = parent/guardian,
C = child learner, S = server operational.

## Inventory

| # | Class | Subject | Collected | Stored (table) | Purpose | Flows OUT | Retention |
|---|---|---|---|---|---|---|---|
| 1 | Email address | P | signup | `parents.email` | account, verification, reset, weekly digest | SMTP provider (digest when opted in; verification/reset mail when routed through mailer) | life of account |
| 2 | Password hash | P | signup/reset | `parents.password_hash` | authentication | none | life of account (scrypt, per-row salt) |
| 3 | Parent session/verification/reset tokens | P | login/signup/reset | `parent_sessions`, `parent_tokens` (SHA-256 digests) | session continuity, email proof, reset | none | 7-day session TTL / 30-day refresh window / 24 h verify / 1 h reset; purged by sweep |
| 4 | Consent records | P/C | consent acceptance | `consent_records` (append-only) | COPPA evidence | in child export | life of account (evidence; no TTL by doctrine) |
| 5 | Consent policy + legal document texts | - | seeded | `consent_policy_versions`, `legal_documents` | the texts parents accept/read | public endpoints (the texts are public documents; no PII) | append-only |
| 6 | Learner profile (nickname, username, avatar, age band, grade, motor baseline) | C | parent creates child | `students` | operate the learner journey | in child export; NEVER in telemetry | life of profile (deleted by #62 deletion) |
| 7 | Learner PIN hash | C | parent sets 4-digit PIN | `students.pin_hash` | device-level profile unlock | never (credential column excluded from export) | life of profile (scrypt) |
| 8 | Practice attempts (answers, correctness, times, misconception tags, timestamps) | C | practice/gate/game/placement sessions | `student_question_attempts` (append-only) | teaching engine input, progress, analytics | in child export; aggregates only to metrics | life of profile |
| 9 | Topic/unit progress, mastery keys, SR scheduling | C | derived server-side | `student_topic_progress`, `student_unit_progress` | journey state | in child export | life of profile |
| 10 | Gamification state (XP events, coins, badges, streaks, hearts outcomes) | C | derived | `student_xp_events`, `student_badge_awards`, `student_gamification_state`, `student_session_outcomes` | rewards | in child export (gamification block == portal numbers by construction) | life of profile |
| 11 | Placement records | C | derived from placement sessions | `student_placement_records` | start-point recommendation | in child export | life of profile |
| 12 | Parent-child bindings | P/C | creation/claim | `parent_children` | ownership | relation/status/dates in child export | life of profile |
| 13 | Devices + child device sessions | P/C | parent mints device access | `devices`, `child_device_sessions` (token digests) | device authorization | device metadata in child export; token hashes never | 30-day absolute TTL or parent revoke; sweep |
| 14 | Student sessions (M1) | C | PIN login | `student_sessions` (raw token — see security-review SR-3) | session continuity | timestamps only in export | 30-day TTL; sweep |
| 15 | Portal child settings (time limits, subject restrictions, grade ceiling) | P | parent sets | `portal_child_settings` | enforcement (server-side, every surface) | in child export | life of profile |
| 16 | Weekly digest stats + sent-ledger | P | derived; opt-in | `weekly_digest_sent`, `parents.weekly_email_enabled` | parent summary email | SMTP provider (parent's own address; aggregate counts only — no per-question data) | ISO-week ledger rows |
| 17 | Request logs | S | every request | stdout/log sink | operations | none beyond the log sink | log sink policy; fields: route class, path, truncated IP prefix, opaque surrogate UUIDs, timing |
| 18 | Metrics | S | every request + engine outcomes | in-process registry (Prometheus exposition) | reliability | internal scrape only (never edge-routed) | process lifetime (no persistent PII) |
| 19 | Error events | S | failures | `error_events` | reliability | internal | 30-day rolling purge |
| 20 | Deletion audit | S | #62 deletion | `deletion_audit` (append-only) | compliance evidence | none | indefinite (identifiers + timestamps only) |
| 21 | Curriculum content, questions, packs | - | seeded/compiled | `grades/units/skill_topics/practice_questions`, signed pack files | the product | public content endpoints + signed packs (public artifacts, no PII) | n/a |

## Cross-checks performed (#68)

1. **Export completeness** — every C-subject row above except the two
   credential classes (7: PIN hash; 13/14: token values) is present in
   `GET /api/portal/children/:id/export` (data-rights.mjs selects by
   name; timestamps-only for sessions). Verified against the code in
   this issue; the data-rights suite pins the shape.
2. **Telemetry carries no PII** — classes 17–19 never capture request
   bodies; direct identifiers are scrubbed at capture
   (observability/redact.mjs); the PII-scan test plants child names and
   proves they cannot reach logs/metrics/errors. The #66 observability
   doc remains the detailed authority.
3. **Flows out are exactly two third parties + stores** — SMTP provider
   (parent email only, classes 1+16) and app-store distribution. No ad
   networks, analytics vendors, data brokers, or SDK-based flows (see
   families-kids-self-check layer 1).
4. **Deletion truth** — #62 deletion removes every C-subject class for
   the child (6–15) with password re-auth, lands in class 20; export and
   deletion share the ownership guard.
5. **Consent coverage** — no C-subject row can be created without a
   current-version consent record (suite-end invariant, re-verified
   post-M3–M5 on this branch).

## Store-form mapping hints (#69 will finalize)

- "Personal info" (Apple) / "Personal info" (Play): email (P), name
  (nickname — C, app functionality), address: none, phone: none.
- "Photos/videos/audio": none collected (device TTS/speech is generated,
  not stored; audio duration metadata only within class 8).
- "App activity" (Play): app interactions/history — classes 8–11 (C,
  app functionality, linked to identity, parental-consented).
- "Diagnostics": classes 17–19 (S, not linked to identity — truncated
  IPs + surrogate IDs).
- "Data shared": SMTP provider (email address, class 1+16 only).
  Everything else: no sharing.
- "Data encryption": in transit (TLS) — yes, all network paths.
- "Deletion": in-app self-serve (#62 routes, parent-authenticated).
- Draft caveats: `[BACKUP_RETENTION_PLACEHOLDER]` in the privacy policy
  must be answered (backup window) before the forms are filed.
