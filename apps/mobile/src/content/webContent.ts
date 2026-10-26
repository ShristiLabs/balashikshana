/**
 * Web content-pack bindings (issue #71): ContentPackDeps over browser
 * storage. The SAME ContentPackService logic runs unchanged — signed
 * packs download through fetch, stage as raw bytes in the web pack
 * store (IndexedDB; memory fallback when storage is blocked), verify
 * with the SAME @noble/ed25519 + SHA-256 checks (verify.ts is pure JS),
 * and publish by store rename. Pack artifacts open read-only through
 * sql.js (platform/sqlite.web.ts) — byte-identical .sqlite files.
 *
 * Differences vs native, honestly held (docs/web-export.md matrix):
 * - No streaming download: fetch buffers pack bytes in JS (multi-MB is
 *   fine over the multi-MB budget; Chromebook RAM tolerates it).
 * - "Atomic rename" is a store-key swap (same never-half-installed
 *   guarantee: the meta row only ever points at fully verified bytes).
 */
import { sha256 } from "@noble/hashes/sha2.js";
import * as SQLite from "../platform/sqlite";
import { openPackArtifact } from "../platform/packdb";
import {
  deletePackBytes,
  getPackBytes,
  listPackArtifactNames,
  putPackBytes,
} from "../platform/webStorage";
import {
  createSharedMetaSeam as createMetaSeam,
  migrateLifecycleDb,
  readPackInfoRow,
} from "./sharedContent";
import { parseManifestIndex } from "./manifest";
import { trustedKeysForEnvironment } from "./keys";
import { CONTENT_DB_NAME } from "./schema";
import type { ContentPackDeps } from "./types";

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

let lifecycleDbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function openLifecycleDb(): Promise<SQLite.SQLiteDatabase> {
  lifecycleDbPromise ??= (async () => {
    const db = await SQLite.openDatabaseAsync(CONTENT_DB_NAME);
    await migrateLifecycleDb(db);
    return db;
  })();
  return lifecycleDbPromise;
}

export function createWebContentDeps(options: {
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
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`pack download failed: ${res.status}`);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      await putPackBytes(fileName, bytes);
    },
    async fileSize(fileName) {
      const bytes = await getPackBytes(fileName);
      return bytes ? bytes.length : null;
    },
    async sha256Hex(fileName) {
      const bytes = await getPackBytes(fileName);
      return bytes ? hex(sha256(bytes)) : null;
    },
    async readBytes(fileName) {
      return getPackBytes(fileName);
    },
    async move(fromFileName, toFileName) {
      const bytes = await getPackBytes(fromFileName);
      if (bytes === null) throw new Error(`pack not staged: ${fromFileName}`);
      await putPackBytes(toFileName, bytes);
      await deletePackBytes(fromFileName);
    },
    async deleteFile(fileName) {
      await deletePackBytes(fileName);
    },
    async exists(fileName) {
      return (await getPackBytes(fileName)) !== null;
    },
    async listArtifacts() {
      return listPackArtifactNames();
    },
    async openPackInfo(fileName) {
      const db = await openPackArtifact(fileName);
      try {
        return await readPackInfoRow(db);
      } finally {
        await db.closeAsync();
      }
    },
    meta: createMetaSeam(openLifecycleDb),
    trustedKeys: trustedKeysForEnvironment(options.isDev),
    packUrl: (gradeId) => `${base}/api/content/packs/${gradeId}`,
    now: () => Date.now(),
    log: (message, extra) => {
      // First-party, PII-free diagnostics only (COPPA: no child data here).
      console.warn(`[content:web] ${message}`, extra ?? {});
    },
  };
}
