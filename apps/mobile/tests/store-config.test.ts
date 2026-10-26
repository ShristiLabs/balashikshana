/**
 * Store-readiness config audit, automated half (issue #69): pins that keep
 * the native config HONEST against the Data Safety answers filed from
 * docs/data-flow-inventory.md. A mismatch between declared and actual
 * permissions/flows is a store rejection at best and a post-launch
 * compliance failure at worst — these pins make the drift fail CI.
 *
 * 1. AUDIO PERMISSION DRIFT — the app is playback-only (nativeAudio.ts
 *    sets allowsRecording:false, shouldPlayInBackground:false), so the
 *    expo-audio plugin must be configured to NOT merge RECORD_AUDIO
 *    (Android), NSMicrophoneUsageDescription (iOS), or any
 *    background-audio / foreground-service permission. The bare plugin
 *    defaults merge ALL of those; the fix is pinned here.
 *
 * 2. PLUGIN ALLOWLIST — the expo plugin list is exact: a new native
 *    module is a conscious, reviewed act (new permissions mean the Data
 *    Safety answers and docs/store/ must change in the same PR).
 *
 * 3. NO UNDECLARED PERMISSION STRINGS — no location, contacts, camera,
 *    advertising-ID, or post-notification permission may appear anywhere
 *    in app.json (notifications are local-only per #57; diagnostics flow
 *    first-party per #66).
 *
 * 4. ENDPOINT DISCLOSURE — every network egress in shipped sources goes
 *    through the single EXPO_PUBLIC_API_BASE seam; the only absolute-URL
 *    literal allowed in src is the localhost dev default ON that seam's
 *    line. No undisclosed endpoints can ship silently.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mobileRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/+$/, "");

function readText(rel: string): string {
  return readFileSync(join(mobileRoot, rel), "utf8");
}

const appJson = JSON.parse(readText("app.json")) as {
  expo: {
    plugins: (string | [string, Record<string, unknown>])[];
    android?: { package?: string; permissions?: string[]; blockedPermissions?: string[] };
    ios?: Record<string, unknown>;
  };
};

function pluginEntry(name: string): string | [string, Record<string, unknown>] | undefined {
  return appJson.expo.plugins.find(
    (p) => (typeof p === "string" && p === name) || (Array.isArray(p) && p[0] === name),
  );
}

// --- 1. Audio permission drift ---------------------------------------------------

describe("store config: expo-audio merged-permission drift fix (issue #69)", () => {
  it("expo-audio plugin pins the playback-only posture (no mic, no background audio)", () => {
    const entry = pluginEntry("expo-audio");
    expect(
      Array.isArray(entry),
      "expo-audio must be configured with explicit props, not bare",
    ).toBe(true);
    const props = (entry as [string, Record<string, unknown>])[1];
    expect(props.microphonePermission).toBe(false);
    expect(props.recordAudioAndroid).toBe(false);
    expect(props.enableBackgroundRecording).toBe(false);
    expect(props.enableBackgroundPlayback).toBe(false);
  });

  it("the runtime audio mode agrees: never records, never plays in background", () => {
    const native = readText("src/audio/nativeAudio.ts");
    expect(native).toContain("allowsRecording: false");
    expect(native).toContain("shouldPlayInBackground: false");
    // And nothing in shipped src touches the recording API surface.
    expect(native).not.toMatch(/useAudioRecorder|requestRecordPermissions|AudioRecording/g);
  });
});

describe("store config: the mailed-code verification UX exists (mailer-flip dependency)", () => {
  // issue #69 mailer flip: production parents receive the verification
  // token by email as a copyable code. The flip is zero-client-change
  // BECAUSE the verify step already takes manual token entry — pin that
  // premise so a refactor cannot silently remove the entry surface.
  it("VerifyEmailStep renders a manual token entry field", () => {
    const step = readText("src/onboarding/steps/VerifyEmailStep.tsx");
    // The step's entry primitive is the shared <Field> component wrapping
    // a TextInput — pin the editability wiring, not the wrapper name.
    expect(step).toContain("onChangeText");
    expect(step).toMatch(/<Field/);
    const shared = readText("src/onboarding/steps/shared.tsx");
    expect(shared).toMatch(/TextInput/);
  });
});

// --- 2. Plugin allowlist ----------------------------------------------------------

describe("store config: expo plugin allowlist is exact", () => {
  it("the plugin list matches the reviewed set exactly", () => {
    const names = appJson.expo.plugins.map((p) => (Array.isArray(p) ? p[0] : p));
    expect([...names].sort()).toEqual([
      "expo-audio",
      "expo-router",
      "expo-splash-screen",
      "expo-sqlite",
    ]);
  });
});

// --- 3. No undeclared permission strings ------------------------------------------

describe("store config: no undeclared permission strings in app.json", () => {
  // Names that must NEVER appear anywhere in app.json, not even inside a
  // removal list — declaring them would contradict the Data Safety forms.
  // (READ/WRITE_EXTERNAL_STORAGE are exempt from the raw-text scan: they
  // legitimately appear inside blockedPermissions as REMOVAL instructions;
  // the parsed-array checks below keep them from being REQUESTED.)
  const FORBIDDEN_ANYWHERE = [
    "RECORD_AUDIO",
    "ACCESS_FINE_LOCATION",
    "ACCESS_COARSE_LOCATION",
    "READ_CONTACTS",
    "WRITE_CONTACTS",
    "CAMERA",
    "AD_ID",
    "ACCESS_ADVERTISING",
    "POST_NOTIFICATIONS",
    "READ_MEDIA",
    "NSMicrophoneUsageDescription",
    "NSCameraUsageDescription",
    "NSLocationWhenInUseUsageDescription",
    "NSContactsUsageDescription",
    "NSPhotoLibraryUsageDescription",
  ];

  it.each(FORBIDDEN_ANYWHERE)("app.json must not contain %s", (needle) => {
    expect(readText("app.json")).not.toContain(needle);
  });

  it("android.permissions is not expanded beyond the (empty) reviewed set", () => {
    const permissions = appJson.expo.android?.permissions;
    if (permissions !== undefined) {
      expect(Array.isArray(permissions)).toBe(true);
      expect(permissions).toEqual([]);
    }
  });

  it("no requested-permission path may carry a forbidden name (parsed, not raw text)", () => {
    // Everything the config can REQUEST goes through android.permissions —
    // assert none of the forbidden names appear in ANY requested list.
    const requested = (appJson.expo.android?.permissions ?? []).join(" ");
    for (const needle of [
      "READ_EXTERNAL_STORAGE",
      "WRITE_EXTERNAL_STORAGE",
      "RECORD_AUDIO",
      "CAMERA",
      "ACCESS_",
      "AD_ID",
      "POST_NOTIFICATIONS",
    ]) {
      expect(requested).not.toContain(needle);
    }
  });

  it("the Expo template's unused default permissions stay blocked (verified against prebuild output)", () => {
    // Prebuild on this branch produced exactly INTERNET + MODIFY_AUDIO_SETTINGS
    // (playback routing) + VIBRATE (haptics) as ACTIVE permissions; the Expo
    // template's storage + overlay defaults are stripped via blockedPermissions
    // (manifest markers tools:node="remove"). The app never touches shared
    // storage or draws overlays — declaring them would be untrue.
    expect([...(appJson.expo.android?.blockedPermissions ?? [])].sort()).toEqual([
      "android.permission.READ_EXTERNAL_STORAGE",
      "android.permission.SYSTEM_ALERT_WINDOW",
      "android.permission.WRITE_EXTERNAL_STORAGE",
    ]);
  });
});

// --- 4. Endpoint disclosure -------------------------------------------------------

describe("store config: single-endpoint disclosure (no undisclosed hosts)", () => {
  const DEV_DEFAULT = "http://localhost:4000";

  it("the only absolute-URL literal in shipped src is the dev default ON the EXPO_PUBLIC_API_BASE seam", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(mobileRoot, dir))) {
        if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
        const full = join(mobileRoot, dir, entry);
        if (statSync(full).isDirectory()) walk(join(dir, entry));
        else if (/\.(ts|tsx)$/.test(entry)) files.push(full);
      }
    };
    walk("src");

    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        if (!/https?:\/\//.test(line)) return;
        if (
          line.includes("EXPO_PUBLIC_API_BASE") &&
          line.includes(DEV_DEFAULT) &&
          !line.replace(DEV_DEFAULT, "").match(/https?:\/\//)
        ) {
          return; // the single seam's dev default
        }
        offenders.push(`${file.replace(mobileRoot, "")}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, `undisclosed absolute URLs:\n${offenders.join("\n")}`).toEqual([]);
  });
});
