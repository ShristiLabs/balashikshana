/**
 * Local notifications policy specs (issue #57 acceptance criteria):
 * the COPPA/D5 doctrine is pinned at the SOURCE level because the
 * notification shell is native (no RN component harness in this repo —
 * standing debt) and the doctrine lives in WHICH code may call WHAT:
 *
 * - LOCAL ONLY: no remote-push API (Expo/device token fetch, remote
 *   registration, remote-message handling) anywhere in the app source;
 * - NO NETWORK in the notification module (explicit no-network path);
 * - PARENT-GATED permissions: requestPermissionsAsync has exactly one
 *   call site — the parent settings section behind the #44 gate; child
 *   surfaces (journey/practice/game/gate/launcher) never prompt;
 * - SETTINGS WRITES: upsertReminderSettings has exactly one caller —
 *   the parent settings section (the bootstrap is read-only);
 * - DEFAULT OFF: a fresh install (no row) normalizes disabled and the
 *   engine plan cancels even on a granted device;
 * - NO PII: the notification payload is the two static literals; no
 *   child name/progress ever interpolates into it;
 * - PERSISTENCE: the device-local row round-trips on REAL SQLite
 *   (schema v7) through the node adapter that mirrors nativePractice
 *   SQL, and both adapters reject invalid rows (engine rule gate).
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// eslint-disable-next-line import/no-unresolved
import { DatabaseSync } from "node:sqlite";
import { normalizeReminderSettings, reminderPlan } from "@balashikshana/core-engine";
import { CONTENT_DB_MIGRATIONS } from "../src/content/schema";
import { NodeReminderSettingsStorage } from "./helpers/practiceEnv";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const mobileRoot = `${repoRoot}/apps/mobile`;
const srcRoot = `${mobileRoot}/src`;
const appRoot = `${mobileRoot}/app`;
const read = (p: string) => readFileSync(p, "utf8");

/** Mirrors migrateContentDb (nativeContent.ts): apply each migration
 *  newer than PRAGMA user_version, then stamp it. */
