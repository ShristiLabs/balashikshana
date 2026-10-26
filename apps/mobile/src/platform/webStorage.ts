/**
 * Browser-storage seam (issue #71): the tiny key-value surface the web
 * adapters need, with feature detection and an in-memory fallback.
 *
 * This module is PURE (no react-native imports) so it stays
 * node-testable; tests inject a factory through configureWebStorage().
 * Only `.web.ts` seam twins import it, so it never enters a native
 * bundle.
 *
 * GRACEFUL DEGRADATION (issue acceptance criterion): managed Chromebook
 * profiles can block browser storage entirely. detectWebStorage()
 * probes IndexedDB with a real open + put + get + delete cycle; on any
 * failure the app falls back to the in-memory backend
 * (webStorageBackend() === "memory") — everything works for the
 * session, nothing persists, offline is unavailable, and the UI
 * surfaces that honestly. Never a broken state.
 */

/** The storage backend actually in use after detection. */
export type WebStorageBackend = "undetected" | "indexeddb" | "memory";

export interface KeyValueStore {
  get(key: string): Promise<Uint8Array | string | null>;
  put(key: string, value: Uint8Array | string): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

type StoreFactory = (storeName: string) => Promise<KeyValueStore>;

interface WebStorageConfig {
  createStore: StoreFactory | null;
}

let config: WebStorageConfig = { createStore: null };
let detectedBackend: WebStorageBackend = "undetected";

/** Tests inject their store factory before driving the adapters. */
export function configureWebStorage(createStore: StoreFactory | null): void {
  config = { createStore };
}

export function webStorageBackend(): WebStorageBackend {
  return detectedBackend;
}

/**
 * Probe browser storage (async, once). Persistent storage requires
 * IndexedDB to open AND round-trip a marker record — a quota- or
 * policy-blocked open degrades to memory instead of throwing later.
 */
export async function detectWebStorage(): Promise<WebStorageBackend> {
  if (detectedBackend !== "undetected") return detectedBackend;
  try {
    const probe = await browserIdbStore("balashikshana-storage-probe");
    await probe.put("probe", "ok");
    const echoed = await probe.get("probe");
    await probe.delete("probe");
    if (echoed !== "ok") throw new Error("storage probe mismatch");
    detectedBackend = "indexeddb";
  } catch {
    detectedBackend = "memory";
  }
  return detectedBackend;
}

/**
 * Open a key-value store by name. Resolves the detected backend on
 * first use; the memory fallback keeps the app functional when browser
 * storage is blocked (see webStorageBackend for the honest mode signal).
 */
export async function openKeyValueStore(storeName: string): Promise<KeyValueStore> {
  if (config.createStore !== null) {
    return config.createStore(storeName);
  }
  await detectWebStorage();
  if (detectedBackend === "indexeddb") {
    try {
      return await browserIdbStore("balashikshana-web-storage", storeName);
    } catch {
      return memoryStore(storeName);
    }
  }
  return memoryStore(storeName);
}

// --- IndexedDB backend (browser only) ----------------------------------------------

const DB_VERSION = 1;
// All logical stores share ONE physical object store with prefixed
// string keys: IndexedDB only runs the upgrade callback on VERSION
// change, so lazily adding stores per name would never create the
// second store. One store + `name~key` composition has no such trap.
const KV_STORE = "kv";
const KEY_SEPARATOR = "~";

function reqDone(request: IDBRequest): Promise<void> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("indexeddb request failed"));
  });
}

async function browserIdbStore(dbName: string, storeName?: string): Promise<KeyValueStore> {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) throw new Error("indexeddb unavailable");
  const openRequest = idb.open(dbName, DB_VERSION);
  openRequest.onupgradeneeded = () => {
    const db = openRequest.result;
    if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE);
  };
  await reqDone(openRequest);
  const db = openRequest.result;
  const prefix = `${storeName ?? "probe"}${KEY_SEPARATOR}`;

  const run = async (mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest) => {
    const tx = db.transaction(KV_STORE, mode);
    const request = op(tx.objectStore(KV_STORE));
    await reqDone(request);
    return request.result;
  };

  return {
    async get(key) {
      return (
        ((await run("readonly", (s) => s.get(prefix + key))) as Uint8Array | string | null) ?? null
      );
    },
    async put(key, value) {
      await run("readwrite", (s) => s.put(value, prefix + key));
    },
    async delete(key) {
      await run("readwrite", (s) => s.delete(prefix + key));
    },
    async keys() {
      const all = (await run("readonly", (s) => s.getAllKeys())) as IDBValidKey[];
      return all
        .filter((k): k is string => typeof k === "string" && k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
    },
  };
}

// --- memory fallback ----------------------------------------------------------------

const memoryStores = new Map<string, Map<string, Uint8Array | string>>();

export function memoryStore(storeName: string): KeyValueStore {
  let store = memoryStores.get(storeName);
  if (!store) {
    store = new Map();
    memoryStores.set(storeName, store);
  }
  return {
    async get(key) {
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    async keys() {
      return [...store.keys()];
    },
  };
}

/** Tests reset the memory fallback between cases. */
export function resetMemoryStores(): void {
  memoryStores.clear();
}

/** Tests reset detection state between suites. */
export function resetWebStorageDetection(): void {
  detectedBackend = "undetected";
}

/**
 * The honest storage-blocked notice copy (#71, Decision 9): only the
 * memory backend (browser storage blocked/unavailable) produces a
 * notice; "" means no notice. Pure — the WebStorageNotice component
 * renders exactly this string.
 */
export function webStorageNoticeCopy(backend: WebStorageBackend): string {
  if (backend !== "memory") return "";
  return (
    "This browser is not letting the app save information (storage is blocked). " +
    "You can keep playing while online, but progress will not be saved between visits " +
    "and offline play is not available."
  );
}

// --- content-pack byte store ---------------------------------------------------------
// Pack artifacts persist as raw bytes under the "packs" prefix; the web
// content deps (download/staging/publish) and the sql.js pack-artifact
// opener share this one store.

const PACK_STORE_NAME = "packs";

async function packStore(): Promise<KeyValueStore> {
  return openKeyValueStore(PACK_STORE_NAME);
}

export async function putPackBytes(fileName: string, bytes: Uint8Array): Promise<void> {
  await (await packStore()).put(fileName, bytes);
}

export async function getPackBytes(fileName: string): Promise<Uint8Array | null> {
  const value = await (await packStore()).get(fileName);
  return value instanceof Uint8Array ? value : null;
}

export async function deletePackBytes(fileName: string): Promise<void> {
  await (await packStore()).delete(fileName);
}

export async function listPackArtifactNames(): Promise<string[]> {
  return (await (await packStore()).keys()).filter((name) => name.endsWith(".sqlite"));
}
