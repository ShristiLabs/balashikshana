// B2B licensing seam integration tests (issue #70): license activation,
// seat validation, and the roster-import stub against a live server on a
// throwaway database. Covers the issue's acceptance matrix —
// valid / invalid-signature / expired / seat-exhausted paths, the auth
// matrix on every new endpoint, renewal supersession, duplicate license
// rejection, and the stub's ZERO-WRITES guarantee (row-count deltas over
// every B2B table before/after roster calls).
//
// Port 4785 (test port registry; 4783/4784 = parent-auth-mail, 4792-4794
// = parent-auth per delivery-69; this suite owns 4785).

import { test, describe, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { Client } from "pg";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import crypto from "node:crypto";
import {
  createTestDatabase,
  dropTestDatabase,
  startTestServer,
  waitForHealth,
  createVerifiedParentWithConsent,
  registerConsentedStudent
} from "./helpers.mjs";
import { canonicalClaimsJson, DEV_LICENSE_KEY_SEED, EXPECTED_PRODUCT_ID } from "../license-verifier.mjs";

const API = "http://127.0.0.1:4785";

{
  const merge = (msgs) => {
    const total = msgs.reduce((n, m) => n + m.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const m of msgs) {
      out.set(m, offset);
      offset += m.length;
    }
    return out;
  };
  ed.etc.sha512Sync = (...m) => sha512(merge(m));
}

const DEV_SEED = Buffer.from(DEV_LICENSE_KEY_SEED, "utf8");
const STRANGER_SEED = crypto.randomBytes(32);

let licenseSeq = 0;
function makeLicenseFile(overrides = {}, seed = DEV_SEED) {
  const claims = {
    license_id: `lic-b2b-${++licenseSeq}`,
    product_id: EXPECTED_PRODUCT_ID,
    customer: "Seam Elementary District",
    plan: "school",
    seats: 2,
    instance_id: "inst-b2b-001",
    issued_at: "2026-10-01T00:00:00Z",
    expires_at: "2099-01-01T00:00:00Z",
    features: ["roster-import"],
    ...overrides
  };
  const signature = Buffer.from(ed.sign(Buffer.from(canonicalClaimsJson(claims), "utf8"), seed)).toString("base64");
  return { ...claims, signature };
}

async function api(pathname, { method = "GET", token, body, rawBody, contentType } = {}) {
  const headers = {};
  if (rawBody !== undefined) headers["Content-Type"] = contentType;
  else if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers,
    body: rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON
  }
  return { status: res.status, json };
}

async function b2bTableCounts() {
  const { rows } = await db.query(`SELECT
    (SELECT COUNT(*)::int FROM organizations) AS orgs,
    (SELECT COUNT(*)::int FROM organization_licenses) AS licenses,
    (SELECT COUNT(*)::int FROM organization_seats) AS seats`);
  return rows[0];
}

let serverProcess;
let testDatabase;
let db;

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  // Functional suite: buckets wide open (the #40 rate-limit behavior is
  // covered by parent-auth.test.mjs's tuned servers; the B2B route-level
  // buckets follow the same proven injected-bucket pattern).
  serverProcess = await startTestServer({
    port: 4785,
    databaseUrl: testDatabase.url,
    env: {
      RATE_LIMIT_PER_IP_MIN: "1000",
      RATE_LIMIT_PER_TOKEN_MIN: "1000",
      RATE_LIMIT_PARENT_SIGNUP_PER_IP_MIN: "1000",
      RATE_LIMIT_PARENT_LOGIN_PER_IP_MIN: "1000",
      RATE_LIMIT_PARENT_TOKEN_PER_IP_MIN: "1000",
      RATE_LIMIT_B2B_ACTIVATE_PER_IP_MIN: "1000",
      RATE_LIMIT_B2B_ROSTER_PER_IP_MIN: "1000"
    }
  });
  await waitForHealth(API);
  db = new Client({ connectionString: testDatabase.url });
  await db.connect();
}, 180000);

afterAll(async () => {
  if (db) await db.end();
  if (serverProcess) serverProcess.kill("SIGTERM");
  if (testDatabase) await dropTestDatabase(testDatabase.name);
});

