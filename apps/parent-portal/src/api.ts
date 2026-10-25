// Thin fetch client for the portal API surface. No SDK, no interceptors
// framework — the portal talks to exactly one API with one auth shape.
//
// - All requests are same-contract JSON; errors are RFC 9457
//   problem+json bodies (the API's universal envelope) surfaced as
//   ApiError with the problem's title/detail.
// - 401s raise UnauthorizedError so App can run its one-shot refresh
//   rotation and otherwise return to the login screen.
// - The API never sees credentials beyond the bearer header; no secrets
//   exist in this bundle (the token lives in auth.ts's store).

import type {
  PortalChildrenResponse,
  PortalQuadrantResponse,
  PortalSettingsPutResponse,
  PortalSettingsResponse,
  PortalWeeklyResponse,
  ParentPublic
} from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly type?: string;
  constructor(status: number, title: string, detail: string, type?: string) {
    super(detail || title);
    this.name = "ApiError";
    this.status = status;
    this.type = type;
  }
}

export class UnauthorizedError extends ApiError {
  constructor() {
    super(401, "Unauthorized", "Your session has expired. Please log in again.");
    this.name = "UnauthorizedError";
  }
}

/** Type-safe check for catch blocks over `unknown`. */
export function isUnauthorizedError(err: unknown): boolean {
  return err instanceof UnauthorizedError;
}

const BASE_URL: string = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? "http://localhost:4000";

async function call<T>(path: string, init: { method?: string; token?: string | null; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined
    });
  } catch {
    throw new ApiError(0, "Network error", "Could not reach the server. Check your connection and try again.");
  }
  if (res.status === 401) throw new UnauthorizedError();
  if (!res.ok) {
    let problem: Record<string, unknown> = {};
    try {
      problem = (await res.json()) as Record<string, unknown>;
    } catch {
      // Non-JSON error body — fall through with defaults.
    }
    throw new ApiError(
      res.status,
      typeof problem.title === "string" ? problem.title : `Error ${res.status}`,
      typeof problem.detail === "string" ? problem.detail : `Request failed (${res.status}).`,
      typeof problem.type === "string" ? problem.type : undefined
    );
  }
  return (await res.json()) as T;
}

export interface LoginResult {
  token: string;
  parent: ParentPublic;
}

export const api = {
  baseUrl: BASE_URL,
  login(email: string, password: string): Promise<LoginResult> {
    return call<LoginResult>("/api/parents/login", { method: "POST", body: { email, password } });
  },
  refresh(token: string): Promise<{ token: string }> {
    return call<{ token: string }>("/api/parents/refresh", { method: "POST", token });
  },
  logout(token: string): Promise<{ ok: boolean }> {
    return call<{ ok: boolean }>("/api/parents/logout", { method: "POST", token });
  },
  children(token: string): Promise<PortalChildrenResponse> {
    return call<PortalChildrenResponse>("/api/portal/children", { token });
  },
  quadrant(token: string, studentId: string): Promise<PortalQuadrantResponse> {
    return call<PortalQuadrantResponse>(`/api/portal/children/${encodeURIComponent(studentId)}/analytics/quadrant`, { token });
  },
  weekly(token: string, studentId: string, weeks = 8): Promise<PortalWeeklyResponse> {
    return call<PortalWeeklyResponse>(
      `/api/portal/children/${encodeURIComponent(studentId)}/analytics/weekly?weeks=${weeks}`,
      { token }
    );
  },
  settings(token: string, studentId: string): Promise<PortalSettingsResponse> {
    return call<PortalSettingsResponse>(`/api/portal/children/${encodeURIComponent(studentId)}/settings`, { token });
  },
  notificationPreferences(token: string): Promise<import("./types").NotificationPreferences> {
    return call<import("./types").NotificationPreferences>("/api/portal/notification-preferences", { token });
  },
  putNotificationPreferences(token: string, weeklyEmailEnabled: boolean): Promise<import("./types").NotificationPreferences> {
    return call<import("./types").NotificationPreferences>("/api/portal/notification-preferences", {
      method: "PUT",
      token,
      body: { weeklyEmailEnabled }
    });
  },
  putSettings(token: string, studentId: string, body: import("./types").ChildSettings): Promise<PortalSettingsPutResponse> {
    return call<PortalSettingsPutResponse>(`/api/portal/children/${encodeURIComponent(studentId)}/settings`, {
      method: "PUT",
      token,
      body
    });
  },
  /**
   * Download the child's COPPA data export as a JSON attachment. Uses a
   * raw fetch (not call<T>): the response is a Blob to hand to the
   * browser's download flow, and Content-Disposition names the file.
   */
  async exportChildData(token: string, studentId: string): Promise<Blob> {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/api/portal/children/${encodeURIComponent(studentId)}/export`, {
        headers: { Authorization: `Bearer ${token}` }
      });
    } catch {
      throw new ApiError(0, "Network error", "Could not reach the server. Check your connection and try again.");
    }
    if (res.status === 401) throw new UnauthorizedError();
    if (!res.ok) {
      let problem: Record<string, unknown> = {};
      try {
        problem = (await res.json()) as Record<string, unknown>;
      } catch {
        // Non-JSON error body — fall through with defaults.
      }
      throw new ApiError(
        res.status,
        typeof problem.title === "string" ? problem.title : `Error ${res.status}`,
        typeof problem.detail === "string" ? problem.detail : `Request failed (${res.status}).`
      );
    }
    return res.blob();
  },
  /**
   * Delete a child's data (password re-authentication). Deliberately NOT
   * call<T>: the route's 401 re-auth-required (wrong password) must surface
   * as a readable ApiError, not be conflated with the session-expired 401
   * that logs the parent out — only a plain 401 (no re-auth problem type)
   * raises UnauthorizedError.
   */
  async deleteChild(token: string, studentId: string, password: string): Promise<import("./types").DeletionSummary> {
    let res: Response;
    try {
      res = await fetch(`${BASE_URL}/api/portal/children/${encodeURIComponent(studentId)}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ password })
      });
    } catch {
      throw new ApiError(0, "Network error", "Could not reach the server. Check your connection and try again.");
    }
    if (res.status === 401) {
      let problem: Record<string, unknown> = {};
      try {
        problem = (await res.json()) as Record<string, unknown>;
      } catch {
        // Non-JSON body — treat as a session failure.
      }
      if (typeof problem.type === "string" && problem.type.endsWith("/re-auth-required")) {
        throw new ApiError(
          401,
          typeof problem.title === "string" ? problem.title : "Re-authentication failed",
          typeof problem.detail === "string" ? problem.detail : "Deleting your child's data requires your account password.",
          problem.type
        );
      }
      throw new UnauthorizedError();
    }
    if (!res.ok) {
      let problem: Record<string, unknown> = {};
      try {
        problem = (await res.json()) as Record<string, unknown>;
      } catch {
        // Non-JSON error body — fall through with defaults.
      }
      throw new ApiError(
        res.status,
        typeof problem.title === "string" ? problem.title : `Error ${res.status}`,
        typeof problem.detail === "string" ? problem.detail : `Request failed (${res.status}).`
      );
    }
    return (await res.json()) as import("./types").DeletionSummary;
  }
};
