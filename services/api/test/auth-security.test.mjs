// Security regression tests for issue #28 (auth and session hardening).
//
// Runs the real API server as a child process against a throwaway
// PostgreSQL database and exercises the session/PIN lifecycle end to end,
// including the cross-student access (IDOR) denial that is the core
// acceptance criterion. Vitest suite (issue #32); assertions are the
// node:test originals, unchanged.

import { test, describe, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "pg";
import { fileURLToPath } from "node:url";
import { createTestDatabase, dropTestDatabase, startTestServer, waitForHealth, createVerifiedParentWithConsent } from "./helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API = "http://127.0.0.1:4799";

let serverProcess;
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
  // `json` is the historical name; `body`/`headers` alias the same fields
  // for tests that assert the RFC 9457 document shape and content type.
  return { status: res.status, json, body: json, headers: res.headers };
}

async function waitForHealthLocal(timeoutMs = 60000) {
  return waitForHealth(API, timeoutMs);
}

// #41: POST /api/students is consent-gated (verified parent + current
// consent). One shared consented parent covers this suite's many
// registrations; the consent behaviors themselves are covered in
// consent.test.mjs.
let suiteParent;

async function registerStudent(name, pin = "5533") {
  suiteParent ||= await createVerifiedParentWithConsent(API);
  const res = await api("/api/students", {
    method: "POST",
    token: suiteParent.token,
    body: { nickname: name, username: name, currentGrade: "kindergarten", pin }
  });
  assert.equal(res.status, 201, `registration failed: ${JSON.stringify(res.json)}`);
  return res.json;
}

async function login(identifier, pin) {
  return api("/api/auth/login", { method: "POST", body: { ...identifier, pin } });
}

let testDatabase;

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  serverProcess = await startTestServer({
    port: 4799,
    databaseUrl: testDatabase.url,
    env: {
      // This suite logs in many times from one IP; rate-limit behavior is
      // covered separately in edge-hardening.test.mjs with tuned limits.
      RATE_LIMIT_PER_IP_MIN: "1000",
      RATE_LIMIT_PER_TOKEN_MIN: "1000",
      RATE_LIMIT_LOGIN_PER_IP_MIN: "1000"
    }
  });
  serverProcess.stderr.on("data", () => {});
  await waitForHealthLocal();
  db = new Client({ connectionString: testDatabase.url });
  await db.connect();
});

afterAll(async () => {
  try {
    await db?.end();
  } catch {
    // already closed
  }
  serverProcess?.kill("SIGTERM");
  if (testDatabase) await dropTestDatabase(testDatabase.name);
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

    const row = (await db.query("SELECT pin_hash FROM students WHERE student_id = $1", [created.student.studentId])).rows[0];
    assert.match(row.pin_hash, /^scrypt\$16384\$8\$1\$[0-9a-f]+\$[0-9a-f]+$/);
  });

  test("two students with the same PIN get different hashes (per-row salt)", async () => {
    const a = await registerStudent("salteda", "7777");
    const b = await registerStudent("saltedb", "7777");
    const rows = (await db.query("SELECT pin_hash FROM students WHERE student_id IN ($1, $2)", [a.student.studentId, b.student.studentId])).rows;
    assert.notEqual(rows[0].pin_hash, rows[1].pin_hash);
  });

  test("unknown extra fields in the register body are rejected 400 (closed schema)", async () => {
    const res = await api("/api/students", {
      method: "POST",
      body: { nickname: "ExtraField", currentGrade: "kindergarten", pin: "4321", role: "admin" }
    });
    assert.equal(res.status, 400);
    assert.equal(res.json.title, "Validation failed");
  });
});

describe("login", () => {
  test("wrong PIN returns 401", async () => {
    await registerStudent("pintester", "4242");
    const res = await login({ username: "pintester" }, "0000");
    assert.equal(res.status, 401);
  });

  test("empty-string PIN returns 400 problem+json (schema-validated)", async () => {
    await registerStudent("nopinlogin", "4242");
    const res = await login({ username: "nopinlogin" }, "");
    assert.equal(res.status, 400);
    assert.equal(res.json.status, 400);
    assert.equal(res.json.title, "Validation failed");
    assert.ok(Array.isArray(res.json.errors), "schema validation details must be present");
  });

  test("absent PIN field returns 401 (PIN-less login is gone, uniform with wrong PIN)", async () => {
    await registerStudent("nopinfield", "4242");
    const res = await api("/api/auth/login", {
      method: "POST",
      body: { username: "nopinfield" }
    });
    assert.equal(res.status, 401);
    const wrong = await login({ username: "nopinfield" }, "9999");
    assert.equal(wrong.status, 401);
    assert.deepEqual(res.json, wrong.json, "absent-PIN and wrong-PIN must be indistinguishable");
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
      token: suiteParent.token,
      body: { nickname: "dupuser", username: "dupuser", currentGrade: "kindergarten", pin: "1212" }
    });
    assert.equal(second.status, 201);
    assert.notEqual(second.json.student.username, first.student.username);
    const res = await login({ username: second.json.student.username }, "1212");
    assert.equal(res.status, 200);
  });

  test("repeated duplicate registrations keep drawing free suffixes (no 500 on collision)", async () => {
    const usernames = new Set();
    for (let i = 0; i < 3; i += 1) {
      const res = await api("/api/students", {
        method: "POST",
        token: suiteParent.token,
        body: { nickname: "duploop", username: "duploop", currentGrade: "kindergarten", pin: "1313" }
      });
      assert.equal(res.status, 201, `registration ${i + 1} failed: ${JSON.stringify(res.json)}`);
      usernames.add(res.json.student.username);
      const loginRes = await login({ username: res.json.student.username }, "1313");
      assert.equal(loginRes.status, 200, `login ${i + 1} failed for ${res.json.student.username}`);
    }
    // The base name plus two auto-suffixed variants: three distinct rows.
    assert.equal(usernames.size, 3);
    assert.ok(usernames.has("duploop"));
  });

  test("legacy unsalted-SHA256 row logs in and is rehashed to scrypt", async () => {
    const created = await registerStudent("legacyrow", "8642");
    // Downgrade the row to the legacy format, then log in again.
    const legacyHash = (
      await import("node:crypto")
    ).createHash("sha256").update("balashikshana:8642").digest("hex");
    await db.query("UPDATE students SET pin_hash = $1 WHERE student_id = $2", [
      legacyHash,
      created.student.studentId
    ]);

    const res = await login({ username: "legacyrow" }, "8642");
    assert.equal(res.status, 200);

    const upgraded = (await db.query("SELECT pin_hash FROM students WHERE student_id = $1", [created.student.studentId])).rows[0];
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
    // RFC 9457 contract: authorization failures are problem documents too.
    assert.match(res.headers.get("content-type") || "", /application\/problem\+json/);
    assert.equal(res.body.status, 403);
    assert.ok(res.body.detail, "problem+json detail missing on 403");
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
    await db.query("UPDATE student_sessions SET expires_at = $1 WHERE token = $2", [
      new Date(Date.now() - 1000).toISOString(),
      created.token
    ]);
    const res = await api(`/api/students/${created.student.studentId}`, {
      token: created.token
    });
    assert.equal(res.status, 401);

    const row = (await db.query("SELECT token FROM student_sessions WHERE token = $1", [created.token])).rows[0];
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
