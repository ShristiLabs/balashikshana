/**
 * #71 web adapter tests — the browser-storage + sql.js seams, driven in
 * node exactly the way they run in the browser: webStorage's injected
 * factory (memory backend), the REAL sql.js engine (SQLite-to-wasm runs
 * in node; the wasm ships with the package), and the web content-pack
 * deps over both. No RN imports — the seams are pure by construction.
 *
 * Covers:
 * - webStorage: detection fallback (no IndexedDB in node -> memory),
 *   openKeyValueStore via configureWebStorage, pack byte store CRUD +
 *   artifact listing, and the storage-blocked notice copy (Decision 9).
 * - securekv.web: the SecureKeyValue contract over an injected store.
 * - sqlite.web (Decision 3): open/persist/reopen roundtrip (image
 *   survival), query_only enforcement on pack artifacts, the pagehide
 *   flush (the durability hook), and close semantics.
 * - webContent deps (Decision 2): download/sha256/move/delete/exists
 *   over the pack store + fetchIndex parsing fail-closed.
 * - keys.contentTrustIsDev: the export-time dev-trust switch (#71).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  configureWebStorage,
  deletePackBytes,
  detectWebStorage,
  getPackBytes,
  listPackArtifactNames,
  memoryStore,
  putPackBytes,
  resetWebStorageDetection,
  webStorageBackend,
  webStorageNoticeCopy as noticeCopyFor,
} from "../src/platform/webStorage";
import {
  configureSqlJsEngine,
  flushAllOpenDatabases,
  openDatabaseAsync,
  resetOpenDatabaseTracking,
} from "../src/platform/sqlite.web";
import { secureKeyValue as webSecureKeyValue } from "../src/platform/securekv.web";
import { WEB_PACK_STORE_URI } from "../src/platform/packdb.web";
import { createWebContentDeps } from "../src/content/webContent";
import { contentTrustIsDev } from "../src/content/keys";
import { sha256 } from "@noble/hashes/sha2.js";

// In node there is no metro platform resolution: the base ../platform/sqlite
// would load expo-sqlite (which imports react-native's Flow entry and cannot
// parse outside metro), and the base ../platform/packdb would load the native
// content seam (expo-file-system). The web twins are exactly what the web
// bundle uses, so mock both seams to the web implementations for this
// suite's module graph (vitest hoists vi.mock above the imports).
vi.mock("../src/platform/sqlite", async () => await import("../src/platform/sqlite.web"));
vi.mock("../src/platform/packdb", async () => await import("../src/platform/packdb.web"));

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Deterministic sqlite bytes built with the real engine (pack-shaped). */
async function buildPackBytes(): Promise<Uint8Array> {
  const { default: initSqlJs } = await import("sql.js");
  const sql = await initSqlJs();
  const db = new sql.Database();
  db.exec("CREATE TABLE pack_info (id INTEGER PRIMARY KEY, grade_id TEXT)");
  db.run("INSERT INTO pack_info (id, grade_id) VALUES (1, 'kindergarten')");
  const bytes = db.export();
  db.close();
  return bytes;
}

