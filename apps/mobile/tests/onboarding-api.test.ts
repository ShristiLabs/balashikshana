/**
 * Onboarding API client error paths (issue #44). Every behavior here is
 * the res.ok debt fix: the dev web harness skips these checks; this
 * client never does. Mocked fetch - no network, no react-native.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createApiClient,
  parentFacingMessage,
  type FetchLike,
} from "../src/onboarding/api";

const PROBLEM = "https://balashikshana.dev/problems";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/problem+json" },
  });
}

function clientWith(handler: FetchLike) {
  return createApiClient({ baseUrl: "http://api.test/", fetchImpl: handler });
}

/** Minimal typed access to a vi.fn()'s call log without vitest type globals. */
type MockCalls = { mock: { calls: [string, RequestInit][] } };

describe("request shaping", () => {
  it("sends bearer tokens and JSON bodies", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true }));
    const api = clientWith(fetchImpl as unknown as FetchLike);
    await api.captureConsent("tok-1", "v1");
    const [url, init] = (fetchImpl as unknown as MockCalls).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/api/consent/records");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-1");
    expect(JSON.parse(String(init.body))).toEqual({ policyVersion: "v1" });
  });

  it("trims a trailing slash from the base URL", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true }));
    const api = createApiClient({
      baseUrl: "http://api.test///",
      fetchImpl: fetchImpl as unknown as FetchLike,
    });
    await api.parentLogout("t");
    const [url] = (fetchImpl as unknown as MockCalls).mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.test/api/parents/logout");
  });

  it("URL-encodes the studentId path segment on mint", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(201, { sessionId: "s" }));
    const api = clientWith(fetchImpl as unknown as FetchLike);
    await api.mintDeviceSession("t", "stu/a b", "dev-1", "ios");
    const [url] = (fetchImpl as unknown as MockCalls).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/parent/children/stu%2Fa%20b/device-sessions");
  });
});

