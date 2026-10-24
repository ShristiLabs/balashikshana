# On-Device SQLite Schema (reference only)

`001_schema.sql` is the SQLite schema for the future on-device offline
store (roadmap D2: SQLite stays on-device; the served datastore is
PostgreSQL, managed under `../migrations/`). It is kept here as the
canonical reference for the M3 mobile-client content packs and is not
executed by any server code. Since #46, the content-pack compiler
(`tools/content-pipeline/src/packDb.mjs`) implements this column
contract — its `practice_questions` rows mirror these columns exactly —
when writing the signed per-grade pack artifacts.
