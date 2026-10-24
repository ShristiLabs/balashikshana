/**
 * React-native journey bindings (issue #49).
 *
 * The ONLY module in the journey tree that touches native seams
 * (expo-sqlite via the practice deps, the onboarding store, the content
 * pack service). Everything above stays node-testable.
 *
 * Responsibilities:
 * - resolve the active student + grade (child-device session + the
 *   onboarding snapshot's gradeId — the same source PracticeWarmup and
 *   ContentPackProvider read);
 * - persist a grade switch by updating the snapshot's gradeId (the
 *   documented resumability store; per-grade progress rows are keyed by
 *   unit id and survive every switch);
 * - read the per-grade pack currency off pack_meta for the switcher.
 */

import { getContentPackService } from "../content/nativeContent";
import type { ContentPackService } from "../content/service";
import { createNativeDependencies } from "../onboarding/nativeStores";
import { TokenStore } from "../onboarding/storage";
import { GRADE_IDS, GRADE_LABELS } from "../onboarding/types";
import type { GradeId } from "../onboarding/types";
import { getNativePracticeDeps } from "../practice/nativePractice";
import type { GradeSlot } from "./store";

const API_BASE = process.env.EXPO_PUBLIC_API_BASE ?? "http://localhost:4000";

export interface JourneyIdentity {
  studentId: string | null;
  gradeId: string | null;
}

/** The child-device session's student + the snapshot's active grade. */
export async function loadJourneyIdentity(): Promise<JourneyIdentity> {
  const native = await createNativeDependencies();
  const tokens = new TokenStore(native.secure);
  const session = await tokens.getChildDeviceSession();
  const snapshot = await native.onboardingStore.load();
  return {
    studentId: session?.studentId ?? snapshot?.studentId ?? null,
    gradeId: snapshot?.gradeId ?? null,
  };
}

/**
 * Persist the selected grade into the onboarding snapshot. Safe by
 * design: the snapshot write only touches gradeId (and updatedAt) on an
 * existing completed snapshot; onboarding re-entry does not depend on
 * gradeId once a child exists.
 */
export async function persistActiveGrade(gradeId: string): Promise<void> {
  const native = await createNativeDependencies();
  const snapshot = await native.onboardingStore.load();
  if (!snapshot || snapshot.gradeId === gradeId) return;
  await native.onboardingStore.save({
    ...snapshot,
    gradeId: gradeId as GradeId,
    updatedAt: Date.now(),
  });
}

/** The fixed platform grade list with live pack currency (pack_meta). */
export async function loadGradeSlots(): Promise<GradeSlot[]> {
  const deps = getNativePracticeDeps();
  const installed = await deps.storage.activePackVersions();
  const installedByGrade = new Map(installed.map((row) => [row.gradeId, row.contentVersion]));
  return GRADE_IDS.map((gradeId) => {
    const contentVersion = installedByGrade.get(gradeId) ?? null;
    return {
      gradeId,
      label: GRADE_LABELS[gradeId],
      currency: contentVersion ? ("installed" as const) : ("missing" as const),
      contentVersion,
    };
  });
}

/** The #46 service singleton (grade switch downloads run through it). */
export function getContentService(): ContentPackService {
  return getContentPackService(API_BASE);
}
