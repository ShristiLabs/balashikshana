// Security regression tests for issue #28 (auth and session hardening).
//
// Runs the real API server as a child process against a throwaway SQLite
// database and exercises the session/PIN lifecycle end to end, including
// the cross-student access (IDOR) denial that is the core acceptance
// criterion. Uses Node's built-in test runner only (zero dependencies);
// issue #32 ports these cases onto vitest with the Postgres-backed suite.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = "http://127.0.0.1:4799";
const SERVER = path.resolve(__dirname, "../server.mjs");

let serverProcess;
let tempDir;
let db;

async function api(pathname, { method = "GET", token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON response
  }
  return { status: res.status, json };
}

async function waitForHealth(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API}/api/health`);
      if (res.ok) return;
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("API server did not become healthy in time");
}

async function registerStudent(name, pin = "5533") {
  const res = await api("/api/students", {
    method: "POST",
    body: { nickname: name, username: name, currentGrade: "kindergarten", pin }
  });
  assert.equal(res.status, 201, `registration failed: ${JSON.stringify(res.json)}`);
  return res.json;
}

async function login(identifier, pin) {
  return api("/api/auth/login", { method: "POST", body: { ...identifier, pin } });
}

before(async () => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "balashikshana-auth-test-"));
  serverProcess = spawn(
    process.execPath,
    ["--experimental-sqlite", "--no-warnings", SERVER],
    {
      env: {
        ...process.env,
        PORT: "4799",
        SQLITE_DB_PATH: path.join(tempDir, "test.sqlite")
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  serverProcess.stderr.on("data", () => {});
  await waitForHealth();
  db = new DatabaseSync(path.join(tempDir, "test.sqlite"));
});

after(() => {
  try {
    db?.close();
  } catch {
    // already closed
  }
  serverProcess?.kill("SIGTERM");
  rmSync(tempDir, { recursive: true, force: true });
});

describe("PIN hashing and registration", () => {
  test("register requires a 4-digit PIN (no default PIN exists)", async () => {
    const noPin = await api("/api/students", {
      method: "POST",
      body: { nickname: "NoPin", currentGrade: "kindergarten" }
    });
    assert.equal(noPin.status, 400);

    const shortPin = await api("/api/students", {
      method: "POST",
      body: { nickname: "ShortPin", currentGrade: "kindergarten", pin: "12" }
    });
    assert.equal(shortPin.status, 400);
  });

  test("register returns 201 and stores a salted scrypt hash", async () => {
    const created = await registerStudent("scryptholder");
    assert.ok(created.token, "registration must mint a session token");

    const row = db.prepare("SELECT pin_hash FROM students WHERE student_id = ?").get(created.student.studentId);
    assert.match(row.pin_hash, /^scrypt\$16384\$8\$1\$[0-9a-f]+\$[0-9a-f]+$/);
  });

  test("two students with the same PIN get different hashes (per-row salt)", async () => {
    const a = await registerStudent("salteda", "7777");
    const b = await registerStudent("saltedb", "7777");
    const rows = db
      .prepare("SELECT pin_hash FROM students WHERE student_id IN (?, ?)")
      .all(a.student.studentId, b.student.studentId);
    assert.notEqual(rows[0].pin_hash, rows[1].pin_hash);
  });
});

describe("login", () => {
  test("wrong PIN returns 401", async () => {
    await registerStudent("pintester", "4242");
    const res = await login({ username: "pintester" }, "0000");
    assert.equal(res.status, 401);
  });

  test("missing PIN returns 401 (PIN-less login is gone)", async () => {
    await registerStudent("nopinlogin", "4242");
    const res = await login({ username: "nopinlogin" }, "");
    assert.equal(res.status, 401);
  });

  test("unknown user and wrong PIN return identical 401 bodies (no enumeration)", async () => {
    await registerStudent("enumcheck", "4242");
    const unknown = await login({ username: "does-not-exist" }, "4242");
    const wrong = await login({ username: "enumcheck" }, "9999");
    assert.equal(unknown.status, 401);
    assert.equal(wrong.status, 401);
    assert.deepEqual(unknown.json, wrong.json);
  });

  test("correct PIN returns 200 with token for that student", async () => {
    const created = await registerStudent("goodlogin", "1357");
    const res = await login({ username: "goodlogin" }, "1357");
    assert.equal(res.status, 200);
    assert.ok(res.json.token);
    assert.equal(res.json.student.studentId, created.student.studentId);
  });

  test("login works with studentId + PIN too", async () => {
    const created = await registerStudent("idlogin", "2468");
    const res = await login({ studentId: created.student.studentId }, "2468");
    assert.equal(res.status, 200);
    assert.ok(res.json.token);
  });

  test("PIN with surrounding whitespace is normalized (trimmed)", async () => {
    await registerStudent("trimtest", "3579");
    const res = await login({ username: "trimtest" }, " 3579 ");
    assert.equal(res.status, 200);
  });

  test("register duplicate username gets a unique suffix and can log in", async () => {
    const first = await registerStudent("dupuser", "1212");
    const second = await api("/api/students", {
      method: "POST",
      body: { nickname: "dupuser", username: "dupuser", currentGrade: "kindergarten", pin: "1212" }
    });
    assert.equal(second.status, 201);
    assert.notEqual(second.json.student.username, first.student.username);
    const res = await login({ username: second.json.student.username }, "1212");
    assert.equal(res.status, 200);
  });

  test("legacy unsalted-SHA256 row logs in and is rehashed to scrypt", async () => {
    const created = await registerStudent("legacyrow", "8642");
    // Downgrade the row to the legacy format, then log in again.
    const legacyHash = (
      await import("node:crypto")
    ).createHash("sha256").update("balashikshana:8642").digest("hex");
    db.prepare("UPDATE students SET pin_hash = ? WHERE student_id = ?").run(
      legacyHash,
      created.student.studentId
    );

    const res = await login({ username: "legacyrow" }, "8642");
    assert.equal(res.status, 200);

    const upgraded = db
      .prepare("SELECT pin_hash FROM students WHERE student_id = ?")
      .get(created.student.studentId);
    assert.match(upgraded.pin_hash, /^scrypt\$16384\$8\$1\$/, "legacy hash must be rehashed on login");

    // And the old PIN no longer validates through the legacy path.
    const again = await login({ username: "legacyrow" }, "8642");
    assert.equal(again.status, 200);
  });
});

describe("session validation (IDOR fix)", () => {
  test("own student state accessible with own token", async () => {
    const created = await registerStudent("ownaccess", "3131");
    const res = await api(`/api/students/${created.student.studentId}`, {
      token: created.token
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.student.studentId, created.student.studentId);
  });

  test("cross-student GET with a valid token returns 403", async () => {
    const alice = await registerStudent("alice28", "1111");
    const bob = await registerStudent("bob28", "2222");
    const res = await api(`/api/students/${bob.student.studentId}`, {
      token: alice.token
    });
    assert.equal(res.status, 403);
  });

  test("cross-student calibrate with a valid token returns 403", async () => {
    const alice = await registerStudent("alice29", "1111");
    const bob = await registerStudent("bob29", "2222");
    const res = await api(`/api/students/${bob.student.studentId}/calibrate`, {
      method: "POST",
      token: alice.token,
      body: { motorBaselineSec: 0.5 }
    });
    assert.equal(res.status, 403);
  });

  test("practice/complete for another student returns 403", async () => {
    const alice = await registerStudent("alice30", "1111");
    const bob = await registerStudent("bob30", "2222");
    const res = await api("/api/practice/topic/complete", {
      method: "POST",
      token: alice.token,
      body: {
        studentId: bob.student.studentId,
        unitId: "K-M1",
        topicCode: "A",
        responses: [{ questionId: "K-M1-A-Q1", chosenAnswer: "1", isCorrect: true, rawTimeSec: 2 }]
      }
    });
    assert.equal(res.status, 403);
  });

  test("gate/evaluate for another student returns 403", async () => {
    const alice = await registerStudent("alice31", "1111");
    const bob = await registerStudent("bob31", "2222");
    const res = await api("/api/gate/evaluate", {
      method: "POST",
      token: alice.token,
      body: {
        studentId: bob.student.studentId,
        unitId: "K-M1",
        responses: []
      }
    });
    assert.equal(res.status, 403);
  });

  test("calibrate with OWN token succeeds (positive control for the 403 tests)", async () => {
    const created = await registerStudent("owncal", "1515");
    const res = await api(`/api/students/${created.student.studentId}/calibrate`, {
      method: "POST",
      token: created.token,
      body: { motorBaselineSec: 0.48 }
    });
    assert.equal(res.status, 200);
  });

  test("no token returns 401", async () => {
    const created = await registerStudent("notoken", "6060");
    const res = await api(`/api/students/${created.student.studentId}`);
    assert.equal(res.status, 401);
  });

  test("garbage token returns 401", async () => {
    const created = await registerStudent("badtoken", "6061");
    const res = await api(`/api/students/${created.student.studentId}`, {
      token: "not-a-real-token!!"
    });
    assert.equal(res.status, 401);
  });

  test("lowercase 'bearer' scheme is rejected (401) — scheme matching is strict", async () => {
    const created = await registerStudent("casescheme", "1616");
    const res = await fetch(`${API}/api/students/${created.student.studentId}`, {
      headers: { Authorization: `bearer ${created.token}` }
    });
    assert.equal(res.status, 401);
  });

  test("ownSummary is present on /api/students with a valid session", async () => {
    const created = await registerStudent("ownsum", "1717");
    const res = await api("/api/students", { token: created.token });
    assert.equal(res.status, 200);
    assert.equal(res.json.ownSummary.studentId, created.student.studentId);
  });
});

describe("token lifecycle", () => {
  test("multiple concurrent sessions: logging out one leaves the other valid", async () => {
    await registerStudent("multisession", "6565");
    const first = await login({ username: "multisession" }, "6565");
    const second = await login({ username: "multisession" }, "6565");
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.notEqual(first.json.token, second.json.token);

    const out = await api("/api/auth/logout", { method: "POST", token: first.json.token });
    assert.equal(out.status, 200);

    const revokedCall = await api("/api/students/" + first.json.student.studentId, {
      token: first.json.token
    });
    assert.equal(revokedCall.status, 401);

    const stillValid = await api("/api/students/" + second.json.student.studentId, {
      token: second.json.token
    });
    assert.equal(stillValid.status, 200);
  });

  test("logout revokes the token; reuse returns 401", async () => {
    const created = await registerStudent("logoutuser", "7070");
    const out = await api("/api/auth/logout", { method: "POST", token: created.token });
    assert.equal(out.status, 200);
    assert.equal(out.json.ok, true);

    const reuse = await api(`/api/students/${created.student.studentId}`, {
      token: created.token
    });
    assert.equal(reuse.status, 401);
  });

  test("expired session token returns 401 and is deleted", async () => {
    const created = await registerStudent("expireduser", "8080");
    db.prepare("UPDATE student_sessions SET expires_at = ? WHERE token = ?").run(
      new Date(Date.now() - 1000).toISOString(),
      created.token
    );
    const res = await api(`/api/students/${created.student.studentId}`, {
      token: created.token
    });
    assert.equal(res.status, 401);

    const row = db.prepare("SELECT token FROM student_sessions WHERE token = ?").get(created.token);
    assert.equal(row, undefined, "expired session row must be lazily deleted");
  });
});

describe("public student list privacy", () => {
  test("unauthenticated /api/students returns only public profile fields", async () => {
    await registerStudent("publicview", "9090");
    const res = await api("/api/students");
    assert.equal(res.status, 200);
    for (const s of res.json.students) {
      assert.deepEqual(Object.keys(s).sort(), [
        "ageYears",
        "avatar",
        "currentGrade",
        "nickname",
        "studentId",
        "username"
      ]);
    }
  });
});
