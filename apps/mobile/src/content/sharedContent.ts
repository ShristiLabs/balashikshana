/**
 * Shared content-pack SQL helpers (issue #71) — PURE: no react-native,
 * no expo modules, node-testable. The lifecycle-DB migrations, the
 * pack_info reader, and the pack-meta seam run identically over BOTH
 * storage backends (expo-sqlite native, sql.js web) — one schema, one
 * SQL, two backends. The platform deps twins (nativeContent.ts,
 * webContent.ts) both build on this module; nothing here may import a
 * platform seam. Moved verbatim from nativeContent.ts (the pre-#71
 * single-platform home) so the web twin shares the SAME code instead of
 * forking it.
 */
import type * as SQLite from "../platform/sqlite";
import { CONTENT_DB_MIGRATIONS } from "./schema";
import type { ContentPackDeps, PackInfoRow, PackMetaRow } from "./types";

type MetaSqlRow = {
  grade_id: string;
  content_version: string;
  format_version: number;
  artifact: string;
  size_bytes: number;
  sha256: string;
  key_id: string;
  installed_at: number;
};

const META_COLUMNS =
  "grade_id, content_version, format_version, artifact, size_bytes, sha256, key_id, installed_at";

function rowToMeta(row: MetaSqlRow): PackMetaRow {
  return {
    gradeId: row.grade_id,
    contentVersion: row.content_version,
    formatVersion: row.format_version,
    status: "active",
    artifact: row.artifact,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    keyId: row.key_id,
    installedAt: row.installed_at,
  };
}

/** Run the lifecycle-DB versioned migrations over any SQL seam. */
export async function migrateLifecycleDb(db: SQLite.SQLiteDatabase): Promise<void> {
  const rows = await db.getAllAsync<{ user_version: number }>("PRAGMA user_version");
  let current = rows[0]?.user_version ?? 0;
  for (const migration of CONTENT_DB_MIGRATIONS) {
    if (migration.version <= current) continue;
    for (const statement of migration.statements) {
      await db.execAsync(statement);
    }
    await db.execAsync(`PRAGMA user_version = ${migration.version}`);
    current = migration.version;
  }
}

/**
 * Read the pack_info row from any SQL seam (pack artifacts are read
 * with query_only set by doctrine).
 */
export async function readPackInfoRow(db: SQLite.SQLiteDatabase): Promise<PackInfoRow | null> {
  await db.execAsync("PRAGMA query_only = ON");
  const rows = await db.getAllAsync<{
    pack_format_version: number;
    pack_schema_version: number;
    grade_id: string;
    grade_name: string;
    content_version: string;
    registry_version: string;
    unit_count: number;
    topic_count: number;
    question_count: number;
  }>(
    "SELECT pack_format_version, pack_schema_version, grade_id, grade_name, content_version, registry_version, unit_count, topic_count, question_count FROM pack_info WHERE id = 1",
  );
  const row = rows[0];
  if (!row) return null;
  return {
    packFormatVersion: row.pack_format_version,
    packSchemaVersion: row.pack_schema_version,
    gradeId: row.grade_id,
    gradeName: row.grade_name,
    contentVersion: row.content_version,
    registryVersion: row.registry_version,
    unitCount: row.unit_count,
    topicCount: row.topic_count,
    questionCount: row.question_count,
  };
}

/**
 * The pack-meta lifecycle seam over any SQL opener (native or web) —
 * one schema, one SQL, two storage backends (#71).
 */
export function createSharedMetaSeam(
  openDb: () => Promise<SQLite.SQLiteDatabase>,
): ContentPackDeps["meta"] {
  // The DB handle opens lazily on first use; the constructor stays sync.
  let store: Promise<SQLite.SQLiteDatabase> | null = null;
  const db = () => (store ??= openDb());
  return {
    async getActive(gradeId: string) {
      const rows = await (
        await db()
      ).getAllAsync<MetaSqlRow>(
        `SELECT ${META_COLUMNS} FROM pack_meta WHERE grade_id = ? ORDER BY installed_at DESC LIMIT 1`,
        [gradeId],
      );
      const row = rows[0];
      return row ? rowToMeta(row) : null;
    },
    async upsert(row: PackMetaRow) {
      await (
        await db()
      ).runAsync(
        `INSERT INTO pack_meta (grade_id, content_version, format_version, status, artifact, size_bytes, sha256, key_id, installed_at)
         VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?)
         ON CONFLICT(grade_id, content_version) DO UPDATE SET
           status = 'active', artifact = excluded.artifact, size_bytes = excluded.size_bytes,
           sha256 = excluded.sha256, key_id = excluded.key_id, installed_at = excluded.installed_at`,
        [
          row.gradeId,
          row.contentVersion,
          row.formatVersion,
          row.artifact,
          row.sizeBytes,
          row.sha256,
          row.keyId,
          row.installedAt,
        ],
      );
    },
    async all() {
      const rows = await (
        await db()
      ).getAllAsync<MetaSqlRow>(`SELECT ${META_COLUMNS} FROM pack_meta`);
      return rows.map(rowToMeta);
    },
    async remove(gradeId: string, contentVersion: string) {
      await (
        await db()
      ).runAsync("DELETE FROM pack_meta WHERE grade_id = ? AND content_version = ?", [
        gradeId,
        contentVersion,
      ]);
    },
  };
}
