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
// eslint-disable-next-line import/no-unresolved
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
  it("migrates a fresh database to user_version 1 with every table and index", () => {
    const { db } = freshDb();
    runMigrations(db);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      1,
    );

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    for (const table of ["pack_meta", "attempt_log", "topic_progress", "unit_progress"]) {
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
    db.close();
  });

  it("is idempotent: re-running preserves data and the version", () => {
    const { db } = freshDb();
    runMigrations(db);
    db.prepare(
      "INSERT INTO pack_meta (grade_id, content_version, format_version, status, artifact, size_bytes, sha256, key_id, installed_at) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)",
    ).run("pre-k", "1.0.0", 1, "pack-pre-k-v1.0.0.sqlite", 2048, "a".repeat(64), "dev-local", 42);
    runMigrations(db); // second device launch
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      1,
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
