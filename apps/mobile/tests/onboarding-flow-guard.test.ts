/**
 * Child-surface readiness guard (issue #44): child surfaces unlock only
 * after a complete onboarding chain, and a consent-policy bump re-locks
 * them (re-consent first).
 */
import { describe, expect, it } from "vitest";
import { childAccessReady } from "../src/onboarding/flowGuard";
import { applyEvent, initialSnapshot } from "../src/onboarding/state";

const NOW = 1_700_000_000_000;

function completedSnapshot() {
  let snap = initialSnapshot(NOW);
  snap = applyEvent(snap, { type: "gate-passed" }, NOW);
  snap = applyEvent(
    snap,
    { type: "account-ready", parentId: "p", email: "e@x.y", emailVerified: true },
    NOW,
  );
  snap = applyEvent(snap, { type: "consent-captured", policyVersion: "v1" }, NOW);
  snap = applyEvent(snap, { type: "child-drafted", nickname: "N", avatar: "A" }, NOW);
  snap = applyEvent(snap, { type: "child-submission-in-flight", gradeId: "kindergarten" }, NOW);
  snap = applyEvent(
    snap,
    { type: "child-created", studentId: "stu-1", gradeId: "kindergarten" },
    NOW,
  );
  snap = applyEvent(snap, { type: "onboarding-completed" }, NOW);
  return snap;
}

const CONSENT_OK = { currentPolicyVersion: "v1", consentCurrent: true };

describe("childAccessReady", () => {
  it("no snapshot -> onboarding", () => {
    const r = childAccessReady({
      snapshot: null,
      parentToken: null,
      childDeviceSession: null,
      consentStatus: null,
    });
    expect(r).toMatchObject({ ready: false, redirect: "/onboarding", reason: "no-snapshot" });
  });

  it("incomplete onboarding -> onboarding", () => {
    const r = childAccessReady({
      snapshot: initialSnapshot(NOW),
      parentToken: "t",
      childDeviceSession: {},
      consentStatus: CONSENT_OK,
    });
    expect(r.reason).toBe("onboarding-incomplete");
  });

  it("complete but signed out -> onboarding", () => {
    const r = childAccessReady({
      snapshot: completedSnapshot(),
      parentToken: null,
      childDeviceSession: {},
      consentStatus: CONSENT_OK,
    });
    expect(r.reason).toBe("no-parent-token");
  });

  it("complete without the child device session -> onboarding", () => {
    const r = childAccessReady({
      snapshot: completedSnapshot(),
      parentToken: "t",
      childDeviceSession: null,
      consentStatus: CONSENT_OK,
    });
    expect(r.reason).toBe("no-child-device-session");
  });

  it("policy bump re-locks child surfaces until re-consent (the AC)", () => {
    const r = childAccessReady({
      snapshot: completedSnapshot(),
      parentToken: "t",
      childDeviceSession: {},
      consentStatus: { currentPolicyVersion: "v2", consentCurrent: false },
    });
    expect(r).toMatchObject({
      ready: false,
      redirect: "/onboarding",
      reason: "consent-not-current",
    });
  });

  it("full chain -> ready, no redirect", () => {
    const r = childAccessReady({
      snapshot: completedSnapshot(),
      parentToken: "t",
      childDeviceSession: {},
      consentStatus: CONSENT_OK,
    });
    expect(r).toMatchObject({ ready: true, redirect: null, reason: "complete" });
  });

  it("offline fallback: snapshot carries the last-known consent version for the journey seam", () => {
    const snap = completedSnapshot();
    expect(snap.consentPolicyVersion).toBe("v1");
  });
});
