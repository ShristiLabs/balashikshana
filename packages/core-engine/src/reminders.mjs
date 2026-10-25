/**
 * Daily practice-reminder rules (issue #57, roadmap D5) — PURE functions
 * and data only. Zero dependencies, no clocks (time arrives as a
 * parameter), no I/O. This module is the ONE source of the reminder
 * scheduling policy so the parent surface's decisions and any future
 * surface (the #61 portal) can never fork from the rules the mobile
 * shell executes.
 *
 * D5 DOCTRINE (binding, roadmap decision table): reminders are LOCAL
 * ONLY — scheduled through the device's own notification system via
 * expo-notifications CALENDAR triggers. No push registration, no remote
 * endpoints, no third-party SDKs (AGENTS.md COPPA invariant). The rules
 * here never name a transport; they only decide WHAT the shell should
 * do (schedule / cancel / hold) given parent settings and the OS
 * permission state.
 *
 * DEFAULT OFF: reminders exist ONLY after a parent enables them behind
 * the #44 parental gate. Every fail-path in this module resolves to
 * "cancel" (never schedule garbage): invalid settings cancel, disabled
 * cancels, and a missing permission holds the setting without ever
 * scheduling. A fresh install has no settings row and no schedule.
 *
 * TIME SEMANTICS: the parent picks a LOCAL wall-clock time (hour,
 * minute) and the OS calendar trigger repeats daily at that local time,
 * which is DST-agnostic by construction — the OS keeps the wall-clock
 * meaning across DST transitions. The pure next-occurrence rule below
 * models local days at a FIXED utc offset (the same convention as
 * rewards.mjs dayKeyForMs) because a fixed offset is exactly testable;
 * it is used for boundary tests and diagnostics, while the OS trigger
 * owns runtime DST behavior.
 */

/** The single notification identifier the client shell schedules and
 *  cancels (one daily reminder per device — the settings are
 *  device-local by design, never synced). */
export const REMINDER_NOTIFICATION_ID = "balashikshana-daily-practice-reminder";

/** Default reminder time: 17:00 local (an after-school hour). Only
 *  meaningful once a parent enables reminders — the enabled default is
 *  OFF, so a fresh install never schedules anything. */
export const DEFAULT_REMINDER_HOUR = 17;
export const DEFAULT_REMINDER_MINUTE = 0;

/** OS notification permission states the plan rules over (the client
 *  shell maps expo-notifications' status onto these). */
export const REMINDER_PERMISSION_STATES = Object.freeze(["granted", "denied", "undetermined"]);

/**
 * Validate parent reminder settings. Returns null when consistent, or a
 * short machine-readable problem string (the parent surface shows its
 * own copy; the string is for logs/tests). Rules: enabled is a boolean;
 * hour/minute are integers in range. Shared by the settings writer and
 * the plan so a bad row can never reach the scheduler.
 *
 * @param {{ enabled: unknown, hour: unknown, minute: unknown }} settings
 * @returns {string | null}
 */
export function reminderSettingsProblem({ enabled, hour, minute }) {
  if (typeof enabled !== "boolean") return "reminder-enabled-not-boolean";
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return "reminder-hour-out-of-range";
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return "reminder-minute-out-of-range";
  return null;
}

/**
 * Coerce arbitrary input (a storage row, a partial UI state) to valid
 * settings. Every INVALID field falls back to its default — enabled
 * falls back to FALSE (fail-closed: a corrupt row can never turn
 * reminders on), and hour/minute fall back to the after-school default.
 *
 * @param {{ enabled?: unknown, hour?: unknown, minute?: unknown }} [input]
 * @returns {{ enabled: boolean, hour: number, minute: number }}
 */
export function normalizeReminderSettings(input = {}) {
  const enabled = input.enabled === true;
  const hour = Number.isInteger(input.hour) && input.hour >= 0 && input.hour <= 23 ? input.hour : DEFAULT_REMINDER_HOUR;
  const minute =
    Number.isInteger(input.minute) && input.minute >= 0 && input.minute <= 59
      ? input.minute
      : DEFAULT_REMINDER_MINUTE;
  return { enabled, hour, minute };
}

/**
 * The next wall-clock occurrence of hour:minute STRICTLY AFTER nowMs,
 * modeled at a fixed UTC offset in minutes, positive EAST of UTC
 * (local = UTC + offset; the dayKeyForMs convention). The reminder time
 * crossing midnight is the rule, not an edge case: an evening time
 * after "now" rolls to tomorrow's occurrence even when that is only
 * minutes away (e.g. reminder 00:15 with now 23:50). Non-finite inputs
 * yield null (no occurrence — the caller must not schedule).
 *
 * @param {{ nowMs: number, hour: number, minute: number, utcOffsetMinutes?: number }} input
 * @returns {number | null}
 */
export function nextReminderOccurrenceMs({ nowMs, hour, minute, utcOffsetMinutes = 0 }) {
  if (!Number.isFinite(nowMs)) return null;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  const offsetMs = Number.isFinite(utcOffsetMinutes) ? utcOffsetMinutes * 60000 : 0;
  const localNow = nowMs + offsetMs;
  const localMidnight = Math.floor(localNow / 86400000) * 86400000;
  const timeOfDayMs = (hour * 60 + minute) * 60000;
  let occurrenceLocal = localMidnight + timeOfDayMs;
  if (occurrenceLocal <= localNow) occurrenceLocal += 86400000;
  return occurrenceLocal - offsetMs;
}

/**
 * What the notification shell must do right now, given the parent's
 * settings and the OS permission state. The decision table (every
 * fail-path resolves away from scheduling):
 *
 * - invalid settings  -> cancel (fail-safe: never schedule garbage)
 * - disabled          -> cancel (turning off removes the OS schedule)
 * - enabled, no grant -> none + "permission-not-granted" (the setting
 *   stays saved for the parent surface to explain; nothing schedules)
 * - enabled + granted -> schedule (idempotent daily calendar trigger)
 *
 * @param {{ settings: { enabled: unknown, hour: unknown, minute: unknown },
 *           permission: string }} input
 * @returns {{ action: "schedule" | "cancel" | "none", reason: string, hour: number, minute: number }}
 */
export function reminderPlan({ settings, permission }) {
  const problem = reminderSettingsProblem(settings ?? {});
  const normalized = normalizeReminderSettings(settings ?? {});
  if (problem) {
    return { action: "cancel", reason: "invalid-settings", hour: normalized.hour, minute: normalized.minute };
  }
  if (!normalized.enabled) {
    return { action: "cancel", reason: "disabled", hour: normalized.hour, minute: normalized.minute };
  }
  if (permission !== "granted") {
    return {
      action: "none",
      reason: "permission-not-granted",
      hour: normalized.hour,
      minute: normalized.minute,
    };
  }
  return { action: "schedule", reason: "enabled", hour: normalized.hour, minute: normalized.minute };
}
