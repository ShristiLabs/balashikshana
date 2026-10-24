/**
 * Onboarding state-machine invariants (issue #44): kill-and-relaunch at
 * EVERY step resumes at the correct step and can never order a duplicate
 * submission. All cases run against the pure planner + transitions.
 */
import { describe, expect, it } from "vitest";
import {
  adoptChild,
  applyEvent,
  ensureCompleted,
  initialSnapshot,
  onboardingComplete,
  planResume,
} from "../src/onboarding/state";
import type { ChildProfileInfo, OnboardingSnapshot } from "../src/onboarding/types";

const NOW = 1_700_000_000_000;

const child = (over: Partial<ChildProfileInfo> = {}): ChildProfileInfo => ({
  studentId: "stu-test-1",
  username: "testkid",
  nickname: "Maya",
  avatar: "panda",
  currentGrade: "kindergarten",
  status: "claimed",
  activeDeviceSessions: 1,
  ...over,
});

/** The happy-path event sequence; `happyPath(stopBefore)` kills mid-flow. */
const EVENTS = {
  gate: { type: "gate-passed" } as const,
  account: {
    type: "account-ready",
    parentId: "par-1",
    email: "a@b.c",
    emailVerified: false,
  } as const,
  verify: { type: "email-verified" } as const,
  consent: { type: "consent-captured", policyVersion: "2026-10" } as const,
  addChild: { type: "child-drafted", nickname: "Maya", avatar: "panda" } as const,
  inflight: { type: "child-submission-in-flight", gradeId: "kindergarten" } as const,
  created: { type: "child-created", studentId: "stu-test-1", gradeId: "kindergarten" } as const,
  mint: { type: "device-session-stored" } as const,
  done: { type: "onboarding-completed" } as const,
};

type EventKey = keyof typeof EVENTS;

/** Walk the happy path with a kill (`stopBefore`) after each transition. */
function happyPath(stopBefore?: EventKey): OnboardingSnapshot {
  let snap = initialSnapshot(NOW);
  for (const key of Object.keys(EVENTS) as EventKey[]) {
    if (key === stopBefore) break;
    snap = applyEvent(snap, EVENTS[key], NOW);
  }
  return snap;
}

const CONSENT_OK = { currentPolicyVersion: "2026-10", consentCurrent: true };
const CONSENT_STALE = { currentPolicyVersion: "2026-11", consentCurrent: false };

describe("transitions", () => {
  it("gate pass advances to account", () => {
    const snap = applyEvent(initialSnapshot(NOW), { type: "gate-passed" }, NOW);
    expect(snap.gatePassed).toBe(true);
    expect(snap.step).toBe("account");
  });

  it("signup (unverified) routes to verify-email; verified login routes to consent", () => {
    const base = happyPath("account");
    const unverified = applyEvent(
      base,
      { type: "account-ready", parentId: "par-1", email: "a@b.c", emailVerified: false },
      NOW,
    );
    expect(unverified.step).toBe("verify-email");
    const verified = applyEvent(
      base,
      { type: "account-ready", parentId: "par-1", email: "a@b.c", emailVerified: true },
      NOW,
    );
    expect(verified.step).toBe("consent");
  });

  it("consent capture advances to add-child with the version recorded", () => {
    const snap = applyEvent(
      happyPath("consent"),
      { type: "consent-captured", policyVersion: "v9" },
      NOW,
    );
    expect(snap.step).toBe("add-child");
    expect(snap.consentPolicyVersion).toBe("v9");
  });

  it("child draft advances to grade; the draft carries no PIN (secure-store only)", () => {
    const snap = applyEvent(
      happyPath("addChild"),
      { type: "child-drafted", nickname: "N", avatar: "A" },
      NOW,
    );
    expect(snap.step).toBe("grade");
    expect(snap.childDraft).toEqual({ nickname: "N", avatar: "A" });
    expect(JSON.stringify(snap)).not.toContain("pin");
  });

  it("in-flight marker snapshots the exact payload; creation clears it", () => {
    const marked = applyEvent(
      happyPath("inflight"),
      { type: "child-submission-in-flight", gradeId: "grade-2" },
      NOW,
    );
    expect(marked.childSubmissionInFlight).toEqual({
      nickname: "Maya",
      avatar: "panda",
      gradeId: "grade-2",
    });
    const created = applyEvent(
      marked,
      { type: "child-created", studentId: "stu-x", gradeId: "grade-2" },
      NOW,
    );
    expect(created.childSubmissionInFlight).toBeUndefined();
    expect(created.studentId).toBe("stu-x");
    expect(created.step).toBe("complete");
  });
});