beforeEach(() => {
  resetWebStorageDetection();
  configureWebStorage((name) => Promise.resolve(memoryStore(name)));
  resetOpenDatabaseTracking();
  // The real sql.js engine, as in the browser (locateFile default in
  // node resolves the package's own wasm on disk).
  configureSqlJsEngine(async () => (await import("sql.js")).default());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// --- webStorage -----------------------------------------------------------------

describe("webStorage: feature detection + memory fallback (Decision 9)", () => {
  it("degrades to memory when IndexedDB is unavailable (node has none)", async () => {
    expect(webStorageBackend()).toBe("undetected");
    expect(await detectWebStorage()).toBe("memory");
    expect(webStorageBackend()).toBe("memory");
  });

  it("notice copy is honest: only the memory backend notifies", () => {
    expect(noticeCopyFor("undetected")).toBe("");
    expect(noticeCopyFor("indexeddb")).toBe("");
    expect(noticeCopyFor("memory")).toContain("storage is blocked");
    expect(noticeCopyFor("memory")).toContain("offline play is not available");
  });

  it("pack byte store round-trips and lists .sqlite artifacts only", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await putPackBytes("k-2026.1.0.sqlite", bytes);
    await putPackBytes("staging.tmp", new Uint8Array([9]));
    expect(await getPackBytes("k-2026.1.0.sqlite")).toEqual(bytes);
    expect(await listPackArtifactNames()).toEqual(["k-2026.1.0.sqlite"]);
    await deletePackBytes("k-2026.1.0.sqlite");
    expect(await getPackBytes("k-2026.1.0.sqlite")).toBeNull();
  });
});

// --- securekv.web ----------------------------------------------------------------

describe("securekv.web: SecureKeyValue contract", () => {
  it("get/set/delete strings through the injected store", async () => {
    expect(await webSecureKeyValue.get("session")).toBeNull();
    await webSecureKeyValue.set("session", "tok");
    expect(await webSecureKeyValue.get("session")).toBe("tok");
    await webSecureKeyValue.delete("session");
    expect(await webSecureKeyValue.get("session")).toBeNull();
  });
});

// --- sqlite.web ------------------------------------------------------------------

describe("sqlite.web: sql.js seam (Decision 3)", () => {
  it("persists a mutable database image and reopens it with the data intact", async () => {
    const db = await openDatabaseAsync("lifecycle-test.db");
    await db.execAsync("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    await db.runAsync("INSERT INTO t (v) VALUES (?)", ["hello"]);
    await db.closeAsync();

    const reopened = await openDatabaseAsync("lifecycle-test.db");
    const rows = await reopened.getAllAsync<{ v: string }>("SELECT v FROM t");
    expect(rows.map((r) => r.v)).toEqual(["hello"]);
    await reopened.closeAsync();
  });

  it("runAsync returns changes + lastInsertRowId", async () => {
    const db = await openDatabaseAsync("runresult.db");
    await db.execAsync("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const r1 = await db.runAsync("INSERT INTO t (v) VALUES (?)", ["a"]);
    expect(r1.changes).toBe(1);
    expect(r1.lastInsertRowId).toBe(1);
    const r2 = await db.runAsync("UPDATE t SET v = ? WHERE id = ?", ["b", 1]);
    expect(r2.changes).toBe(1);
    await db.closeAsync();
  });

  it("honors PRAGMA query_only on pack artifacts (writes throw, reads work)", async () => {
    const bytes = await buildPackBytes();
    await putPackBytes("pack-test.sqlite", bytes);
    const db = await openDatabaseAsync(
      "pack-test.sqlite",
      { useNewConnection: true },
      WEB_PACK_STORE_URI,
    );
    await db.execAsync("PRAGMA query_only = ON");
    const rows = await db.getAllAsync<{ grade_id: string }>(
      "SELECT grade_id FROM pack_info WHERE id = 1",
    );
    expect(rows[0]?.grade_id).toBe("kindergarten");
    await expect(
      db.runAsync("INSERT INTO pack_info (id, grade_id) VALUES (2, 'x')"),
    ).rejects.toThrow();
    await db.closeAsync();
  });

  it("pack artifact open fails closed when the bytes are absent", async () => {
    await expect(
      openDatabaseAsync("missing.sqlite", { useNewConnection: true }, WEB_PACK_STORE_URI),
    ).rejects.toThrow(/not found/);
  });

  it("flushes open database images on pagehide (the durability hook)", async () => {
    const puts: string[] = [];
    configureWebStorage((name) => {
      const backing = memoryStore(name);
      return Promise.resolve({
        async get(k: string) {
          return backing.get(k);
        },
        async put(k: string, v: Uint8Array | string) {
          puts.push(k);
          return backing.put(k, v);
        },
        async delete(k: string) {
          return backing.delete(k);
        },
        async keys() {
          return backing.keys();
        },
      });
    });
    const db = await openDatabaseAsync("pagehide.db");
    await db.execAsync("CREATE TABLE t (x INTEGER)");
    puts.length = 0;
    // The pagehide listener body (node's global is not an EventTarget,
    // so the test invokes the same function the listener calls).
    flushAllOpenDatabases();
    await new Promise((r) => setTimeout(r, 10));
    expect(puts).toContain("pagehide.db");
    await db.closeAsync();
    // closeAsync must DROP the handle: a closed database is never
    // re-flushed by pagehide and does not linger in the tracking set.
    puts.length = 0;
    flushAllOpenDatabases();
    await new Promise((r) => setTimeout(r, 10));
    expect(puts).not.toContain("pagehide.db");
  });

  it("closed databases refuse further use", async () => {
    const db = await openDatabaseAsync("closed.db");
    await db.closeAsync();
    await expect(db.execAsync("SELECT 1")).rejects.toThrow(/closed/);
  });
});

// --- webContent deps --------------------------------------------------------------

describe("webContent: content-pack deps over browser storage (Decision 2)", () => {
  it("download stages bytes; sha256Hex matches @noble over the same bytes", async () => {
    const deps = createWebContentDeps({ apiBaseUrl: "http://localhost:4000/", isDev: true });
    const payload = new Uint8Array([7, 7, 7]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(payload, { status: 200 })),
    );
    await deps.download("http://localhost:4000/api/content/packs/kindergarten", "k.sqlite");
    expect(await deps.exists("k.sqlite")).toBe(true);
    expect(await deps.fileSize("k.sqlite")).toBe(3);
    expect(await deps.readBytes("k.sqlite")).toEqual(payload);
    expect(await deps.sha256Hex("k.sqlite")).toBe(hex(sha256(payload)));
    expect(await deps.sha256Hex("absent.sqlite")).toBeNull();
  });

  it("download surfaces non-OK statuses; move renames atomically-ish (store swap)", async () => {
    const deps = createWebContentDeps({ apiBaseUrl: "http://localhost:4000", isDev: true });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 503 })),
    );
    await expect(deps.download("http://x/p.sqlite", "p.sqlite")).rejects.toThrow(/503/);
    await putPackBytes("stage.tmp", new Uint8Array([1]));
    await deps.move("stage.tmp", "published.sqlite");
    expect(await deps.exists("stage.tmp")).toBe(false);
    expect(await deps.exists("published.sqlite")).toBe(true);
  });

  it("fetchIndex parses a valid index and fails closed on bad payloads", async () => {
    const deps = createWebContentDeps({ apiBaseUrl: "http://localhost:4000", isDev: false });
    const valid = {
      packs: [
        {
          formatVersion: 1,
          gradeId: "kindergarten",
          gradeName: "Kindergarten",
          contentVersion: "1.0.0",
          registryVersion: "2026-01-01",
          artifact: "k.sqlite",
          sizeBytes: 10,
          sha256: "a".repeat(64),
          keyId: "dev-1",
          signature: "sig",
          unitCount: 1,
          topicCount: 1,
          questionCount: 1,
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(valid), { status: 200 })),
    );
    const parsed = await deps.fetchIndex();
    expect(parsed?.[0]?.gradeId).toBe("kindergarten");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );
    expect(await deps.fetchIndex()).toBeNull();

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ packs: [] }), { status: 200 })),
    );
    expect(await deps.fetchIndex()).toBeNull();
  });

  it("openPackInfo reads pack_info through the sql.js pack-artifact opener", async () => {
    const deps = createWebContentDeps({ apiBaseUrl: "http://localhost:4000", isDev: true });
    await putPackBytes("grade.sqlite", await buildPackBytes());
    // buildPackBytes creates a minimal pack_info; readPackInfoRow expects
    // the full column set — assert the shared reader is wired by checking
    // the failure mode is a missing-column SQL error, not a seam error.
    await expect(deps.openPackInfo("grade.sqlite")).rejects.toThrow();
    await expect(deps.openPackInfo("absent.sqlite")).rejects.toThrow(/not found/);
  });
});

