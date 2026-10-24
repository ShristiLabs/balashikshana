// Edge-hardening regression tests for issue #29 (CORS allowlist, rate
// limiting, request size caps, structured logging). Runs the real API
// server as a child process with env-tuned limits so the behaviors are
// deterministic. Vitest suite (issue #32); assertions are the node:test
// originals, unchanged.

import { test, describe, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDatabase, dropTestDatabase, startTestServer, waitForHealth, registerConsentedStudent } from "./helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = "http://127.0.0.1:4798";
const SERVER = path.resolve(__dirname, "../server.mjs");

const TEST_ENV = {
  ...process.env,
  PORT: "4798",
  RATE_LIMIT_PER_IP_MIN: "1000", // general traffic unthrottled for the suite
  RATE_LIMIT_PER_TOKEN_MIN: "3", // per-token limit exercised by its own test
  RATE_LIMIT_LOGIN_PER_IP_MIN: "3",
  BODY_LIMIT_BYTES: "2000"
};

let serverProcess;
let testDatabase;
let stdoutLines = [];
let stderrText = "";

function spawnExpectingFailure(extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--no-warnings", SERVER],
      {
        env: {
          ...TEST_ENV,
          ...extraEnv,
          DATABASE_URL: "postgres://balashikshana:balashikshana_dev@localhost:5432/no_such_db_expected_unused"
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let err = "";
    child.stderr.on("data", (c) => (err += String(c)));
    child.on("close", (code) => resolve({ code, err }));
    setTimeout(() => {
      child.kill("SIGKILL");
    }, 15000);
  });
}

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  serverProcess = await startTestServer({
    port: 4798,
    databaseUrl: testDatabase.url,
    env: TEST_ENV,
    onStdout: (c) => {
      for (const line of c.split("\n")) {
        if (line.trim()) stdoutLines.push(line);
      }
    },
    onStderr: (c) => {
      stderrText += c;
    }
  });
  await waitForHealth(API, 120000);
});

afterAll(async () => {
  serverProcess?.kill("SIGTERM");
  if (testDatabase) await dropTestDatabase(testDatabase.name);
});

