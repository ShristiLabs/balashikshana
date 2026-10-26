/**
 * On-device lifecycle-DB schema tests (issue #46): the versioned
 * user_version migrations in src/content/schema.ts applied to a REAL
 * SQLite database (node:sqlite mirrors expo-sqlite's DDL engine), using
 * the same runner semantics as migrateContentDb in nativeContent.ts.
 *
 * Guards:
 * - fresh install reaches user_version 1 with every #47-facing table
 * - re-running is idempotent (IF NOT EXISTS + version gate)
 * - pack_meta's CHECK forces status='active' (fail-closed lifecycle)
 * - the native seam's column list matches schema.ts exactly (drift tripwire)
 * - a database from a NEWER app version is left untouched (no downgrade)
 */
// node:sqlite is a Node 22 built-in the expo eslint import resolver does
// not know yet; the runtime import is real (test script enables the flag).
 
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTENT_DB_MIGRATIONS, CONTENT_DB_NAME } from "../src/content/schema";

// Mirrors migrateContentDb (nativeContent.ts): apply each migration whose
// version is newer than the database's PRAGMA user_version, then stamp it.
function runMigrations(db: DatabaseSync): void {
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version;
  let at = current;
  for (const migration of CONTENT_DB_MIGRATIONS) {
    if (migration.version <= at) continue;
    for (const statement of migration.statements) {
      db.exec(statement);
    }
    db.exec(`PRAGMA user_version = ${migration.version}`);
    at = migration.version;
  }
}

const tmpDbs: string[] = [];

function freshDb(): { db: DatabaseSync; file: string } {
  const file = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "content-schema-")),
    CONTENT_DB_NAME,
  );
  tmpDbs.push(file);
  return { db: new DatabaseSync(file), file };
}

afterEach(() => {
  for (const file of tmpDbs) fs.rmSync(path.dirname(file), { recursive: true, force: true });
  tmpDbs.length = 0;
});

