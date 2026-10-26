/**
 * React-native content-pack bindings (issue #46).
 *
 * The ONLY module in the content tree that imports native modules
 * (expo-file-system; SQL routes through the platform twin since #71);
 * every pure module above stays node-testable. Platform decisions:
 *
 * - Pack directory: Paths.document/content-packs — app-owned storage the
 *   OS will not purge, same volume as staging so the final publish is a
 *   single atomic rename (never a half-installed pack).
 * - Downloads stream natively into the staging file (expo-file-system
 *   downloadFileAsync): zero JS-thread byte pumping for multi-MB packs.
 * - SHA-256 uses the native file digest; Ed25519 verification runs pure-JS
 *   (@noble/ed25519) over the staged bytes off the render critical path.
 * - Pack artifacts open through the SQL seam with PRAGMA query_only set:
 *   content rows are READ, never written, on-device.
 * - The lifecycle DB (balashikshana_content.db) runs versioned migrations
 *   via PRAGMA user_version (schema.ts); #47 extends the same database.
 *
 * Since #71 the SAME service runs on web: getContentPackService() below
 * dispatches to createWebContentDeps (browser-storage pack store) when
 * Platform.OS === "web" — same ContentPackService logic, same signed
 * packs, different storage seams. No screen code forks.
 */
import { Directory, File, Paths } from "expo-file-system";
import { Platform } from "react-native";
import * as SQLite from "../platform/sqlite";
import { openPackArtifact } from "../platform/packdb";
import { createWebContentDeps } from "./webContent";
import {
  createSharedMetaSeam as createMetaSeam,
  migrateLifecycleDb,
  readPackInfoRow,
} from "./sharedContent";
import { parseManifestIndex } from "./manifest";
import { contentTrustIsDev, trustedKeysForEnvironment } from "./keys";
import { CONTENT_DB_NAME } from "./schema";
import { ContentPackService } from "./service";
import type { ContentPackDeps, PackInfoRow } from "./types";

// Shared pure helpers (moved to sharedContent.ts in #71 so the web deps
// twin runs the SAME SQL): re-exported here for existing importers.
export { migrateLifecycleDb as migrateLifecycleDbOn, readPackInfoRow } from "./sharedContent";

const PACK_DIR_NAME = "content-packs";
const ONBOARDING_DB = "balashikshana_onboarding.db";

function packDir(): Directory {
  const dir = new Directory(Paths.document, PACK_DIR_NAME);
  if (!dir.exists) dir.create({ idempotent: true });
  return dir;
}

/** The on-device pack directory (shared with the #47 practice reader). */
export function contentPackDirectory(): Directory {
  return packDir();
}

function packFile(fileName: string): File {
  return new File(packDir(), fileName);
}

async function openContentDb(): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(CONTENT_DB_NAME);
  await migrateLifecycleDb(db);
  return db;
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
      const db = await openPackArtifact(fileName);
      try {
        return await readPackInfoRow(db);
      } finally {
        await db.closeAsync();
      }
    },
    meta: createMetaSeam(openContentDb),
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
    const isDev = contentTrustIsDev(typeof __DEV__ !== "undefined" ? __DEV__ : false);
    const deps =
      Platform.OS === "web"
        ? createWebContentDeps({ apiBaseUrl, isDev })
        : createNativeContentDeps({ apiBaseUrl, isDev });
    serviceSingleton = new ContentPackService(deps);
  }
  return serviceSingleton;
}
