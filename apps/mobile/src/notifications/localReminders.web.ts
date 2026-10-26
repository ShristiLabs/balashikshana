/**
 * WEB TWIN of the local-reminder shell (issue #71). Metro picks this
 * file for web exports — which keeps the notifications library (and its
 * push-registration code paths, including the remote device-token
 * endpoint string) OUT of the web bundle entirely: the web edition
 * contains ZERO notification code, per the D5/COPPA doctrine (local
 * only, never a permission prompt on a kid surface) and the issue's
 * exclusion of browser push.
 *
 * Reminders are honestly UNAVAILABLE on web: every function no-ops, and
 * the parent settings section renders an explanation instead of the
 * toggle (remindersUnavailableOnWeb === true here).
 *
 * The canonical implementation + the test-pinned copy literals live in
 * localReminders.ts (the native/base twin); the constants here MUST
 * stay byte-identical (web-adapters.test.ts pins the sync).
 */
import type { ReminderPlan, ReminderPermissionStatus } from "@balashikshana/core-engine";

export const remindersUnavailableOnWeb = true;

/** Mirror of the native twin's pinned literal (drift-pinned by tests). */
export const REMINDER_TITLE = "Time to practice!";
/** Mirror of the native twin's pinned literal (drift-pinned by tests). */
export const REMINDER_BODY = "A short practice session keeps your streak growing.";

/** No notification handler exists on web (nothing to foreground). */
export function initializeLocalReminders(): void {
  /* reminders unavailable on web */
}

export async function getReminderPermissionStatus(): Promise<ReminderPermissionStatus> {
  return "denied";
}

/** Web: permission is never requested — the surface explains instead. */
export async function requestReminderPermissionFromParentSurface(): Promise<ReminderPermissionStatus> {
  return "denied";
}

/** Web: no OS scheduler exists; the engine plan is simply not applied. */
export async function applyReminderPlan(_plan: ReminderPlan): Promise<void> {
  /* reminders unavailable on web */
}