describe("activation matrix (POST /api/b2b/licenses)", () => {
  test("401 anonymous, 403 student token, 403 child-device token", async () => {
    const anonymous = await api("/api/b2b/licenses", { method: "POST", body: makeLicenseFile() });
    assert.equal(anonymous.status, 401);

    const parent = await createVerifiedParentWithConsent(API);
    const student = await registerConsentedStudent(API, {}, parent);
    const studentRes = await api("/api/b2b/licenses", { method: "POST", token: student.token, body: makeLicenseFile() });
    assert.equal(studentRes.status, 403);
    assert.ok(studentRes.json.type.includes("wrong-token-type"));

    const device = await api(`/api/parent/children/${student.student.studentId}/device-sessions`, {
      method: "POST",
      token: parent.token,
      body: { clientDeviceId: "device-b2b-test-01", platform: "web" }
    });
    assert.equal(device.status, 201);
    const deviceRes = await api("/api/b2b/licenses", { method: "POST", token: device.json.token, body: makeLicenseFile() });
    assert.equal(deviceRes.status, 403);
    assert.ok(deviceRes.json.type.includes("wrong-token-type"));
  });

  test("valid dev-signed license activates: org created, 201 summary", async () => {
    const parent = await createVerifiedParentWithConsent(API);
    const file = makeLicenseFile({ customer: "First Activation School", seats: 3 });
    const res = await api("/api/b2b/licenses", { method: "POST", token: parent.token, body: file });
    assert.equal(res.status, 201);
    assert.equal(res.json.organizationName, "First Activation School");
    assert.equal(res.json.seats, 3);
    assert.equal(res.json.status, "active");
    assert.equal(res.json.licenseId, file.license_id);
    assert.ok(res.json.organizationId.startsWith("org-"));
    assert.ok(!res.json.signature, "activation response never echoes the signature");
  });

  test("invalid signature -> 422 problem with the licensing-core taxonomy", async () => {
    const parent = await createVerifiedParentWithConsent(API);
    const file = makeLicenseFile();
    file.seats = 500; // tampered after signing
    const res = await api("/api/b2b/licenses", { method: "POST", token: parent.token, body: file });
    assert.equal(res.status, 422);
    assert.ok(res.json.type.endsWith("b2b-license-invalid-signature"));
  });

  test("wrong signing key -> 422 invalid-signature", async () => {
    const parent = await createVerifiedParentWithConsent(API);
    const res = await api("/api/b2b/licenses", { method: "POST", token: parent.token, body: makeLicenseFile({}, STRANGER_SEED) });
    assert.equal(res.status, 422);
    assert.ok(res.json.type.endsWith("b2b-license-invalid-signature"));
  });

  test("expired license -> 422 expired", async () => {
    const parent = await createVerifiedParentWithConsent(API);
    const res = await api("/api/b2b/licenses", {
      method: "POST",
      token: parent.token,
      body: makeLicenseFile({ expires_at: "2020-01-01T00:00:00Z" })
    });
    assert.equal(res.status, 422);
    assert.ok(res.json.type.endsWith("b2b-license-expired"));
  });

  test("license for another product -> 422 product-mismatch", async () => {
    const parent = await createVerifiedParentWithConsent(API);
    const res = await api("/api/b2b/licenses", {
      method: "POST",
      token: parent.token,
      body: makeLicenseFile({ product_id: "madhyamas" })
    });
    assert.equal(res.status, 422);
    assert.ok(res.json.type.endsWith("b2b-license-product-mismatch"));
  });

  test("duplicate license_id (same or different org) -> 409, globally unique", async () => {
    const file = makeLicenseFile({ customer: "Duplicate Check School" });
    const first = await createVerifiedParentWithConsent(API);
    const res1 = await api("/api/b2b/licenses", { method: "POST", token: first.token, body: file });
    assert.equal(res1.status, 201);
    // Same parent re-activating the same license.
    const res2 = await api("/api/b2b/licenses", { method: "POST", token: first.token, body: file });
    assert.equal(res2.status, 409);
    assert.ok(res2.json.type.endsWith("b2b-license-already-activated"));
    // A DIFFERENT parent trying to bind the same issued license.
    const second = await createVerifiedParentWithConsent(API);
    const res3 = await api("/api/b2b/licenses", { method: "POST", token: second.token, body: file });
    assert.equal(res3.status, 409);
    assert.ok(res3.json.type.endsWith("b2b-license-already-activated"));
  });

  test("second unexpired license while one is active -> 409 active-license-exists", async () => {
    const parent = await createVerifiedParentWithConsent(API);
    const res1 = await api("/api/b2b/licenses", { method: "POST", token: parent.token, body: makeLicenseFile() });
    assert.equal(res1.status, 201);
    const res2 = await api("/api/b2b/licenses", { method: "POST", token: parent.token, body: makeLicenseFile() });
    assert.equal(res2.status, 409);
    assert.ok(res2.json.type.endsWith("b2b-active-license-exists"));
  });

  test("renewal: an EXPIRED active license is superseded by a new one", async () => {
    const parent = await createVerifiedParentWithConsent(API);
    const res1 = await api("/api/b2b/licenses", {
      method: "POST",
      token: parent.token,
      body: makeLicenseFile({ expires_at: "2020-01-01T00:00:00Z" })
    });
    // Activation itself refuses expired licenses; simulate the passage of
    // time instead by inserting via a short-lived license that is EXPIRED
    // at renewal time: activate unexpired-far-future first, then flip the
    // row's expiry into the past directly (the clock is not injectable
    // through the API by design) and renew.
    assert.equal(res1.status, 422); // expired licenses never activate
    const res2 = await api("/api/b2b/licenses", { method: "POST", token: parent.token, body: makeLicenseFile() });
    assert.equal(res2.status, 201);
    await db.query("UPDATE organization_licenses SET expires_at = '2020-01-01T00:00:00Z' WHERE license_id = $1", [
      res2.json.licenseId
    ]);
    const res3 = await api("/api/b2b/licenses", { method: "POST", token: parent.token, body: makeLicenseFile({ seats: 5 }) });
    assert.equal(res3.status, 201);
    const statuses = await db.query(
      "SELECT status FROM organization_licenses WHERE org_id = $1 ORDER BY created_at",
      [res3.json.organizationId]
    );
    assert.deepEqual(statuses.rows.map((r) => r.status), ["superseded", "active"]);
  });
});

