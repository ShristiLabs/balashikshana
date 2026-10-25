/**
 * Reminder settings contracts (issue #57, roadmap D5) — the
 * DEVICE-LOCAL parent notification settings. Types + storage seam
 * only; the scheduling POLICY lives in @balashikshana/core-engine
 * (reminders.mjs, pure functions) and the expo-notifications calls
 * live in localReminders.ts (the thin imperative shell).
 *
 * COPPA posture (binding): the settings are device-local and NEVER
 * synced — there is no server table, no sync wire field, and no PII in
 * them (a boolean + an hour/minute + a timestamp). Only the parent
 * surface (app/parent, behind the #44 hold-to-confirm gate) may write
 * them; child-facing surfaces cannot reach this seam.
 *
 * DI doctrine (the GamificationStorage pattern): this interface is
 * pure TypeScript; nativePractice.ts (expo-sqlite, lifecycle DB
 * schema v7) and the node test adapter (tests/helpers/practiceEnv.ts)
 * implement it speaking the exact same SQL.
 */

import type { ReminderSettings } from "@balashikshana/core-engine";

/** The persisted reminder_settings row (id is always the singleton 1). */
export interface ReminderSettingsRecord extends ReminderSettings {
  /** Epoch ms of the last parent write (diagnostics only). */
  updatedAt: number;
}

export interface ReminderSettingsStorage {
  /** The singleton row, or null when no parent ever saved settings. */
  getReminderSettings(): Promise<ReminderSettingsRecord | null>;
  /**
   * Persist the parent's choice (single-writer: the parent surface).
   * Implementations MUST validate before writing (the engine's
   * reminderSettingsProblem) so a corrupt row can never exist.
   */
  upsertReminderSettings(settings: ReminderSettings, nowMs: number): Promise<void>;
}