describe("CONTENT_DB_MIGRATIONS invariants", () => {
  it("is a strictly increasing version list starting at 1 with real statements", () => {
    expect(CONTENT_DB_MIGRATIONS.length).toBeGreaterThan(0);
    expect(CONTENT_DB_MIGRATIONS[0]?.version).toBe(1);
    for (let i = 1; i < CONTENT_DB_MIGRATIONS.length; i += 1) {
      expect(CONTENT_DB_MIGRATIONS[i]!.version).toBeGreaterThan(
        CONTENT_DB_MIGRATIONS[i - 1]!.version,
      );
    }
    for (const migration of CONTENT_DB_MIGRATIONS) {
      expect(migration.statements.length).toBeGreaterThan(0);
      for (const statement of migration.statements) {
        expect(typeof statement).toBe("string");
        expect(statement.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("lifecycle DB migrations on real SQLite", () => {
  it("migrates a fresh database to the latest user_version with every table and index", () => {
    const { db } = freshDb();
    runMigrations(db);
    const latest = CONTENT_DB_MIGRATIONS[CONTENT_DB_MIGRATIONS.length - 1]!.version;
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      latest,
    );

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    for (const table of [
      "pack_meta",
      "attempt_log",
      "topic_progress",
      "unit_progress",
      "gamification_state",
      // #56: append-only hearts session outcomes.
      "session_outcomes",
      // #57: device-local parent reminder settings (singleton).
      "reminder_settings",
    ]) {
      expect(tables).toContain(table);
    }

    const indexes = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
          .all() as { name: string }[]
      ).map((r) => r.name),
    );
    expect(indexes.has("idx_pack_meta_grade")).toBe(true);
    expect(indexes.has("idx_attempt_log_student")).toBe(true);
    // Partial index over unsynced rows only (#48 sync flag).
    expect(indexes.has("idx_attempt_log_unsynced")).toBe(true);
    // #47: ordered drain cursor for the #48 sync worker.
    expect(indexes.has("idx_attempt_log_drain")).toBe(true);
    // #56: the outcomes' own drain cursor + exactly-once unique key.
    expect(indexes.has("idx_session_outcomes_drain")).toBe(true);
    const uniqueIndexes = new Set(
      (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'uq_%'")
          .all() as { name: string }[]
      ).map((r) => r.name),
    );
    expect(uniqueIndexes.has("uq_session_outcomes_session")).toBe(true);
    db.close();
  });

  it("is idempotent: re-running preserves data and the version", () => {
    const { db } = freshDb();
    runMigrations(db);
    db.prepare(
      "INSERT INTO pack_meta (grade_id, content_version, format_version, status, artifact, size_bytes, sha256, key_id, installed_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)",
    ).run("pre-k", "1.0.0", 1, "pack-pre-k-v1.0.0.sqlite", 2048, "a".repeat(64), "dev-local", 42);
    runMigrations(db); // second device launch
    const latest = CONTENT_DB_MIGRATIONS[CONTENT_DB_MIGRATIONS.length - 1]!.version;
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      latest,
    );
    expect((db.prepare("SELECT COUNT(*) n FROM pack_meta").get() as { n: number }).n).toBe(1);
    db.close();
  });

  it("pack_meta columns match the native seam exactly (drift tripwire)", () => {
    const { db } = freshDb();
    runMigrations(db);
    const columns = (db.prepare("PRAGMA table_info(pack_meta)").all() as { name: string }[])
      .map((r) => r.name)
      .sort();
    // Must equal the column list nativeContent.ts META_COLUMNS + status.
    expect(columns).toEqual(
      [
        "grade_id",
        "content_version",
        "format_version",
        "status",
        "artifact",
        "size_bytes",
        "sha256",
        "key_id",
        "installed_at",
      ].sort(),
    );
    // Composite primary key on (grade_id, content_version) — the seam's
    // ON CONFLICT (grade_id, content_version) relies on it.
    const pk = (db.prepare("PRAGMA table_info(pack_meta)").all() as { name: string; pk: number }[])
      .filter((c) => c.pk > 0)
      .map((c) => c.name)
      .sort();
    expect(pk).toEqual(["content_version", "grade_id"]);
    db.close();
  });

  it("rejects non-active pack_meta status rows (CHECK constraint)", () => {
    const { db } = freshDb();
    runMigrations(db);
    const insert = (status: string) =>
      db
        .prepare(
          "INSERT INTO pack_meta (grade_id, content_version, format_version, status, artifact, size_bytes, sha256, key_id, installed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("pre-k", "1.0.0", 1, status, "pack-pre-k-v1.0.0.sqlite", 1, "a".repeat(64), "k", 1);
    expect(() => insert("active")).not.toThrow();
    expect(() => insert("retired")).toThrow();
    db.close();
  });

  it("attempt_log is append-only shaped with defaults (#47 will write it)", () => {
    const { db } = freshDb();
    runMigrations(db);
    const stmt = db.prepare(
      "INSERT INTO attempt_log (student_id, topic_id, question_id, interaction_type, is_correct, cognitive_time_sec, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const first = stmt.run("s1", "t1", "q1", "tap-target", 1, 3.5, 1000);
    const second = stmt.run("s1", "t1", "q2", "tap-target", 0, 5.0, 1001);
    expect(second.lastInsertRowid).toBeGreaterThan(first.lastInsertRowid);
    const row = db
      .prepare("SELECT synced, audio_duration_sec FROM attempt_log WHERE id = ?")
      .get(first.lastInsertRowid) as { synced: number; audio_duration_sec: number };
    expect(row.synced).toBe(0);
    expect(row.audio_duration_sec).toBe(0);
    db.close();
  });

  it("upgrades a v1 database in place to v2, preserving rows and adding the #47 columns", () => {
    const { db } = freshDb();
    // A #46-era device: only migration 1 has run, and it holds real rows.
    db.exec(CONTENT_DB_MIGRATIONS[0]!.statements.join("; "));
    db.exec("PRAGMA user_version = 1");
    db.prepare(
      "INSERT INTO attempt_log (student_id, topic_id, question_id, interaction_type, is_correct, cognitive_time_sec, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run("s1", "K-M1-A", "K-M1-A-Q1", "tap-target", 1, 3.5, 1000);
    db.prepare(
      "INSERT INTO topic_progress (student_id, topic_id, unit_id, attempts_count, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("s1", "K-M1-A", "K-M1", 2, 1234);
    db.prepare(
      "INSERT INTO unit_progress (student_id, unit_id, status, key_state, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).run("s1", "K-M1", "in_progress", null, 1234);

    runMigrations(db); // the #47/#48 app version opens the same device
    const latest = CONTENT_DB_MIGRATIONS[CONTENT_DB_MIGRATIONS.length - 1]!.version;
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      latest,
    );
    // v1 rows survived the ALTERs.
    expect((db.prepare("SELECT COUNT(*) n FROM attempt_log").get() as { n: number }).n).toBe(1);
    const attempt = db.prepare("SELECT * FROM attempt_log").get() as Record<string, unknown>;
    expect(attempt.unit_id).toBe("");
    expect(attempt.session_type).toBe("TOPIC_PRACTICE");
    expect(attempt.session_id).toBe("");
    expect(attempt.raw_time_sec).toBe(0);
    expect(attempt.fluency_grade).toBe(0);
    expect(attempt.misconception_tags_json).toBe("[]");
    expect(attempt.chosen_answer).toBe("");
    // v3 (#48): pre-existing rows backfill to the mobile default motor
    // baseline so server replay reproduces the engine math.
    expect(attempt.motor_baseline_sec).toBe(0.42);
    const topic = db.prepare("SELECT * FROM topic_progress").get() as Record<string, unknown>;
    expect(topic.stability_days).toBe(1.0);
    expect(topic.provisional).toBe(0);
    const unit = db.prepare("SELECT * FROM unit_progress").get() as Record<string, unknown>;
    expect(unit.silver_awarded_at).toBe(0);
    expect(unit.gold_verified_at).toBe(0);
    expect(unit.cpa_stage).toBe("CONCRETE_INTERACTIVE");
    db.close();
  });

  it("upgrades a v3-era database in place to v4 (#52), backfilling the game telemetry defaults", () => {
    const { db } = freshDb();
    // A #48-era device: migrations 1-3 have run, attempt_log holds real
    // rows WITHOUT the four game telemetry columns.
    for (const migration of CONTENT_DB_MIGRATIONS.filter((m) => m.version <= 3)) {
      for (const statement of migration.statements) db.exec(statement);
      db.exec(`PRAGMA user_version = ${migration.version}`);
    }
    db.prepare(
      `INSERT INTO attempt_log (
         student_id, topic_id, question_id, interaction_type, is_correct,
         cognitive_time_sec, answered_at, synced,
         unit_id, session_type, session_id, raw_time_sec, fluency_grade,
         misconception_tags_json, chosen_answer, motor_baseline_sec
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "s1",
      "K-M1-A",
      "K-M1-A-Q1",
      "tap-target",
      1,
      3.5,
      1000,
      "K-M1",
      "GATE",
      "sess-1",
      4.2,
      3,
      "[]",
      "7",
      0.42,
    );

    runMigrations(db); // the #60 app version opens the same device
    const latest = CONTENT_DB_MIGRATIONS[CONTENT_DB_MIGRATIONS.length - 1]!.version;
    expect(latest).toBe(8);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      8,
    );
    // The pre-game row survived and backfilled to the documented
    // defaults: empty provenance string (NOT NULL ''), zero target,
    // empty archetype, fallback marker 0.
    expect((db.prepare("SELECT COUNT(*) n FROM attempt_log").get() as { n: number }).n).toBe(1);
    const row = db.prepare("SELECT * FROM attempt_log").get() as Record<string, unknown>;
    expect(row.game_spiral_provenance).toBe("");
    expect(row.game_target_speed_sec).toBe(0);
    expect(row.game_archetype).toBe("");
    expect(row.game_fallback).toBe(0);
    // New rows may write every telemetry column against the same table.
    db.prepare(
      `INSERT INTO attempt_log (
         student_id, topic_id, question_id, interaction_type, is_correct,
         cognitive_time_sec, answered_at, synced,
         unit_id, session_type, session_id, raw_time_sec, fluency_grade,
         misconception_tags_json, chosen_answer, motor_baseline_sec,
         game_spiral_provenance, game_target_speed_sec, game_archetype, game_fallback
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 'contrastive', 5.5, 'block-builder', 0)`,
    ).run(
      "s1",
      "K-M1-A",
      "K-M1-A-Q2",
      "tap-target",
      1,
      3.5,
      1001,
      "K-M1",
      "GAME",
      "sess-2",
      4.2,
      3,
      "[]",
      "7",
      0.42,
    );
    const gameRow = db.prepare("SELECT * FROM attempt_log WHERE id = 2").get() as Record<
      string,
      unknown
    >;
    expect(gameRow.game_spiral_provenance).toBe("contrastive");
    expect(gameRow.game_target_speed_sec).toBe(5.5);
    expect(gameRow.game_archetype).toBe("block-builder");
    db.close();
  });

  it("v2 attempt_log columns carry the synced-flag contract untouched", () => {
    const { db } = freshDb();
    runMigrations(db);
    db.prepare(
      `INSERT INTO attempt_log (
         student_id, topic_id, question_id, interaction_type, is_correct,
         cognitive_time_sec, answered_at, synced,
         unit_id, session_type, session_id, raw_time_sec, fluency_grade,
         misconception_tags_json, chosen_answer
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "s1",
      "K-M1-A",
      "K-M1-A-Q1",
      "tap-target",
      1,
      3.5,
      1000,
      "K-M1",
      "GATE",
      "sess-1",
      4.2,
      3,
      '["a"]',
      "7",
    );
    const row = db.prepare("SELECT * FROM attempt_log WHERE id = 1").get() as Record<
      string,
      unknown
    >;
    expect(row.synced).toBe(0);
    expect(row.session_id).toBe("sess-1");
    expect(row.fluency_grade).toBe(3);
    db.close();
  });

  it("leaves a database from a NEWER app version untouched (no downgrade)", () => {
    const { db } = freshDb();
    runMigrations(db);
    // Simulate a future #47 migration having run on this device.
    db.exec("ALTER TABLE attempt_log ADD COLUMN future_flag INTEGER NOT NULL DEFAULT 0");
    db.exec(`PRAGMA user_version = ${CONTENT_DB_MIGRATIONS.length + 1}`);
    runMigrations(db); // older app binary opens the same DB
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      CONTENT_DB_MIGRATIONS.length + 1,
    );
    const columns = (db.prepare("PRAGMA table_info(attempt_log)").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(columns).toContain("future_flag");
    db.close();
  });
});
