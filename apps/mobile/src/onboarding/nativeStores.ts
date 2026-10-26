/**
 * React-native persistence bindings for the onboarding flow (issue #44).
 *
 * This is the ONLY module in the onboarding tree that touches native
 * seams; every pure module above stays node-testable. Since #71 the
 * native modules route through platform-suffixed twins
 * (../platform/sqlite, ../platform/securekv) so the SAME seam code runs
 * on web with browser-storage adapters. The screen layer calls
 * createNativeDependencies() once and passes the results down as the
 * storage seams from storage.ts.
 *
 * - Tokens/credentials: the secure key-value seam (expo-secure-store on
 *   native; browser-storage backed store on web — see
 *   platform/securekv.web.ts for the honest limits).
 * - Onboarding snapshot: a one-row JSON document in a minimal SQLite
 *   table (expo-sqlite on native; sql.js on web). #46 (content packs)
 *   owns the real on-device schema; this tiny table is deliberately
 *   self-contained so the migration story stays trivial (drop + recreate
 *   loses nothing but resumability progress).
 */

import * as SQLite from "../platform/sqlite";
import { secureKeyValue } from "../platform/securekv";
import { getContentPackService } from "../content/nativeContent";
import type { EnsureResult } from "../content/types";
import type { OnboardingStore, SecureKeyValue } from "./storage";
import { parseSnapshot } from "./storage";

// Re-exported for the sync + gamification token seams (#48/#55 import
// path unchanged; the platform twin resolves per OS).
export { secureKeyValue };

const SNAPSHOT_DB = "balashikshana_onboarding.db";
const SNAPSHOT_TABLE = `
  CREATE TABLE IF NOT EXISTS onboarding_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    snapshot TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

export interface NativeDependencies {
  onboardingStore: OnboardingStore;
  secure: SecureKeyValue;
  /**
   * Content-pack trigger (#46). Lazy singleton; init failures degrade to
   * undefined (the flow treats the seam as optional and never blocks).
   */
  contentPacks?: { ensurePack(gradeId: string): Promise<EnsureResult> };
}

const CONTENT_API_BASE = process.env.EXPO_PUBLIC_API_BASE ?? "http://localhost:4000";

export async function createNativeDependencies(): Promise<NativeDependencies> {
  const db = await SQLite.openDatabaseAsync(SNAPSHOT_DB);
  await db.execAsync(SNAPSHOT_TABLE);

  const onboardingStore: OnboardingStore = {
    async load() {
      const rows = await db.getAllAsync<{ snapshot: string }>(
        "SELECT snapshot FROM onboarding_state WHERE id = 1",
      );
      // Corrupt or unknown-schema snapshots are discarded by the pure
      // parseSnapshot guard (unit-tested in storage).
      return parseSnapshot(rows[0]?.snapshot ?? null);
    },
    async save(snapshot) {
      await db.runAsync(
        `INSERT INTO onboarding_state (id, snapshot, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at`,
        [JSON.stringify(snapshot), new Date().toISOString()],
      );
    },
    async clear() {
      await db.runAsync("DELETE FROM onboarding_state WHERE id = 1");
    },
  };

  return {
    onboardingStore,
    secure: secureKeyValue,
    contentPacks: getContentPackService(CONTENT_API_BASE),
  };
}
