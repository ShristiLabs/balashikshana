// Child profiles under parents (issue #42) — functional coverage for the
// new parent-scoped surface, against real PostgreSQL on a throwaway
// database (same harness contract as the sibling suites: own port,
// SEED_DEMO_STUDENTS=0 so legacy students are created explicitly, rate
// limits maxed so limiters never mask assertions):
// - POST /api/parent/children happy path with direct-DB row assertions
//   (students + parent_children + binding consent row + devices, all in
//   the claimed/active state the issue requires),
// - GET /api/parent/children listing shape,
// - legacy claim happy path (exactly the flags/timestamps/consent binding
//   the migration story requires; attempt history untouched),
// - archive path (statuses flipped, sessions killed, listing exclusion,
//   mint refusal),
// - device-session mint/revoke lifecycle used end-to-end from the child
//   token on the existing child-scoped routes,
// - child PIN stored-hash format (shared scrypt parameters, M1 identical).
//
// The adversarial matrices (token-kind confusion, anti-hijack, scoping)
// live in children-security.test.mjs.

import { test, describe, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { Client } from "pg";
import { createTestDatabase, dropTestDatabase, startTestServer, waitForHealth, createVerifiedParentWithConsent } from "./helpers.mjs";
import { hashPinScrypt } from "../db.mjs";

const API = "http://127.0.0.1:4800";

let serverProcess;
let testDatabase;
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
  return { status: res.status, json, headers: res.headers };
}

const PASSWORD = "legitimate-password-1";
let seq = 0;

// Signup -> verify (dev seam) -> login -> consent capture at the active
// policy version (helpers.mjs shared contract).
async function consentedParent() {
  return createVerifiedParentWithConsent(API, { password: PASSWORD });
}

// A LEGACY standalone student exactly like migration 005's back-fill
// population: no parent_children row, status 'legacy', scrypt PIN.
async function insertLegacyStudent(username, pin) {
  const studentId = `stu-${username}`;
  const now = new Date().toISOString();
  await db.query(
    `INSERT INTO students (student_id, username, pin_hash, nickname, avatar, age_years, current_grade, last_active_at, created_at, status)
     VALUES ($1, $2, $3, $2, 'fox', 6, 'kindergarten', $4, $4, 'legacy')`,
    [studentId, username, hashPinScrypt(pin), now]
  );
  return { studentId, username, pin };
}

async function createChild(parent, overrides = {}) {
  return api("/api/parent/children", {
    method: "POST",
    token: parent.token,
    body: {
      nickname: `Kid${++seq}`,
      pin: "5150",
      currentGrade: "kindergarten",
      clientDeviceId: `client-device-${++seq}-abcd`,
      platform: "ios",
      ...overrides
    }
  });
}

async function mintSession(parent, studentId, clientDeviceId, platform = "ios") {
  return api(`/api/parent/children/${studentId}/device-sessions`, {
    method: "POST",
    token: parent.token,
    body: { clientDeviceId, platform }
  });
}

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  serverProcess = await startTestServer({
    port: 4800,
    databaseUrl: testDatabase.url,
    env: {
      RATE_LIMIT_PER_IP_MIN: "1000",
      RATE_LIMIT_PER_TOKEN_MIN: "1000",
      RATE_LIMIT_LOGIN_PER_IP_MIN: "1000",
      RATE_LIMIT_PARENT_SIGNUP_PER_IP_MIN: "1000",
      RATE_LIMIT_PARENT_LOGIN_PER_IP_MIN: "1000",
      RATE_LIMIT_PARENT_TOKEN_PER_IP_MIN: "1000",
      RATE_LIMIT_PARENT_CLAIM_PER_IP_MIN: "1000",
      SEED_DEMO_STUDENTS: "0"
    }
  });
  serverProcess.stderr.on("data", () => {});
  await waitForHealth(API);
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

