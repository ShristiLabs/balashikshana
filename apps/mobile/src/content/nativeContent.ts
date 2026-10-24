/**
 * React-native content-pack bindings (issue #46).
 *
 * The ONLY module in the content tree that imports native modules
 * (expo-file-system, expo-sqlite, global fetch); every pure module above
 * stays node-testable. Platform decisions:
 *
 * - Pack directory: Paths.document/content-packs — app-owned storage the
 *   OS will not purge, same volume as staging so the final publish is a
 *   single atomic rename (never a half-installed pack).
 * - Downloads stream natively into the staging file (expo-file-system
 *   downloadFileAsync): zero JS-thread byte pumping for multi-MB packs.
 * - SHA-256 uses the native file digest; Ed25519 verification runs pure-JS
 *   (@noble/ed25519) over the staged bytes off the render critical path.
 * - Pack artifacts open through expo-sqlite with PRAGMA query_only set:
 *   content rows are READ, never written, on-device.
 * - The lifecycle DB (balashikshana_content.db) runs versioned migrations
 *   via PRAGMA user_version (schema.ts); #47 extends the same database.
 */
import { Directory, File, Paths } from "expo-file-system";
import * as SQLite from "expo-sqlite";
import { parseManifestIndex } from "./manifest";
import { trustedKeysForEnvironment } from "./keys";
import { CONTENT_DB_MIGRATIONS, CONTENT_DB_NAME } from "./schema";
import { ContentPackService } from "./service";
import type { ContentPackDeps, PackInfoRow, PackMetaRow } from "./types";

const PACK_DIR_NAME = "content-packs";
const ONBOARDING_DB = "balashikshana_onboarding.db";

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

function packDir(): Directory {
  const dir = new Directory(Paths.document, PACK_DIR_NAME);
  if (!dir.exists) dir.create({ idempotent: true });
  return dir;
}

function packFile(fileName: string): File {
  return new File(packDir(), fileName);
}

async function migrateContentDb(db: SQLite.SQLiteDatabase): Promise<void> {
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

async function openContentDb(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(CONTENT_DB_NAME);
  await migrateContentDb(db);
  return db;
}

function createMetaSeam(): ContentPackDeps["meta"] {
  // The DB handle opens lazily on first use; the constructor stays sync.
  let store: Promise<SQLite.SQLiteDatabase> | null = null;
  const db = () => (store ??= openContentDb());
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

export function createNativeContentDeps(options: {
  apiBaseUrl: string;
  isDev: boolean;
}): ContentPackDeps {
  const base = options.apiBaseUrl.replace(/\/+$/, "");
  return {
    async fetchIndex() {
      try {
        const res = await fetch(`${base}/api/content/packs`);
        if (!res.ok) return null;
        return parseManifestIndex(await res.json());
      } catch {
        return null;
      }
    },
    async download(url, fileName) {
      const destination = packFile(fileName);
      if (destination.exists) destination.delete();
      await File.downloadFileAsync(url, destination);
    },
    async fileSize(fileName) {
      const file = packFile(fileName);
      return file.exists ? (file.size ?? null) : null;
    },
    async sha256Hex(fileName) {
      const file = packFile(fileName);
      if (!file.exists) return null;
      try {
        return await file.digest("SHA-256");
      } catch {
        return null;
      }
    },
    async readBytes(fileName) {
      const file = packFile(fileName);
      if (!file.exists) return null;
      return await file.bytes();
    },
    async move(fromFileName, toFileName) {
      await packFile(fromFileName).move(packFile(toFileName), { overwrite: true });
    },
    async deleteFile(fileName) {
      const file = packFile(fileName);
      if (file.exists) file.delete();
    },
    async exists(fileName) {
      return packFile(fileName).exists;
    },
    async listArtifacts() {
      return packDir()
        .list()
        .filter(
          (entry): entry is File =>
            entry instanceof File && entry.name.endsWith(".sqlite") && !entry.name.startsWith("."),
        )
        .map((file) => file.name);
    },
    async openPackInfo(fileName): Promise<PackInfoRow | null> {
      const dir = packDir();
      const db = await SQLite.openDatabaseAsync(fileName, { useNewConnection: true }, dir.uri);
      try {
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
      } finally {
        await db.closeAsync();
      }
    },
    meta: createMetaSeam(),
    trustedKeys: trustedKeysForEnvironment(options.isDev),
    packUrl: (gradeId: string) => `${base}/api/content/packs/${gradeId}`,
    now: () => Date.now(),
    log: (message, extra) => {
      // First-party, PII-free diagnostics only (COPPA: no child data here).
      console.warn(`[content] ${message}`, extra ?? {});
    },
  };
}

/**
 * The active grade, read from the onboarding snapshot (read-only peek at
 * the #44 store; #47 introduces the real learner-profile state).
 */
export async function loadActiveGrade(): Promise<string | null> {
  try {
    const db = await SQLite.openDatabaseAsync(ONBOARDING_DB);
    try {
      const rows = await db.getAllAsync<{ snapshot: string }>(
        "SELECT snapshot FROM onboarding_state WHERE id = 1",
      );
      const snapshot = rows[0]?.snapshot
        ? (JSON.parse(rows[0].snapshot) as { gradeId?: string })
        : null;
      return snapshot?.gradeId ?? null;
    } finally {
      await db.closeAsync();
    }
  } catch {
    return null;
  }
}

let serviceSingleton: ContentPackService | null = null;

/** Lazy singleton (failed-init retry mirrors the audio service doctrine). */
export function getContentPackService(apiBaseUrl: string): ContentPackService {
  if (serviceSingleton === null) {
    const isDev = typeof __DEV__ !== "undefined" ? __DEV__ : false;
    serviceSingleton = new ContentPackService(createNativeContentDeps({ apiBaseUrl, isDev }));
  }
  return serviceSingleton;
}
