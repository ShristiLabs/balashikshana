/**
 * Daily practice-reminder rule specs (issue #57 acceptance: pure
 * scheduling rules with an injected clock). Every boundary is pinned:
 * settings validation, fail-closed normalization (DEFAULT OFF), the
 * next-occurrence time incl. the reminder-time-crossing-midnight cases
 * and the fixed-offset local-day model, and the full schedule/cancel/
 * hold decision matrix over permission states.
 */
import { describe, expect, test } from "vitest";
import {
  DEFAULT_REMINDER_HOUR,
  DEFAULT_REMINDER_MINUTE,
  REMINDER_NOTIFICATION_ID,
  REMINDER_PERMISSION_STATES,
  nextReminderOccurrenceMs,
  normalizeReminderSettings,
  reminderPlan,
  reminderSettingsProblem,
} from "../src/index.mjs";

const T = (iso) => Date.parse(iso);

describe("reminderSettingsProblem", () => {
  test("accepts a well-formed row", () => {
    expect(reminderSettingsProblem({ enabled: false, hour: 17, minute: 0 })).toBe(null);
    expect(reminderSettingsProblem({ enabled: true, hour: 0, minute: 59 })).toBe(null);
  });

  test("rejects non-boolean enabled", () => {
    expect(reminderSettingsProblem({ enabled: 1, hour: 17, minute: 0 })).toBe(
      "reminder-enabled-not-boolean",
    );
    expect(reminderSettingsProblem({ enabled: "true", hour: 17, minute: 0 })).toBe(
      "reminder-enabled-not-boolean",
    );
  });

  test("rejects hour/minute outside the clock", () => {
    expect(reminderSettingsProblem({ enabled: true, hour: 24, minute: 0 })).toBe(
      "reminder-hour-out-of-range",
    );
    expect(reminderSettingsProblem({ enabled: true, hour: -1, minute: 0 })).toBe(
      "reminder-hour-out-of-range",
    );
    expect(reminderSettingsProblem({ enabled: true, hour: 12.5, minute: 0 })).toBe(
      "reminder-hour-out-of-range",
    );
    expect(reminderSettingsProblem({ enabled: true, hour: 12, minute: 60 })).toBe(
      "reminder-minute-out-of-range",
    );
    expect(reminderSettingsProblem({ enabled: true, hour: 12, minute: -1 })).toBe(
      "reminder-minute-out-of-range",
    );
  });
});

describe("normalizeReminderSettings (fail-closed, DEFAULT OFF)", () => {
  test("a valid row passes through untouched", () => {
    expect(normalizeReminderSettings({ enabled: true, hour: 8, minute: 30 })).toEqual({
      enabled: true,
      hour: 8,
      minute: 30,
    });
  });

  test("no input at all (fresh install) is DISABLED at the default time", () => {
    expect(normalizeReminderSettings()).toEqual({
      enabled: false,
      hour: DEFAULT_REMINDER_HOUR,
      minute: DEFAULT_REMINDER_MINUTE,
    });
  });

  test("a corrupt enabled field can never turn reminders ON", () => {
    expect(normalizeReminderSettings({ enabled: 1, hour: 8, minute: 30 }).enabled).toBe(false);
    expect(normalizeReminderSettings({ enabled: "yes", hour: 8, minute: 30 }).enabled).toBe(false);
    expect(normalizeReminderSettings({ enabled: null, hour: 8, minute: 30 }).enabled).toBe(false);
  });

  test("invalid time fields fall back to the after-school default", () => {
    expect(normalizeReminderSettings({ enabled: true, hour: 99, minute: 0 })).toEqual({
      enabled: true,
      hour: DEFAULT_REMINDER_HOUR,
      minute: DEFAULT_REMINDER_MINUTE,
    });
    expect(normalizeReminderSettings({ enabled: true, hour: 9, minute: "xx" })).toEqual({
      enabled: true,
      hour: 9,
      minute: DEFAULT_REMINDER_MINUTE,
    });
  });
});