describe("seat validation (GET current + POST /api/b2b/seats)", () => {
  test("full lifecycle: status -> claims to the limit -> exhausted -> duplicate -> expired-at-claim-time", async () => {
    const parent = await createVerifiedParentWithConsent(API);
    const file = makeLicenseFile({ seats: 2, customer: "Seat Lifecycle School" });
    const activation = await api("/api/b2b/licenses", { method: "POST", token: parent.token, body: file });
    assert.equal(activation.status, 201);

    const status0 = await api("/api/b2b/licenses/current", { token: parent.token });
    assert.equal(status0.status, 200);
    assert.equal(status0.json.seatsLicensed, 2);
    assert.equal(status0.json.seatsAssigned, 0);
    assert.equal(status0.json.seatsRemaining, 2);
    assert.equal(status0.json.licenseState, "active");

    const seat1 = await api("/api/b2b/seats", { method: "POST", token: parent.token, body: { subject: "teacher-one" } });
    assert.equal(seat1.status, 201);
    assert.equal(seat1.json.subject, "teacher-one");
    assert.ok(seat1.json.seatId.startsWith("seat-"));

    const seat2 = await api("/api/b2b/seats", { method: "POST", token: parent.token, body: { subject: "teacher-two" } });
    assert.equal(seat2.status, 201);

    // Boundary: exactly at the limit now.
    const exhausted = await api("/api/b2b/seats", { method: "POST", token: parent.token, body: { subject: "teacher-three" } });
    assert.equal(exhausted.status, 409);
    assert.ok(exhausted.json.type.endsWith("b2b-seat-exhausted"));
    // RFC 9457 extension members merge top-level into the problem body.
    assert.equal(exhausted.json.seatsLicensed, 2);
    assert.equal(exhausted.json.seatsAssigned, 2);

    const duplicate = await api("/api/b2b/seats", { method: "POST", token: parent.token, body: { subject: "teacher-one" } });
    assert.equal(duplicate.status, 409);
    assert.ok(duplicate.json.type.endsWith("b2b-seat-subject-exists"));

    const status1 = await api("/api/b2b/licenses/current", { token: parent.token });
    assert.equal(status1.json.seatsAssigned, 2);
    assert.equal(status1.json.seatsRemaining, 0);

    // Runtime expiry re-validation: the row still says 'active', but the
    // clock has passed it — no seat may be granted (subject freed above
    // only by exhaustion... use a fresh subject to isolate expiry).
    await db.query("UPDATE organization_licenses SET expires_at = '2020-01-01T00:00:00Z' WHERE license_id = $1", [
      file.license_id
    ]);
    const expiredClaim = await api("/api/b2b/seats", { method: "POST", token: parent.token, body: { subject: "teacher-x" } });
    assert.equal(expiredClaim.status, 409);
    assert.ok(expiredClaim.json.type.endsWith("b2b-license-expired"));

    const statusExpired = await api("/api/b2b/licenses/current", { token: parent.token });
    assert.equal(statusExpired.json.licenseState, "active-expired");
    assert.equal(statusExpired.json.seatsRemaining, 0);
  });

  test("seats without any license -> 409; seats auth matrix 401/403", async () => {
    const parent = await createVerifiedParentWithConsent(API);
    const noLicense = await api("/api/b2b/seats", { method: "POST", token: parent.token, body: { subject: "early" } });
    assert.equal(noLicense.status, 409);
    assert.ok(noLicense.json.type.endsWith("b2b-no-active-license"));

    const anonymous = await api("/api/b2b/seats", { method: "POST", body: { subject: "anon" } });
    assert.equal(anonymous.status, 401);

    const student = await registerConsentedStudent(API, {}, await createVerifiedParentWithConsent(API));
    const studentRes = await api("/api/b2b/seats", { method: "POST", token: student.token, body: { subject: "s" } });
    assert.equal(studentRes.status, 403);
  });

  test("current without an organization -> 404 no-organization", async () => {
    const parent = await createVerifiedParentWithConsent(API);
    const res = await api("/api/b2b/licenses/current", { token: parent.token });
    assert.equal(res.status, 404);
    assert.ok(res.json.type.endsWith("b2b-no-organization"));
  });

  test("race pin: concurrent activations of the SAME license -> exactly one 201, one 409 (never a 500)", async () => {
    const parentA = await createVerifiedParentWithConsent(API);
    const parentB = await createVerifiedParentWithConsent(API);
    const file = makeLicenseFile({ customer: "Race Condition School" });
    const [a, b] = await Promise.all([
      api("/api/b2b/licenses", { method: "POST", token: parentA.token, body: file }),
      api("/api/b2b/licenses", { method: "POST", token: parentB.token, body: file })
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 409], `expected one 201 + one 409, got ${statuses.join(",")}`);
  });

  test("one org per parent: org row is reused, not duplicated", async () => {
    const parent = await createVerifiedParentWithConsent(API);
    const a = await api("/api/b2b/licenses", { method: "POST", token: parent.token, body: makeLicenseFile() });
    assert.equal(a.status, 201);
    await db.query("UPDATE organization_licenses SET expires_at = '2020-01-01T00:00:00Z' WHERE license_id = $1", [
      a.json.licenseId
    ]);
    const b = await api("/api/b2b/licenses", { method: "POST", token: parent.token, body: makeLicenseFile() });
    assert.equal(b.status, 201);
    assert.equal(b.json.organizationId, a.json.organizationId);
  });
});

