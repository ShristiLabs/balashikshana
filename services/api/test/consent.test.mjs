// Verifiable parental consent coverage for issue #41: the policy catalog
// (versioned, single-active), timestamped append-only capture, the
// consent-required middleware on every child-data-creating route
// (POST /api/students, POST /api/practice/topic/complete,
// POST /api/gate/evaluate), re-consent on policy bump, and the ROADMAP M2
// VERIFICATION ITEM: the invariant that no child-data row exists without a
// matching consent record (audit_students_without_consent reports zero on a
// pristine DB after exercising every gated route).
//
// This suite boots its server with SEED_DEMO_STUDENTS=0: the demo students
// are dev data without consent rows by design (their path is #42's
// claim-or-archive), so a pristine database lets the invariant assert the
// literal "zero rows" the issue requires.

import { test, describe, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { Client } from "pg";
import { createTestDatabase, dropTestDatabase, startTestServer, waitForHealth } from "./helpers.mjs";
import { hashPinScrypt } from "../db.mjs";

const API = "http://127.0.0.1:4791";

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
const uniqueEmail = () => `consent${++seq}@example.com`;

// signup -> verify-email (dev seam) -> login. No consent captured yet.
async function createVerifiedParent() {
  const email = uniqueEmail();
  const signup = await api("/api/parents/signup", { method: "POST", body: { email, password: PASSWORD } });
  assert.equal(signup.status, 201, JSON.stringify(signup.json));
  const verify = await api("/api/parents/verify-email", { method: "POST", body: { token: signup.json.verificationToken } });
  assert.equal(verify.status, 200, JSON.stringify(verify.json));
  const login = await api("/api/parents/login", { method: "POST", body: { email, password: PASSWORD } });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  return { email, parentId: login.json.parent.parentId, token: login.json.token };
}

async function captureConsent(token, policyVersion, extra = {}) {
  return api("/api/consent/records", { method: "POST", token, body: { policyVersion, ...extra } });
}

async function activePolicyVersion() {
  return (await db.query("SELECT version FROM consent_policy_versions WHERE active = true")).rows[0].version;
}

async function counts() {
  return (
    await db.query(`
      SELECT
        (SELECT COUNT(*)::int FROM students) AS students,
        (SELECT COUNT(*)::int FROM consent_records) AS consent,
        (SELECT COUNT(*)::int FROM student_question_attempts) AS attempts,
        (SELECT COUNT(*)::int FROM student_topic_progress) AS topic_progress,
        (SELECT COUNT(*)::int FROM student_unit_progress) AS unit_progress
    `)
  ).rows[0];
}

// Register a student through the GATED route (verified parent + current
// consent). Returns the 201 body plus the consented parent for reuse.
async function registerGatedStudent(parent, payload = {}) {
  const res = await api("/api/students", {
    method: "POST",
    token: parent.token,
    body: { nickname: "Consented", username: `consented${++seq}`, currentGrade: "kindergarten", pin: "5150", ...payload }
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return res.json;
}

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  serverProcess = await startTestServer({
    port: 4791,
    databaseUrl: testDatabase.url,
    env: {
      RATE_LIMIT_PER_IP_MIN: "1000",
      RATE_LIMIT_PER_TOKEN_MIN: "1000",
      RATE_LIMIT_LOGIN_PER_IP_MIN: "1000",
      RATE_LIMIT_PARENT_SIGNUP_PER_IP_MIN: "1000",
      RATE_LIMIT_PARENT_LOGIN_PER_IP_MIN: "1000",
      RATE_LIMIT_PARENT_TOKEN_PER_IP_MIN: "1000",
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

describe("pristine database posture", () => {
  test("SEED_DEMO_STUDENTS=0 leaves zero students — the invariant starts from zero", async () => {
    const c = await counts();
    assert.equal(c.students, 0, "demo students must be absent so the invariant can assert zero");
    assert.equal(c.consent, 0);
  });
});

describe("GET /api/consent/policy/latest (public)", () => {
  test("returns the active v2 production consent statement (migration 014)", async () => {
    const res = await api("/api/consent/policy/latest");
    assert.equal(res.status, 200);
    assert.equal(res.json.version, "2");
    assert.equal(res.json.locale, "en-US");
    assert.equal(res.json.active, true);
    // The v2 statement is the real consent text (draft banner, references
    // the legal pack) — the NON-LEGAL placeholder era ended with #68.
    assert.match(res.json.policyText, /DRAFT/i);
    assert.match(res.json.policyText, /Privacy Policy and Terms of Service/);
    assert.doesNotMatch(res.json.policyText, /NOT LEGAL ADVICE/);
    assert.ok(res.json.createdAt);
  });

  test("with no active policy the route fails closed with 404 (restored after)", async () => {
    await db.query("UPDATE consent_policy_versions SET active = false WHERE active");
    const res = await api("/api/consent/policy/latest");
    assert.equal(res.status, 404);
    await db.query("UPDATE consent_policy_versions SET active = true WHERE version = '2'");
    const back = await api("/api/consent/policy/latest");
    assert.equal(back.status, 200);
  });
});

describe("POST /api/consent/records (capture)", () => {
  test("no token -> 401; no row written", async () => {
    const before = (await counts()).consent;
    const res = await captureConsent(null, "2");
    assert.equal(res.status, 401);
    assert.equal((await counts()).consent, before);
  });

  test("student token -> 403 wrong-token-type; no row written", async () => {
    const parent = await createVerifiedParent();
    await captureConsent(parent.token, "2");
    const student = await registerGatedStudent(parent, { username: `capkind${++seq}`, nickname: "CapKind" });
    const before = (await counts()).consent;
    const res = await captureConsent(student.token, "2");
    assert.equal(res.status, 403);
    assert.equal(res.json.type, "https://balashikshana.dev/problems/wrong-token-type");
    assert.equal((await counts()).consent, before);
  });

  test("unverified parent -> 403 email-verification-required; no row written", async () => {
    const email = uniqueEmail();
    const signup = await api("/api/parents/signup", { method: "POST", body: { email, password: PASSWORD } });
    assert.equal(signup.status, 201);
    const login = await api("/api/parents/login", { method: "POST", body: { email, password: PASSWORD } });
    assert.equal(login.status, 200);
    assert.equal(login.json.parent.emailVerified, false);

    const before = (await counts()).consent;
    const res = await captureConsent(login.json.token, "2");
    assert.equal(res.status, 403);
    assert.equal(res.json.type, "https://balashikshana.dev/problems/email-verification-required");
    assert.match(res.headers.get("content-type") || "", /application\/problem\+json/);
    assert.equal((await counts()).consent, before, "unverified capture must write nothing");
  });

  test("verified parent, stale/unknown policyVersion -> 409 policy-version-mismatch with currentPolicyVersion; no row", async () => {
    const parent = await createVerifiedParent();
    const before = (await counts()).consent;
    const res = await captureConsent(parent.token, "999");
    assert.equal(res.status, 409);
    assert.equal(res.json.type, "https://balashikshana.dev/problems/policy-version-mismatch");
    assert.equal(res.json.currentPolicyVersion, "2");
    assert.equal((await counts()).consent, before);
  });

  test("first capture -> 201, server-stamped timestamps, method signup-form, append-only row", async () => {
    const parent = await createVerifiedParent();
    const beforeCapture = Date.now() - 5000;
    const res = await captureConsent(parent.token, "2");
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.match(res.json.consentId, /^con-/);
    assert.equal(res.json.parentId, parent.parentId);
    assert.equal(res.json.studentId, null);
    assert.equal(res.json.policyVersion, "2");
    assert.equal(res.json.method, "signup-form");
    assert.ok(new Date(res.json.capturedAt).getTime() >= beforeCapture, "capturedAt must be server-stamped now()");

    const row = (await db.query("SELECT * FROM consent_records WHERE consent_id = $1", [res.json.consentId])).rows[0];
    assert.ok(row, "row must be persisted");
    assert.equal(row.method, "signup-form");
    assert.ok(row.captured_at, "captured_at DEFAULT now() must be set server-side");
  });

  test("client cannot assert a method, timestamp, or extra fields (closed schema 400)", async () => {
    const parent = await createVerifiedParent();
    for (const extra of [{ method: "carrier-pigeon" }, { capturedAt: "2020-01-01T00:00:00Z" }, { bogus: true }]) {
      const res = await captureConsent(parent.token, "2", extra);
      assert.equal(res.status, 400, `extra fields must be rejected: ${JSON.stringify(extra)}`);
      assert.equal(res.json.title, "Validation failed");
    }
  });

  test("second capture by the same parent is derived as re-consent", async () => {
    const parent = await createVerifiedParent();
    const first = await captureConsent(parent.token, "2");
    assert.equal(first.json.method, "signup-form");
    const second = await captureConsent(parent.token, "2");
    assert.equal(second.status, 201);
    assert.equal(second.json.method, "re-consent");
    // Append-only: the first row is untouched by the second capture.
    const rows = (await db.query("SELECT policy_version, method, captured_at FROM consent_records WHERE parent_id = $1 ORDER BY captured_at ASC", [parent.parentId])).rows;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].method, "signup-form");
    assert.equal(rows[1].method, "re-consent");
  });

  test("studentId without a parent_children binding -> 403 no-child-binding; with a binding -> 201 naming the student", async () => {
    const parent = await createVerifiedParent();
    await captureConsent(parent.token, "2");
    const student = await registerGatedStudent(parent, { username: `bound${++seq}`, nickname: "Bound" });

    // Since #42, registration itself writes the binding, so an UNBOUND
    // student only exists as pre-#42 dev data: insert one directly (the
    // migration-005 legacy shape) for the refusal case.
    const unboundId = `stu-unbound-${++seq}`;
    await db.query(
      `INSERT INTO students (student_id, username, pin_hash, nickname, avatar, age_years, current_grade, last_active_at, created_at, status)
       VALUES ($1, $2, $3, 'Unbound', 'fox', 6, 'kindergarten', now(), now(), 'legacy')`,
      [unboundId, `unbound${unboundId}`, hashPinScrypt("4848")]
    );
    const refused = await captureConsent(parent.token, "2", { studentId: unboundId });
    assert.equal(refused.status, 403);
    assert.equal(refused.json.type, "https://balashikshana.dev/problems/no-child-binding");
    // The unbound row is test scaffolding, not a route-created student:
    // remove it so the suite-end invariant check stays meaningful.
    await db.query("DELETE FROM students WHERE student_id = $1", [unboundId]);

    // The #42 reality: the gated student carries its creation-time binding,
    // so the same parent can scope consent to it without any manual row.
    const binding = (
      await db.query("SELECT 1 FROM parent_children WHERE parent_id = $1 AND student_id = $2", [
        parent.parentId,
        student.student.studentId
      ])
    ).rows[0];
    assert.ok(binding, "registration must write the parent_children binding since #42");
    const ok = await captureConsent(parent.token, "2", { studentId: student.student.studentId });
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    assert.equal(ok.json.studentId, student.student.studentId);
    const row = (await db.query("SELECT student_id FROM consent_records WHERE consent_id = $1", [ok.json.consentId])).rows[0];
    assert.equal(row.student_id, student.student.studentId);
  });
});

describe("GET /api/consent/status", () => {
  test("no token -> 401", async () => {
    const res = await api("/api/consent/status");
    assert.equal(res.status, 401);
  });

  test("fresh verified parent: no consent yet, not current", async () => {
    const parent = await createVerifiedParent();
    const res = await api("/api/consent/status", { token: parent.token });
    assert.equal(res.status, 200);
    assert.equal(res.json.currentPolicyVersion, "2");
    assert.equal(res.json.consentCurrent, false);
    assert.equal(res.json.latestConsent, null);
  });

  test("after capture: current true with the latest row surfaced", async () => {
    const parent = await createVerifiedParent();
    await captureConsent(parent.token, "2");
    const res = await api("/api/consent/status", { token: parent.token });
    assert.equal(res.status, 200);
    assert.equal(res.json.consentCurrent, true);
    assert.equal(res.json.latestConsent.policyVersion, "2");
    assert.equal(res.json.latestConsent.studentId, null);
  });
});

describe("consent-required middleware: POST /api/students", () => {
  test("no token -> 401; nothing written", async () => {
    const before = await counts();
    const res = await api("/api/students", {
      method: "POST",
      body: { nickname: "NoToken", username: "notoken", currentGrade: "kindergarten", pin: "5150" }
    });
    assert.equal(res.status, 401);
    assert.deepEqual(await counts(), before, "no student, no consent, no progress rows");
  });

  test("verified parent WITHOUT consent -> 403 consent-required naming the version; nothing written", async () => {
    const parent = await createVerifiedParent();
    const before = await counts();
    const res = await api("/api/students", {
      method: "POST",
      token: parent.token,
      body: { nickname: "NoConsent", username: "noconsent", currentGrade: "kindergarten", pin: "5150" }
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.type, "https://balashikshana.dev/problems/consent-required");
    assert.equal(res.json.currentPolicyVersion, "2");
    assert.match(res.headers.get("content-type") || "", /application\/problem\+json/);
    assert.deepEqual(await counts(), before, "a refused creation must write nothing");
  });

  test("consented parent -> 201 and the student-scoped binding consent row exists", async () => {
    const parent = await createVerifiedParent();
    await captureConsent(parent.token, "2");
    const created = await registerGatedStudent(parent);
    const binding = (
      await db.query("SELECT * FROM consent_records WHERE student_id = $1", [created.student.studentId])
    ).rows[0];
    assert.ok(binding, "creation must insert the student-scoped binding consent row");
    assert.equal(binding.parent_id, parent.parentId);
    assert.equal(binding.policy_version, "2");
    assert.ok(binding.captured_at, "binding row timestamps are server-side");
    // The 201 contract is unchanged: a student session token is issued.
    assert.ok(created.token);
    assert.ok(created.student.studentId);
  });
});

describe("consent-required middleware: progress routes", () => {
  let consented;
  let consentedParent;

  beforeAll(async () => {
    consentedParent = await createVerifiedParent();
    const res = await captureConsent(consentedParent.token, "2");
    assert.equal(res.status, 201, JSON.stringify(res.json));
    consented = await registerGatedStudent(consentedParent, { username: `progress${++seq}`, nickname: "Progress" });
  });

  test("happy path: practice/complete and gate/evaluate succeed for the consented student", async () => {
    const practice = await api("/api/practice/topic/complete", {
      method: "POST",
      token: consented.token,
      body: {
        studentId: consented.student.studentId,
        unitId: "K-M2",
        topicCode: "I",
        motorBaselineSec: 0.4,
        responses: [{ questionId: "K-M2-I-Q1", chosenAnswer: "6", isCorrect: true, rawTimeSec: 2.5 }]
      }
    });
    assert.equal(practice.status, 200, JSON.stringify(practice.json));

    const gate = await api("/api/gate/evaluate", {
      method: "POST",
      token: consented.token,
      body: { studentId: consented.student.studentId, unitId: "PK-M1", motorBaselineSec: 0.42, responses: [] }
    });
    assert.equal(gate.status, 200, JSON.stringify(gate.json));
    assert.equal(gate.json.evaluation.passed, false, "empty responses: a failed gate, not an error");
  });

  test("legacy student (no consent row) authenticates but is refused on both write routes with zero writes", async () => {
    // Simulated pre-gate dev data: direct row insert, no consent evidence.
    const studentId = `stu-legacy-${++seq}`;
    await db.query(
      `INSERT INTO students (student_id, username, pin_hash, nickname, avatar, age_years, current_grade, last_active_at, created_at)
       VALUES ($1, $2, $3, 'Legacy', 'fox', 6, 'kindergarten', now(), now())`,
      [studentId, `legacy${studentId}`, hashPinScrypt("7777")]
    );
    const login = await api("/api/auth/login", { method: "POST", body: { studentId, pin: "7777" } });
    assert.equal(login.status, 200, "student login itself is not gated");

    const before = await counts();
    const practice = await api("/api/practice/topic/complete", {
      method: "POST",
      token: login.json.token,
      body: {
        studentId,
        unitId: "K-M2",
        topicCode: "I",
        responses: [{ questionId: "K-M2-I-Q1", chosenAnswer: "6", isCorrect: true, rawTimeSec: 2.5 }]
      }
    });
    assert.equal(practice.status, 403);
    assert.equal(practice.json.type, "https://balashikshana.dev/problems/consent-required");
    assert.equal(practice.json.currentPolicyVersion, "2");

    const gate = await api("/api/gate/evaluate", {
      method: "POST",
      token: login.json.token,
      body: { studentId, unitId: "PK-M1", responses: [] }
    });
    assert.equal(gate.status, 403);
    assert.equal(gate.json.type, "https://balashikshana.dev/problems/consent-required");

    assert.deepEqual(await counts(), before, "refused progress writes must leave no rows");

    // Dev-data cleanup in the documented #62 order (evidence, then rows):
    // this row was direct DB insertion simulating PRE-gate data, never a
    // route write — removing it keeps the final invariant assertion literal
    // (the routes alone must account for every student row).
    await db.query("DELETE FROM student_sessions WHERE student_id = $1", [studentId]);
    await db.query("DELETE FROM students WHERE student_id = $1", [studentId]);
  });

  test("no token -> 401 (auth precedes the consent check)", async () => {
    const res = await api("/api/practice/topic/complete", {
      method: "POST",
      body: { studentId: "stu-whatever", unitId: "K-M2", topicCode: "I", responses: [] }
    });
    assert.equal(res.status, 401);
  });

  test("parent token on a student write route -> 403 wrong-token-type (kind check precedes consent)", async () => {
    const res = await api("/api/practice/topic/complete", {
      method: "POST",
      token: consentedParent.token,
      body: {
        studentId: consented.student.studentId,
        unitId: "K-M2",
        topicCode: "I",
        responses: []
      }
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.type, "https://balashikshana.dev/problems/wrong-token-type");
  });

  test("student token on POST /api/students -> 403 wrong-token-type (creation is a parent surface)", async () => {
    const res = await api("/api/students", {
      method: "POST",
      token: consented.token,
      body: { nickname: "TokenKind", username: "tokenkind", currentGrade: "kindergarten", pin: "5150" }
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.type, "https://balashikshana.dev/problems/wrong-token-type");
  });

  test("unverified parent on POST /api/students -> 403 email-verification-required; nothing written", async () => {
    const email = uniqueEmail();
    const signup = await api("/api/parents/signup", { method: "POST", body: { email, password: PASSWORD } });
    assert.equal(signup.status, 201);
    const login = await api("/api/parents/login", { method: "POST", body: { email, password: PASSWORD } });
    assert.equal(login.status, 200);
    const before = await counts();
    const res = await api("/api/students", {
      method: "POST",
      token: login.json.token,
      body: { nickname: "Unverified", username: "unverified", currentGrade: "kindergarten", pin: "5150" }
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.type, "https://balashikshana.dev/problems/email-verification-required");
    assert.deepEqual(await counts(), before);
  });
});

describe("re-consent on policy bump (end to end)", () => {
  test("bump -> stale consent fails everywhere -> re-consent restores access", async () => {
    // Parent consents at v1 and creates a child.
    const parent = await createVerifiedParent();
    await captureConsent(parent.token, "2");
    const child = await registerGatedStudent(parent, { username: `reconsent${++seq}`, nickname: "ReConsent" });

    const practiceOk = await api("/api/practice/topic/complete", {
      method: "POST",
      token: child.token,
      body: {
        studentId: child.student.studentId,
        unitId: "K-M2",
        topicCode: "I",
        responses: [{ questionId: "K-M2-I-Q1", chosenAnswer: "6", isCorrect: true, rawTimeSec: 2.5 }]
      }
    });
    assert.equal(practiceOk.status, 200, JSON.stringify(practiceOk.json));

    // --- The bump: flip v2 inactive, insert v3 active (ops flow, direct).
    // (Baseline moved to v2 by migration 014 — the production consent
    // statement — so this test bumps to v3.)
    await db.query("UPDATE consent_policy_versions SET active = false WHERE version = '2'");
    await db.query(
      "INSERT INTO consent_policy_versions (version, locale, policy_text, active) VALUES ('3', 'en-US', $1, true)",
      ["v3 test policy — bumped text"]
    );
    // The partial unique index forbids a second active row per locale.
    await assert.rejects(
      db.query("INSERT INTO consent_policy_versions (version, locale, policy_text, active) VALUES ('2-dup', 'en-US', 'dup', true)"),
      (err) => err.code === "23505"
    );

    // Policy surfacing picks up v3.
    const latest = await api("/api/consent/policy/latest");
    assert.equal(latest.status, 200);
    assert.equal(latest.json.version, "3");

    const status = await api("/api/consent/status", { token: parent.token });
    assert.equal(status.json.consentCurrent, false, "v2 consent must read as stale");
    assert.equal(status.json.currentPolicyVersion, "3");

    // Stale consent refuses NEW child-data creation on every gated route.
    const before = await counts();
    const createStale = await api("/api/students", {
      method: "POST",
      token: parent.token,
      body: { nickname: "Stale", username: `stale${++seq}`, currentGrade: "kindergarten", pin: "5150" }
    });
    assert.equal(createStale.status, 403);
    assert.equal(createStale.json.type, "https://balashikshana.dev/problems/consent-required");
    assert.equal(createStale.json.currentPolicyVersion, "3");

    const practiceStale = await api("/api/practice/topic/complete", {
      method: "POST",
      token: child.token,
      body: {
        studentId: child.student.studentId,
        unitId: "K-M2",
        topicCode: "I",
        responses: [{ questionId: "K-M2-I-Q2", chosenAnswer: "1", isCorrect: false, rawTimeSec: 3.5 }]
      }
    });
    assert.equal(practiceStale.status, 403);
    assert.equal(practiceStale.json.currentPolicyVersion, "3");
    assert.deepEqual(await counts(), before, "stale-consent attempts must write nothing");

    // Capturing at the OLD version is a mismatch; at the NEW version it is
    // a re-consent (method derived server-side).
    const staleCapture = await captureConsent(parent.token, "2");
    assert.equal(staleCapture.status, 409);
    assert.equal(staleCapture.json.currentPolicyVersion, "3");
    const recapture = await captureConsent(parent.token, "3");
    assert.equal(recapture.status, 201, JSON.stringify(recapture.json));
    assert.equal(recapture.json.method, "re-consent");

    // Re-consent RESTORES access end to end: the parent-level v3 row covers
    // the bound child through consent lineage, no re-binding needed.
    const statusAfter = await api("/api/consent/status", { token: parent.token });
    assert.equal(statusAfter.json.consentCurrent, true);

    const practiceRestored = await api("/api/practice/topic/complete", {
      method: "POST",
      token: child.token,
      body: {
        studentId: child.student.studentId,
        unitId: "K-M2",
        topicCode: "I",
        responses: [{ questionId: "K-M2-I-Q2", chosenAnswer: "1", isCorrect: false, rawTimeSec: 3.5 }]
      }
    });
    assert.equal(practiceRestored.status, 200, JSON.stringify(practiceRestored.json));

    const gateRestored = await api("/api/gate/evaluate", {
      method: "POST",
      token: child.token,
      body: { studentId: child.student.studentId, unitId: "PK-M1", motorBaselineSec: 0.42, responses: [] }
    });
    assert.equal(gateRestored.status, 200, JSON.stringify(gateRestored.json));

    // New children can be created under the re-consented parent, and their
    // binding rows cite v3.
    const child2 = await registerGatedStudent(parent, { username: `reconsent2-${++seq}`, nickname: "ReConsent2" });
    const binding2 = (
      await db.query("SELECT policy_version FROM consent_records WHERE student_id = $1", [child2.student.studentId])
    ).rows[0];
    assert.equal(binding2.policy_version, "3");
  });
});

describe("the consent invariant (roadmap M2 verification item)", () => {
  // Runs LAST on purpose: every child-data-creating route has been exercised
  // above — gated happy paths AND every refusal path. The audit view must
  // report ZERO students without a matching consent record, and no progress
  // row may exist for a student lacking one.
  test("audit_students_without_consent is empty after exercising every child-data-creating route", async () => {
    const unconsented = (await db.query("SELECT * FROM audit_students_without_consent")).rows;
    assert.deepEqual(unconsented, [], "no student row may exist without a matching consent record");

    const orphanProgress = (
      await db.query(`
        SELECT
          (SELECT COUNT(*)::int FROM student_question_attempts a
             WHERE NOT EXISTS (SELECT 1 FROM consent_records c WHERE c.student_id = a.student_id)) AS attempts,
          (SELECT COUNT(*)::int FROM student_topic_progress t
             WHERE NOT EXISTS (SELECT 1 FROM consent_records c WHERE c.student_id = t.student_id)) AS topic,
          (SELECT COUNT(*)::int FROM student_unit_progress u
             WHERE NOT EXISTS (SELECT 1 FROM consent_records c WHERE c.student_id = u.student_id)) AS unit
      `)
    ).rows[0];
    assert.equal(orphanProgress.attempts, 0, "no attempt rows without consent");
    assert.equal(orphanProgress.topic, 0, "no topic-progress rows without consent");
    assert.equal(orphanProgress.unit, 0, "no unit-progress rows without consent");
  });

  test("consent rows are append-only across the whole suite (all writes are inserts)", async () => {
    // The suite only ever consented forward; every consent row still exists
    // with its original version/method (immutability by demonstration —
    // re-consent ADDED rows, the API has no update path).
    const rows = (await db.query("SELECT policy_version, method FROM consent_records ORDER BY captured_at ASC")).rows;
    assert.ok(rows.length >= 8, "suite must have exercised multiple captures");
    const v2Signup = rows.filter((r) => r.policy_version === "2" && r.method === "signup-form").length;
    const v2Re = rows.filter((r) => r.policy_version === "2" && r.method === "re-consent").length;
    const v3Re = rows.filter((r) => r.policy_version === "3" && r.method === "re-consent").length;
    assert.ok(v2Signup >= 1 && v2Re >= 1 && v3Re >= 1, `expected signup-form, v2 re-consent and v3 re-consent rows, got ${JSON.stringify(rows)}`);
  });
});
