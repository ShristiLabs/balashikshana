// Security-deepening coverage for issue #41 (companion to
// consent.test.mjs): the consent surface's negative matrices that must hold
// for the M2 gate to be trustworthy —
// - token-kind confusion on every consent route (student tokens are never
//   parent evidence),
// - CROSS-PARENT lineage isolation: another parent's consent must never
//   authorize (or restore access for) someone else's child,
// - stale-consent direct probes: after a policy bump EVERY child-data-
//   creating route refuses AND writes nothing (row-count deltas, not just
//   the audit view),
// - fail-closed policy resolution: no active policy -> no writes, anywhere,
// - binding-row attribution: the creation-time consent row copies the
//   standing consent's version AND method, attributed to the creating
//   parent,
// - append-only immutability: existing consent rows are never mutated by
//   any later capture.
//
// Same harness contract as the sibling suites: own throwaway database,
// own port, SEED_DEMO_STUDENTS=0 (pristine; the invariant's zero-rows
// posture), rate limits maxed so limiters never mask assertions.

import { test, describe, beforeAll, afterAll, afterEach } from "vitest";
import assert from "node:assert/strict";
import { Client } from "pg";
import { createTestDatabase, dropTestDatabase, startTestServer, waitForHealth } from "./helpers.mjs";

const API = "http://127.0.0.1:4796";

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
const uniqueEmail = () => `csec${++seq}@example.com`;

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

async function consentedParentWithStudent() {
  const parent = await createVerifiedParent();
  const policy = await activePolicyVersion();
  const consent = await captureConsent(parent.token, policy);
  assert.equal(consent.status, 201, JSON.stringify(consent.json));
  const student = await api("/api/students", {
    method: "POST",
    token: parent.token,
    body: { nickname: "Probe", username: `probe${++seq}`, currentGrade: "kindergarten", pin: "5150" }
  });
  assert.equal(student.status, 201, JSON.stringify(student.json));
  return { parent, policy, child: { token: student.json.token, studentId: student.json.student.studentId } };
}

// The ops policy bump (see migration 004 notes): deactivate the current
// active row, insert a fresh active one. Each call mints a unique version
// so repeated bumps in one suite never collide; the v1 seed is restored in
// afterEach. Policy rows are append-only — nothing is deleted here.
async function bumpPolicy() {
  const version = `t2${++seq}`;
  await db.query("UPDATE consent_policy_versions SET active = false WHERE active");
  await db.query(
    "INSERT INTO consent_policy_versions (version, locale, policy_text, active) VALUES ($1, 'en-US', $2, true)",
    [version, `bumped test policy ${version}`]
  );
  return version;
}

const practiceBody = (studentId) => ({
  studentId,
  unitId: "K-M2",
  topicCode: "I",
  responses: [{ questionId: "K-M2-I-Q1", chosenAnswer: "6", isCorrect: true, rawTimeSec: 2.5 }]
});