describe("nextReminderOccurrenceMs (injected clock, fixed-offset local model)", () => {
  test("later today when the reminder time is still ahead", () => {
    const now = T("2026-10-26T10:00:00Z");
    expect(nextReminderOccurrenceMs({ nowMs: now, hour: 17, minute: 0 })).toBe(
      T("2026-10-26T17:00:00Z"),
    );
  });

  test("tomorrow when today's occurrence already passed (evening reminder)", () => {
    const now = T("2026-10-26T18:00:00Z");
    expect(nextReminderOccurrenceMs({ nowMs: now, hour: 17, minute: 0 })).toBe(
      T("2026-10-27T17:00:00Z"),
    );
  });

  test("exactly-now means today's reminder already fired: next is tomorrow", () => {
    const now = T("2026-10-26T17:00:00.000Z");
    expect(nextReminderOccurrenceMs({ nowMs: now, hour: 17, minute: 0 })).toBe(
      T("2026-10-27T17:00:00Z"),
    );
  });

  test("one millisecond before the time means today", () => {
    const now = T("2026-10-26T16:59:59.999Z");
    expect(nextReminderOccurrenceMs({ nowMs: now, hour: 17, minute: 0 })).toBe(
      T("2026-10-26T17:00:00Z"),
    );
  });

  test("a just-after-midnight reminder crossed by a late evening now is 25 min away", () => {
    // Reminder 00:15 local; now 23:50 local the same local day: the next
    // occurrence is tomorrow 00:15 local — 25 minutes later, crossing
    // midnight. Modeled at UTC for clarity.
    const now = T("2026-10-26T23:50:00Z");
    const next = nextReminderOccurrenceMs({ nowMs: now, hour: 0, minute: 15 });
    expect(next).toBe(T("2026-10-27T00:15:00Z"));
    expect(next - now).toBe(25 * 60 * 1000);
  });

  test("a 23:30 reminder after 23:45 rolls a full day to tomorrow 23:30", () => {
    const now = T("2026-10-26T23:45:00Z");
    expect(nextReminderOccurrenceMs({ nowMs: now, hour: 23, minute: 30 })).toBe(
      T("2026-10-27T23:30:00Z"),
    );
  });

  test("day boundaries: the local day, not the UTC day, owns the rule (offset model)", () => {
    // 2026-10-26T23:30Z is 2026-10-27 05:00 at UTC+5:30: the UTC day is
    // still Oct 26, but the LOCAL day Oct 27 is young — its 17:00 local
    // occurrence (= Oct 27 11:30Z) is still ahead and is the answer.
    const now = T("2026-10-26T23:30:00Z");
    expect(nextReminderOccurrenceMs({ nowMs: now, hour: 17, minute: 0, utcOffsetMinutes: 330 })).toBe(
      T("2026-10-27T11:30:00Z"),
    );
  });

  test("offset model: an evening reminder still ahead on the local day", () => {
    // 2026-10-26T20:00Z is local Oct 27 01:30 at UTC+5:30; local 09:00
    // (03:30Z) already passed, local 17:00 (11:30Z) is later today local.
    const now = T("2026-10-26T20:00:00Z");
    expect(nextReminderOccurrenceMs({ nowMs: now, hour: 17, minute: 0, utcOffsetMinutes: 330 })).toBe(
      T("2026-10-27T11:30:00Z"),
    );
  });

  test("a negative offset (US Eastern, UTC-4) keeps the local-day rule", () => {
    // 2026-10-26T02:00Z is local Oct 25 22:00 at UTC-4; reminder 19:00
    // local already passed Oct 25 -> next is Oct 26 19:00 local (23:00Z).
    const now = T("2026-10-26T02:00:00Z");
    expect(nextReminderOccurrenceMs({ nowMs: now, hour: 19, minute: 0, utcOffsetMinutes: -240 })).toBe(
      T("2026-10-26T23:00:00Z"),
    );
  });

  test("invalid inputs never produce an occurrence (null — do not schedule)", () => {
    expect(nextReminderOccurrenceMs({ nowMs: Number.NaN, hour: 17, minute: 0 })).toBe(null);
    expect(nextReminderOccurrenceMs({ nowMs: T("2026-10-26T10:00:00Z"), hour: 24, minute: 0 })).toBe(null);
    expect(nextReminderOccurrenceMs({ nowMs: T("2026-10-26T10:00:00Z"), hour: 10, minute: 60 })).toBe(null);
  });
});