describe("resume: kill at every step lands on the right screen", () => {
  it("no snapshot at all -> gate", () => {
    const plan = planResume({
      snapshot: null,
      parentToken: null,
      childDeviceSessionStored: false,
      consentStatus: null,
      children: null,
    });
    expect(plan.step).toBe("gate");
  });

  it("kill before the gate -> gate", () => {
    const plan = planResume({
      snapshot: happyPath("gate"),
      parentToken: null,
      childDeviceSessionStored: false,
      consentStatus: null,
      children: null,
    });
    expect(plan.step).toBe("gate");
  });

  it("kill after gate, before account -> account", () => {
    const plan = planResume({
      snapshot: happyPath("account"),
      parentToken: null,
      childDeviceSessionStored: false,
      consentStatus: null,
      children: null,
    });
    expect(plan.step).toBe("account");
  });

  it("kill after signup, before verification -> verify-email", () => {
    const plan = planResume({
      snapshot: happyPath("verify"),
      parentToken: null, // signup issues no session token
      childDeviceSessionStored: false,
      consentStatus: null,
      children: null,
    });
    expect(plan.step).toBe("verify-email");
  });

  it("token lost/expired mid-flow -> account (password re-entry, never persisted)", () => {
    const plan = planResume({
      snapshot: happyPath("addChild"),
      parentToken: null,
      childDeviceSessionStored: false,
      consentStatus: null,
      children: null,
    });
    expect(plan.step).toBe("account");
  });

  it("kill after consent, before add-child -> add-child (consent NOT re-asked)", () => {
    const plan = planResume({
      snapshot: happyPath("addChild"),
      parentToken: "tok",
      childDeviceSessionStored: false,
      consentStatus: CONSENT_OK,
      children: [],
    });
    expect(plan.step).toBe("add-child");
    expect(plan.needsConsent).toBe(false);
  });

  it("kill after add-child draft, before grade -> grade (draft PIN still in secure store)", () => {
    const plan = planResume({
      snapshot: happyPath("inflight"),
      parentToken: "tok",
      childDeviceSessionStored: false,
      consentStatus: CONSENT_OK,
      children: [],
    });
    expect(plan.step).toBe("grade");
  });
});

describe("resume: duplicate-submission safety", () => {
  it("kill between create-POST and studentId persist -> child EXISTS: adopt, never re-create", () => {
    const plan = planResume({
      snapshot: happyPath("created"), // in-flight marker set, no studentId yet
      parentToken: "tok",
      childDeviceSessionStored: false,
      consentStatus: CONSENT_OK,
      children: [child()],
    });
    expect(plan.step).toBe("complete");
    expect(plan.adoptedChild).toEqual(child());
  });

  it("adoption matches nickname+grade first, falls back to newest binding", () => {
    const others = [
      child({ studentId: "stu-old", nickname: "Other", currentGrade: "grade-1" }),
      child({ studentId: "stu-new", nickname: "Newest", currentGrade: "grade-3" }),
    ];
    const plan = planResume({
      snapshot: happyPath("created"),
      parentToken: "tok",
      childDeviceSessionStored: false,
      consentStatus: CONSENT_OK,
      children: others,
    });
    // No nickname match ("Maya" vs Other/Newest): adopt the newest binding.
    expect(plan.adoptedChild?.studentId).toBe("stu-new");
  });

  it("kill between marker and POST -> NO children: re-submit is allowed exactly once", () => {
    const plan = planResume({
      snapshot: happyPath("created"),
      parentToken: "tok",
      childDeviceSessionStored: false,
      consentStatus: CONSENT_OK,
      children: [],
    });
    expect(plan.step).toBe("grade");
    expect(plan.adoptedChild).toBeNull();
  });

  it("kill after creation persisted -> complete; missing device session flags a re-mint", () => {
    const plan = planResume({
      snapshot: happyPath("mint"), // studentId persisted, session not yet
      parentToken: "tok",
      childDeviceSessionStored: false,
      consentStatus: CONSENT_OK,
      children: [child()],
    });
    expect(plan.step).toBe("complete");
    expect(plan.needsDeviceSession).toBe(true);
  });

  it("fully stored device session needs no re-mint", () => {
    const plan = planResume({
      snapshot: happyPath(),
      parentToken: "tok",
      childDeviceSessionStored: true,
      consentStatus: CONSENT_OK,
      children: [child()],
    });
    expect(plan.step).toBe("complete");
    expect(plan.needsDeviceSession).toBe(false);
  });

  it("policy version bump -> consent step again BEFORE child surfaces (re-consent AC)", () => {
    const plan = planResume({
      snapshot: happyPath(), // onboarding was fully complete at v2026-10
      parentToken: "tok",
      childDeviceSessionStored: true,
      consentStatus: CONSENT_STALE, // server bumped to 2026-11
      children: [child()],
    });
    expect(plan.step).toBe("consent");
    expect(plan.needsConsent).toBe(true);
  });

  it("offline boot after completion (status unknown) stays on complete, not consent", () => {
    const plan = planResume({
      snapshot: happyPath(),
      parentToken: "tok",
      childDeviceSessionStored: true,
      consentStatus: null,
      children: null,
    });
    expect(plan.step).toBe("complete");
  });

  it("adoption folds the server-side child into the snapshot idempotently", () => {
    const snap = adoptChild(happyPath("created"), child(), NOW);
    expect(snap.studentId).toBe("stu-test-1");
    expect(snap.childSubmissionInFlight).toBeUndefined();
    expect(snap.gradeId).toBe("kindergarten");
  });
});

