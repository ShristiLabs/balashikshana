/**
 * Parent reminder settings section (issue #57, roadmap D5) — the
 * SETTINGS SEAM (the full parent portal surface is #61/M5). Rendered
 * ONLY inside app/parent BEHIND the #44 hold-to-confirm parental gate,
 * which is what makes these settings "writable only behind the
 * parental gate": no child-facing route imports this component
 * (source-pinned by tests).
 *
 * Doctrine encoded here:
 * - The OS permission prompt fires ONLY from this surface, ONLY when a
 *   parent flips the toggle ON (the single permission-REQUEST call site
 *   in the codebase — the shell's wrapper, nowhere else).
 * - Turning reminders OFF never needs a permission and always cancels
 *   the OS schedule (engine plan "cancel").
 * - Denied permission keeps the parent's saved choice but schedules
 *   nothing (engine plan "none"); the status line explains how to
 *   recover from OS settings.
 * - Times are 24h local (steppers; hour step 1, minute step 5 — the #61
 *   portal will replace this seam with a proper picker).
 */
import React, { useCallback, useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";
import {
  normalizeReminderSettings,
  reminderPlan,
  reminderSettingsProblem,
  type ReminderPermissionStatus,
  type ReminderSettings,
} from "@balashikshana/core-engine";
import { Button } from "../design/primitives";
import { useTheme } from "../design/theme";
import { spacing, typeRamp } from "../design/tokens";
import { getNativeReminderSettingsStorage } from "../practice/nativePractice";
import {
  applyReminderPlan,
  getReminderPermissionStatus,
  remindersUnavailableOnWeb,
  requestReminderPermissionFromParentSurface,
} from "./localReminders";

function twoDigits(n: number): string {
  return String(n).padStart(2, "0");
}

function Stepper({
  label,
  display,
  onDecrement,
  onIncrement,
  testPrefix,
}: {
  label: string;
  display: string;
  onDecrement: () => void;
  onIncrement: () => void;
  testPrefix: string;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
      <Text style={{ ...typeRamp.body, color: colors.text, minWidth: 64 }}>{label}</Text>
      <Button
        label="-"
        variant="outline"
        onPress={onDecrement}
        accessibilityHint={`Decrease reminder ${label.toLowerCase()}`}
        testID={`${testPrefix}.minus`}
      />
      <Text
        style={{ ...typeRamp.body, color: colors.text, minWidth: 52, textAlign: "center" }}
        accessibilityLabel={`Reminder ${label.toLowerCase()} ${display}`}
      >
        {display}
      </Text>
      <Button
        label="+"
        variant="outline"
        onPress={onIncrement}
        accessibilityHint={`Increase reminder ${label.toLowerCase()}`}
        testID={`${testPrefix}.plus`}
      />
    </View>
  );
}

export function ReminderSettingsSection(): React.JSX.Element {
  const { colors } = useTheme();
  const storage = getNativeReminderSettingsStorage();
  const [settings, setSettings] = useState<ReminderSettings>(() => normalizeReminderSettings());
  const [permission, setPermission] = useState<ReminderPermissionStatus>("undetermined");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [record, status] = await Promise.all([
        storage.getReminderSettings().catch(() => null),
        getReminderPermissionStatus().catch(() => "undetermined" as const),
      ]);
      if (cancelled) return;
      setSettings(normalizeReminderSettings(record ?? undefined));
      setPermission(status);
      setLoaded(true);
      // Re-apply the engine plan at mount: default-off cancels any
      // stray schedule; a saved enabled+granted reminder is confirmed.
      const plan = reminderPlan({
        settings: normalizeReminderSettings(record ?? undefined),
        permission: status,
      });
      await applyReminderPlan(plan).catch(() => {
        // Scheduling is best-effort here; the explicit toggle flow
        // below surfaces errors by re-reading status on next mount.
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persistAndApply = useCallback(
    async (next: ReminderSettings, nextPermission: ReminderPermissionStatus) => {
      setSettings(next);
      setPermission(nextPermission);
      if (reminderSettingsProblem(next)) return;
      const nowMs = Date.now();
      await storage.upsertReminderSettings(next, nowMs).catch(() => {
        // Device-local persistence failure keeps the in-memory choice;
        // the next toggle re-attempts the write.
      });
      const plan = reminderPlan({ settings: next, permission: nextPermission });
      await applyReminderPlan(plan).catch(() => {});
    },
    [storage],
  );

  /** The ONLY permission prompt path: the parent enabling reminders. */
  const onToggle = useCallback(async () => {
    if (settings.enabled) {
      await persistAndApply({ ...settings, enabled: false }, permission);
      return;
    }
    const status = await requestReminderPermissionFromParentSurface().catch(
      () => "denied" as const,
    );
    await persistAndApply({ ...settings, enabled: true }, status);
  }, [persistAndApply, permission, settings]);

  const onHour = useCallback(
    (delta: number) => {
      const hour = (settings.hour + delta + 24) % 24;
      void persistAndApply({ ...settings, hour }, permission);
    },
    [persistAndApply, permission, settings],
  );

  const onMinute = useCallback(
    (delta: number) => {
      const minute = (settings.minute + delta * 5 + 60) % 60;
      void persistAndApply({ ...settings, minute }, permission);
    },
    [persistAndApply, permission, settings],
  );

  const blockedByPermission = loaded && settings.enabled && permission !== "granted";

  // WEB EDITION (#71): browser push/notifications are out of doctrine
  // (local-only reminders + kid-safe no-permission-prompt surface), so
  // the toggle and steppers are replaced by an honest explanation. The
  // saved choice (if any) is preserved untouched for native devices.
  if (remindersUnavailableOnWeb) {
    return (
      <View style={{ gap: spacing.md }} accessibilityLabel="Daily practice reminder settings">
        <Text style={{ ...typeRamp.h3, color: colors.text }}>Daily practice reminder</Text>
        <Text
          style={{ ...typeRamp.body, color: colors.text }}
          testID="parent.reminders.web-unavailable"
        >
          Practice reminders are not available in the web edition. Browser notification permissions
          are never requested here. Use the installed app on a phone or tablet to set a daily
          reminder.
        </Text>
      </View>
    );
  }

  return (
    <View style={{ gap: spacing.md }} accessibilityLabel="Daily practice reminder settings">
      <Text style={{ ...typeRamp.h3, color: colors.text }}>Daily practice reminder</Text>
      <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
        A gentle local reminder at one time each day, set by you. It works offline on this device
        only - nothing is sent anywhere, and your child cannot change it.
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
        <Switch
          value={settings.enabled}
          onValueChange={() => void onToggle()}
          disabled={!loaded}
          trackColor={{ true: colors.primary.fill, false: colors.surfaceAlt }}
          accessibilityLabel="Daily practice reminder"
          accessibilityHint="Turn the daily practice reminder on or off"
          testID="parent.reminders.toggle"
        />
        <Text style={{ ...typeRamp.body, color: colors.text }}>
          {settings.enabled ? "On" : "Off (default)"}
        </Text>
      </View>
      {settings.enabled ? (
        <View style={{ gap: spacing.sm }}>
          <Stepper
            label="Hour"
            display={twoDigits(settings.hour)}
            onDecrement={() => onHour(-1)}
            onIncrement={() => onHour(1)}
            testPrefix="parent.reminders.hour"
          />
          <Stepper
            label="Minute"
            display={twoDigits(settings.minute)}
            onDecrement={() => onMinute(-1)}
            onIncrement={() => onMinute(1)}
            testPrefix="parent.reminders.minute"
          />
          <Text style={{ ...typeRamp.caption, color: colors.textMuted }}>
            {`Reminder time ${twoDigits(settings.hour)}:${twoDigits(settings.minute)} (this device's clock)`}
          </Text>
        </View>
      ) : null}
      {blockedByPermission ? (
        <Text
          style={{ ...typeRamp.body, color: colors.statusInk.warning }}
          testID="parent.reminders.permission"
        >
          Notifications are currently not allowed for this app, so the reminder cannot show. Allow
          notifications for Balashikshana in the device settings, then turn this off and back on.
        </Text>
      ) : null}
    </View>
  );
}
