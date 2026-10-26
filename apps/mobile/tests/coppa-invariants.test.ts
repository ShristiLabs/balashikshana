/**
 * Families/Kids policy self-check, automated half (issue #68): the
 * evidence-generating scans behind docs/families-kids-self-check.md.
 *
 * 1. SDK SCAN — no third-party advertising/analytics/tracking SDKs
 *    anywhere in the repo's manifests. Two layers: an exact COPPA
 *    ALLOWLIST per workspace manifest (extending it is a conscious,
 *    reviewed act) and a vendor-pattern blocklist over every dependency
 *    name (runtime AND dev, every workspace).
 *
 * 2. LINK AUDIT — no external-link escape hatches (Linking.openURL /
 *    anchor hrefs) anywhere in shipped mobile sources. Apple Kids
 *    Category and Google Play Families reject un-gated external links;
 *    the app renders all content (including the legal pack) in-app.
 *
 * 3. PARENTAL-GATE COVERAGE — the parent/settings surface is reachable
 *    only through the hold-to-confirm gate: the gate branch precedes
 *    every parent-content render, and parent-surface modules do not leak
 *    into child-facing route files.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url)).replace(/\/+$/, "");
const mobileRoot = fileURLToPath(new URL("..", import.meta.url));

function readText(rel: string): string {
  return readFileSync(join(mobileRoot, rel), "utf8");
}

function listFiles(dir: string, filter: (name: string) => boolean, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      listFiles(full, filter, acc);
    } else if (filter(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

// --- 1. SDK scan ----------------------------------------------------------------

// Exact per-manifest COPPA allowlists (runtime dependencies). Adding a
// dependency means adding it HERE, in the same PR, under review — the
// store Data Safety forms are regenerated from this inventory.
const COPPA_RUNTIME_ALLOWLIST: Record<string, string[]> = {
  "apps/mobile/package.json": [
    "@balashikshana/core-engine",
    "@noble/ed25519",
    "@noble/hashes",
    "@react-native-community/netinfo",
    "expo",
    "expo-asset",
    "expo-audio",
    "expo-constants",
    "expo-file-system",
    "expo-haptics",
    "expo-image",
    "expo-linking",
    "expo-notifications",
    "expo-router",
    "expo-secure-store",
    "expo-speech",
    "expo-splash-screen",
    "expo-sqlite",
    "react",
    "react-native",
    "react-native-reanimated",
    "react-native-safe-area-context",
    "react-native-svg",
    "react-native-worklets",
  ],
  "apps/parent-portal/package.json": ["react", "react-dom"],
  "services/api/package.json": [
    "@fastify/cors",
    "@fastify/helmet",
    "@fastify/rate-limit",
    "fastify",
    "node-pg-migrate",
    "nodemailer",
    "pg",
    "pino",
  ],
  "packages/core-engine/package.json": [], // zero-dependency invariant (AGENTS.md)
  "tools/content-pipeline/package.json": [],
  "package.json": [],
};

// Vendor/purpose patterns that define a forbidden SDK regardless of
// allowlist (defense in depth — the allowlist above is the primary gate).
const FORBIDDEN_SDK_PATTERN =
  /(admob|adsense|doubleclick|facebook|firebase|app-analytics|amplitude|mixpanel|segment(-|$)|appsflyer|adjust(-|$)|branch(-|$)|kochava|braze|clevertap|moengage|sentry|bugsnag|datadog|newrelic|flurry|chartbeat|hotjar|quantcast|scorecardresearch|taboola|outbrain|criteo|unity-ads|ironsource|vungle|applovin)/i;

function manifests(): string[] {
  const out: string[] = [];
  const workspaces = [
    "apps/mobile",
    "apps/parent-portal",
    "services/api",
    "packages/core-engine",
    "tools/content-pipeline",
  ];
  for (const ws of [".", ...workspaces]) {
    const p = join(repoRoot, ws, "package.json");
    if (existsSync(p)) out.push(p);
  }
  return out;
}

describe("COPPA SDK scan (families/kids self-check, evidence layer 1)", () => {
  for (const manifestPath of manifests()) {
    const rel = manifestPath.slice(repoRoot.length + 1);
    it(`${rel}: runtime dependencies exactly match the COPPA allowlist`, () => {
      const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
      const deps = Object.keys(pkg.dependencies || {}).sort();
      const allowed = [...(COPPA_RUNTIME_ALLOWLIST[rel] ?? [])].sort();
      expect(deps).toEqual(allowed);
    });

    it(`${rel}: no advertising/analytics/tracking SDK name in ANY dependency (runtime or dev)`, () => {
      const pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
      const names = [
        ...Object.keys(pkg.dependencies || {}),
        ...Object.keys(pkg.devDependencies || {}),
      ];
      const hits = names.filter((n) => FORBIDDEN_SDK_PATTERN.test(n));
      expect(hits, `forbidden SDK names: ${hits.join(", ")}`).toEqual([]);
    });
  }

  it("packages/core-engine remains zero-dependency (AGENTS.md invariant)", () => {
    const pkg = JSON.parse(
      readFileSync(join(repoRoot, "packages/core-engine/package.json"), "utf8"),
    );
    expect(Object.keys(pkg.dependencies || {})).toEqual([]);
  });
});

// --- 2. Link audit ----------------------------------------------------------------

describe("external-link audit (families/kids self-check, evidence layer 2)", () => {
  const sourceFiles = listFiles(join(mobileRoot, "src"), (n) => /\.(ts|tsx)$/.test(n)).concat(
    listFiles(join(mobileRoot, "app"), (n) => /\.(ts|tsx)$/.test(n)),
  );

  it("scans a non-trivial source surface", () => {
    expect(sourceFiles.length).toBeGreaterThan(80);
  });

  it("no shipped mobile source opens an external URL (Linking.openURL / anchors)", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const text = readFileSync(file, "utf8");
      if (/Linking\s*\.\s*openURL|openURL\s*\(|<a\s+href/i.test(text)) {
        offenders.push(file.slice(mobileRoot.length + 1));
      }
    }
    expect(offenders, `files opening external URLs: ${offenders.join(", ")}`).toEqual([]);
  });

  it("expo-notifications usage is device-local only (zero remote push)", () => {
    // The #57 doctrine: reminders are local notifications scheduled on the
    // device (setNotificationHandler + scheduleNotificationAsync are the
    // LOCAL surface); push token registration would be the remote seam and
    // must not exist anywhere.
    const offenders: string[] = [];
    for (const file of sourceFiles) {
      const text = readFileSync(file, "utf8");
      if (
        /getDevicePushToken|getExpoPushToken|registerDeviceForRemoteMessages|useLastNotificationResponse/.test(
          text,
        )
      ) {
        offenders.push(file.slice(mobileRoot.length + 1));
      }
    }
    expect(offenders, `remote-push surfaces: ${offenders.join(", ")}`).toEqual([]);
  });
});

// --- 3. Parental-gate coverage -----------------------------------------------------

describe("parental-gate coverage (audit layer 3)", () => {
  it("the parent area gates ALL of its content behind the hold-to-confirm gate", () => {
    const source = readText("app/parent/index.tsx");
    const gateBranch = source.indexOf("if (!gatePassed)");
    expect(gateBranch).toBeGreaterThan(-1);
    // Every parent-content RENDER (not import) sits after the gate branch.
    for (const marker of [
      "<ReminderSettingsSection",
      "<LegalDocuments",
      'label="Switch parent account"',
      'label="Sign out"',
    ]) {
      expect(source.indexOf(marker), `${marker} must render only after the gate`).toBeGreaterThan(
        gateBranch,
      );
    }
  });

  it("parent-surface modules do not leak into child-facing route files", () => {
    // ReminderSettingsSection and the parent-area legal section are the
    // parent surfaces; child-facing routes must not import them.
    const childRoutes = [
      "journey/index.tsx",
      "practice/index.tsx",
      "gate/index.tsx",
      "game/index.tsx",
      "placement/index.tsx",
    ];
    for (const route of childRoutes) {
      const source = readText(join("app", route));
      expect(source).not.toContain("ReminderSettingsSection");
      expect(source).not.toContain("LegalDocuments");
      expect(source).not.toContain("ParentalGate");
    }
  });

  it("the gate component stays the shared single implementation (no forked gates)", () => {
    // src/onboarding/ParentalGate.tsx is the one gate; the timing model is
    // the pure gateTimer module (tap-spam immunity pinned in
    // onboarding-gate-timer.test.ts).
    const gate = readText("src/onboarding/ParentalGate.tsx");
    expect(gate).toContain("gateTimer");
    expect(gate).toContain("PARENTAL_GATE_HOLD_MS");
    // No tap-to-pass accessibility action (a documented COPPA design rule).
    expect(gate).not.toMatch(/accessibilityAction|"onTap"/);
  });
});
