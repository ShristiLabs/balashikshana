/**
 * #71 onboarding web seams — createNativeDependencies() driven in node
 * through the WEB platform twins (the same seams a web export runs):
 * the snapshot store (SQL round-trip + corrupt-row guard + clear) and
 * the secure key-value seam. Before #71 this module was native-only and
 * untestable in node; the seam swap makes the SAME glue testable for
 * both platforms (this suite exercises the web twins; the SQL shape is
 * identical on native).
 *
 * Also pins the two #71 FLOW WIRING fixes (source-pin doctrine — no
 * component harness exists): the gate-passed handler must advance the
 * RENDERED step (setStep paired with persist), and the verified handler
 * must persist the server-minted session token BEFORE clearing the
 * pending verification token (the consent-capture call is Bearer-gated).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNativeDependencies } from "../src/onboarding/nativeStores";
import {
  configureWebStorage,
  memoryStore,
  resetWebStorageDetection,
} from "../src/platform/webStorage";
import {
  configureSqlJsEngine,
  flushAllOpenDatabases,
  resetOpenDatabaseTracking,
} from "../src/platform/sqlite.web";
import { applyEvent, initialSnapshot } from "../src/onboarding/state";
import { parseSnapshot } from "../src/onboarding/storage";

// Node has no metro platform resolution: route the seams to the web
// twins exactly as a web bundle resolves them, and stub the
// native-module-bearing optional content singleton (its web deps twin
// has its own suite). Vitest hoists vi.mock above the imports.
vi.mock("../src/platform/sqlite", async () => await import("../src/platform/sqlite.web"));
vi.mock("../src/platform/securekv", async () => await import("../src/platform/securekv.web"));
vi.mock("../src/content/nativeContent", () => ({
  getContentPackService: () => ({
    ensurePack: async () => ({ ok: true as const }),
  }),
}));

const mobileRoot = fileURLToPath(new URL("..", import.meta.url));

beforeEach(() => {
  resetWebStorageDetection();
  configureWebStorage((name) => Promise.resolve(memoryStore(name)));
  resetOpenDatabaseTracking();
  // The browser locator (/vendor/...) does not exist in node; use the
  // package's own wasm (web-adapters.test.ts precedent).
  configureSqlJsEngine(async () => (await import("sql.js")).default());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("#71 onboarding snapshot store over the web SQL seam", () => {
  it("save -> load round-trips a snapshot (web sql.js persistence)", async () => {
    const deps = await createNativeDependencies();
    let snap = initialSnapshot(1_700_000_000_000);
    snap = applyEvent(snap, { type: "gate-passed" }, 1_700_000_000_001);
    await deps.onboardingStore.save(snap);
    const loaded = await deps.onboardingStore.load();
    expect(loaded).not.toBeNull();
    expect(loaded?.step).toBe("account");
  });

  it("clear removes the row (fresh install state)", async () => {
    const deps = await createNativeDependencies();
    await deps.onboardingStore.save(initialSnapshot(1));
    await deps.onboardingStore.clear();
    expect(await deps.onboardingStore.load()).toBeNull();
  });

  it("a corrupt row is discarded by the parseSnapshot guard, never crashes", async () => {
    const deps = await createNativeDependencies();
    await deps.onboardingStore.save(initialSnapshot(1));
    // Persist the image before opening a second connection (the write
    // debounce is 200ms; the flush hook is the deterministic way).
    await flushAllOpenDatabases();
    const db = await (
      await import("../src/platform/sqlite.web")
    ).openDatabaseAsync("balashikshana_onboarding.db");
    await db.runAsync("UPDATE onboarding_state SET snapshot = ? WHERE id = 1", ["{not-json"]);
    await db.closeAsync();
    // A FRESH store (next app open) loads the corrupted image; the
    // parseSnapshot guard discards it instead of crashing.
    const fresh = await createNativeDependencies();
    expect(await fresh.onboardingStore.load()).toBeNull();
    expect(parseSnapshot("{not-json")).toBeNull();
  });

  it("the secure seam is the web secureKeyValue (set/get/delete strings)", async () => {
    const deps = await createNativeDependencies();
    expect(await deps.secure.get("parent-session")).toBeNull();
    await deps.secure.set("parent-session", "tok_1");
    expect(await deps.secure.get("parent-session")).toBe("tok_1");
    await deps.secure.delete("parent-session");
    expect(await deps.secure.get("parent-session")).toBeNull();
  });
});

describe("#71 flow wiring pins (gate render fix + minted session)", () => {
  const flow = readFileSync(join(mobileRoot, "src/onboarding/OnboardingFlow.tsx"), "utf8");
  const verifyStep = readFileSync(
    join(mobileRoot, "src/onboarding/steps/VerifyEmailStep.tsx"),
    "utf8",
  );

  it("the gate-passed handler pairs persist with setStep (the rendered step advances)", () => {
    expect(flow).toContain("const handleGatePassed");
    expect(flow).toMatch(/handleGatePassed[\s\S]*?setStep\(next\.step\)/);
    // Both gate render sites use the handler, not a bare applyAndPersist.
    expect(flow.match(/onPassed=\{handleGatePassed\}/g)?.length).toBe(2);
  });

  it("handleVerified persists the minted session BEFORE clearing the pending token", () => {
    const handler = flow.slice(flow.indexOf("const handleVerified"));
    const persistIdx = handler.indexOf("setParentSessionToken");
    const clearIdx = handler.indexOf("clearPendingVerificationToken");
    expect(persistIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeGreaterThan(persistIdx);
  });

  it("VerifyEmailStep forwards the server-minted token to onVerified", () => {
    expect(verifyStep).toContain("onVerified(result.token)");
    expect(verifyStep).toContain("mintedSessionToken");
  });
});
