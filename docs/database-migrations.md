# Database Migration Ledger

Served datastore: **PostgreSQL** (roadmap decision D2). Migrations live in
`services/api/migrations/`, run with [node-pg-migrate](https://github.com/salsita/node-pg-migrate),
and are applied automatically (and idempotently) at API startup. The
SQLite schema under `services/api/sqlite/` is the on-device offline-store
reference only and is intentionally not executed by the server.

## How to run

```bash
# Automatic at boot (recommended; migrations + registry seed are idempotent):
DATABASE_URL=postgres://... node services/api/server.mjs

# Manual ops commands:
cd services/api
npm run migrate         # apply all pending
npm run migrate:down    # roll back the last one
```

Every migration must be reversible: `down` is mandatory. Registry seeding
(grades, units, skill topics, 6,140 practice questions) is idempotent and
re-runs only when the questions table is below its expected size.

## Ledger

| Version | Date | Description | Author |
| --- | --- | --- | --- |
| 001 | 2026-10-21 | Initial schema port from the SQLite reference (`services/api/sqlite/001_schema.sql`): grades, units, skill_topics, practice_questions, students, student_sessions, student_unit_progress, student_topic_progress, student_question_attempts. Dialect changes: `AUTOINCREMENT` -> `GENERATED ALWAYS AS IDENTITY`; explicit composite primary keys on the progress tables. | delivery pipeline (issue #30) |
| 002 | 2026-10-23 | Parent accounts and COPPA consent groundwork (roadmap D4): `parents` (case-insensitively unique email via a functional unique index on `LOWER(email)`, scrypt-format `password_hash`, `email_verified_at` NULL until #40), `parent_children` (composite PK `(parent_id, student_id)`, `relation`, `status` default `claimed`, `claimed_at`), `consent_records` (`policy_version`, `captured_at`, `method`; both FKs `ON DELETE RESTRICT` so consent evidence is never cascade-deleted — #62 handles retention explicitly; `student_id` nullable until #42), `devices` (unique `(parent_id, client_device_id)`, `platform`, `last_seen_at`), and the `audit_students_without_consent` view enumerating students without a matching consent record (pre-#41 baseline). New timestamps are `timestamptz` (Postgres-native tables; 001's TEXT timestamps are a SQLite-port artifact). Schema-only: no route, seed, or dev-data changes; parents exist only via #40 signup. | delivery pipeline (issue #39) |

## Rules

1. One migration per schema change; never edit an applied migration.
2. Add a ledger row in the same PR as the migration (roadmap D11).
3. `up` and `down` must both work on a database seeded with production-shaped data.
4. Breaking changes follow expand/contract: add the new shape, migrate
   data, then remove the old shape in a later migration.
