/**
 * Content-pack bootstrap (issue #46): the launch-time version check.
 *
 * Mounted once at the root layout (same pattern as AudioServiceProvider).
 * On boot it reads the active grade from the onboarding store and runs
 * ensurePack — a no-op when the pack is current, an upgrade when the
 * server offers a newer content version. Everything is fire-and-forget
 * with logged failures: pack maintenance must never block or crash the
 * app shell. Onboarding additionally triggers ensurePack at grade
 * selection (its own seam in OnboardingFlow.submitChild).
 */
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { getContentPackService, loadActiveGrade } from "./nativeContent";
import { ContentPackService } from "./service";
import type { EnsureResult } from "./types";

const API_BASE = process.env.EXPO_PUBLIC_API_BASE ?? "http://localhost:4000";

interface ContentPackContextValue {
  service: ContentPackService | null;
  lastResult: EnsureResult | null;
}

const ContentPackContext = createContext<ContentPackContextValue>({
  service: null,
  lastResult: null,
});

export function useContentPacks(): ContentPackContextValue {
  return useContext(ContentPackContext);
}

export function ContentPackProvider({ children }: { children: React.ReactNode }) {
  const [service, setService] = useState<ContentPackService | null>(null);
  const [lastResult, setLastResult] = useState<EnsureResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const gradeId = await loadActiveGrade();
        const contentService = getContentPackService(API_BASE);
        if (!cancelled) setService(contentService);
        // No grade yet (fresh install): the onboarding seam triggers the
        // first download; nothing to check at launch.
        if (!gradeId) return;
        const result = await contentService.ensurePack(gradeId);
        if (!cancelled) setLastResult(result);
      } catch {
        // Pack maintenance is best-effort at boot; onboarding and the
        // next launch retry. Logged inside the service.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const value = useMemo<ContentPackContextValue>(
    () => ({ service, lastResult }),
    [service, lastResult],
  );

  return <ContentPackContext.Provider value={value}>{children}</ContentPackContext.Provider>;
}
