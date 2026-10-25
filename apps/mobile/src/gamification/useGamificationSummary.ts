/**
 * Gamification summary hook (issue #55) — the kid-facing surfacing seam.
 *
 * Loads the OPTIMISTIC local ledger row (projector output persisted by
 * the session engine), then — fire-and-forget, online only — adopts the
 * server-authoritative ledger (the D8 confirm step). Failures are
 * swallowed: the provisional local values keep rendering and the next
 * mount retries (a kid never sees a ledger error). Display wiring for
 * session summaries and badge blooms lands with #56/#57/#58.
 */
import { useEffect, useReducer } from "react";
import { TokenStore } from "../onboarding/storage";
import { secureKeyValue } from "../onboarding/nativeStores";
import { getNativeGamificationStorage } from "../practice/nativePractice";
import { createGamificationApi } from "./api";
import { initialGamificationState } from "./rewardsProjector";
import { initialGamificationStoreState, gamificationReducer } from "./gamificationStore";
import type { GamificationSummary } from "./types";

const API_BASE = (process.env.EXPO_PUBLIC_API_BASE ?? "http://localhost:4000").replace(/\/+$/, "");

export function useGamificationSummary(studentId: string | null): GamificationSummary | null {
  const [store, dispatch] = useReducer(
    gamificationReducer,
    undefined,
    initialGamificationStoreState,
  );

  useEffect(() => {
    if (!studentId) return;
    let cancelled = false;
    (async () => {
      const storage = getNativeGamificationStorage();
      const local =
        (await storage.getGamificationState(studentId).catch(() => null)) ??
        initialGamificationState(studentId, Date.now());
      if (!cancelled) dispatch({ type: "state-loaded", state: local });

      // Server confirmation (best-effort, device session only).
      const tokenStore = new TokenStore(secureKeyValue);
      const api = createGamificationApi({
        baseUrl: API_BASE,
        getToken: async () => (await tokenStore.getChildDeviceSession())?.token ?? null,
      });
      try {
        const ledger = await api.fetchLedger(studentId);
        if (!cancelled) dispatch({ type: "ledger-adopted", ledger, nowMs: Date.now() });
      } catch {
        // Offline / signed out / server unreachable: provisional stands.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [studentId]);

  return store.summary;
}
