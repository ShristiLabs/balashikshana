/**
 * Practice bootstrap (issue #47): launch-time warm-up of the offline
 * practice core.
 *
 * Mounted once at the root layout (same fire-and-forget pattern as
 * ContentPackProvider — pack maintenance must never block the shell).
 * On boot it reads the active grade and pre-opens the query_only pack
 * reader through the native practice deps, so the first practice
 * session (#50) pays no first-query cost. It also places the
 * core-engine-powered practice module into the app's production entry
 * graph — the dual-platform Hermes export asserts the engine bundles.
 *
 * No UI, no network: a failure here is swallowed and retried on the
 * next launch; the practice engine opens its own reader lazily anyway.
 */
import { useEffect } from "react";
import { loadActiveGrade } from "../content/nativeContent";
import { PracticeSessionEngine } from "./practiceEngine";
import { getNativePracticeDeps } from "./nativePractice";

export function PracticeWarmup(): null {
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const gradeId = await loadActiveGrade();
        if (cancelled || !gradeId) return;
        const deps = getNativePracticeDeps();
        const reader = await deps.openContent(gradeId);
        if (reader && !cancelled) {
          // Touch the pack once (policy lookup) so the reader handle and
          // SQLite page cache are warm for the first session.
          await reader.gradePolicy(gradeId);
        }
      } catch {
        // Warm-up is best-effort; sessions open their own reader.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}

/**
 * The engine singleton callers (#50) will use: sessions live in the
 * engine's memory between start and complete, so the whole app shares
 * ONE instance (same lazy-singleton doctrine as the audio service).
 */
let engineSingleton: PracticeSessionEngine | null = null;

export function getPracticeEngine(): PracticeSessionEngine {
  engineSingleton ??= new PracticeSessionEngine(getNativePracticeDeps());
  return engineSingleton;
}