const gateBody = (studentId) => ({ studentId, unitId: "PK-M1", motorBaselineSec: 0.42, responses: [] });

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

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  serverProcess = await startTestServer({
    port: 4796,
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

afterEach(async () => {
  // Policy state reset: bumps deactivate v1; restore the seed as the single
  // active row so every test starts from the same v1 posture no matter the
  // order its siblings ran in. Deactivate-others first — the partial unique
  // index allows exactly one active row per locale.
  try {
    await db.query("UPDATE consent_policy_versions SET active = false WHERE version <> '1'");
    await db.query("UPDATE consent_policy_versions SET active = true WHERE version = '1' AND active = false");
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

describe("token-kind confusion on the consent surface", () => {
  test("student session token on GET /api/consent/status -> 403 wrong-token-type", async () => {
    const { child } = await consentedParentWithStudent();
    const res = await api("/api/consent/status", { token: child.token });
    assert.equal(res.status, 403);
    assert.equal(res.json.type, "https://balashikshana.dev/problems/wrong-token-type");
    assert.match(res.headers.get("content-type") || "", /application\/problem\+json/);
  });

  test("well-formed but unknown bearer on GET /api/consent/status -> 401, not a kind confusion", async () => {
    const res = await api("/api/consent/status", { token: "c2VjdXJpdHktdGVzdC1ub3RhdG9rZW4" });
    assert.equal(res.status, 401);
    assert.equal(res.json.type, "https://balashikshana.dev/problems/unauthorized");
  });
});

describe("cross-parent consent lineage isolation", () => {
  test("parent B cannot capture consent naming parent A's student -> 403 no-child-binding, no row written", async () => {
    const a = await consentedParentWithStudent();
    const b = await createVerifiedParent();
    const before = await counts();
    const scopedBefore = (
      await db.query("SELECT COUNT(*)::int AS n FROM consent_records WHERE student_id = $1", [a.child.studentId])
    ).rows[0].n;

    const res = await captureConsent(b.token, a.policy, { studentId: a.child.studentId });
    assert.equal(res.status, 403, JSON.stringify(res.json));
    assert.equal(res.json.type, "https://balashikshana.dev/problems/no-child-binding");

    assert.deepEqual(await counts(), before, "a refused cross-parent capture must write nothing");
    const scopedAfter = (
      await db.query("SELECT COUNT(*)::int AS n FROM consent_records WHERE student_id = $1", [a.child.studentId])
    ).rows[0].n;
    assert.equal(scopedAfter, scopedBefore, "parent B must not gain consent evidence for parent A's student");
  });

  test("parent B's re-consent after a bump does NOT restore parent A's child (lineage is scoped, not global)", async () => {
    const a = await consentedParentWithStudent(); // parent A + child, consent at v1
    const b = await consentedParentWithStudent(); // parent B + child, consent at v1
    const v2 = await bumpPolicy();

    // Parent B re-consents at the new version — restoring THEIR child.
    const recapture = await captureConsent(b.parent.token, v2);
    assert.equal(recapture.status, 201, JSON.stringify(recapture.json));

    // Parent A's child must STILL be refused: B's parent-level v2 row is not
    // A-lineage evidence, so the stale v1 binding row leaves child A gated.
    const before = await counts();
    const refused = await api("/api/practice/topic/complete", {
      method: "POST",
      token: a.child.token,
      body: practiceBody(a.child.studentId)
    });
    assert.equal(refused.status, 403);
    assert.equal(refused.json.type, "https://balashikshana.dev/problems/consent-required");
    assert.equal(refused.json.currentPolicyVersion, v2);
    assert.equal((await counts()).attempts, before.attempts, "the refused stale write must persist no attempts");

    // Parent B's own child IS restored by the same re-consent — the refusal
    // above is lineage scoping, not a global lock.
    const restored = await api("/api/practice/topic/complete", {
      method: "POST",
      token: b.child.token,
      body: practiceBody(b.child.studentId)
    });
    assert.equal(restored.status, 200, JSON.stringify(restored.json));
  });

  test("parent A's own re-consent restores parent A's child end to end", async () => {
    const a = await consentedParentWithStudent();
    const v2 = await bumpPolicy();

    const stale = await api("/api/practice/topic/complete", {
      method: "POST",
      token: a.child.token,
      body: practiceBody(a.child.studentId)
    });
    assert.equal(stale.status, 403);

    const statusBefore = await api("/api/consent/status", { token: a.parent.token });
    assert.equal(statusBefore.json.consentCurrent, false);

    const recapture = await captureConsent(a.parent.token, v2);
    assert.equal(recapture.status, 201);
    assert.equal(recapture.json.method, "re-consent");

    const practice = await api("/api/practice/topic/complete", {
      method: "POST",
      token: a.child.token,
      body: practiceBody(a.child.studentId)
    });
    assert.equal(practice.status, 200, JSON.stringify(practice.json));
    const gate = await api("/api/gate/evaluate", { method: "POST", token: a.child.token, body: gateBody(a.child.studentId) });
    assert.equal(gate.status, 200, JSON.stringify(gate.json));
  });
});

describe("stale consent after a policy bump: every gated route refuses AND writes nothing", () => {
  test("POST /api/students with stale consent -> 403 consent-required, zero row delta", async () => {
    const { parent } = await consentedParentWithStudent();
    const v2 = await bumpPolicy();
    const before = await counts();

    const res = await api("/api/students", {
      method: "POST",
      token: parent.token,
      body: { nickname: "StaleCreate", username: `stalecreate${++seq}`, currentGrade: "kindergarten", pin: "5150" }
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.type, "https://balashikshana.dev/problems/consent-required");
    assert.equal(res.json.currentPolicyVersion, v2);
    assert.deepEqual(await counts(), before, "stale-consent student creation must write no student, consent, or progress rows");
  });

  test("practice/topic/complete with stale consent -> 403, no attempt or progress rows created", async () => {
    const { child } = await consentedParentWithStudent();
    await bumpPolicy();
    const before = await counts();

    const res = await api("/api/practice/topic/complete", { method: "POST", token: child.token, body: practiceBody(child.studentId) });
    assert.equal(res.status, 403);
    assert.equal(res.json.type, "https://balashikshana.dev/problems/consent-required");
    assert.deepEqual(await counts(), before, "a refused practice write must create no rows");
  });

  test("gate/evaluate with stale consent -> 403, no unit-progress rows created", async () => {
    const { child } = await consentedParentWithStudent();
    await bumpPolicy();
    const before = await counts();

    const res = await api("/api/gate/evaluate", { method: "POST", token: child.token, body: gateBody(child.studentId) });
    assert.equal(res.status, 403);
    assert.equal(res.json.type, "https://balashikshana.dev/problems/consent-required");
    assert.deepEqual(await counts(), before, "a refused gate write must create no rows");
  });
});

describe("fail-closed policy resolution (no active policy)", () => {
  test("consent capture and child-data writes fail closed with zero row delta", async () => {
    const { parent, child } = await consentedParentWithStudent();
    await db.query("UPDATE consent_policy_versions SET active = false WHERE active");
    const before = await counts();

    const capture = await captureConsent(parent.token, "1");
    assert.equal(capture.status, 500, "capture must fail closed when there is nothing to consent to");
    assert.equal(capture.json.type, "https://balashikshana.dev/problems/internal");

    const create = await api("/api/students", {
      method: "POST",
      token: parent.token,
      body: { nickname: "NoPolicy", username: `nopolicy${++seq}`, currentGrade: "kindergarten", pin: "5150" }
    });
    assert.equal(create.status, 500);
    assert.equal(create.json.type, "https://balashikshana.dev/problems/internal");

    const practice = await api("/api/practice/topic/complete", {
      method: "POST",
      token: child.token,
      body: practiceBody(child.studentId)
    });
    assert.equal(practice.status, 500);
    assert.equal(practice.json.type, "https://balashikshana.dev/problems/internal");

    const gate = await api("/api/gate/evaluate", { method: "POST", token: child.token, body: gateBody(child.studentId) });
    assert.equal(gate.status, 500);
    assert.deepEqual(await counts(), before, "fail-closed refusals must write nothing anywhere");
  });
});

describe("binding-row attribution at student creation", () => {
  test("the binding row cites the standing consent's version AND method, attributed to the creating parent", async () => {
    const parent = await createVerifiedParent();
    const v1 = await activePolicyVersion();
    await captureConsent(parent.token, v1); // method: signup-form
    const v2 = await bumpPolicy();
    const recapture = await captureConsent(parent.token, v2); // method: re-consent
    assert.equal(recapture.json.method, "re-consent");

    const created = await api("/api/students", {
      method: "POST",
      token: parent.token,
      body: { nickname: "Attributed", username: `attributed${++seq}`, currentGrade: "kindergarten", pin: "5150" }
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));

    const binding = (
      await db.query("SELECT * FROM consent_records WHERE student_id = $1", [created.json.student.studentId])
    ).rows[0];
    assert.ok(binding, "creation must write the student-scoped binding consent row");
    assert.equal(binding.parent_id, parent.parentId, "binding row is attributed to the creating parent");
    assert.equal(binding.policy_version, v2, "binding row cites the standing consent's CURRENT version");
    assert.equal(binding.method, "re-consent", "binding row copies the standing consent's derived method, not a fresh derivation");
    assert.ok(binding.captured_at, "binding row timestamps are server-side");
  });

  test("every creation writes its own binding row (two children, two distinct rows)", async () => {
    const { parent } = await consentedParentWithStudent();
    const second = await api("/api/students", {
      method: "POST",
      token: parent.token,
      body: { nickname: "Second", username: `second${++seq}`, currentGrade: "kindergarten", pin: "5150" }
    });
    assert.equal(second.status, 201, JSON.stringify(second.json));

    const scoped = (
      await db.query(
        "SELECT student_id FROM consent_records WHERE parent_id = $1 AND student_id IS NOT NULL ORDER BY captured_at ASC",
        [parent.parentId]
      )
    ).rows;
    assert.equal(scoped.length, 2, "each created child carries its own binding row");
  });
});

describe("append-only immutability of consent rows", () => {
  test("later captures (same version, re-consent, and post-bump) never mutate an existing row", async () => {
    const parent = await createVerifiedParent();
    const v1 = await activePolicyVersion();
    const first = await captureConsent(parent.token, v1);
    assert.equal(first.status, 201);

    const snapshot = (await db.query("SELECT * FROM consent_records WHERE consent_id = $1", [first.json.consentId])).rows[0];
    assert.ok(snapshot);

    await captureConsent(parent.token, v1); // re-consent at the same version
    const v2 = await bumpPolicy();
    await captureConsent(parent.token, v2); // re-consent after a bump

    const after = (await db.query("SELECT * FROM consent_records WHERE consent_id = $1", [first.json.consentId])).rows[0];
    assert.deepEqual(after, snapshot, "the original consent row must be byte-for-byte unchanged by any later capture");

    const total = (await db.query("SELECT COUNT(*)::int AS n FROM consent_records WHERE parent_id = $1", [parent.parentId])).rows[0].n;
    assert.equal(total, 3, "corrections/updates arrive as NEW rows, never in-place rewrites");
  });
});
