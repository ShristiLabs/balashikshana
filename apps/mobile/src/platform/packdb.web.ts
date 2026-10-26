/**
 * Web pack-artifact database opener (issue #71): loads the verified
 * pack bytes from browser storage into sql.js (the same pack .sqlite
 * artifacts, byte-identical; callers set PRAGMA query_only themselves).
 */
import type { SQLiteDatabase } from "./sqlite";
import { openDatabaseAsync } from "./sqlite";

/** The sentinel URI marking the web pack store (parity with the native
 * call shape: openDatabaseAsync(name, opts, uri)). */
export const WEB_PACK_STORE_URI = "idb://balashikshana/packs";

export async function openPackArtifact(fileName: string): Promise<SQLiteDatabase> {
  return openDatabaseAsync(fileName, { useNewConnection: true }, WEB_PACK_STORE_URI);
}
