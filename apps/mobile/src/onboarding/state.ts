/**
 * Onboarding state machine + resume planner (issue #44).
 *
 * PURE module: transitions are total functions over OnboardingSnapshot;
 * the screen layer owns all I/O. The vitest suite kills the flow at every
 * step and asserts the resume plan both lands on the right step and never
 * orders a duplicate submission.
 *
 * Resume doctrine (the acceptance criteria):
 * - The persisted snapshot plus the secure store plus a server reconcile
 *   decide the landing step - never a stale local "step" alone.
 * - Every mutating server call is preceded by persisting an in-flight
 *   marker and followed by persisting the result. On resume, an in-flight
 *   marker means the submission MAY have landed: the planner orders a
 *   RECONCILE (read-only GETs) that either finds the landed result or
 *   proves it never happened - only then may the flow re-submit.
 *   Concretely:
 *   - signup replay: the server's 409 email-already-registered IS the
 *     reconcile (the account exists; go to login/verify), so a retry can
 *     never create a second account.
 *   - consent replay: GET /api/consent/status first; only capture when
 *     consentCurrent is false. The capture itself is server-append-only
 *     and idempotent in effect (a repeat row records a re-consent), but
 *     the status check means normal resumes never write a duplicate.
 *   - child creation: childSubmissionInFlight + GET /api/parent/children.
 *     Any child present => adopt it (match nickname+grade, else newest
 *     binding); zero children => the POST never landed, safe to submit.
 *     POST /api/parent/children is NOT idempotent, so the flow never
 *     re-submits it while a child already exists for this onboarding.
 *   - device-session mint: raw tokens are shown exactly once, so a lost
 *     response cannot be recovered; resume re-mints (the possibly-orphaned
 *     earlier session is inert on-device and revocable later via the
 *     parent portal surface, #61).
 */

import type {
  ChildProfileInfo,
  ConsentStatusInfo,
  GradeId,
  OnboardingSnapshot,
  OnboardingStep,
} from "./types";

export function initialSnapshot(now: number): OnboardingSnapshot {
  return {
    schemaVersion: 1,
    step: "gate",
    gatePassed: false,
    updatedAt: now,
  };
}

export function withStep(
  snapshot: OnboardingSnapshot,
  step: OnboardingStep,
  now: number,
): OnboardingSnapshot {
  return { ...snapshot, step, updatedAt: now };
}

// --- Step-completion transitions (called after the server confirmed) -----------

export interface GatePassedEvent {
  type: "gate-passed";
}

export interface AccountReadyEvent {
  type: "account-ready";
  parentId: string;
  email: string;
  emailVerified: boolean;
}

export interface EmailVerifiedEvent {
  type: "email-verified";
}

export interface ConsentCapturedEvent {
  type: "consent-captured";
  policyVersion: string;
}

export interface ChildDraftEvent {
  type: "child-drafted";
  nickname: string;
  avatar: string;
}

export interface ChildSubmissionInFlightEvent {
  type: "child-submission-in-flight";
  gradeId: GradeId;
}

export interface ChildCreatedEvent {
  type: "child-created";
  studentId: string;
  gradeId: GradeId;
}

export interface DeviceSessionStoredEvent {
  type: "device-session-stored";
}

export interface OnboardingCompletedEvent {
  type: "onboarding-completed";
}

export type OnboardingEvent =
  | GatePassedEvent
  | AccountReadyEvent
  | EmailVerifiedEvent
  | ConsentCapturedEvent
  | ChildDraftEvent
  | ChildSubmissionInFlightEvent
  | ChildCreatedEvent
  | DeviceSessionStoredEvent
  | OnboardingCompletedEvent;