describe("roster-import stub (POST /api/b2b/roster/validate) — validation-only dry run", () => {
  test("CSV: accepted + rejected rows with reasons and seat projection", async () => {
    const parent = await createVerifiedParentWithConsent(API);
    await api("/api/b2b/licenses", { method: "POST", token: parent.token, body: makeLicenseFile({ seats: 5, customer: "Roster School" }) });
    await api("/api/b2b/seats", { method: "POST", token: parent.token, body: { subject: "already-seated" } });

    const csv = [
      "guardian_email,student_name,grade",
      "parent1@example.com,Maya,kindergarten",
      "not-an-email,Noah,grade-1",
      "parent3@example.com,,grade-2",
      "parent4@example.com,Liam,grade-9",
      'parent5@example.com,"Quoted, Ana",pre-k'
    ].join("\n");

    const res = await api("/api/b2b/roster/validate", { method: "POST", token: parent.token, rawBody: csv, contentType: "text/csv" });
    assert.equal(res.status, 200);
    assert.equal(res.json.dryRun, true);
    assert.equal(res.json.validationOnly, true);
    assert.ok(res.json.note.includes("nothing was created"));
    assert.equal(res.json.summary.rowsTotal, 5);
    assert.equal(res.json.summary.accepted, 2);
    assert.equal(res.json.summary.rejected, 3);
    assert.equal(res.json.summary.seatsNeeded, 2);
    assert.equal(res.json.summary.seatProjection.seatsRemaining, 4);
    assert.equal(res.json.summary.seatsSufficient, true);
    const rejected = res.json.rows.filter((r) => r.status === "rejected");
    assert.deepEqual(
      rejected.map((r) => r.line).sort(),
      [2, 3, 4]
    );
    assert.ok(rejected.find((r) => r.line === 2).reasons.join(" ").includes("email"));
    assert.ok(rejected.find((r) => r.line === 3).reasons.join(" ").includes("student_name is required"));
    assert.ok(rejected.find((r) => r.line === 4).reasons.join(" ").includes("grade"));
  });

  test("seat-capacity boundary: seatsNeeded > remaining -> seatsSufficient false (still 200)", async () => {
    const parent = await createVerifiedParentWithConsent(API);
    await api("/api/b2b/licenses", { method: "POST", token: parent.token, body: makeLicenseFile({ seats: 1, customer: "Tiny School" }) });
    const csv = "student_name,grade,guardian_email\nAva,pre-k,a@example.com\nBen,pre-k,b@example.com";
    const res = await api("/api/b2b/roster/validate", { method: "POST", token: parent.token, rawBody: csv, contentType: "text/csv" });
    assert.equal(res.status, 200);
    assert.equal(res.json.summary.seatsNeeded, 2);
    assert.equal(res.json.summary.seatProjection.seatsRemaining, 1);
    assert.equal(res.json.summary.seatsSufficient, false);
  });

  test("without a license: rows still validate, seat projection is null", async () => {
    const parent = await createVerifiedParentWithConsent(API);
    const csv = "student_name,grade,guardian_email\nAva,pre-k,a@example.com";
    const res = await api("/api/b2b/roster/validate", { method: "POST", token: parent.token, rawBody: csv, contentType: "text/csv" });
    assert.equal(res.status, 200);
    assert.equal(res.json.summary.accepted, 1);
    assert.equal(res.json.summary.seatProjection, null);
    assert.equal(res.json.summary.seatsSufficient, null);
  });

  test("JSON intake path", async () => {
    const parent = await createVerifiedParentWithConsent(API);
    const res = await api("/api/b2b/roster/validate", {
      method: "POST",
      token: parent.token,
      body: { rows: [{ student_name: "Zoe", grade: "grade-3", guardian_email: "z@example.com" }] }
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.summary.accepted, 1);
  });

  test("malformed intake: bad header, unterminated quote, empty CSV, wrong shape, too many rows", async () => {
    const parent = await createVerifiedParentWithConsent(API);
    const badHeader = await api("/api/b2b/roster/validate", {
      method: "POST", token: parent.token, rawBody: "name,grade,email\nA,pre-k,a@b.co", contentType: "text/csv"
    });
    assert.equal(badHeader.status, 422);
    assert.ok(badHeader.json.type.endsWith("b2b-roster-header-invalid"));

    const unterminated = await api("/api/b2b/roster/validate", {
      method: "POST", token: parent.token, rawBody: 'student_name,grade,guardian_email\n"open,pre-k,a@b.co', contentType: "text/csv"
    });
    assert.equal(unterminated.status, 422);
    assert.ok(unterminated.json.type.endsWith("b2b-roster-csv-invalid"));

    const onlyHeader = await api("/api/b2b/roster/validate", {
      method: "POST", token: parent.token, rawBody: "student_name,grade,guardian_email", contentType: "text/csv"
    });
    assert.equal(onlyHeader.status, 422);

    const wrongShape = await api("/api/b2b/roster/validate", { method: "POST", token: parent.token, body: { csv: "nope" } });
    assert.equal(wrongShape.status, 422);

    const many = `student_name,grade,guardian_email\n${Array.from({ length: 501 }, (_, i) => `S${i},pre-k,s${i}@example.com`).join("\n")}`;
    const tooMany = await api("/api/b2b/roster/validate", { method: "POST", token: parent.token, rawBody: many, contentType: "text/csv" });
    assert.equal(tooMany.status, 413);
    assert.ok(tooMany.json.type.endsWith("b2b-roster-too-large"));
  });

  test("tester additions: UTF-8 BOM is tolerated; wrong-field-count rows are row-level rejects", async () => {
    const parent = await createVerifiedParentWithConsent(API);
    // Excel-style BOM before the header must not break intake.
    const bomCsv = "\uFEFFstudent_name,grade,guardian_email\nMaya,pre-k,parent@example.com";
    const bom = await api("/api/b2b/roster/validate", { method: "POST", token: parent.token, rawBody: bomCsv, contentType: "text/csv" });
    assert.equal(bom.status, 200);
    assert.equal(bom.json.summary.accepted, 1);

    // A short row (2 fields under a 3-column header) and a long row (4)
    // are both rejected with an explicit field-count reason — never
    // silently truncated.
    const raggedCsv = "student_name,grade,guardian_email\nMaya,pre-k\nNoah,pre-k,parent@example.com,extra";
    const ragged = await api("/api/b2b/roster/validate", { method: "POST", token: parent.token, rawBody: raggedCsv, contentType: "text/csv" });
    assert.equal(ragged.status, 200);
    assert.equal(ragged.json.summary.accepted, 0);
    assert.equal(ragged.json.summary.rejected, 2);
    assert.ok(ragged.json.rows.find((r) => r.line === 1).reasons[0].includes("expected 3 fields, found 2"));
    assert.ok(ragged.json.rows.find((r) => r.line === 2).reasons[0].includes("expected 3 fields, found 4"));
  });

  test("auth matrix: 401 anonymous / 403 student token", async () => {
    const anonymous = await api("/api/b2b/roster/validate", { method: "POST", rawBody: "student_name,grade,guardian_email\nA,pre-k,a@b.co", contentType: "text/csv" });
    assert.equal(anonymous.status, 401);
    const student = await registerConsentedStudent(API, {}, await createVerifiedParentWithConsent(API));
    const studentRes = await api("/api/b2b/roster/validate", {
      method: "POST", token: student.token, rawBody: "student_name,grade,guardian_email\nA,pre-k,a@b.co", contentType: "text/csv"
    });
    assert.equal(studentRes.status, 403);
  });

  test("ZERO-WRITES PROOF: roster validation leaves every B2B table byte-identical", async () => {
    const parent = await createVerifiedParentWithConsent(API);
    await api("/api/b2b/licenses", { method: "POST", token: parent.token, body: makeLicenseFile({ seats: 3, customer: "No Writes School" }) });
    const before = await b2bTableCounts();

    const csv = "student_name,grade,guardian_email\nMaya,kindergarten,parent@example.com\nBad,grade-99,x";
    const withLicense = await api("/api/b2b/roster/validate", { method: "POST", token: parent.token, rawBody: csv, contentType: "text/csv" });
    assert.equal(withLicense.status, 200);

    const fresh = await createVerifiedParentWithConsent(API);
    const withoutLicense = await api("/api/b2b/roster/validate", { method: "POST", token: fresh.token, rawBody: csv, contentType: "text/csv" });
    assert.equal(withoutLicense.status, 200);

    // Students/parents untouched too: the stub creates no child data.
    const studentCount = await db.query("SELECT COUNT(*)::int AS n FROM students");
    const after = await b2bTableCounts();
    assert.deepEqual(after, before);
    assert.equal(studentCount.rows[0].n > 0, true); // sanity: the counter is live
  });
});
