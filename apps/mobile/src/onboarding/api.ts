/**
 * Onboarding API client (issue #44) for the M2 surface.
 *
 * PURE module: no react-native imports; `fetchImpl` is injectable so the
 * vitest suite drives every error path with a mock.
 *
 * Error doctrine (this client fixes the dev-harness res.ok debt - the web
 * reference client in apps/mobile/public/index.html skips these checks;
 * that omission is deliberately NOT copied):
 * - EVERY response is checked with res.ok BEFORE the body is consumed as
 *   success data.
 * - Error bodies are parsed as RFC 9457 problem+json documents
 *   (status/type/title/detail/extensions); non-JSON bodies degrade to a
 *   generic network-shape error, never a crash.
 * - Transport failures (offline, DNS, refused) surface as
 *   kind="network" so callers can render offline-tolerant UI.
 * - Nothing is logged here, ever: no tokens, no emails, no PINs. Client
 *   code has no console output by design.
 */

import type {
  ChildProfileInfo,
  ConsentStatusInfo,
  CreateChildPayload,
  GradeId,
  ParentPublicInfo,
} from "./types";

export interface ProblemDocument {
  status: number;
  type: string;
  title?: string;
  detail?: string;
  extensions?: Record<string, unknown>;
}

export type ApiErrorCode =
  | "network"
  | "bad-status"
  | "bad-body"
  | "consent-required"
  | "policy-version-mismatch"
  | "email-already-registered"
  | "email-verification-required"
  | "wrong-token-type"
  | "unauthorized"
  | "not-found"
  | "already-claimed"
  | "no-child-binding"
  | "child-archived"
  | "claim-rejected"
  | "invalid-token"
  | "rate-limited"
  | "validation"
  | "unknown";

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly problem: ProblemDocument | null;

  constructor(
    code: ApiErrorCode,
    message: string,
    status = 0,
    problem: ProblemDocument | null = null,
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.problem = problem;
  }

  /** The current policy version a consent-required/mismatch problem carries. */
  currentPolicyVersion(): string | null {
    const ext = this.problem?.extensions as { currentPolicyVersion?: unknown } | undefined;
    if (ext && typeof ext.currentPolicyVersion === "string") return ext.currentPolicyVersion;
    return null;
  }
}

const PROBLEM_CODE_BY_TYPE: Record<string, ApiErrorCode> = {
  "consent-required": "consent-required",
  "policy-version-mismatch": "policy-version-mismatch",
  "email-already-registered": "email-already-registered",
  "email-verification-required": "email-verification-required",
  "wrong-token-type": "wrong-token-type",
  unauthorized: "unauthorized",
  "not-found": "not-found",
  "already-claimed": "already-claimed",
  "no-child-binding": "no-child-binding",
  "child-archived": "child-archived",
  "claim-rejected": "claim-rejected",
  "invalid-token": "invalid-token",
};

function codeForProblem(problem: ProblemDocument): ApiErrorCode {
  const suffix = problem.type.split("/").pop() ?? "";
  if (PROBLEM_CODE_BY_TYPE[suffix]) return PROBLEM_CODE_BY_TYPE[suffix] as ApiErrorCode;
  if (problem.status === 401) return "unauthorized";
  if (problem.status === 404) return "not-found";
  if (problem.status === 400) return "validation";
  if (problem.status === 429) return "rate-limited";
  return "unknown";
}

/**
 * Parent-facing message copy per code. Kid-appropriate and actionable;
 * never echoes raw server detail into a kid-facing surface (parent screens
 * may show problem.detail alongside this copy).
 */
export const PARENT_FACING_MESSAGES: Readonly<Record<ApiErrorCode, string>> = {
  network: "We cannot reach the learning service. Check your internet connection and try again.",
  "bad-status": "Something went wrong talking to the service. Please try again.",
  "bad-body": "The service sent an unexpected reply. Please try again.",
  "consent-required":
    "Your consent needs to be recorded (or renewed) before we can set up the learner.",
  "policy-version-mismatch":
    "The consent policy was updated. Please review and accept the new version.",
  "email-already-registered": "An account with this email already exists. Try logging in instead.",
  "email-verification-required": "Please verify your email address before continuing.",
  "wrong-token-type": "This action needs a different sign-in. Please sign in again.",
  unauthorized: "Your sign-in did not work. Please check the email and password.",
  "not-found": "We could not find that. Please try again.",
  "already-claimed": "That learner is already connected to a parent account.",
  "no-child-binding": "That learner is not connected to this parent account.",
  "child-archived": "That learner profile has been archived.",
  "claim-rejected": "The username or PIN did not match an unclaimed learner.",
  "invalid-token": "That code is invalid or has expired. Please request a fresh one.",
  "rate-limited": "Too many attempts. Please wait a moment and try again.",
  validation: "Please check the entered details and try again.",
  unknown: "Something went wrong. Please try again.",
};

export function parentFacingMessage(error: ApiError): string {
  return PARENT_FACING_MESSAGES[error.code];
}

export interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

export interface ApiClientOptions {
  baseUrl: string;
  fetchImpl?: FetchLike;
}

interface CallOptions {
  method: "GET" | "POST" | "DELETE";
  path: string;
  token?: string;
  body?: unknown;
}