describe("error doctrine: res.ok is checked on every call", () => {
  it.each([
    [
      "signup duplicate email (409)",
      jsonResponse(409, {
        type: `${PROBLEM}/email-already-registered`,
        detail: "An account with this email already exists.",
      }),
      "email-already-registered",
      409,
    ],
    [
      "login uniform 401",
      jsonResponse(401, {
        type: `${PROBLEM}/unauthorized`,
        detail: "Incorrect email or password.",
      }),
      "unauthorized",
      401,
    ],
    [
      "consent-required with version extension",
      jsonResponse(403, {
        type: `${PROBLEM}/consent-required`,
        detail: "Consent required.",
        extensions: { currentPolicyVersion: "v2" },
      }),
      "consent-required",
      403,
    ],
    [
      "policy-version-mismatch carries the new version",
      jsonResponse(409, {
        type: `${PROBLEM}/policy-version-mismatch`,
        detail: "Updated.",
        extensions: { currentPolicyVersion: "2026-11" },
      }),
      "policy-version-mismatch",
      409,
    ],
    [
      "email-verification-required",
      jsonResponse(403, {
        type: `${PROBLEM}/email-verification-required`,
        detail: "Verify first.",
      }),
      "email-verification-required",
      403,
    ],
    [
      "wrong-token-type",
      jsonResponse(403, { type: `${PROBLEM}/wrong-token-type`, detail: "No." }),
      "wrong-token-type",
      403,
    ],
    [
      "rate-limited (429)",
      jsonResponse(429, { type: `${PROBLEM}/rate-limited`, detail: "Slow down." }),
      "rate-limited",
      429,
    ],
  ])("%s maps to a typed ApiError", async (_name, res, code, status) => {
    const api = clientWith((async () => res) as unknown as FetchLike);
    const attempt = api.login("a@b.c", "password-12345");
    await expect(attempt).rejects.toMatchObject({ code, status });
  });

  it("policy-version-mismatch exposes currentPolicyVersion()", async () => {
    const api = clientWith((async () =>
      jsonResponse(409, {
        type: `${PROBLEM}/policy-version-mismatch`,
        detail: "The consent policy has been updated; accept the current version.",
        extensions: { currentPolicyVersion: "2026-11" },
      })) as unknown as FetchLike);
    try {
      await api.captureConsent("t", "2026-10");
      expect.unreachable("must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).currentPolicyVersion()).toBe("2026-11");
    }
  });

  it("non-problem error bodies degrade to bad-status, not a crash", async () => {
    const api = clientWith(
      (async () => new Response("<html>boom</html>", { status: 502 })) as unknown as FetchLike,
    );
    await expect(api.policyLatest()).rejects.toMatchObject({ code: "bad-status", status: 502 });
  });

  it("#68 legalLatest fetches the versioned legal catalog (both kinds)", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      const kind = url.includes("terms-of-service") ? "terms-of-service" : "privacy-policy";
      return jsonResponse(200, {
        kind,
        version: "1",
        locale: "en-US",
        body: `DRAFT ${kind} text`,
        createdAt: "2026-10-26T00:00:00Z",
        active: true,
      });
    });
    const api = clientWith(fetchImpl as unknown as FetchLike);

    const privacy = await api.legalLatest("privacy-policy");
    expect(privacy.kind).toBe("privacy-policy");
    expect(privacy.version).toBe("1");
    expect(privacy.body).toContain("DRAFT");

    const terms = await api.legalLatest("terms-of-service");
    expect(terms.kind).toBe("terms-of-service");
    expect(terms.body).toContain("terms-of-service");
    const calls = (fetchImpl as unknown as MockCalls).mock.calls.map(([u]) => String(u));
    expect(calls).toEqual([
      "http://api.test/api/legal/privacy-policy/latest",
      "http://api.test/api/legal/terms-of-service/latest",
    ]);
  });

  it("#68 legalLatest problem bodies map to ApiError codes", async () => {
    const api = clientWith((async () =>
      jsonResponse(404, {
        status: 404,
        type: `${PROBLEM}/not-found`,
        title: "Not Found",
      })) as unknown as FetchLike);
    await expect(api.legalLatest("privacy-policy")).rejects.toMatchObject({
      code: "not-found",
      status: 404,
    });
  });

  it("empty success bodies are a bad-body error, not null crashes", async () => {
    const api = clientWith((async () => new Response("", { status: 200 })) as unknown as FetchLike);
    await expect(api.policyLatest()).rejects.toMatchObject({ code: "bad-body" });
  });

  it("network rejection surfaces as kind=network (offline-tolerant UI)", async () => {
    const api = clientWith((async () => {
      throw new TypeError("fetch failed");
    }) as unknown as FetchLike);
    await expect(api.login("a@b.c", "password-12345")).rejects.toMatchObject({
      code: "network",
      status: 0,
    });
  });
});

describe("parent-facing copy", () => {
  it("maps every code to actionable, kid/parent-appropriate copy", () => {
    const error = new ApiError("email-already-registered", "x");
    expect(parentFacingMessage(error)).toBe(
      "An account with this email already exists. Try logging in instead.",
    );
  });

  it("network copy mentions the connection", () => {
    expect(parentFacingMessage(new ApiError("network", "x"))).toContain("internet connection");
  });

  it("no raw server detail leaks into the mapped copy", () => {
    const error = new ApiError("unknown", "x", 500, {
      status: 500,
      type: `${PROBLEM}/internal`,
      detail: "SELECT * FROM parents; -- secret internals",
    });
    expect(parentFacingMessage(error)).not.toContain("SELECT");
  });
});

describe("success shapes", () => {
  it("signup carries the dev verification token through", async () => {
    const api = clientWith((async () =>
      jsonResponse(201, {
        parentId: "par-1",
        email: "a@b.c",
        emailVerified: false,
        verificationToken: "vt-xyz",
      })) as unknown as FetchLike);
    const result = await api.signup("a@b.c", "password-12345");
    expect(result.verificationToken).toBe("vt-xyz");
    expect(result.emailVerified).toBe(false);
  });

  it("consent status and children parse into domain types", async () => {
    const api = clientWith((async () =>
      jsonResponse(200, {
        parentId: "par-1",
        children: [
          {
            studentId: "stu-1",
            username: "maya",
            nickname: "Maya",
            avatar: "panda",
            currentGrade: "kindergarten",
            status: "claimed",
            activeDeviceSessions: 1,
          },
        ],
      })) as unknown as FetchLike);
    const listed = await api.listChildren("t");
    expect(listed.children[0]?.studentId).toBe("stu-1");
  });
});