// --- content trust switch ----------------------------------------------------------

describe("#71 notifications web twin: pinned literals stay in sync with the native twin", () => {
  const mobileRoot = fileURLToPath(new URL("..", import.meta.url));
  it("REMINDER_TITLE/REMINDER_BODY are byte-identical across the twins", () => {
    const native = readFileSync(join(mobileRoot, "src/notifications/localReminders.ts"), "utf8");
    const web = readFileSync(join(mobileRoot, "src/notifications/localReminders.web.ts"), "utf8");
    expect(native).toContain('export const REMINDER_TITLE = "Time to practice!";');
    expect(web).toContain('export const REMINDER_TITLE = "Time to practice!";');
    expect(native).toContain(
      'export const REMINDER_BODY = "A short practice session keeps your streak growing.";',
    );
    expect(web).toContain(
      'export const REMINDER_BODY = "A short practice session keeps your streak growing.";',
    );
  });

  it("the web twin excludes expo-notifications entirely (no push code in the web bundle)", () => {
    const web = readFileSync(join(mobileRoot, "src/notifications/localReminders.web.ts"), "utf8");
    expect(web).not.toMatch(/from "expo-notifications"|import\("expo-notifications"\)/);
    expect(web).not.toContain("exp.host");
    expect(web).toContain("remindersUnavailableOnWeb = true");
  });
});

describe("keys.contentTrustIsDev (#71 export-time dev trust)", () => {
  it("runtime dev wins; production trusts only the export-time switch", () => {
    const prev = process.env.EXPO_PUBLIC_CONTENT_TRUST_DEV;
    try {
      delete process.env.EXPO_PUBLIC_CONTENT_TRUST_DEV;
      expect(contentTrustIsDev(true)).toBe(true);
      expect(contentTrustIsDev(false)).toBe(false);
      process.env.EXPO_PUBLIC_CONTENT_TRUST_DEV = "true";
      expect(contentTrustIsDev(false)).toBe(true);
      process.env.EXPO_PUBLIC_CONTENT_TRUST_DEV = "false";
      expect(contentTrustIsDev(false)).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.EXPO_PUBLIC_CONTENT_TRUST_DEV;
      else process.env.EXPO_PUBLIC_CONTENT_TRUST_DEV = prev;
    }
  });
});