async function callApi(fetchImpl: FetchLike, baseUrl: string, call: CallOptions): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (call.body !== undefined) headers["Content-Type"] = "application/json";
  if (call.token !== undefined) headers.Authorization = `Bearer ${call.token}`;

  let res: Response;
  try {
    res = await fetchImpl(`${baseUrl}${call.path}`, {
      method: call.method,
      headers,
      body: call.body !== undefined ? JSON.stringify(call.body) : undefined,
    });
  } catch {
    throw new ApiError("network", "Network request failed");
  }

  let parsed: unknown = null;
  try {
    const text = await res.text();
    parsed = text.length > 0 ? (JSON.parse(text) as unknown) : null;
  } catch {
    parsed = null;
  }

  if (!res.ok) {
    const problem: ProblemDocument | null =
      parsed &&
      typeof parsed === "object" &&
      "type" in parsed &&
      typeof (parsed as { type: unknown }).type === "string"
        ? (parsed as ProblemDocument)
        : null;
    if (problem) {
      problem.status = problem.status ?? res.status;
      throw new ApiError(
        codeForProblem(problem),
        problem.detail || problem.title || `Request failed with status ${res.status}`,
        res.status,
        problem,
      );
    }
    throw new ApiError("bad-status", `Request failed with status ${res.status}`, res.status);
  }

  if (parsed === null) {
    throw new ApiError("bad-body", "Expected a JSON reply", res.status);
  }
  return parsed;
}

export interface SignupResult {
  parentId: string;
  email: string;
  emailVerified: boolean;
  /**
   * Dev-only delivery seam (suppressed in production): the email
   * verification token. Persisted only in the secure store, never in the
   * SQLite snapshot.
   */
  verificationToken?: string;
}

export interface LoginResult {
  token: string;
  parent: ParentPublicInfo;
}

export interface ConsentCaptureResult {
  consentId: string;
  policyVersion: string;
  capturedAt: string;
}

export interface CreateChildResult {
  studentId: string;
  username: string;
  nickname: string;
  avatar: string;
  currentGrade: string;
}

export interface DeviceSessionResult {
  sessionId: string;
  token: string;
  deviceId: string;
  studentId: string;
  expiresAt: string;
}

export interface ApiClient {
  signup(email: string, password: string): Promise<SignupResult>;
  verifyEmail(token: string): Promise<{ ok: boolean; emailVerified: boolean }>;
  login(email: string, password: string): Promise<LoginResult>;
  refresh(token: string): Promise<{ token: string }>;
  parentLogout(token: string): Promise<{ ok: boolean }>;
  parentLogoutAll(token: string): Promise<{ ok: boolean; revokedSessions: number }>;
  policyLatest(): Promise<{
    version: string;
    locale: string;
    policyText: string;
    createdAt: string;
  }>;
  consentStatus(token: string): Promise<ConsentStatusInfo>;
  captureConsent(token: string, policyVersion: string): Promise<ConsentCaptureResult>;
  listChildren(token: string): Promise<{ parentId: string; children: ChildProfileInfo[] }>;
  createChild(token: string, payload: CreateChildPayload): Promise<CreateChildResult>;
  mintDeviceSession(
    token: string,
    studentId: string,
    clientDeviceId: string,
    platform: string,
  ): Promise<DeviceSessionResult>;
}

function expectResult<T>(value: unknown): T {
  if (!value || typeof value !== "object") throw new ApiError("bad-body", "Unexpected reply shape");
  return value as T;
}

export function createApiClient(options: ApiClientOptions): ApiClient {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch.bind(globalThis) as FetchLike);
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const call = (c: CallOptions) => callApi(fetchImpl, baseUrl, c);

  return {
    async signup(email, password) {
      return expectResult<SignupResult>(
        await call({ method: "POST", path: "/api/parents/signup", body: { email, password } }),
      );
    },
    async verifyEmail(token) {
      return expectResult<{ ok: boolean; emailVerified: boolean }>(
        await call({ method: "POST", path: "/api/parents/verify-email", body: { token } }),
      );
    },
    async login(email, password) {
      return expectResult<LoginResult>(
        await call({ method: "POST", path: "/api/parents/login", body: { email, password } }),
      );
    },
    async refresh(token) {
      return expectResult<{ token: string }>(
        await call({ method: "POST", path: "/api/parents/refresh", token }),
      );
    },
    async parentLogout(token) {
      return expectResult<{ ok: boolean }>(
        await call({ method: "POST", path: "/api/parents/logout", token }),
      );
    },
    async parentLogoutAll(token) {
      return expectResult<{ ok: boolean; revokedSessions: number }>(
        await call({ method: "POST", path: "/api/parents/logout-all", token }),
      );
    },
    async policyLatest() {
      return expectResult<{
        version: string;
        locale: string;
        policyText: string;
        createdAt: string;
      }>(await call({ method: "GET", path: "/api/consent/policy/latest" }));
    },
    async consentStatus(token) {
      return expectResult<ConsentStatusInfo>(
        await call({ method: "GET", path: "/api/consent/status", token }),
      );
    },
    async captureConsent(token, policyVersion) {
      return expectResult<ConsentCaptureResult>(
        await call({
          method: "POST",
          path: "/api/consent/records",
          token,
          body: { policyVersion },
        }),
      );
    },
    async listChildren(token) {
      return expectResult<{ parentId: string; children: ChildProfileInfo[] }>(
        await call({ method: "GET", path: "/api/parent/children", token }),
      );
    },
    async createChild(token, payload) {
      return expectResult<CreateChildResult>(
        await call({ method: "POST", path: "/api/parent/children", token, body: payload }),
      );
    },
    async mintDeviceSession(token, studentId, clientDeviceId, platform) {
      return expectResult<DeviceSessionResult>(
        await call({
          method: "POST",
          path: `/api/parent/children/${encodeURIComponent(studentId)}/device-sessions`,
          token,
          body: { clientDeviceId, platform },
        }),
      );
    },
  };
}

/** Re-exported for the grade step's option list. */
export type { GradeId };
