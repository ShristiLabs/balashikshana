// Security-deepening coverage for issue #42 (companion to
// children.test.mjs): the matrices the M2 capstone must hold —
// - token-kind confusion across all THREE kinds on every new route,
// - the consent gates extended to the new creation paths (unverified,
//   no-consent, stale-consent after a policy bump),
// - claim ANTI-HIJACK: uniform proof-of-knowledge refusals (no PIN oracle,
//   no archive-state oracle), exactly-once under a second claimant,
//   unclaimed-only eligibility, gated callers,
// - child-token scoping: one student only (cross-child 403), expiry,
//   immediate revocation, device-scoped revocation isolation,
// - the #41 invariant EXTENDED per the issue AC: creation, claim, and mint
//   paths all leave audit_students_without_consent at zero on a pristine
//   database.
//
// Same harness contract as the sibling suites: own throwaway database,
// own port, SEED_DEMO_STUDENTS=0 (pristine), rate limits maxed so limiters
// never mask assertions.

import { test, describe, beforeAll, afterAll, afterEach } from "vitest";
import assert from "node:assert/strict";
import { Client } from "pg";
import { createTestDatabase, dropTestDatabase, startTestServer, waitForHealth, createVerifiedParentWithConsent } from "./helpers.mjs";
import { hashPinScrypt } from "../db.mjs";

const API = "http://127.0.0.1:4801";

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
const P = "https://balashikshana.dev/problems";
let seq = 0;

// A verified parent WITHOUT consent capture (signup -> verify -> login).
async function verifiedParentWithoutConsent() {
  const email = `noclaim${++seq}@example.com`;
  const signup = await api("/api/parents/signup", { method: "POST", body: { email, password: PASSWORD } });
  assert.equal(signup.status, 201);
  const verify = await api("/api/parents/verify-email", {
    method: "POST",
    body: { token: signup.json.verificationToken }
  });
  assert.equal(verify.status, 200);
  const login = await api("/api/parents/login", { method: "POST", body: { email, password: PASSWORD } });
  assert.equal(login.status, 200);
  return { parentId: login.json.parent.parentId, token: login.json.token };
}

// An UNVERIFIED parent (signup only, then login).
async function unverifiedParent() {
  const email = `unver${++seq}@example.com`;
  const signup = await api("/api/parents/signup", { method: "POST", body: { email, password: PASSWORD } });
  assert.equal(signup.status, 201);
  const login = await api("/api/parents/login", { method: "POST", body: { email, password: PASSWORD } });
  assert.equal(login.status, 200);
  return { token: login.json.token };
}

// A legacy standalone student (migration-005 population shape).
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

async function consentedParent() {
  return createVerifiedParentWithConsent(API, { password: PASSWORD });
}

