// Advanced/race coverage for issue #42 (companion to children.test.mjs and
// children-security.test.mjs): the seams the happy-path and adversarial
// suites do not pin down —
// - claim RACE semantics simulated at the DB seam: the students-row mutex
//   and the partial-unique-index backstop both firing THROUGH the route,
// - the archived state enforced on EVERY student-scoped route, including a
//   forged M1 session inserted directly after the archive (the route must
//   refuse on status, not on session absence),
// - one device shared by two siblings: single devices row, per-session
//   revoke isolation,
// - cross-kind replay: revoked/expired/unknown tokens on the new routes,
// - consent bump -> new-path refusals -> re-consent -> full restore,
// - schema edges: enum/pattern/length rejections, closed bodies.
//
// Same harness contract as the sibling suites: own throwaway database, own
// port, SEED_DEMO_STUDENTS=0, rate limits maxed.

import { test, describe, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { Client } from "pg";
import { createTestDatabase, dropTestDatabase, startTestServer, waitForHealth, createVerifiedParentWithConsent } from "./helpers.mjs";
import { hashPinScrypt } from "../db.mjs";

const API = "http://127.0.0.1:4802";
const P = "https://balashikshana.dev/problems";

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
  return { status: res.status, json };
}

const PASSWORD = "legitimate-password-1";
let seq = 0;

