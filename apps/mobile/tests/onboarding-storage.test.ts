/**
 * Persistence seam invariants (issue #44): tokens and the draft PIN route
 * ONLY through the secure store; the SQLite-bound snapshot can never carry
 * a credential. Memory implementations stand in for the native adapters
 * (the interfaces are the contract the native bindings satisfy).
 */
import { describe, expect, it } from "vitest";
import {
  createMemoryOnboardingStore,
  createMemorySecureKeyValue,
  parseSnapshot,
  TOKEN_KEYS,
  TokenStore,
} from "../src/onboarding/storage";
import { initialSnapshot, applyEvent } from "../src/onboarding/state";
import type { OnboardingSnapshot } from "../src/onboarding/types";

const NOW = 1_700_000_000_000;

describe("OnboardingStore (snapshot persistence)", () => {
  it("round-trips the snapshot through save/load", async () => {
    const store = createMemoryOnboardingStore();
    const snap: OnboardingSnapshot = applyEvent(initialSnapshot(NOW), { type: "gate-passed" }, NOW);
    await store.save(snap);
    const loaded = await store.load();
    expect(loaded).toEqual(snap);
  });

  it("clear removes the snapshot", async () => {
    const store = createMemoryOnboardingStore();
    await store.save(initialSnapshot(NOW));
    await store.clear();
    expect(await store.load()).toBeNull();
  });
});

describe("TokenStore (secure store adapter)", () => {
  it("stores and clears the parent session token", async () => {
    const tokens = new TokenStore(createMemorySecureKeyValue());
    await tokens.setParentSessionToken("par-tok-1");
    expect(await tokens.getParentSessionToken()).toBe("par-tok-1");
    await tokens.clearParentSessionToken();
    expect(await tokens.getParentSessionToken()).toBeNull();
  });

  it("round-trips the child device session as structured data", async () => {
    const tokens = new TokenStore(createMemorySecureKeyValue());
    await tokens.setChildDeviceSession({
      token: "cdt-1",
      sessionId: "cds-1",
      studentId: "stu-1",
      deviceId: "dev-1",
      expiresAt: "2026-11-01T00:00:00.000Z",
    });
    expect((await tokens.getChildDeviceSession())?.studentId).toBe("stu-1");
  });

  it("corrupt child-session JSON degrades to null, not a crash", async () => {
    const secure = createMemorySecureKeyValue();
    await secure.set(TOKEN_KEYS.childDeviceSession, "{not json");
    const tokens = new TokenStore(secure);
    expect(await tokens.getChildDeviceSession()).toBeNull();
  });

  it("the draft PIN lives here - and only here", async () => {
    const tokens = new TokenStore(createMemorySecureKeyValue());
    await tokens.setDraftChildPin("4321");
    expect(await tokens.getDraftChildPin()).toBe("4321");
    await tokens.clearDraftChildPin();
    expect(await tokens.getDraftChildPin()).toBeNull();
  });

  it("clearAllCredentials wipes every credential key (logout / switch parent)", async () => {
    const secure = createMemorySecureKeyValue();
    const tokens = new TokenStore(secure);
    await tokens.setParentSessionToken("p");
    await tokens.setPendingVerificationToken("v");
    await tokens.setChildDeviceSession({
      token: "c",
      sessionId: "s",
      studentId: "st",
      deviceId: "d",
      expiresAt: "e",
    });
    await tokens.setDraftChildPin("1111");
    await tokens.clearAllCredentials();
    expect(secure.dump().has(TOKEN_KEYS.parentSession)).toBe(false);
    expect(secure.dump().has(TOKEN_KEYS.pendingVerification)).toBe(false);
    expect(secure.dump().has(TOKEN_KEYS.childDeviceSession)).toBe(false);
    expect(secure.dump().has(TOKEN_KEYS.draftChildPin)).toBe(false);
    // The install device id is not a credential: it survives sign-out.
    await tokens.setClientDeviceId("dev-1");
    await tokens.clearAllCredentials();
    expect(await tokens.getClientDeviceId()).toBe("dev-1");
  });
});

describe("secrets never enter the snapshot", () => {
  it("a full happy-path snapshot serializes without any token or PIN shape", async () => {
    const store = createMemoryOnboardingStore();
    let snap = initialSnapshot(NOW);
    snap = applyEvent(snap, { type: "gate-passed" }, NOW);
    snap = applyEvent(
      snap,
      {
        type: "account-ready",
        parentId: "par-1",
        email: "parent@example.com",
        emailVerified: true,
      },
      NOW,
    );
    snap = applyEvent(snap, { type: "consent-captured", policyVersion: "v1" }, NOW);
    snap = applyEvent(snap, { type: "child-drafted", nickname: "Maya", avatar: "panda" }, NOW);
    snap = applyEvent(snap, { type: "child-submission-in-flight", gradeId: "kindergarten" }, NOW);
    snap = applyEvent(
      snap,
      { type: "child-created", studentId: "stu-1", gradeId: "kindergarten" },
      NOW,
    );
    snap = applyEvent(snap, { type: "onboarding-completed" }, NOW);
    await store.save(snap);
    const serialized = JSON.stringify(store.snapshot);
    expect(serialized).not.toContain("pin");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("token");
    // The parent email is user-visible identity data, not a credential.
    expect(serialized).toContain("parent@example.com");
  });
});

describe("parseSnapshot (persisted-snapshot guard)", () => {
  it("round-trips a valid v1 snapshot string", () => {
    const snap = applyEvent(initialSnapshot(NOW), { type: "gate-passed" }, NOW);
    expect(parseSnapshot(JSON.stringify(snap))).toEqual(snap);
  });

  it("discards corrupt JSON instead of crashing", () => {
    expect(parseSnapshot("{not json")).toBeNull();
    expect(parseSnapshot("")).toBeNull();
  });

  it("discards snapshots from an unknown schema version (fresh onboarding, never misread)", () => {
    const future = {
      ...applyEvent(initialSnapshot(NOW), { type: "gate-passed" }, NOW),
      schemaVersion: 2,
    };
    expect(parseSnapshot(JSON.stringify(future))).toBeNull();
    expect(parseSnapshot(null)).toBeNull();
  });
});