async function createChild(parent, overrides = {}) {
  const res = await api("/api/parent/children", {
    method: "POST",
    token: parent.token,
    body: {
      nickname: `Sec${++seq}`,
      pin: "5150",
      currentGrade: "kindergarten",
      clientDeviceId: `sec-device-${++seq}-xy`,
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

// A student session token (M1 kind) for confusion tests.
async function studentTokenFor(studentId, pin) {
  const res = await api("/api/auth/login", { method: "POST", body: { studentId, pin } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return res.json.token;
}

// The ops policy bump (consent-security.test.mjs contract); restored in
// afterEach.
async function bumpPolicy() {
  const version = `s2${++seq}`;
  await db.query("UPDATE consent_policy_versions SET active = false WHERE active");
  await db.query(
    "INSERT INTO consent_policy_versions (version, locale, policy_text, active) VALUES ($1, 'en-US', $2, true)",
    [version, `bumped security test policy ${version}`]
  );
  return version;
}

async function auditCount() {
  return (await db.query("SELECT COUNT(*)::int AS n FROM audit_students_without_consent")).rows[0].n;
}

async function counts() {
  return (
    await db.query(`
      SELECT
        (SELECT COUNT(*)::int FROM students) AS students,
        (SELECT COUNT(*)::int FROM parent_children) AS bindings,
        (SELECT COUNT(*)::int FROM consent_records) AS consent,
        (SELECT COUNT(*)::int FROM child_device_sessions) AS sessions
    `)
  ).rows[0];
}

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  serverProcess = await startTestServer({
    port: 4801,
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

afterEach(async () => {
  try {
    await db.query("UPDATE consent_policy_versions SET active = false WHERE version <> '2'");
    await db.query("UPDATE consent_policy_versions SET active = true WHERE version = '2' AND active = false");
  } catch {
    // never mask a test failure with cleanup noise
  }
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

describe("consent gates on the new creation paths", () => {
  test("create without any token -> 401", async () => {
    const res = await api("/api/parent/children", {
      method: "POST",
      body: { pin: "5150", clientDeviceId: "anon-device-01", platform: "ios" }
    });
    assert.equal(res.status, 401);
    assert.equal(res.json.type, `${P}/unauthorized`);
  });

  test("create with an unverified parent -> 403 email-verification-required", async () => {
    const parent = await unverifiedParent();
    const res = await api("/api/parent/children", {
      method: "POST",
      token: parent.token,
      body: { pin: "5150", clientDeviceId: "unverified-01", platform: "ios" }
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.type, `${P}/email-verification-required`);
  });

  test("create with a verified but unconsented parent -> 403 consent-required", async () => {
    const parent = await verifiedParentWithoutConsent();
    const before = await counts();
    const res = await api("/api/parent/children", {
      method: "POST",
      token: parent.token,
      body: { pin: "5150", clientDeviceId: "noconsent-01", platform: "ios" }
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.type, `${P}/consent-required`);
    assert.equal(res.json.currentPolicyVersion, "2");
    assert.deepEqual(await counts(), before, "a refused creation must write nothing");
  });

  test("stale consent after a policy bump refuses create AND claim, both with zero row delta", async () => {
    const parent = await consentedParent();
    const legacy = await insertLegacyStudent(`stale${++seq}`, "3131");
    const v2 = await bumpPolicy();
    const before = await counts();

    const create = await api("/api/parent/children", {
      method: "POST",
      token: parent.token,
      body: { pin: "5150", clientDeviceId: "stale-device-1", platform: "ios" }
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
    assert.equal(claim.json.type, `${P}/consent-required`);

    assert.deepEqual(await counts(), before, "stale-consent refusals must write nothing anywhere");
  });

  test("mint requires current-version consent for the student (bump blocks, re-consent restores)", async () => {
    const parent = await consentedParent();
    const child = await createChild(parent);
    const v2 = await bumpPolicy();

    const blocked = await api(`/api/parent/children/${child.studentId}/device-sessions`, {
      method: "POST",
      token: parent.token,
      body: { clientDeviceId: `mint-block-${++seq}`, platform: "ios" }
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.json.type, `${P}/consent-required`);
    assert.equal(blocked.json.currentPolicyVersion, v2);

    const recapture = await api("/api/consent/records", {
      method: "POST",
      token: parent.token,
      body: { policyVersion: v2 }
    });
    assert.equal(recapture.status, 201);

    const minted = await api(`/api/parent/children/${child.studentId}/device-sessions`, {
      method: "POST",
      token: parent.token,
      body: { clientDeviceId: `mint-ok-${++seq}`, platform: "ios" }
    });
    assert.equal(minted.status, 201, JSON.stringify(minted.json));
  });
});

describe("token-kind confusion across the three kinds", () => {
  test("student token on the children routes -> 403 wrong-token-type", async () => {
    const parent = await consentedParent();
    const child = await createChild(parent, { pin: "6161" });
    const studentToken = await studentTokenFor(child.studentId, "6161");

    const list = await api("/api/parent/children", { token: studentToken });
    assert.equal(list.status, 403);
    assert.equal(list.json.type, `${P}/wrong-token-type`);

    const create = await api("/api/parent/children", {
      method: "POST",
      token: studentToken,
      body: { pin: "5150", clientDeviceId: "confused-student", platform: "ios" }
    });
    assert.equal(create.status, 403);
    assert.equal(create.json.type, `${P}/wrong-token-type`);
  });

  test("child device token on parent routes -> 403 wrong-token-type (incl. register + consent)", async () => {
    const parent = await consentedParent();
    const child = await createChild(parent, { pin: "6262" });
    const minted = await mint(parent, child.studentId, `conf-${++seq}-dev`);

    const list = await api("/api/parent/children", { token: minted.token });
    assert.equal(list.status, 403);
    assert.equal(list.json.type, `${P}/wrong-token-type`);

    const create = await api("/api/students", {
      method: "POST",
      token: minted.token,
      body: { nickname: "Nope", pin: "5150" }
    });
    assert.equal(create.status, 403);
    assert.equal(create.json.type, `${P}/wrong-token-type`);

    const status = await api("/api/consent/status", { token: minted.token });
    assert.equal(status.status, 403);
    assert.equal(status.json.type, `${P}/wrong-token-type`);
  });

  test("parent token on student-scoped routes stays 403 wrong-token-type", async () => {
    const parent = await consentedParent();
    const child = await createChild(parent);
    const res = await api(`/api/students/${child.studentId}`, { token: parent.token });
    assert.equal(res.status, 403);
    assert.equal(res.json.type, `${P}/wrong-token-type`);
  });
});

describe("claim anti-hijack (the security core)", () => {
  test("unknown username, wrong PIN, and archived student fail with byte-identical problems", async () => {
    const parent = await consentedParent();
    const archived = await insertLegacyStudent(`archived${++seq}`, "3434");
    // Archive it via the legitimate flow: a second parent claims then archives.
    const claimer = await consentedParent();
    const claim = await api("/api/parent/children/claim", {
      method: "POST",
      token: claimer.token,
      body: { username: archived.username, pin: archived.pin }
    });
    assert.equal(claim.status, 201);
    const archive = await api(`/api/parent/children/${archived.studentId}/archive`, {
      method: "POST",
      token: claimer.token
    });
    assert.equal(archive.status, 200);

    const unknown = await api("/api/parent/children/claim", {
      method: "POST",
      token: parent.token,
      body: { username: `ghost${++seq}`, pin: "9999" }
    });
    const wrongPin = await api("/api/parent/children/claim", {
      method: "POST",
      token: parent.token,
      body: { username: archived.username, pin: "0000" }
    });
    const archivedAttempt = await api("/api/parent/children/claim", {
      method: "POST",
      token: parent.token,
      body: { username: archived.username, pin: archived.pin }
    });

    for (const res of [unknown, wrongPin, archivedAttempt]) {
      assert.equal(res.status, 403);
      assert.equal(res.json.type, `${P}/claim-rejected`);
    }
    // #66: requestId is the per-request correlation id (unique by
    // design); uniformity is over the enumerable problem fields.
    const strip = (b) => { const c = { ...b }; delete c.requestId; return JSON.stringify(c); };
    assert.equal(strip(unknown.json), strip(wrongPin.json));
    assert.equal(strip(unknown.json), strip(archivedAttempt.json));
  });

  test("exactly-once: a second parent claiming the same student is rejected 409 with no binding written", async () => {
    const legacy = await insertLegacyStudent(`race${++seq}`, "5656");
    const winner = await consentedParent();
    const loser = await consentedParent();

    const first = await api("/api/parent/children/claim", {
      method: "POST",
      token: winner.token,
      body: { username: legacy.username, pin: legacy.pin }
    });
    assert.equal(first.status, 201);

    const before = await counts();
    const second = await api("/api/parent/children/claim", {
      method: "POST",
      token: loser.token,
      body: { username: legacy.username, pin: legacy.pin }
    });
    assert.equal(second.status, 409);
    assert.equal(second.json.type, `${P}/already-claimed`);
    assert.deepEqual(await counts(), before, "the rejected claim must write nothing");

    const binding = (
      await db.query("SELECT parent_id FROM parent_children WHERE student_id = $1", [legacy.studentId])
    ).rows;
    assert.equal(binding.length, 1);
    assert.equal(binding[0].parent_id, winner.parentId);
  });

  test("the original owner's own child is not claimable by another parent (409, not steal)", async () => {
    const owner = await consentedParent();
    const child = await createChild(owner, { pin: "7575" });
    const attacker = await consentedParent();
    const res = await api("/api/parent/children/claim", {
      method: "POST",
      token: attacker.token,
      body: { username: child.username, pin: "7575" } // correct PIN, wrong parent
    });
    assert.equal(res.status, 409);
    assert.equal(res.json.type, `${P}/already-claimed`);
  });

  test("claim gates: unverified -> 403 email-verification-required; unconsented -> 403 consent-required; no token -> 401", async () => {
    const legacy = await insertLegacyStudent(`gated${++seq}`, "8585");
    const unverified = await unverifiedParent();
    const r1 = await api("/api/parent/children/claim", {
      method: "POST",
      token: unverified.token,
      body: { username: legacy.username, pin: legacy.pin }
    });
    assert.equal(r1.status, 403);
    assert.equal(r1.json.type, `${P}/email-verification-required`);

    const noConsent = await verifiedParentWithoutConsent();
    const r2 = await api("/api/parent/children/claim", {
      method: "POST",
      token: noConsent.token,
      body: { username: legacy.username, pin: legacy.pin }
    });
    assert.equal(r2.status, 403);
    assert.equal(r2.json.type, `${P}/consent-required`);

    const r3 = await api("/api/parent/children/claim", {
      method: "POST",
      body: { username: legacy.username, pin: legacy.pin }
    });
    assert.equal(r3.status, 401);

    const stu = (await db.query("SELECT status FROM students WHERE student_id = $1", [legacy.studentId])).rows[0];
    assert.equal(stu.status, "legacy", "a gated claim must leave the student untouched");
  });

  test("claim cannot be used as a consent-evidence oracle for someone else's studentId", async () => {
    // A successful claim writes consent evidence for the claiming parent; a
    // FAILED claim (all forms above) must never leave evidence behind.
    const legacy = await insertLegacyStudent(`oracle${++seq}`, "1616");
    const attacker = await consentedParent();
    await api("/api/parent/children/claim", {
      method: "POST",
      token: attacker.token,
      body: { username: legacy.username, pin: "0000" }
    });
    const evidence = (
      await db.query("SELECT COUNT(*)::int AS n FROM consent_records WHERE student_id = $1", [legacy.studentId])
    ).rows[0].n;
    assert.equal(evidence, 0, "a rejected claim must not fabricate consent evidence");
  });
});

describe("child-device token scoping", () => {
  test("a child token reaches ONLY its bound student (cross-child 403 forbidden)", async () => {
    const parent = await consentedParent();
    const childA = await createChild(parent, { nickname: "ScopeA" });
    const childB = await createChild(parent, { nickname: "ScopeB" });
    const minted = await mint(parent, childA.studentId, `scope-${++seq}-a`);

    const own = await api(`/api/students/${childA.studentId}`, { token: minted.token });
    assert.equal(own.status, 200);

    const cross = await api(`/api/students/${childB.studentId}`, { token: minted.token });
    assert.equal(cross.status, 403);
    assert.equal(cross.json.type, `${P}/forbidden`);

    const crossWrite = await api("/api/practice/topic/complete", {
      method: "POST",
      token: minted.token,
      body: {
        studentId: childB.studentId,
        unitId: "K-M2",
        topicCode: "I",
        responses: [{ questionId: "K-M2-I-Q1", chosenAnswer: "6", isCorrect: true, rawTimeSec: 2.5 }]
      }
    });
    assert.equal(crossWrite.status, 403);
    const attempts = (
      await db.query("SELECT COUNT(*)::int AS n FROM student_question_attempts WHERE student_id = $1", [
        childB.studentId
      ])
    ).rows[0].n;
    assert.equal(attempts, 0, "a cross-child write must persist nothing");
  });

  test("the token grants nothing on parent surfaces even with correct studentId in play", async () => {
    const parent = await consentedParent();
    const child = await createChild(parent);
    const minted = await mint(parent, child.studentId, `noscope-${++seq}-d`);
    const res = await api(`/api/parent/children/${child.studentId}/archive`, {
      method: "POST",
      token: minted.token
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.type, `${P}/wrong-token-type`);
  });
});

describe("consent invariant extended to the #42 paths (issue AC)", () => {
  // Order-independent form: sibling tests in this suite leave deliberate
  // unclaimed legacy rows in the shared suite database, so the invariant is
  // asserted RELATIVE to the pre-state: create adds zero unconsented rows,
  // an unclaimed legacy student is exactly one, claim returns it to zero
  // delta, mint adds none.
  test("create adds no unconsented row; legacy is +1; claim returns to delta 0; mint adds none", async () => {
    const before = await auditCount();
    const parent = await consentedParent();

    const created = await createChild(parent); // creation path
    assert.equal(await auditCount(), before, "creation path must add no unconsented student");

    const legacy = await insertLegacyStudent(`inv${++seq}`, "2626");
    assert.equal(await auditCount(), before + 1, "an unclaimed legacy student is exactly one unconsented row");

    const claim = await api("/api/parent/children/claim", {
      method: "POST",
      token: parent.token,
      body: { username: legacy.username, pin: legacy.pin }
    });
    assert.equal(claim.status, 201);
    assert.equal(await auditCount(), before, "claim path must return the audit view to its baseline");

    const minted = await mint(parent, created.studentId, `inv-${++seq}-m`); // mint path
    assert.ok(minted.token);
    assert.equal(await auditCount(), before, "mint path must add no unconsented student");
  });

  test("no route may create a standalone student: every non-legacy students row has a binding", async () => {
    const parent = await consentedParent();
    await createChild(parent);
    // The M1 register path also binds now (#42 change).
    const registered = await api("/api/students", {
      method: "POST",
      token: parent.token,
      body: { nickname: "BoundToo", username: `boundtoo${++seq}`, currentGrade: "kindergarten", pin: "5533" }
    });
    assert.equal(registered.status, 201, JSON.stringify(registered.json));

    // 'legacy' rows are the pre-#42 population (sibling tests create them
    // deliberately); any OTHER student without a binding would be a route
    // creating standalone students — the hole #42 closes.
    const standalone = (
      await db.query(`
        SELECT COUNT(*)::int AS n FROM students s
        WHERE s.status <> 'legacy'
          AND NOT EXISTS (SELECT 1 FROM parent_children pc WHERE pc.student_id = s.student_id)
      `)
    ).rows[0].n;
    assert.equal(standalone, 0, "every student created through any route is bound to a parent");
  });
});
