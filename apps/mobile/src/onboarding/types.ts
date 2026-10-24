/**
 * Onboarding domain types (issue #44). Pure data: this module must never
 * import react-native or any runtime framework so the vitest suite can
 * exercise the state machine directly.
 *
 * Secrets doctrine:
 * - NOTHING in OnboardingSnapshot is a secret. Session tokens, the child
 *   device token, the pending email-verification token, the draft child
 *   PIN, and the install device id live ONLY in the secure store
 *   (TokenStore). The snapshot is safe for plain SQLite persistence.
 * - Parent PASSWORDS are never persisted anywhere: a kill during the
 *   account step means the password is re-entered, by design.
 */

/** The five M2 API grade ids (services/api children.mjs GRADE_IDS). */
export const GRADE_IDS = ["pre-k", "kindergarten", "grade-1", "grade-2", "grade-3"] as const;

export type GradeId = (typeof GRADE_IDS)[number];

/** Server platform enum for child creation / device sessions. */
export type PlatformId = "ios" | "android" | "web";

export const GRADE_LABELS: Record<GradeId, string> = {
  "pre-k": "Pre-K",
  kindergarten: "Kindergarten",
  "grade-1": "Grade 1",
  "grade-2": "Grade 2",
  "grade-3": "Grade 3",
};

export type OnboardingStep =
  "gate" | "account" | "verify-email" | "consent" | "add-child" | "grade" | "complete";

/**
 * The persisted onboarding snapshot. Every field is either a UI progress
 * marker or non-secret draft data; resumability reads this plus secure
 * store contents plus a server reconcile to pick the landing step.
 */
export interface OnboardingSnapshot {
  /** Schema guard for forward compatibility of persisted snapshots. */
  schemaVersion: 1;
  step: OnboardingStep;
  /** Parental gate passed (hold-to-confirm). Re-asked on fresh starts. */
  gatePassed: boolean;
  /** Parent identity (non-secret; the login email is user-visible data). */
  parentId?: string;
  email?: string;
  /** True once the server confirmed email verification for this parent. */
  emailVerified?: boolean;
  /** Policy version the parent consented at during onboarding. */
  consentPolicyVersion?: string;
  /** Draft child profile collected on the add-child step (no PIN here). */
  childDraft?: {
    nickname: string;
    avatar: string;
  };
  /**
   * Set BEFORE the create-child request fires and cleared after the
   * studentId is persisted: the resume planner uses it to detect a
   * kill between submission and persistence (never double-create).
   */
  childSubmissionInFlight?: {
    nickname: string;
    avatar: string;
    gradeId: GradeId;
  };
  studentId?: string;
  gradeId?: GradeId;
  completedAt?: string;
  /** Timestamp (ms) of the last snapshot write, for diagnostics only. */
  updatedAt: number;
}

export interface ParentPublicInfo {
  parentId: string;
  email: string;
  emailVerified: boolean;
}

export interface ConsentStatusInfo {
  currentPolicyVersion: string | null;
  consentCurrent: boolean;
}

export interface ChildProfileInfo {
  studentId: string;
  username: string;
  nickname: string;
  avatar: string;
  currentGrade: string;
  status: string;
  activeDeviceSessions: number;
}

/** The child creation request payload (PIN supplied at call time only). */
export interface CreateChildPayload {
  nickname: string;
  pin: string;
  currentGrade: GradeId;
  avatar: string;
  clientDeviceId: string;
  platform: PlatformId;
}
