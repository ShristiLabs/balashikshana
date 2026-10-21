// Edge-hardening regression tests for issue #29 (CORS allowlist, rate
// limiting, request size caps, structured logging). Runs the real API
// server as a child process with env-tuned limits so the behaviors are
// deterministic. Node's built-in test runner only (zero extra deps).

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
let tempDir;
let stdoutLines = [];
let stderrText = "";

function spawnServer(extraEnv) {
  const child = spawn(
    process.execPath,
    ["--experimental-sqlite", "--no-warnings", SERVER],
    {
      env: { ...TEST_ENV, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  child.stdout.on("data", (c) => {
    for (const line of String(c).split("\n")) {
      if (line.trim()) stdoutLines.push(line);
    }
  });
  child.stderr.on("data", (c) => {
    stderrText += String(c);
  });
  return child;
}

async function waitForHealth(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("API server did not become healthy in time");
}

function spawnExpectingFailure(extraEnv) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--experimental-sqlite", "--no-warnings", SERVER],
      {
        env: {
          ...TEST_ENV,
          ...extraEnv,
          SQLITE_DB_PATH: path.join(mkdtempSync(path.join(os.tmpdir(), "bootfail-")), "x.sqlite")
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

before(async () => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "balashikshana-edge-test-"));
  serverProcess = spawnServer({ SQLITE_DB_PATH: path.join(tempDir, "test.sqlite") });
  await waitForHealth();
});

after(() => {
  serverProcess?.kill("SIGTERM");
  rmSync(tempDir, { recursive: true, force: true });
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
    const body = await throttled.json();
    assert.ok(body.error);
  });

  test("per-TOKEN limit returns 429 for an over-active valid session", async () => {
    const reg = await fetch(`${API}/api/students`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname: "TokenBurst", username: "tokenburst", currentGrade: "kindergarten", pin: "5566" })
    });
    assert.equal(reg.status, 201);
    const { token, student } = await reg.json();

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
    const reg = await fetch(`${API}/api/students`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname: "LogProbe", username: "logprobe", currentGrade: "kindergarten", pin: "7788" })
    });
    const { token, student } = await reg.json();
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