describe("completion", () => {
  it("onboardingComplete requires gate + completion + studentId", () => {
    expect(onboardingComplete(null)).toBe(false);
    expect(onboardingComplete(happyPath("created"))).toBe(false);
    expect(onboardingComplete(happyPath())).toBe(true);
  });
});

describe("resume: planner edges", () => {
  it("stale store with parentId but gatePassed=false re-asks the gate (it guards every parent session)", () => {
    const stale = { ...initialSnapshot(NOW), parentId: "par-1", email: "a@b.c", gatePassed: false };
    const plan = planResume({
      snapshot: stale,
      parentToken: "tok",
      childDeviceSessionStored: false,
      consentStatus: CONSENT_OK,
      children: [],
    });
    expect(plan.step).toBe("gate");
  });

  it("in-flight submission + STALE consent + existing children -> consent FIRST (never adopt or re-submit before re-consent)", () => {
    const plan = planResume({
      snapshot: happyPath("created"),
      parentToken: "tok",
      childDeviceSessionStored: false,
      consentStatus: CONSENT_STALE,
      children: [child()],
    });
    expect(plan.step).toBe("consent");
    expect(plan.needsConsent).toBe(true);
  });

  it("in-flight submission + offline (status unknown) -> consent, not a blind re-submit", () => {
    const plan = planResume({
      snapshot: happyPath("created"),
      parentToken: "tok",
      childDeviceSessionStored: false,
      consentStatus: null,
      children: null,
    });
    expect(plan.step).toBe("consent");
  });
});

describe("landing-complete invariant (reviewer HIGH fix)", () => {
  it.each([
    [
      "adopt landing (kill between POST and persist)",
      {
        snapshot: happyPath("created"),
        parentToken: "tok",
        childDeviceSessionStored: false,
        consentStatus: CONSENT_OK,
        children: [child()],
      },
    ],
    [
      "studentId landing (kill after persist, before mint)",
      {
        snapshot: happyPath("mint"),
        parentToken: "tok",
        childDeviceSessionStored: false,
        consentStatus: CONSENT_OK,
        children: [child()],
      },
    ],
    [
      "offline-complete landing",
      {
        snapshot: happyPath(),
        parentToken: "tok",
        childDeviceSessionStored: true,
        consentStatus: null,
        children: null,
      },
    ],
  ])("%s: the persisted landing snapshot passes onboardingComplete", (_name, inputs) => {
    const plan = planResume(inputs);
    expect(plan.step).toBe("complete");
    let snap = inputs.snapshot;
    if (plan.adoptedChild) snap = adoptChild(snap, plan.adoptedChild, NOW);
    // The flow persists ensureCompleted(snap) - the invariant that keeps
    // the journey guard from redirect-looping a returning parent.
    expect(onboardingComplete(ensureCompleted(snap, NOW))).toBe(true);
  });

  it("ensureCompleted stamps completedAt exactly when a studentId exists and none is set", () => {
    const adopt = adoptChild(happyPath("created"), child(), NOW);
    expect(adopt.completedAt).toBeUndefined();
    const ensured = ensureCompleted(adopt, NOW);
    expect(ensured.completedAt).toBeTypeOf("string");
    expect(onboardingComplete(ensured)).toBe(true);
  });

  it("ensureCompleted is idempotent (no timestamp churn on re-runs)", () => {
    const done = happyPath();
    expect(ensureCompleted(done, NOW + 9999)).toBe(done);
  });

  it("ensureCompleted never completes a snapshot without a studentId", () => {
    const gated = applyEvent(initialSnapshot(NOW), { type: "gate-passed" }, NOW);
    expect(ensureCompleted(gated, NOW).completedAt).toBeUndefined();
  });
});