describe("POST /api/parent/children (creation under a parent)", () => {
  test("happy path: 201, and the full binding set is written atomically", async () => {
    const parent = await consentedParent();
    const res = await createChild(parent, { nickname: "Ashwin", username: `ashwin${++seq}`, relation: "father" });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    const studentId = res.json.studentId;

    // students row: active, scrypt PIN in the shared M1 format.
    const stu = (await db.query("SELECT * FROM students WHERE student_id = $1", [studentId])).rows[0];
    assert.ok(stu, "students row must exist");
    assert.equal(stu.status, "active");
    assert.match(stu.pin_hash, /^scrypt\$16384\$8\$1\$[0-9a-f]{32}\$[0-9a-f]{128}$/, "child PIN must use the shared scrypt parameters");

    // parent_children binding: claimed, relation, server timestamp.
    const binding = (
      await db.query("SELECT * FROM parent_children WHERE parent_id = $1 AND student_id = $2", [
        parent.parentId,
        studentId
      ])
    ).rows[0];
    assert.ok(binding, "parent_children row must exist");
    assert.equal(binding.status, "claimed");
    assert.equal(binding.relation, "father");
    assert.ok(binding.claimed_at);

    // Binding consent row (#41 attribution doctrine on the new path).
    const consent = (
      await db.query("SELECT * FROM consent_records WHERE student_id = $1", [studentId])
    ).rows[0];
    assert.ok(consent, "student-scoped binding consent row must exist");
    assert.equal(consent.parent_id, parent.parentId);
    assert.equal(consent.policy_version, parent.policyVersion);
    assert.equal(consent.method, "signup-form");

    // devices row keyed to the parent + client device.
    const device = (
      await db.query("SELECT * FROM devices WHERE parent_id = $1", [parent.parentId])
    ).rows[0];
    assert.ok(device, "devices row must exist");
    assert.equal(device.device_id, res.json.deviceId);
    assert.equal(device.platform, "ios");

    // No session token in the creation response: parents mint device
    // sessions explicitly.
    assert.equal(res.json.token, undefined);
    assert.equal(res.json.parentId, parent.parentId);
    assert.equal(res.json.consent.policyVersion, parent.policyVersion);
  });

  test("re-creating on the same client device reuses the device row (upsert)", async () => {
    const parent = await consentedParent();
    const clientDeviceId = `shared-tablet-${++seq}-xy`;
    const first = await createChild(parent, { clientDeviceId, platform: "ios" });
    assert.equal(first.status, 201, JSON.stringify(first.json));
    const second = await createChild(parent, { nickname: "Second", clientDeviceId, platform: "android" });
    assert.equal(second.status, 201, JSON.stringify(second.json));

    const devices = (
      await db.query("SELECT * FROM devices WHERE parent_id = $1 AND client_device_id = $2", [
        parent.parentId,
        clientDeviceId
      ])
    ).rows;
    assert.equal(devices.length, 1, "the devices row must upsert, not duplicate");
    assert.equal(devices[0].platform, "android", "platform refreshes on the re-seen device");
    assert.equal(devices[0].device_id, first.json.deviceId, "device_id is stable across upserts");
    assert.equal(second.json.deviceId, first.json.deviceId);
  });

  test("a child created here never appears unclaimed: no second parent can claim it", async () => {
    const parent = await consentedParent();
    const created = await createChild(parent, { username: `mine${++seq}` });
    assert.equal(created.status, 201);
    const other = await consentedParent();
    const claim = await api("/api/parent/children/claim", {
      method: "POST",
      token: other.token,
      body: { username: created.json.username, pin: "5150" }
    });
    assert.equal(claim.status, 409);
    assert.equal(claim.json.type, "https://balashikshana.dev/problems/already-claimed");
  });
});

describe("GET /api/parent/children (listing)", () => {
  test("lists the caller's children with binding status and active session counts", async () => {
    const parent = await consentedParent();
    const child = await createChild(parent, { nickname: "Listed" });
    assert.equal(child.status, 201);

    const minted = await mintSession(parent, child.json.studentId, `list-device-${++seq}-aa`);
    assert.equal(minted.status, 201, JSON.stringify(minted.json));

    const res = await api("/api/parent/children", { token: parent.token });
    assert.equal(res.status, 200);
    assert.equal(res.json.parentId, parent.parentId);
    const mine = res.json.children.filter((c) => c.studentId === child.json.studentId);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].status, "claimed");
    assert.equal(mine[0].relation, "guardian");
    assert.equal(mine[0].activeDeviceSessions, 1);
    assert.ok(mine[0].claimedAt);
  });

  test("one parent never sees another parent's children", async () => {
    const a = await consentedParent();
    const b = await consentedParent();
    await createChild(a, { nickname: "OnlyA" });
    const res = await api("/api/parent/children", { token: b.token });
    assert.equal(res.status, 200);
    assert.equal(res.json.children.length, 0);
  });
});