describe("CORS allowlist", () => {
  test("allowed origin is echoed with CORS headers", async () => {
    const res = await fetch(`${API}/api/health`, {
      headers: { Origin: "http://localhost:4200" }
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "http://localhost:4200");
    assert.equal(res.headers.get("vary"), "Origin");
  });

  test("disallowed origin receives no CORS headers", async () => {
    const res = await fetch(`${API}/api/health`, {
      headers: { Origin: "https://evil.example.com" }
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });

  test("preflight from disallowed origin is rejected 403", async () => {
    const res = await fetch(`${API}/api/students`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example.com", "Access-Control-Request-Method": "POST" }
    });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });

  test("preflight from allowed origin is 204", async () => {
    const res = await fetch(`${API}/api/students`, {
      method: "OPTIONS",
      headers: { Origin: "http://127.0.0.1:4200", "Access-Control-Request-Method": "POST" }
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "http://127.0.0.1:4200");
  });

  test("requests without Origin pass through (curl/CI) with no CORS headers", async () => {
    const res = await fetch(`${API}/api/health`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });

  test("OPTIONS without an Origin header still returns 204 (pre-Fastify parity)", async () => {
    const res = await fetch(`${API}/api/health`, { method: "OPTIONS" });
    assert.equal(res.status, 204);
  });

  test("preflight short-circuit replies also carry an X-Request-Id UUID", async () => {
    const noOrigin = await fetch(`${API}/api/health`, { method: "OPTIONS" });
    assert.equal(noOrigin.status, 204);
    assert.match(
      noOrigin.headers.get("x-request-id") || "",
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );

    const rejected = await fetch(`${API}/api/students`, {
      method: "OPTIONS",
      headers: { Origin: "https://evil.example.com", "Access-Control-Request-Method": "POST" }
    });
    assert.equal(rejected.status, 403);
    assert.match(
      rejected.headers.get("x-request-id") || "",
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  test("production mode with wildcard ALLOWED_ORIGINS refuses to boot", async () => {
    const { code, err } = await spawnExpectingFailure({
      NODE_ENV: "production",
      ALLOWED_ORIGINS: "*"
    });
    assert.notEqual(code, 0, "server must exit non-zero");
    assert.match(err, /wildcard/i);
  });

  test("production mode with unset ALLOWED_ORIGINS refuses to boot", async () => {
    const { code, err } = await spawnExpectingFailure({
      NODE_ENV: "production",
      ALLOWED_ORIGINS: ""
    });
    assert.notEqual(code, 0, "server must exit non-zero");
    assert.match(err, /ALLOWED_ORIGINS/i);
  });
});

describe("rate limiting", () => {
  test("login burst beyond the per-IP cap returns 429 with Retry-After", async () => {
    const attempts = [];
    for (let i = 0; i < 5; i++) {
      attempts.push(
        fetch(`${API}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "edge-burst-user", pin: "0000" })
        })
      );
    }
    const responses = await Promise.all(attempts);
    const statuses = responses.map((r) => r.status).sort();
    assert.equal(statuses[statuses.length - 1], 429, `expected at least one 429, got ${statuses.join(",")}`);
    const throttled = responses.find((r) => r.status === 429);
    const retryAfter = Number(throttled.headers.get("retry-after"));
    assert.ok(retryAfter >= 1 && retryAfter <= 60, `Retry-After out of range: ${retryAfter}`);
    assert.match(throttled.headers.get("content-type") || "", /application\/problem\+json/);
    const body = await throttled.json();
    assert.equal(body.status, 429);
    assert.ok(body.title, "problem+json title missing");
    assert.ok(body.detail, "problem+json detail missing");
  });

  test("per-TOKEN limit returns 429 for an over-active valid session", async () => {
    // #41: registration is consent-gated; a fresh consented parent keeps the
    // parent token at 2 uses (consent + create), safely under this suite's
    // tuned per-token cap of 3 — the burst below targets the STUDENT token.
    const { token, student } = await registerConsentedStudent(API, {
      nickname: "TokenBurst",
      username: "tokenburst",
      pin: "5566"
    });

    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${API}/api/students/${student.studentId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      statuses.push(res.status);
    }
    assert.ok(statuses.includes(429), `expected a 429 among [${statuses.join(",")}]`);
    const throttledIdx = statuses.indexOf(429);
    assert.equal(statuses[0], 200, "first request with a fresh token must pass");
    assert.ok(statuses.slice(throttledIdx).every((s) => s === 429), "limit must latch for the window");
  });
});

describe("request size caps", () => {
  test("oversized body is rejected 413", async () => {
    // Uses the register route (same shared body cap) so the exhausted
    // login-burst limiter from the previous describe cannot mask the 413.
    const bigPayload = JSON.stringify({ nickname: "x".repeat(4000), pin: "1111" });
    const res = await fetch(`${API}/api/students`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bigPayload
    });
    assert.equal(res.status, 413);
  });

  test("on session-guarded routes the 413 fires before auth (no token, oversized body)", async () => {
    const bigPayload = JSON.stringify({ studentId: "stu-x", responses: "x".repeat(4000) });
    const res = await fetch(`${API}/api/practice/topic/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: bigPayload
    });
    // Pins the ordering: the shared body cap runs before the 401/403
    // session guard inside the route callback.
    assert.equal(res.status, 413);
  });
});

describe("structured logging and request IDs", () => {
  test("every response carries an X-Request-Id UUID", async () => {
    const res = await fetch(`${API}/api/health`);
    const requestId = res.headers.get("x-request-id");
    assert.ok(requestId, "X-Request-Id header missing");
    assert.match(requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  test("X-Request-Id values are unique across requests", async () => {
    const [a, b] = await Promise.all([fetch(`${API}/api/health`), fetch(`${API}/api/health`)]);
    const idA = a.headers.get("x-request-id");
    const idB = b.headers.get("x-request-id");
    assert.ok(idA && idB);
    assert.notEqual(idA, idB);
  });

  test("each request logs one structured JSON line with requestId/statusCode/durationMs", async () => {
    stdoutLines = [];
    await fetch(`${API}/api/health`);
    await new Promise((r) => setTimeout(r, 300));
    const parsed = stdoutLines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((o) => o && o.msg === "request");
    assert.ok(parsed.length >= 1, "expected at least one request log line");
    const line = parsed[parsed.length - 1];
    assert.ok(line.requestId, "requestId missing");
    assert.equal(line.statusCode, 200);
    assert.equal(typeof line.durationMs, "number");
    assert.equal(line.url, "/api/health");
  });

  test("authenticated requests log the session's studentId", async () => {
    const { token, student } = await registerConsentedStudent(API, {
      nickname: "LogProbe",
      username: "logprobe",
      pin: "7788"
    });
    stdoutLines = [];
    await fetch(`${API}/api/students/${student.studentId}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    await new Promise((r) => setTimeout(r, 300));
    const parsed = stdoutLines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((o) => o && o.msg === "request");
    const line = parsed.find((o) => o.url === `/api/students/${student.studentId}`);
    assert.ok(line, "request log line for the authenticated call missing");
    assert.equal(line.studentId, student.studentId);
    assert.equal(line.statusCode, 200);
  });
});

describe("problem+json error contract (RFC 9457)", () => {
  test("unknown route returns a 404 problem document with type/title/status/detail/instance", async () => {
    const res = await fetch(`${API}/api/definitely-not-a-route`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") || "", /application\/problem\+json/);
    const body = await res.json();
    assert.equal(body.status, 404);
    assert.equal(typeof body.type, "string");
    assert.ok(body.title);
    assert.ok(body.detail);
    assert.equal(body.instance, "/api/definitely-not-a-route");
  });

  test("validation failure returns 400 with schema details in errors[]", async () => {
    // Uses the register route: the login throttle bucket is still latched
    // by the earlier burst test (1-minute fixed window).
    const res = await fetch(`${API}/api/students`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname: "shapeprobe", pin: "12" })
    });
    assert.equal(res.status, 400);
    assert.match(res.headers.get("content-type") || "", /application\/problem\+json/);
    const body = await res.json();
    assert.equal(body.status, 400);
    assert.equal(body.title, "Validation failed");
    assert.ok(Array.isArray(body.errors) && body.errors.length >= 1, "schema error details missing");
    assert.equal(body.instance, "/api/students");
  });

  test("query validation on practice topic rejects out-of-range count with 400", async () => {
    const res = await fetch(`${API}/api/practice/topic/K-M2/I?count=999`);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.status, 400);
    assert.ok(Array.isArray(body.errors));
  });

  test("session rejection on a student route is a 401 problem document", async () => {
    const res = await fetch(`${API}/api/students/stu-not-real`);
    assert.equal(res.status, 401);
    assert.match(res.headers.get("content-type") || "", /application\/problem\+json/);
    const body = await res.json();
    assert.equal(body.status, 401);
    assert.ok(body.detail);
  });

  test("malformed JSON body returns a 400 problem document", async () => {
    const res = await fetch(`${API}/api/students`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json"
    });
    assert.equal(res.status, 400);
    assert.match(res.headers.get("content-type") || "", /application\/problem\+json/);
    const body = await res.json();
    assert.equal(body.status, 400);
  });

  test("oversized URL returns a 414 problem document", async () => {
    const res = await fetch(`${API}/api/health?pad=${"x".repeat(2200)}`);
    assert.equal(res.status, 414);
    const body = await res.json();
    assert.equal(body.status, 414);
  });
});