function runMigrations(db: DatabaseSync): void {
  let at = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (const migration of CONTENT_DB_MIGRATIONS) {
    if (migration.version <= at) continue;
    for (const statement of migration.statements) db.exec(statement);
    db.exec(`PRAGMA user_version = ${migration.version}`);
    at = migration.version;
  }
}

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules") continue;
      walk(full, exts, out);
    } else if (exts.some((e) => entry.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

const sourceFiles = [...walk(srcRoot, [".ts", ".tsx"]), ...walk(appRoot, [".ts", ".tsx"])];

describe("local-only doctrine (D5): no remote push anywhere", () => {
  const forbiddenApis = [
    "getExpoPushTokenAsync",
    "getDevicePushTokenAsync",
    "registerForRemoteNotifications",
    "unregisterForRemoteNotifications",
    "getExpoPushTokenProperty",
    "useLastNotificationResponse",
    "PUSH_MANAGER",
    "DevicePushToken",
  ];

  it("no app source file contains any remote-push API", () => {
    for (const file of sourceFiles) {
      const source = read(file);
      for (const api of forbiddenApis) {
        expect(
          source.includes(api),
          `${api} must not appear in ${path.relative(mobileRoot, file)}`,
        ).toBe(false);
      }
    }
  });

  it("the app manifest never enables remote notification registration", () => {
    const manifest = read(`${mobileRoot}/app.json`);
    expect(manifest).not.toContain('"notification"');
  });

  it("the notification shell uses ONLY the local calendar trigger (repeats daily)", () => {
    const shell = read(`${srcRoot}/notifications/localReminders.ts`);
    expect(shell).toContain("SchedulableTriggerInputTypes.CALENDAR");
    expect(shell).toContain("repeats: true");
    expect(shell).not.toContain("SchedulableTriggerInputTypes.DAILY");
    expect(shell).not.toContain("SchedulableTriggerInputTypes.TIME_INTERVAL");
  });
});

describe("no-network code path (notification module)", () => {
  it("the notification module performs no network I/O of any kind", () => {
    for (const file of walk(`${srcRoot}/notifications`, [".ts", ".tsx"])) {
      const source = read(file);
      expect(source, String(file)).not.toContain("fetch(");
      expect(source, String(file)).not.toContain("XMLHttpRequest");
      expect(source, String(file)).not.toContain("NetInfo");
      expect(source, String(file)).not.toMatch(/https?:\/\//);
    }
  });

  it("expo-notifications is imported only by the thin shell (policy stays in the engine)", () => {
    for (const file of sourceFiles) {
      const rel = path.relative(mobileRoot, file);
      if (rel === "src/notifications/localReminders.ts") continue;
      expect(read(file), rel).not.toContain('"expo-notifications"');
    }
  });
});

describe("parent-gated permission doctrine", () => {
  it("requestPermissionsAsync has exactly ONE call site: the parent settings section", () => {
    const shell = read(`${srcRoot}/notifications/localReminders.ts`);
    expect(shell).toContain("requestPermissionsAsync");
    for (const file of sourceFiles) {
      const rel = path.relative(mobileRoot, file);
      if (rel === "src/notifications/localReminders.ts") continue;
      expect(read(file), rel).not.toContain("requestPermissionsAsync");
    }
  });

  it("the prompt wrapper is named for its single parent caller and documented as gated", () => {
    const shell = read(`${srcRoot}/notifications/localReminders.ts`);
    expect(shell).toContain("requestReminderPermissionFromParentSurface");
    expect(shell).toContain("PARENT-SURFACE ONLY");
  });

  it("the parent settings section is imported ONLY by the gate-protected parent route", () => {
    for (const file of sourceFiles) {
      const rel = path.relative(mobileRoot, file);
      if (rel === "app/parent/index.tsx" || rel === "src/notifications/ReminderSettingsSection.tsx")
        continue;
      expect(read(file), rel).not.toContain("ReminderSettingsSection");
    }
  });

  it("child-facing surfaces never import the notifications settings seam", () => {
    const childSurfaces = ["journey", "practice", "games", "runner", "gate", "onboarding"];
    for (const file of sourceFiles) {
      const rel = path.relative(mobileRoot, file);
      if (!childSurfaces.some((s) => rel.includes(`/${s}/`) || rel.includes(`\\${s}\\`))) continue;
      expect(read(file), rel).not.toContain("notifications/localReminders");
      expect(read(file), rel).not.toContain("ReminderSettingsSection");
    }
  });

  it("settings writes (upsertReminderSettings) come only from the parent section", () => {
    for (const file of sourceFiles) {
      const rel = path.relative(mobileRoot, file);
      const allowed =
        rel === "src/notifications/ReminderSettingsSection.tsx" ||
        rel === "src/notifications/reminderSettings.ts" || // the contract declaration
        rel === "src/practice/nativePractice.ts"; // the adapter itself
      if (allowed) continue;
      expect(read(file), rel).not.toContain("upsertReminderSettings");
    }
  });

  it("the bootstrap is read-only: it never writes settings and never prompts", () => {
    const bootstrap = read(`${srcRoot}/notifications/ReminderBootstrap.tsx`);
    expect(bootstrap).not.toContain("upsertReminderSettings");
    expect(bootstrap).not.toContain("requestReminderPermission");
    const layout = read(`${appRoot}/_layout.tsx`);
    expect(layout).toContain("ReminderBootstrap");
  });
});

describe("no PII in notification content", () => {
  it("the payload is exactly the two static literals (never templated with child data)", () => {
    const shell = read(`${srcRoot}/notifications/localReminders.ts`);
    expect(shell).toContain('export const REMINDER_TITLE = "Time to practice!";');
    expect(shell).toContain(
      'export const REMINDER_BODY = "A short practice session keeps your streak growing.";',
    );
    expect(shell).toContain("title: REMINDER_TITLE");
    expect(shell).toContain("body: REMINDER_BODY");
    expect(shell).not.toContain("studentId");
    expect(shell).not.toContain("childName");
    expect(shell).not.toContain("snapshot");
  });
});

describe("default OFF + settings persistence (device-local, schema v7)", () => {
  it("a fresh install is disabled: no row normalizes OFF and the plan cancels on a granted device", () => {
    const settings = normalizeReminderSettings();
    expect(settings.enabled).toBe(false);
    expect(reminderPlan({ settings, permission: "granted" })).toMatchObject({
      action: "cancel",
      reason: "disabled",
    });
  });

  it("the settings row round-trips every field on REAL SQLite (the node adapter mirrors native SQL)", () => {
    const db = new DatabaseSync(":memory:");
    runMigrations(db);
    const storage = new NodeReminderSettingsStorage(db);
    expect(storage.getReminderSettings()).resolves.toBeNull();
    const now = 1_793_000_000_000;
    void storage.upsertReminderSettings({ enabled: true, hour: 8, minute: 30 }, now);
    expect(storage.getReminderSettings()).resolves.toEqual({
      enabled: true,
      hour: 8,
      minute: 30,
      updatedAt: now,
    });
    // Parent turns reminders off; the choice survives (cancel is a plan
    // outcome, not a row deletion).
    void storage.upsertReminderSettings({ enabled: false, hour: 8, minute: 30 }, now + 1000);
    expect(storage.getReminderSettings()).resolves.toEqual({
      enabled: false,
      hour: 8,
      minute: 30,
      updatedAt: now + 1000,
    });
    db.close();
  });

  it("both adapters gate writes on the engine rule (invalid rows can never reach the DB)", async () => {
    const db = new DatabaseSync(":memory:");
    runMigrations(db);
    const storage = new NodeReminderSettingsStorage(db);
    await expect(
      storage.upsertReminderSettings({ enabled: true, hour: 24, minute: 0 }, 0),
    ).rejects.toThrow("invalid reminder settings");
    const native = read(`${srcRoot}/practice/nativePractice.ts`);
    expect(native).toContain("reminderSettingsProblem(settings)");
    db.close();
  });

  it("the singleton table carries no student id (device-local, no PII, no sync field)", () => {
    const schema = read(`${srcRoot}/content/schema.ts`);
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS reminder_settings");
    expect(schema).toContain("CHECK (id = 1)");
    const tableBlock = schema.slice(schema.indexOf("reminder_settings"));
    expect(tableBlock.slice(0, 400)).not.toContain("student_id");
    // No sync wire field exists for reminders (D5: never leaves the device).
    const syncTypes = read(`${srcRoot}/sync/types.ts`);
    expect(syncTypes).not.toContain("reminder");
  });
});

describe("scheduling transitions + adapter parity (tester additions)", () => {
  it("the shell REPLACES the single reminder on every schedule (cancel-before-schedule invariant)", () => {
    const shell = read(`${srcRoot}/notifications/localReminders.ts`);
    const cancelIdx = shell.indexOf(
      "await Notifications.cancelScheduledNotificationAsync(REMINDER_NOTIFICATION_ID)",
    );
    const scheduleIdx = shell.indexOf("await Notifications.scheduleNotificationAsync(");
    expect(cancelIdx).toBeGreaterThan(-1);
    expect(scheduleIdx).toBeGreaterThan(cancelIdx);
    // The engine plan gates execution: "none" returns early, and only
    // "schedule" reaches the scheduling call after the cancel.
    expect(shell).toContain('if (plan.action === "none") return;');
    expect(shell).toContain('if (plan.action !== "schedule") return;');
  });

  it("permission mapping is fail-closed: only explicit granted/denied map, else undetermined", () => {
    const shell = read(`${srcRoot}/notifications/localReminders.ts`);
    expect(shell).toContain('if (status === "granted") return "granted";');
    expect(shell).toContain('if (status === "denied") return "denied";');
    expect(shell).toContain('return "undetermined";');
  });

  it("the node adapter speaks the exact reminder_settings SQL of the native adapter", () => {
    const native = read(`${srcRoot}/practice/nativePractice.ts`);
    const node = read(`${mobileRoot}/tests/helpers/practiceEnv.ts`);
    for (const adapter of [native, node]) {
      expect(adapter).toContain(
        "SELECT enabled, hour, minute, updated_at FROM reminder_settings WHERE id = 1",
      );
      expect(adapter).toContain(
        "INSERT INTO reminder_settings (id, enabled, hour, minute, updated_at)",
      );
      expect(adapter).toContain("ON CONFLICT(id) DO UPDATE SET");
    }
  });

  it("the time steppers wrap at clock bounds (hour 23->0, minute 55->0)", () => {
    const section = read(`${srcRoot}/notifications/ReminderSettingsSection.tsx`);
    // Modular wrap: +1 past 23 lands on 0; +5 past 55 lands on 0 (the
    // source formulas — no component harness in this repo, standing debt).
    expect(section).toContain("(settings.hour + delta + 24) % 24");
    expect(section).toContain("(settings.minute + delta * 5 + 60) % 60");
  });
});
