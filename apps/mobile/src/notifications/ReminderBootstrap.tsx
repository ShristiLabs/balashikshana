/**
 * Reminder bootstrap (issue #57): mounted once at the root layout
 * (the SyncBootstrap fire-and-forget pattern). Re-applies the engine's
 * reminder plan at every app start:
 * - default-off / disabled -> cancel (a fresh install removes nothing
 *   because nothing exists, but a stray schedule can never survive);
 * - enabled + granted -> reschedule (Android alarms do not survive a
 *   reboot; re-applying at start restores the daily trigger);
 * - enabled without permission -> hold (no schedule, no prompt — the
 *   OS permission prompt is parent-gated and NEVER fires from here).
 *
 * READ-ONLY with respect to settings: this component never writes the
 * parent's row and never requests permissions.
 */
import { useEffect } from "react";
import { normalizeReminderSettings, reminderPlan } from "@balashikshana/core-engine";
import { getNativeReminderSettingsStorage } from "../practice/nativePractice";
import {
  applyReminderPlan,
  getReminderPermissionStatus,
  initializeLocalReminders,
} from "./localReminders";

export function ReminderBootstrap(): null {
  useEffect(() => {
    initializeLocalReminders();
    let cancelled = false;
    (async () => {
      const storage = getNativeReminderSettingsStorage();
      const [record, permission] = await Promise.all([
        storage.getReminderSettings().catch(() => null),
        getReminderPermissionStatus().catch(() => "undetermined" as const),
      ]);
      if (cancelled) return;
      const settings = normalizeReminderSettings(record ?? undefined);
      const plan = reminderPlan({ settings, permission });
      await applyReminderPlan(plan).catch(() => {
        // Best-effort: the parent surface re-applies on its next mount.
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