export function applyEvent(
  snapshot: OnboardingSnapshot,
  event: OnboardingEvent,
  now: number,
): OnboardingSnapshot {
  switch (event.type) {
    case "gate-passed":
      return { ...withStep(snapshot, "account", now), gatePassed: true };
    case "account-ready":
      return {
        ...withStep(snapshot, event.emailVerified ? "consent" : "verify-email", now),
        parentId: event.parentId,
        email: event.email,
        emailVerified: event.emailVerified,
      };
    case "email-verified":
      return { ...withStep(snapshot, "consent", now), emailVerified: true };
    case "consent-captured":
      return { ...withStep(snapshot, "add-child", now), consentPolicyVersion: event.policyVersion };
    case "child-drafted":
      return {
        ...withStep(snapshot, "grade", now),
        childDraft: { nickname: event.nickname, avatar: event.avatar },
      };
    case "child-submission-in-flight": {
      const draft = snapshot.childDraft ?? { nickname: "Explorer", avatar: "" };
      return {
        ...snapshot,
        childSubmissionInFlight: {
          nickname: draft.nickname,
          avatar: draft.avatar,
          gradeId: event.gradeId,
        },
        updatedAt: now,
      };
    }
    case "child-created":
      return {
        ...withStep(snapshot, "complete", now),
        childSubmissionInFlight: undefined,
        studentId: event.studentId,
        gradeId: event.gradeId,
        childDraft: undefined,
      };
    case "device-session-stored":
      return { ...snapshot, updatedAt: now };
    case "onboarding-completed":
      return { ...withStep(snapshot, "complete", now), completedAt: new Date(now).toISOString() };
    default: {
      const exhaustive: never = event;
      throw new Error(`Unhandled onboarding event: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// --- Resume planning -------------------------------------------------------------

/** What the reconcile phase should query before the flow picks a screen. */
export interface ReconcileInputs {
  snapshot: OnboardingSnapshot | null;
  parentToken: string | null;
  childDeviceSessionStored: boolean;
  consentStatus: ConsentStatusInfo | null;
  children: ChildProfileInfo[] | null;
}

export interface ResumePlan {
  step: OnboardingStep;
  /** Adoption result when reconcile found an already-created child. */
  adoptedChild: ChildProfileInfo | null;
  /** True when a fresh device-session mint is needed (or re-mint). */
  needsDeviceSession: boolean;
  /** True when consent capture (or re-capture after a policy bump) is due. */
  needsConsent: boolean;
}

/**
 * Decide the landing step from persisted + reconciled state. Rules, in
 * order (each may only relax FORWARD, never back past a server-confirmed
 * milestone; the parental gate is re-asked on any fresh start because it
 * guards the parent surface, not the child's session):
 *
 * 1. No snapshot, or nothing persisted at all -> start at the gate.
 * 2. gatePassed false -> gate.
 * 3. No parent token: an UNVERIFIED signup resumes at verify-email (the
 *    emailed code needs no session); everything else -> account step
 *    (email prefilled; password re-entered - passwords are never
 *    persisted).
 * 4. Token present but parent unverified -> verify-email.
 * 5. Consent: a known-current status passes; a known-stale one routes to
 *    consent (the re-consent surface - a version bump sends the parent
 *    back through the consent screens before child surfaces unlock, the
 *    issue AC). An UNKNOWN status (offline boot): a completed flow stays
 *    complete (offline tolerance - the journey guard falls back to the
 *    last-known consent version); anything else routes to consent, which
 *    reconciles with the server before any capture.
 * 6. Consent current + child submission in flight + children exist ->
 *    ADOPT the matching child, proceed to complete (never re-create).
 * 7. Consent current + in flight + no children -> grade step with the
 *    in-flight payload (the POST never landed; submit now).
 * 8. Consent current + studentId persisted -> complete (mint if the child
 *    device session is missing).
 * 9. Consent current + no child yet: a drafted child -> grade (resume the
 *    draft); otherwise -> add-child.
 */
export function planResume(inputs: ReconcileInputs): ResumePlan {
  const { snapshot, parentToken, childDeviceSessionStored, consentStatus, children } = inputs;

  if (!snapshot || (!snapshot.gatePassed && !snapshot.parentId)) {
    return { step: "gate", adoptedChild: null, needsDeviceSession: false, needsConsent: false };
  }
  if (!snapshot.gatePassed) {
    return { step: "gate", adoptedChild: null, needsDeviceSession: false, needsConsent: false };
  }
  if (!parentToken) {
    if (snapshot.parentId && snapshot.emailVerified === false) {
      return {
        step: "verify-email",
        adoptedChild: null,
        needsDeviceSession: false,
        needsConsent: false,
      };
    }
    return { step: "account", adoptedChild: null, needsDeviceSession: false, needsConsent: false };
  }
  if (!snapshot.emailVerified) {
    return {
      step: "verify-email",
      adoptedChild: null,
      needsDeviceSession: false,
      needsConsent: false,
    };
  }
  const needsDeviceSession = !childDeviceSessionStored;
  if (consentStatus === null) {
    // Unknown (offline): only a fully completed flow rides through; every
    // other state needs the server before it can proceed.
    if (snapshot.completedAt && snapshot.studentId) {
      return { step: "complete", adoptedChild: null, needsDeviceSession, needsConsent: false };
    }
    return { step: "consent", adoptedChild: null, needsDeviceSession: false, needsConsent: true };
  }
  if (!consentStatus.consentCurrent) {
    return { step: "consent", adoptedChild: null, needsDeviceSession: false, needsConsent: true };
  }

  if (snapshot.childSubmissionInFlight) {
    if (children && children.length > 0) {
      const inflight = snapshot.childSubmissionInFlight;
      const adopted =
        children.find(
          (c) => c.nickname === inflight.nickname && c.currentGrade === inflight.gradeId,
        ) ??
        children[children.length - 1] ??
        null;
      return { step: "complete", adoptedChild: adopted, needsDeviceSession, needsConsent: false };
    }
    // Submission never landed: re-submit at the grade step with the
    // persisted in-flight payload (draft PIN is still in the secure store).
    return { step: "grade", adoptedChild: null, needsDeviceSession: false, needsConsent: false };
  }

  if (snapshot.studentId) {
    return { step: "complete", adoptedChild: null, needsDeviceSession, needsConsent: false };
  }

  if (snapshot.completedAt) {
    return { step: "complete", adoptedChild: null, needsDeviceSession, needsConsent: false };
  }

  // Rule 9: a drafted child resumes at grade selection.
  const drafted =
    snapshot.childSubmissionInFlight !== undefined || snapshot.childDraft !== undefined;
  return {
    step: drafted ? "grade" : "add-child",
    adoptedChild: null,
    needsDeviceSession: false,
    needsConsent: false,
  };
}

/**
 * Fold adoption into the snapshot: the child that already exists on the
 * server becomes THE onboarding child (idempotent resume outcome).
 */
export function adoptChild(
  snapshot: OnboardingSnapshot,
  child: ChildProfileInfo,
  now: number,
): OnboardingSnapshot {
  return {
    ...snapshot,
    childSubmissionInFlight: undefined,
    studentId: child.studentId,
    gradeId: (child.currentGrade as GradeId) ?? snapshot.gradeId,
    updatedAt: now,
  };
}

/** Is the onboarding chain complete enough that child surfaces may unlock? */
export function onboardingComplete(snapshot: OnboardingSnapshot | null): boolean {
  return Boolean(snapshot && snapshot.gatePassed && snapshot.completedAt && snapshot.studentId);
}

/**
 * Landing-completion guard (#44 reviewer HIGH finding): any resume path
 * that lands on the complete step with a studentId must also carry
 * completedAt, or childAccessReady keeps child surfaces locked (the
 * journey guard would redirect back to onboarding forever). Idempotent:
 * a snapshot that already records completion is returned unchanged.
 */
export function ensureCompleted(snapshot: OnboardingSnapshot, now: number): OnboardingSnapshot {
  if (snapshot.completedAt || !snapshot.studentId) return snapshot;
  return applyEvent(snapshot, { type: "onboarding-completed" }, now);
}
