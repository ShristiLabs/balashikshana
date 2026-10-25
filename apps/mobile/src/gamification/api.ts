/**
 * Gamification ledger fetch (issue #55) — the server-authoritative read
 * the journey surface adopts after sync. PURE module: no react-native
 * imports; fetch + credentials are injectable (the onboarding/api.ts
 * doctrine). Failures throw ApiError-shaped Errors; callers swallow them
 * (the next mount/sync retries) — a kid never sees a ledger error.
 */

import type { FetchLike } from "../onboarding/api";
import type { ServerLedger } from "./types";

export interface GamificationApiOptions {
  baseUrl: string;
  /** Returns the child-device (or student) bearer token, or null when signed out. */
  getToken(): Promise<string | null>;
  fetchImpl?: FetchLike;
}

export function createGamificationApi(options: GamificationApiOptions) {
  const doFetch = options.fetchImpl ?? (globalThis.fetch.bind(globalThis) as FetchLike);
  return {
    /** GET /api/students/:studentId/gamification/ledger (D9 read). */
    async fetchLedger(studentId: string): Promise<ServerLedger> {
      const token = await options.getToken();
      if (!token) throw new Error("No session token for the gamification ledger");
      const res = await doFetch(
        `${options.baseUrl}/api/students/${encodeURIComponent(studentId)}/gamification/ledger`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      if (!res.ok) {
        throw new Error(`Gamification ledger request failed: ${String(res.status)}`);
      }
      return (await res.json()) as ServerLedger;
    },
  };
}