async function consentedParent() {
  return createVerifiedParentWithConsent(API, { password: PASSWORD });
}

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
  const res = await api("/api/parent/children", {
    method: "POST",
    token: parent.token,
    body: {
      nickname: `Adv${++seq}`,
      pin: "5150",
      currentGrade: "kindergarten",
      clientDeviceId: `adv-device-${++seq}-xy`,
      platform: "ios",
      ...overrides
    }
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

async function mint(parent, studentId, clientDeviceId) {
  const res = await api(`/api/parent/children/${studentId}/device-sessions`, {
    method: "POST",
    token: parent.token,
    body: { clientDeviceId, platform: "ios" }
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

async function bindingCount() {
  return (await db.query("SELECT COUNT(*)::int AS n FROM parent_children")).rows[0].n;
}

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  serverProcess = await startTestServer({
    port: 4802,
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

describe("claim race semantics at the DB seam", () => {
  test("mutex: a status flip landing between PIN check and claim makes the loser 409 with zero writes", async () => {
    // Simulates the race window: the claimant's PIN verifies against a
    // legacy row, but the row is claimed (flipped to active) before the
    // claim transaction's mutex UPDATE runs. The mutex sees a non-legacy
    // row, returns rowCount 0, and the route answers 409 already-claimed.
    const legacy = await insertLegacyStudent(`mutex${++seq}`, "4747");
    const winner = await consentedParent();
    const claim = await api("/api/parent/children/claim", {
      method: "POST",
      token: winner.token,
      body: { username: legacy.username, pin: legacy.pin }
    });
    assert.equal(claim.status, 201);

    const loser = await consentedParent();
    // The loser's request would re-verify the PIN (it is unchanged by the
    // claim); the mutex inside the txn is what must reject it.
    const before = await bindingCount();
    const res = await api("/api/parent/children/claim", {
      method: "POST",
      token: loser.token,
      body: { username: legacy.username, pin: legacy.pin }
    });
    assert.equal(res.status, 409);
    assert.equal(res.json.type, `${P}/already-claimed`);
    assert.equal(await bindingCount(), before, "the lost race must write no binding");
  });

  test("partial-unique backstop: even with students.status forced back to legacy, a second 'claimed' binding is refused", async () => {
    // Defense in depth: if the mutex were ever bypassed (status forcibly
    // reset to 'legacy' after a claim), the partial unique index on
    // parent_children(student_id) WHERE status='claimed' still blocks the
    // second claimant's insert; the route maps 23505 to 409.
    const legacy = await insertLegacyStudent(`backstop${++seq}`, "3737");
    const winner = await consentedParent();
    const claim = await api("/api/parent/children/claim", {
      method: "POST",
      token: winner.token,
      body: { username: legacy.username, pin: legacy.pin }
    });
    assert.equal(claim.status, 201);

    // Force the race-bypass precondition: row looks legacy again, but the
    // winner's 'claimed' binding still exists.
    await db.query("UPDATE students SET status = 'legacy' WHERE student_id = $1", [legacy.studentId]);

    const loser = await consentedParent();
    const res = await api("/api/parent/children/claim", {
      method: "POST",
      token: loser.token,
      body: { username: legacy.username, pin: legacy.pin }
    });
    assert.equal(res.status, 409);
    assert.equal(res.json.type, `${P}/already-claimed`);
    const bindings = (
      await db.query("SELECT parent_id FROM parent_children WHERE student_id = $1", [legacy.studentId])
    ).rows;
    assert.equal(bindings.length, 1, "the index backstop must keep exactly one binding");
    assert.equal(bindings[0].parent_id, winner.parentId);
    // The aborted transaction rolled the loser's OWN flip back: the row
    // keeps the forced 'legacy' precondition exactly as it was, with none
    // of the loser's partial writes surviving.
    const stu = (await db.query("SELECT status FROM students WHERE student_id = $1", [legacy.studentId])).rows[0];
    assert.equal(stu.status, "legacy", "the aborted claim transaction must leave no partial state");
  });
});

describe("archived state enforced on every student-scoped route", () => {
  test("all four student routes refuse an archived child, including via a forged M1 session", async () => {
    const parent = await consentedParent();
    const child = await createChild(parent, { nickname: "Frozen" });
    const archive = await api(`/api/parent/children/${child.studentId}/archive`, {
      method: "POST",
      token: parent.token
    });
    assert.equal(archive.status, 200);

    // Forge an M1 student session DIRECTLY (post-archive, bypassing the
    // login route's archived rejection and the archive txn's delete): the
    // per-request archived check in requireStudentAccess must refuse it.
    await db.query(
      `INSERT INTO student_sessions (token, student_id, created_at, expires_at)
       VALUES ('forged-archived-session-token', $1, now(), now() + interval '1 day')`,
      [child.studentId]
    );

    const forged = { token: "forged-archived-session-token" };
    const probes = [
      api(`/api/students/${child.studentId}`, { token: forged.token }),
      api(`/api/students/${child.studentId}/calibrate`, {
        method: "POST",
        token: forged.token,
        body: { motorBaselineSec: 0.4 }
      }),
      api("/api/practice/topic/complete", {
        method: "POST",
        token: forged.token,
        body: { studentId: child.studentId, unitId: "K-M2", topicCode: "I", responses: [] }
      }),
      api("/api/gate/evaluate", {
        method: "POST",
        token: forged.token,
        body: { studentId: child.studentId, unitId: "PK-M1", responses: [] }
      })
    ];
    const results = await Promise.all(probes);
    for (const res of results) {
      assert.equal(res.status, 403, JSON.stringify(res.json));
      assert.equal(res.json.type, `${P}/child-archived`);
    }
    const attempts = (
      await db.query("SELECT COUNT(*)::int AS n FROM student_question_attempts WHERE student_id = $1", [
        child.studentId
      ])
    ).rows[0].n;
    assert.equal(attempts, 0, "an archived child must never accumulate new child data");
  });
});

describe("one device, two siblings (device sharing)", () => {
  test("a shared clientDeviceId yields one devices row and per-session revocation isolation", async () => {
    const parent = await consentedParent();
    const kidA = await createChild(parent, { nickname: "SharedA" });
    const kidB = await createChild(parent, { nickname: "SharedB" });
    const clientDeviceId = `family-tablet-${++seq}-zz`;

    const forA = await mint(parent, kidA.studentId, clientDeviceId);
    const forB = await mint(parent, kidB.studentId, clientDeviceId);

    const devices = (
      await db.query("SELECT * FROM devices WHERE parent_id = $1 AND client_device_id = $2", [
        parent.parentId,
        clientDeviceId
      ])
    ).rows;
    assert.equal(devices.length, 1, "one devices row for the shared tablet");
    assert.equal(forA.deviceId, devices[0].device_id);
    assert.equal(forB.deviceId, devices[0].device_id);

    // Both sessions live on the same device row but are independent.
    const okA = await api(`/api/students/${kidA.studentId}`, { token: forA.token });
    const okB = await api(`/api/students/${kidB.studentId}`, { token: forB.token });
    assert.equal(okA.status, 200);
    assert.equal(okB.status, 200);

    // Revoking sibling A's session does not disturb sibling B.
    await api(`/api/parent/children/${kidA.studentId}/device-sessions/${forA.sessionId}`, {
      method: "DELETE",
      token: parent.token
    });
    const deadA = await api(`/api/students/${kidA.studentId}`, { token: forA.token });
    const aliveB = await api(`/api/students/${kidB.studentId}`, { token: forB.token });
    assert.equal(deadA.status, 401);
    assert.equal(aliveB.status, 200);

    // Cross-sibling use is refused even on the shared device.
    const crossUse = await api(`/api/students/${kidA.studentId}`, { token: forB.token });
    assert.equal(crossUse.status, 403);
  });
});

describe("cross-kind token replay on the new routes", () => {
  test("a REVOKED parent session token is 401 on every children route", async () => {
    const parent = await consentedParent();
    const login = await api("/api/parents/login", { method: "POST", body: { email: parent.email, password: PASSWORD } });
    assert.equal(login.status, 200);
    const oldToken = login.json.token;
    // Rotate via refresh: revokes the presented session token.
    const refresh = await api("/api/parents/refresh", { method: "POST", token: oldToken });
    assert.equal(refresh.status, 200);

    const child = await createChild(parent);
    const probes = await Promise.all([
      api("/api/parent/children", { token: oldToken }),
      api("/api/parent/children", { method: "POST", token: oldToken, body: { pin: "5150", clientDeviceId: "replay-0001", platform: "ios" } }),
      api("/api/parent/children/claim", { method: "POST", token: oldToken, body: { username: "x", pin: "0000" } }),
      api(`/api/parent/children/${child.studentId}/archive`, { method: "POST", token: oldToken }),
      api(`/api/parent/children/${child.studentId}/device-sessions`, { method: "POST", token: oldToken, body: { clientDeviceId: "replay-0002", platform: "web" } })
    ]);
    for (const res of probes) {
      assert.equal(res.status, 401, JSON.stringify(res.json));
      assert.equal(res.json.type, `${P}/unauthorized`);
      assert.equal(res.json.detail, "Session token is invalid or has been revoked");
    }
  });

  test("an EXPIRED child token is 401 'Session token has expired' and unknown tokens are uniform 401", async () => {
    const parent = await consentedParent();
    const child = await createChild(parent);
    const minted = await mint(parent, child.studentId, `expired-${++seq}-q`);
    await db.query("UPDATE child_device_sessions SET expires_at = now() - interval '1 second' WHERE session_id = $1", [
      minted.sessionId
    ]);

    const expired = await api(`/api/students/${child.studentId}`, { token: minted.token });
    assert.equal(expired.status, 401);
    assert.equal(expired.json.detail, "Session token has expired");

    const unknown = await api(`/api/students/${child.studentId}`, { token: "c2VjdXJpdHktdGVzdC1ub3RhdG9rZW4" });
    assert.equal(unknown.status, 401);
    assert.equal(unknown.json.type, `${P}/unauthorized`);
  });
});

describe("consent bump end-to-end on the new paths (refuse then restore)", () => {
  test("bump -> create/claim/mint all 403 with currentPolicyVersion; re-consent -> all succeed", async () => {
    const parent = await consentedParent();
    const legacy = await insertLegacyStudent(`bumpadv${++seq}`, "2929");
    const child = await createChild(parent); // pre-bump baseline

    const v2 = `adv${++seq}`;
    await db.query("UPDATE consent_policy_versions SET active = false WHERE active");
    await db.query(
      "INSERT INTO consent_policy_versions (version, locale, policy_text, active) VALUES ($1, 'en-US', $2, true)",
      [v2, `advanced bump ${v2}`]
    );

    const create = await api("/api/parent/children", {
      method: "POST",
      token: parent.token,
      body: { pin: "5150", clientDeviceId: `bump-adv-${++seq}`, platform: "ios" }
    });
    assert.equal(create.status, 403);
    assert.equal(create.json.type, `${P}/consent-required`);
    assert.equal(create.json.currentPolicyVersion, v2);

    const claim = await api("/api/parent/children/claim", {
      method: "POST",
      token: parent.token,
      body: { username: legacy.username, pin: legacy.pin }
    });
    assert.equal(claim.status, 403);
    assert.equal(claim.json.currentPolicyVersion, v2);

    const mintBlocked = await api(`/api/parent/children/${child.studentId}/device-sessions`, {
      method: "POST",
      token: parent.token,
      body: { clientDeviceId: `bump-mint-${++seq}`, platform: "ios" }
    });
    assert.equal(mintBlocked.status, 403);
    assert.equal(mintBlocked.json.currentPolicyVersion, v2);

    // Re-consent restores ALL three paths in one sweep.
    const recapture = await api("/api/consent/records", {
      method: "POST",
      token: parent.token,
      body: { policyVersion: v2 }
    });
    assert.equal(recapture.status, 201);

    const create2 = await api("/api/parent/children", {
      method: "POST",
      token: parent.token,
      body: { pin: "5150", clientDeviceId: `bump-adv2-${++seq}`, platform: "ios" }
    });
    assert.equal(create2.status, 201, JSON.stringify(create2.json));
    const claim2 = await api("/api/parent/children/claim", {
      method: "POST",
      token: parent.token,
      body: { username: legacy.username, pin: legacy.pin }
    });
    assert.equal(claim2.status, 201, JSON.stringify(claim2.json));
    const mint2 = await api(`/api/parent/children/${child.studentId}/device-sessions`, {
      method: "POST",
      token: parent.token,
      body: { clientDeviceId: `bump-mint2-${++seq}`, platform: "ios" }
    });
    assert.equal(mint2.status, 201, JSON.stringify(mint2.json));
  });
});

describe("schema edges on the new bodies (closed schemas, enums, patterns)", () => {
  test("invalid platform, short clientDeviceId, bad PIN, extra fields, bad relation -> 400 validation", async () => {
    const parent = await consentedParent();
    const bases = [
      { pin: "5150", clientDeviceId: "valid-length-1", platform: "blackberry" },
      { pin: "5150", clientDeviceId: "short", platform: "ios" },
      { pin: "ABCD", clientDeviceId: "valid-length-2", platform: "ios" },
      { pin: "5150", clientDeviceId: "valid-length-3", platform: "ios", extra: true },
      { pin: "5150", clientDeviceId: "valid-length-4", platform: "ios", relation: "" }
    ];
    for (const body of bases) {
      const res = await api("/api/parent/children", { method: "POST", token: parent.token, body });
      assert.equal(res.status, 400, JSON.stringify(res.json));
      assert.equal(res.json.title, "Validation failed");
    }
    const claimExtras = await api("/api/parent/children/claim", {
      method: "POST",
      token: parent.token,
      body: { username: "someone", pin: "0000", method: "signup-form" }
    });
    assert.equal(claimExtras.status, 400);
    const mintExtras = await api(`/api/parent/children/x/device-sessions`, {
      method: "POST",
      token: parent.token,
      body: { clientDeviceId: "valid-length-5", platform: "ios", token: "injected" }
    });
    assert.equal(mintExtras.status, 400);
  });
});
