/**
 * Local reminder shell (issue #57, roadmap D5) — the THIN imperative
 * layer over expo-notifications. Everything with policy meaning lives
 * in @balashikshana/core-engine reminders.mjs (pure): this module only
 * EXECUTES the engine's plan against the OS.
 *
 * D5 / COPPA DOCTRINE (binding, source-pinned by tests):
 * - LOCAL ONLY. The ONLY notifications API surface used here is local
 *   scheduling (calendar trigger) + permission queries. This module
 *   NEVER registers for remote push, NEVER requests a device or Expo
 *   push token, and contains NO network code path (no web requests, no
 *   connectivity library, no remote endpoints) — the library's
 *   push-token-fetch and remote-message APIs are forbidden and
 *   test-scanned by name.
 * - The OS permission prompt is PARENT-GATED: the permission REQUEST
 *   call is made ONLY from the parent settings section (behind the #44
 *   hold-to-confirm gate). Child surfaces never prompt — this module's
 *   request function is named for that single caller.
 * - Notification content is STATIC encouraging copy with NO child PII:
 *   no name, no progress numbers, no streak value — nothing derived
 *   from any child's data appears in the payload.
 *
 * Android note: scheduled alarms do not survive a device reboot, so the
 * root layout re-applies the engine plan at every app start
 * (ReminderBootstrap) — same effect as re-scheduling after reboot once
 * the app is opened.
 */
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { AndroidImportance } from "expo-notifications";
import {
  REMINDER_NOTIFICATION_ID,
  type ReminderPlan,
  type ReminderPermissionStatus,
} from "@balashikshana/core-engine";

/** Static, PII-free copy: constants by construction (never templated
 *  with any child's data — the source pin asserts the literals). */
export const REMINDER_TITLE = "Time to practice!";
export const REMINDER_BODY = "A short practice session keeps your streak growing.";

/** The Android notification channel for reminders (created before the
 *  first schedule; iOS has no channel concept). */
const REMINDER_CHANNEL_ID = "reminders";

let handlerInitialized = false;

/**
 * Idempotent foreground handler: when a reminder fires while the app is
 * open it shows as a banner, never a badge, never a sound interrupting
 * a live session. Called once from the root layout (ReminderBootstrap).
 */
export function initializeLocalReminders(): void {
  if (handlerInitialized) return;
  handlerInitialized = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

function mapPermission(status: Notifications.PermissionStatus): ReminderPermissionStatus {
  if (status === "granted") return "granted";
  if (status === "denied") return "denied";
  return "undetermined";
}

/** The CURRENT OS permission state without ever prompting. */
export async function getReminderPermissionStatus(): Promise<ReminderPermissionStatus> {
  const { status } = await Notifications.getPermissionsAsync();
  return mapPermission(status);
}

/**
 * Request the OS notification permission. PARENT-SURFACE ONLY: the sole
 * caller is the parent settings section behind the #44 parental gate
 * (test-pinned); a child surface must never import this.
 */
export async function requestReminderPermissionFromParentSurface(): Promise<ReminderPermissionStatus> {
  const { status } = await Notifications.requestPermissionsAsync();
  return mapPermission(status);
}

async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync(REMINDER_CHANNEL_ID, {
    name: "Practice reminders",
    importance: AndroidImportance.DEFAULT,
    sound: "default",
    showBadge: false,
  });
}

/**
 * Execute an engine plan (reminderPlan output) against the OS:
 * - "schedule": replace any existing reminder with the daily LOCAL
 *   calendar trigger at the parent's hour:minute (device-local time —
 *   the OS keeps the wall-clock meaning across DST; repeats daily);
 * - "cancel": remove the reminder (idempotent when nothing is set);
 * - "none": no-op (permission hold — the parent surface explains).
 */
export async function applyReminderPlan(plan: ReminderPlan): Promise<void> {
  if (plan.action === "none") return;
  // Replacing first keeps the single-reminder invariant even if a stale
  // schedule exists under the identifier.
  await Notifications.cancelScheduledNotificationAsync(REMINDER_NOTIFICATION_ID).catch(() => {
    // Nothing scheduled (fresh install): not an error.
  });
  if (plan.action !== "schedule") return;
  await ensureAndroidChannel();
  await Notifications.scheduleNotificationAsync({
    identifier: REMINDER_NOTIFICATION_ID,
    content: {
      title: REMINDER_TITLE,
      body: REMINDER_BODY,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.CALENDAR,
      hour: plan.hour,
      minute: plan.minute,
      repeats: true,
      channelId: REMINDER_CHANNEL_ID,
    },
  });
}