describe("POST /api/parent/children/claim (legacy standalone students)", () => {
  test("happy path: exactly-once claim binds parent + consent, flips status, keeps history", async () => {
    const legacy = await insertLegacyStudent(`claimme${++seq}`, "7777");
    // Pre-existing attempt history (D8: flows under the parent untouched).
    await db.query(
      `INSERT INTO student_question_attempts (
        student_id, session_type, unit_id, topic_id, question_id,
        chosen_answer, is_correct, raw_time_sec, cognitive_time_sec,
        fluency_grade, misconception_tags_json, attempted_at
      ) VALUES ($1, 'TOPIC_PRACTICE', 'K-M1', 'K-M1-A', 'K-M1-A-Q1', '3', 1, 2.0, 1.6, 4, '[]', now())`,
      [legacy.studentId]
    );

    const parent = await consentedParent();
    const res = await api("/api/parent/children/claim", {
      method: "POST",
      token: parent.token,
      body: { username: legacy.username, pin: legacy.pin, relation: "mother" }
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.status, "claimed");
    assert.equal(res.json.studentId, legacy.studentId);

    const stu = (await db.query("SELECT status FROM students WHERE student_id = $1", [legacy.studentId])).rows[0];
    assert.equal(stu.status, "active", "claim flips legacy -> active");

    const binding = (
      await db.query("SELECT * FROM parent_children WHERE student_id = $1", [legacy.studentId])
    ).rows[0];
    assert.equal(binding.parent_id, parent.parentId);
    assert.equal(binding.status, "claimed");
    assert.equal(binding.relation, "mother");

    const consent = (
      await db.query("SELECT * FROM consent_records WHERE student_id = $1", [legacy.studentId])
    ).rows[0];
    assert.ok(consent, "claim writes the binding consent row (audit view drops to zero)");
    assert.equal(consent.parent_id, parent.parentId);
    assert.equal(consent.policy_version, parent.policyVersion);

    const attempts = (
      await db.query("SELECT COUNT(*)::int AS n FROM student_question_attempts WHERE student_id = $1", [
        legacy.studentId
      ])
    ).rows[0].n;
    assert.equal(attempts, 1, "attempt history flows under the parent untouched (D8)");
  });

  test("claim works by nickname too (login-parity lookup)", async () => {
    const legacy = await insertLegacyStudent(`nickmatch${++seq}`, "1234");
    const parent = await consentedParent();
    const res = await api("/api/parent/children/claim", {
      method: "POST",
      token: parent.token,
      body: { username: legacy.username.toUpperCase(), pin: "1234" }
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
  });

  test("legacy students stay unclaimed until explicitly claimed (no auto-adoption)", async () => {
    const legacy = await insertLegacyStudent(`untouched${++seq}`, "9999");
    const bystander = await consentedParent(); // a consented parent exists...
    await api("/api/parent/children", { method: "GET", token: bystander.token }); // ...and interacts
    await createChild(bystander, { nickname: "TheirOwn" }); // ...and creates their own child

    const binding = (
      await db.query("SELECT COUNT(*)::int AS n FROM parent_children WHERE student_id = $1", [legacy.studentId])
    ).rows[0].n;
    assert.equal(binding, 0, "no parent_children row may appear without an explicit claim");
    const stu = (await db.query("SELECT status FROM students WHERE student_id = $1", [legacy.studentId])).rows[0];
    assert.equal(stu.status, "legacy", "status stays legacy until claimed or archived");
  });

  test("the claimed child's data is usable end-to-end after a device mint (restore path)", async () => {
    const legacy = await insertLegacyStudent(`restored${++seq}`, "4242");
    const parent = await consentedParent();
    const claim = await api("/api/parent/children/claim", {
      method: "POST",
      token: parent.token,
      body: { username: legacy.username, pin: "4242" }
    });
    assert.equal(claim.status, 201);
    const minted = await mintSession(parent, legacy.studentId, `restore-device-${++seq}-zz`);
    assert.equal(minted.status, 201, JSON.stringify(minted.json));

    const practice = await api("/api/practice/topic/complete", {
      method: "POST",
      token: minted.json.token,
      body: {
        studentId: legacy.studentId,
        unitId: "K-M2",
        topicCode: "I",
        responses: [{ questionId: "K-M2-I-Q1", chosenAnswer: "6", isCorrect: true, rawTimeSec: 2.5 }]
      }
    });
    assert.equal(practice.status, 200, JSON.stringify(practice.json));
  });
});

describe("child device sessions (mint/revoke lifecycle)", () => {
  test("mint issues a once-only token that reaches the child-scoped routes", async () => {
    const parent = await consentedParent();
    const child = await createChild(parent, { nickname: "TokenKid" });
    const minted = await mintSession(parent, child.json.studentId, `life-device-${++seq}-q1`);
    assert.equal(minted.status, 201);
    assert.match(minted.json.sessionId, /^cds-/);
    assert.match(minted.json.token, /^[A-Za-z0-9_-]+$/);
    assert.ok(minted.json.expiresAt);

    // The token is stored hashed at rest, never raw.
    const row = (
      await db.query("SELECT * FROM child_device_sessions WHERE session_id = $1", [minted.json.sessionId])
    ).rows[0];
    assert.ok(row);
    assert.equal(row.token_hash.length, 64, "token_hash is the SHA-256 hex digest");
    assert.notEqual(row.token_hash, minted.json.token);
    assert.equal(row.revoked_at, null);

    const state = await api(`/api/students/${child.json.studentId}`, { token: minted.json.token });
    assert.equal(state.status, 200);
  });

  test("revoke kills the token immediately; the row stays as lifecycle evidence", async () => {
    const parent = await consentedParent();
    const child = await createChild(parent, { nickname: "RevokeKid" });
    const minted = await mintSession(parent, child.json.studentId, `rev-device-${++seq}-w2`);
    const revoke = await api(`/api/parent/children/${child.json.studentId}/device-sessions/${minted.json.sessionId}`, {
      method: "DELETE",
      token: parent.token
    });
    assert.equal(revoke.status, 200, JSON.stringify(revoke.json));
    assert.ok(revoke.json.revokedAt);

    const refused = await api(`/api/students/${child.json.studentId}`, { token: minted.json.token });
    assert.equal(refused.status, 401);
    assert.equal(refused.json.type, "https://balashikshana.dev/problems/unauthorized");

    const row = (
      await db.query("SELECT revoked_at, revocation_reason FROM child_device_sessions WHERE session_id = $1", [
        minted.json.sessionId
      ])
    ).rows[0];
    assert.ok(row.revoked_at, "soft revoke keeps the evidence row");
    assert.equal(row.revocation_reason, "parent-revoked");
  });

  test("revoking one device's session leaves another device's working (device-scoped revocation)", async () => {
    const parent = await consentedParent();
    const child = await createChild(parent, { nickname: "TwoTablets" });
    const tablet = await mintSession(parent, child.json.studentId, `dev-a-${++seq}-tt`);
    const phone = await mintSession(parent, child.json.studentId, `dev-b-${++seq}-tt`);
    assert.equal(tablet.status, 201);
    assert.equal(phone.status, 201);
    assert.notEqual(tablet.json.deviceId, phone.json.deviceId, "each mint binds its own device row");

    await api(`/api/parent/children/${child.json.studentId}/device-sessions/${tablet.json.sessionId}`, {
      method: "DELETE",
      token: parent.token
    });

    const dead = await api(`/api/students/${child.json.studentId}`, { token: tablet.json.token });
    assert.equal(dead.status, 401);
    const alive = await api(`/api/students/${child.json.studentId}`, { token: phone.json.token });
    assert.equal(alive.status, 200);
  });

  test("an expired child token is refused (401) and lazily deleted", async () => {
    const parent = await consentedParent();
    const child = await createChild(parent, { nickname: "ExpiryKid" });
    const minted = await mintSession(parent, child.json.studentId, `exp-device-${++seq}-e3`);
    await db.query("UPDATE child_device_sessions SET expires_at = now() - interval '1 second' WHERE session_id = $1", [
      minted.json.sessionId
    ]);

    const refused = await api(`/api/students/${child.json.studentId}`, { token: minted.json.token });
    assert.equal(refused.status, 401);
    const gone = (
      await db.query("SELECT COUNT(*)::int AS n FROM child_device_sessions WHERE session_id = $1", [
        minted.json.sessionId
      ])
    ).rows[0].n;
    assert.equal(gone, 0, "expired rows are lazily deleted on lookup");
  });
});

describe("POST /api/parent/children/:studentId/archive", () => {
  test("archive flips both statuses, kills sessions, excludes from the listing, refuses mints", async () => {
    const parent = await consentedParent();
    const child = await createChild(parent, { nickname: "ArchivedKid" });
    const minted = await mintSession(parent, child.json.studentId, `arch-device-${++seq}-r4`);
    assert.equal(minted.status, 201);

    const listingBefore = await api("/api/students");
    assert.ok(listingBefore.json.students.some((s) => s.studentId === child.json.studentId));

    const res = await api(`/api/parent/children/${child.json.studentId}/archive`, {
      method: "POST",
      token: parent.token
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.status, "archived");
    assert.ok(res.json.archivedAt);

    const stu = (await db.query("SELECT status FROM students WHERE student_id = $1", [child.json.studentId])).rows[0];
    assert.equal(stu.status, "archived");
    const binding = (
      await db.query("SELECT status, archived_at FROM parent_children WHERE student_id = $1", [child.json.studentId])
    ).rows[0];
    assert.equal(binding.status, "archived");
    assert.ok(binding.archived_at, "archive timestamp evidences the event");

    const session = (
      await db.query("SELECT revoked_at, revocation_reason FROM child_device_sessions WHERE session_id = $1", [
        minted.json.sessionId
      ])
    ).rows[0];
    assert.ok(session.revoked_at);
    assert.equal(session.revocation_reason, "child-archived");

    const dead = await api(`/api/students/${child.json.studentId}`, { token: minted.json.token });
    assert.equal(dead.status, 401, "the live child token dies with the archive");

    const listingAfter = await api("/api/students");
    assert.ok(!listingAfter.json.students.some((s) => s.studentId === child.json.studentId));

    const mint = await mintSession(parent, child.json.studentId, `post-arch-${++seq}-p5`);
    assert.equal(mint.status, 409);
    assert.equal(mint.json.type, "https://balashikshana.dev/problems/child-archived");

    // PIN login for an archived child fails like an unknown student (401).
    const login = await api("/api/auth/login", {
      method: "POST",
      body: { username: child.json.username, pin: "5150" }
    });
    assert.equal(login.status, 401);

    // Archiving twice is a uniform 409.
    const again = await api(`/api/parent/children/${child.json.studentId}/archive`, {
      method: "POST",
      token: parent.token
    });
    assert.equal(again.status, 409);
  });
});

describe("problem+json and request correlation on every new route", () => {
  test("every error response is problem+json with X-Request-Id", async () => {
    const checks = await Promise.all([
      api("/api/parent/children"),
      api("/api/parent/children", { method: "POST", body: { pin: "0000", clientDeviceId: "12345678", platform: "ios" } }),
      api("/api/parent/children/claim", { method: "POST", body: { username: "x", pin: "0000" } })
    ]);
    for (const res of checks) {
      assert.ok(res.headers.get("x-request-id"), "X-Request-Id must be present");
      if (res.status >= 400) {
        assert.match(res.headers.get("content-type") || "", /application\/problem\+json/);
        assert.equal(typeof res.json.type, "string");
      }
    }
  });
});
