/**
 * Child-surface readiness guard (issue #44 re-consent acceptance
 * criterion): a policy-version bump must surface the re-consent screens on
 * next launch BEFORE child surfaces unlock. Until the real journey screen
 * lands (#49 in the issue tree), the launcher routes through this check.
 *
 * PURE module.
 */

import type { ConsentStatusInfo, OnboardingSnapshot } from "./types";

export interface ReadinessInputs {
  snapshot: OnboardingSnapshot | null;
  parentToken: string | null;
  childDeviceSession: unknown;
  consentStatus: ConsentStatusInfo | null;
}

export interface Readiness {
  /** Child surfaces (journey/practice/gate) may be entered. */
  ready: boolean;
  /** The route to send the user to instead (onboarding when not ready). */
  redirect: "/onboarding" | null;
  /** Why: which link in the chain is missing (diagnostics + tests). */
  reason:
    | "complete"
    | "no-snapshot"
    | "no-parent-token"
    | "no-child-device-session"
    | "consent-not-current"
    | "onboarding-incomplete";
}

export function childAccessReady(inputs: ReadinessInputs): Readiness {
  const { snapshot, parentToken, childDeviceSession, consentStatus } = inputs;
  if (!snapshot) {
    return { ready: false, redirect: "/onboarding", reason: "no-snapshot" };
  }
  if (!snapshot.gatePassed || !snapshot.completedAt || !snapshot.studentId) {
    return { ready: false, redirect: "/onboarding", reason: "onboarding-incomplete" };
  }
  if (!parentToken) {
    return { ready: false, redirect: "/onboarding", reason: "no-parent-token" };
  }
  if (!childDeviceSession) {
    return { ready: false, redirect: "/onboarding", reason: "no-child-device-session" };
  }
  if (!consentStatus || !consentStatus.consentCurrent) {
    // Policy bump: re-consent before child surfaces unlock (the AC).
    return { ready: false, redirect: "/onboarding", reason: "consent-not-current" };
  }
  return { ready: true, redirect: null, reason: "complete" };
}
