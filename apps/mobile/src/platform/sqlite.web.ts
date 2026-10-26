/**
 * Web SQL seam (issue #71): sql.js-backed implementation of the
 * expo-sqlite async API subset the app actually uses.
 *
 * WHY sql.js AND NOT expo-sqlite's web build: expo-sqlite's web module
 * imports a wa-sqlite .wasm worker that a STATIC metro web export
 * cannot bundle (verified empirically on SDK 58 — the export fails at
 * `expo-sqlite/web/worker.ts -> wa-sqlite.wasm`). sql.js is established
 * OSS (SQLite compiled to WebAssembly, MIT) with a plain-JS entry that
 * bundles cleanly and runs in node for tests. The engine is therefore
 * the SAME SQLite as native, executed in wasm.
 *
 * Semantics:
 * - openDatabaseAsync(name) opens a MUTABLE named database whose image
 *   is persisted to browser storage (webStorage) after writes, debounced
 *   and flushed on page hide (best effort — documented limit).
 * - openDatabaseAsync(fileName, options, directoryUri) — the pack
 *   artifact pattern used by the content/practice seams — loads the
 *   verified pack bytes from the web pack store (read-only usage; the
 *   callers set PRAGMA query_only themselves, which sql.js honors).
 *
 * Type compatibility: the returned objects cast to expo-sqlite's
 * SQLiteDatabase type. The implemented surface is exactly what the
 * codebase calls: execAsync, runAsync, getAllAsync, closeAsync (plus
 * lastInsertRowId/changes on run results) — grep-verified, and the
 * type cast keeps future drift visible at the call sites.
 */
import initSqlJs, { type SqlJsDatabase, type SqlJsStatic } from "sql.js";
import type * as ExpoSQLite from "expo-sqlite";
import { getPackBytes, openKeyValueStore } from "./webStorage";

export type SQLiteDatabase = ExpoSQLite.SQLiteDatabase;
export type SQLiteBindValue = ExpoSQLite.SQLiteBindValue;
type RunResult = { changes: number; lastInsertRowId: number };

const DB_IMAGE_STORE = "sqlite-dbs"; // mutable database images, keyed by name
const SAVE_DEBOUNCE_MS = 200;

interface Store {
  get(key: string): Promise<Uint8Array | string | null>;
  put(key: string, value: Uint8Array | string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

let enginePromise: Promise<SqlJsStatic> | null = null;

function engine(): Promise<SqlJsStatic> {
  enginePromise ??= initSqlJs({
    // The wasm ships as a same-origin static asset (public/vendor) so the
    // service worker can cache it as app shell; no CDN, no third party.
    locateFile: (file: string) => `/vendor/${file}`,
  });
  return enginePromise;
}

/** Tests replace the sql.js engine (e.g., with a node-fs-backed one). */
export function configureSqlJsEngine(loader: (() => Promise<SqlJsStatic>) | null): void {
  if (loader === null) {
    enginePromise = null;
  } else {
    enginePromise = loader();
  }
}

async function imageStore(): Promise<Store> {
  return openKeyValueStore(DB_IMAGE_STORE);
}

class WebSqliteDatabase {
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(
    private readonly db: SqlJsDatabase,
    private readonly name: string,
    private readonly persist: boolean,
    private readonly store: Store | null,
  ) {}

  async execAsync(source: string): Promise<void> {
    this.assertOpen();
    try {
      this.db.exec(source);
    } catch (error) {
      throw new Error(`sqlite exec failed: ${String(error)}`);
    }
    this.scheduleSave();
  }

  async runAsync(source: string, ...params: unknown[]): Promise<RunResult> {
    this.assertOpen();
    return this.runInternal(source, (params[0] as SQLiteBindValue[]) ?? []);
  }

  async getAllAsync<T>(source: string, ...params: unknown[]): Promise<T[]> {
    this.assertOpen();
    const stmt = this.db.prepare(source);
    try {
      stmt.bind((params[0] as SQLiteBindValue[]) ?? []);
      const rows: T[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as T);
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  async closeAsync(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.flush();
    this.db.close();
    // Drop the durability tracking so a closed handle is neither
    // re-flushed on pagehide nor leaks in the set for the session.
    openDatabases.delete(this);
  }

  private runInternal(source: string, params: SQLiteBindValue[]): RunResult {
    const stmt = this.db.prepare(source);
    try {
      stmt.bind(params);
      stmt.step();
    } catch (error) {
      throw new Error(`sqlite run failed: ${String(error)}`);
    } finally {
      stmt.free();
    }
    this.scheduleSave();
    const row = this.quickRow(
      "SELECT changes() AS changes, last_insert_rowid() AS lastInsertRowId",
    );
    return {
      changes: Number(row?.changes ?? 0),
      lastInsertRowId: Number(row?.lastInsertRowId ?? 0),
    };
  }

  private quickRow(sql: string): Record<string, number> | null {
    const stmt = this.db.prepare(sql);
    try {
      return stmt.step() ? (stmt.getAsObject() as Record<string, number>) : null;
    } finally {
      stmt.free();
    }
  }

  private scheduleSave(): void {
    if (!this.persist || this.store === null) return;
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.flush();
    }, SAVE_DEBOUNCE_MS);
  }

  /** Serialize the database image to browser storage (fire-and-forget safe). */
  async flush(): Promise<void> {
    if (!this.persist || this.store === null) return;
    try {
      await this.store.put(this.name, this.db.export());
    } catch {
      // Persistence is best-effort; the session keeps working in memory.
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("sqlite database is closed");
  }
}

function toExpoType(db: WebSqliteDatabase): SQLiteDatabase {
  return db as unknown as SQLiteDatabase;
}

/**
 * Open a mutable named database (persisted image) or, when called with
 * a directory URI (the pack-artifact pattern), load pack bytes from the
 * web pack store.
 */
export async function openDatabaseAsync(
  name: string,
  _options?: unknown,
  directoryUri?: string,
): Promise<SQLiteDatabase> {
  const sql = await engine();
  if (directoryUri !== undefined) {
    const bytes = await getPackBytes(name);
    if (bytes === null) {
      throw new Error(`pack artifact not found in browser storage: ${name}`);
    }
    const db = new sql.Database(bytes);
    return toExpoType(new WebSqliteDatabase(db, name, false, null));
  }
  const store = await imageStore();
  const existing = await store.get(name);
  const db = existing instanceof Uint8Array ? new sql.Database(existing) : new sql.Database();
  const handle = new WebSqliteDatabase(db, name, true, store);
  trackForPageFlush(handle);
  return toExpoType(handle);
}

// --- durability hook -------------------------------------------------------------
// Sudden tab closes can race the write debounce. openDatabases tracks
// live persistent handles; the pagehide listener flushes their images.
// closeAsync removes a handle so closed databases are never re-flushed
// and the set does not grow for the session. Best-effort (async write
// during pagehide is not guaranteed) — the documented limit; the sync
// engine reconciles from the server anyway.

const openDatabases = new Set<WebSqliteDatabase>();

function trackForPageFlush(handle: WebSqliteDatabase): void {
  openDatabases.add(handle);
  void handle.flush();
}

/** Flush every tracked persistent handle (the pagehide body, exported
 *  for the node test — node's global is not an EventTarget). */
export function flushAllOpenDatabases(): void {
  for (const handle of openDatabases) {
    void handle.flush();
  }
}

if (typeof globalThis.addEventListener === "function") {
  globalThis.addEventListener("pagehide", flushAllOpenDatabases);
}

/** Tests drop tracking state between suites. */
export function resetOpenDatabaseTracking(): void {
  openDatabases.clear();
}