describe("reminderPlan (the decision matrix)", () => {
  test("invalid settings fail SAFE to cancel", () => {
    const plan = reminderPlan({ settings: { enabled: true, hour: 99, minute: 0 }, permission: "granted" });
    expect(plan.action).toBe("cancel");
    expect(plan.reason).toBe("invalid-settings");
    // Coerced defaults ride along for the shell's cancel path.
    expect(plan.hour).toBe(DEFAULT_REMINDER_HOUR);
  });

  test("disabled cancels (turning reminders off removes the OS schedule)", () => {
    const plan = reminderPlan({ settings: { enabled: false, hour: 17, minute: 0 }, permission: "granted" });
    expect(plan).toEqual({ action: "cancel", reason: "disabled", hour: 17, minute: 0 });
  });

  test("enabled + granted schedules at the parent's time", () => {
    const plan = reminderPlan({ settings: { enabled: true, hour: 8, minute: 30 }, permission: "granted" });
    expect(plan).toEqual({ action: "schedule", reason: "enabled", hour: 8, minute: 30 });
  });

  test("lifecycle transitions: enable -> move time -> disable -> re-enable under denial -> recover", () => {
    // Fresh install (disabled): cancel even on a granted device.
    expect(
      reminderPlan({ settings: { enabled: false, hour: 17, minute: 0 }, permission: "granted" })
        .action,
    ).toBe("cancel");
    // Parent enables: schedule at the chosen time.
    expect(
      reminderPlan({ settings: { enabled: true, hour: 17, minute: 0 }, permission: "granted" }),
    ).toMatchObject({ action: "schedule", hour: 17, minute: 0 });
    // Parent moves the time while enabled: the plan stays "schedule" at
    // the NEW time — the shell's replace semantics reschedule it.
    expect(
      reminderPlan({ settings: { enabled: true, hour: 8, minute: 30 }, permission: "granted" }),
    ).toMatchObject({ action: "schedule", hour: 8, minute: 30 });
    // Parent disables: cancel even though the permission stands.
    expect(
      reminderPlan({ settings: { enabled: false, hour: 8, minute: 30 }, permission: "granted" })
        .action,
    ).toBe("cancel");
    // Parent re-enables but the OS permission is now DENIED: hold —
    // the setting survives, nothing schedules, no error state.
    expect(
      reminderPlan({ settings: { enabled: true, hour: 8, minute: 30 }, permission: "denied" }),
    ).toMatchObject({ action: "none", reason: "permission-not-granted" });
    // Permission recovered from OS settings: scheduling resumes with
    // NO settings change (the saved choice is the whole state).
    expect(
      reminderPlan({ settings: { enabled: true, hour: 8, minute: 30 }, permission: "granted" }),
    ).toMatchObject({ action: "schedule", reason: "enabled" });
  });

  test("enabled without a grant holds: nothing schedules, setting survives", () => {
    for (const permission of ["denied", "undetermined"]) {
      const plan = reminderPlan({ settings: { enabled: true, hour: 8, minute: 30 }, permission });
      expect(plan.action).toBe("none");
      expect(plan.reason).toBe("permission-not-granted");
    }
  });

  test("an unknown permission state is treated as not granted (fail-closed)", () => {
    const plan = reminderPlan({ settings: { enabled: true, hour: 8, minute: 30 }, permission: "garbage" });
    expect(plan.action).toBe("none");
    expect(plan.reason).toBe("permission-not-granted");
  });

  test("default-off proof: fresh-install settings (no row) cancel on a granted device", () => {
    const plan = reminderPlan({ settings: normalizeReminderSettings(), permission: "granted" });
    expect(plan.action).toBe("cancel");
    expect(plan.reason).toBe("disabled");
  });

  test("null settings (missing storage row) fail safe to cancel", () => {
    const plan = reminderPlan({ settings: null, permission: "granted" });
    expect(plan.action).toBe("cancel");
  });
});

describe("module data", () => {
  test("the notification id is the documented single-reminder identifier", () => {
    expect(REMINDER_NOTIFICATION_ID).toBe("balashikshana-daily-practice-reminder");
  });

  test("permission states enumerate exactly the shell's mapping targets", () => {
    expect([...REMINDER_PERMISSION_STATES]).toEqual(["granted", "denied", "undetermined"]);
  });
});
