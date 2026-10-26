// COPPA legal pack coverage for issue #68: the versioned legal_documents
// catalog (privacy policy + terms of service) served publicly for in-app
// rendering, the migration-014 consent-policy bump to the production
// consent statement, and the two #68 security invariants:
//
// - LEGAL DOCUMENT VERSIONS ARE INDEPENDENT OF CONSENT: publishing a new
//   privacy/terms version must NOT flip consentCurrent or change the
//   active consent policy version (re-consent triggers ONLY on
//   consent_policy_versions changes).
// - The shipped texts are drafts: every seeded body carries the
//   counsel-review banner, and placeholders are bracketed (never a bare
//   unmarked token the renderer could silently pass through).
// - PRODUCTION data minimization on GET /api/students (finding SR-1):
//   a second server booted with NODE_ENV=production must refuse the
//   anonymous listing (401), refuse parent tokens (403 wrong-token-type),
//   and return ONLY the caller's own card for a student session.

import { test, describe, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { Client } from "pg";
import { createTestDatabase, dropTestDatabase, startTestServer, waitForHealth } from "./helpers.mjs";

const API = "http://127.0.0.1:4781";
const API_PROD = "http://127.0.0.1:4782";
const PASSWORD = "legitimate-password-1";

let serverProcess;
let prodServerProcess;
let testDatabase;
let db;

async function api(base, pathname, { method = "GET", token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${pathname}`, {
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

let seq = 0;

async function createVerifiedParentAndConsent(base) {
  const email = `legal${++seq}@example.com`;
  const signup = await api(base, "/api/parents/signup", { method: "POST", body: { email, password: PASSWORD } });
  assert.equal(signup.status, 201, JSON.stringify(signup.json));
  const verify = await api(base, "/api/parents/verify-email", {
    method: "POST",
    body: { token: signup.json.verificationToken }
  });
  assert.equal(verify.status, 200);
  const login = await api(base, "/api/parents/login", { method: "POST", body: { email, password: PASSWORD } });
  assert.equal(login.status, 200);
  const policy = await api(base, "/api/consent/policy/latest");
  assert.equal(policy.status, 200);
  const consent = await api(base, "/api/consent/records", {
    method: "POST",
    token: login.json.token,
    body: { policyVersion: policy.json.version }
  });
  assert.equal(consent.status, 201, JSON.stringify(consent.json));
  return { email, token: login.json.token, policyVersion: policy.json.version };
}

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  // The signup route bucket (5/min/IP, the auth-security suite's domain)
  // would trip on this suite's parent-per-test fixtures; the legal suite
  // tests the legal catalog + SR-1 posture, not signup limits, so the
  // env-tunable bucket is widened for THIS server only.
  serverProcess = await startTestServer({
    port: 4781,
    databaseUrl: testDatabase.url,
    env: { SEED_DEMO_STUDENTS: "0", RATE_LIMIT_PARENT_SIGNUP_PER_IP_MIN: "20" }
  });
  await waitForHealth(API);
  db = new Client({ connectionString: testDatabase.url });
  await db.connect();

  // Second server on the SAME database in production mode (SR-1 proof).
  prodServerProcess = await startTestServer({
    port: 4782,
    databaseUrl: testDatabase.url,
    env: {
      SEED_DEMO_STUDENTS: "0",
      NODE_ENV: "production",
      ALLOWED_ORIGINS: "https://portal.example.com"
    }
  });
  await waitForHealth(API_PROD);
});

afterAll(async () => {
  await db.end();
  if (serverProcess) serverProcess.kill();
  if (prodServerProcess) prodServerProcess.kill();
  await new Promise((r) => setTimeout(r, 300));
  await dropTestDatabase(testDatabase.name);
});

describe("GET /api/legal/:kind/latest (public)", () => {
  for (const kind of ["privacy-policy", "terms-of-service"]) {
    test(`${kind}: returns the active seeded draft (public, versioned)`, async () => {
      const res = await api(API, `/api/legal/${kind}/latest`);
      assert.equal(res.status, 200);
      assert.equal(res.json.kind, kind);
      assert.equal(res.json.version, "1");
      assert.equal(res.json.locale, "en-US");
      assert.equal(res.json.active, true);
      assert.ok(res.json.createdAt);
      assert.ok(res.json.body.length > 500, "the seeded body is the full document text");
    });

    test(`${kind}: carries the counsel-review draft banner`, async () => {
      const res = await api(API, `/api/legal/${kind}/latest`);
      assert.match(res.json.body, /DRAFT/i);
      assert.match(res.json.body, /legal counsel/i);
    });

    test(`${kind}: placeholders are bracketed and marked`, async () => {
      const res = await api(API, `/api/legal/${kind}/latest`);
      // Every placeholder token is a [BRACKETED_UPPER_SNAKE] marker.
      const brackets = res.json.body.match(/\[[A-Z][A-Z0-9_]*\]/g) || [];
      assert.ok(brackets.length >= 3, `expected bracketed placeholders, found: ${brackets.join(", ")}`);
      // No unmarked template syntaxes that a renderer might pass through.
      assert.doesNotMatch(res.json.body, /\{\{|\}\}|<[A-Z_]+>/);
    });

    test(`${kind}: unknown-kind sibling route still 404s distinctly`, async () => {
      const res = await api(API, `/api/legal/${kind}-bogus/latest`);
      assert.equal(res.status, 404);
    });

    test(`${kind}: fail closed when no active row (restored after)`, async () => {
      await db.query("UPDATE legal_documents SET active = false WHERE kind = $1", [kind]);
      const res = await api(API, `/api/legal/${kind}/latest`);
      assert.equal(res.status, 404);
      await db.query("UPDATE legal_documents SET active = true WHERE kind = $1 AND version = '1'", [kind]);
      const back = await api(API, `/api/legal/${kind}/latest`);
      assert.equal(back.status, 200);
    });
  }
});

describe("migration 014: consent policy v2 (production consent statement)", () => {
  test("v2 is the single active version; the v1 placeholder is retained but inactive", async () => {
    const rows = (await db.query("SELECT version, active FROM consent_policy_versions ORDER BY version")).rows;
    const v1 = rows.find((r) => r.version === "1");
    const v2 = rows.find((r) => r.version === "2");
    assert.ok(v1, "v1 row retained (append-only evidence)");
    assert.equal(v1.active, false);
    assert.ok(v2, "v2 seeded");
    assert.equal(v2.active, true);
    assert.equal(rows.filter((r) => r.active).length, 1, "exactly one active policy");
  });

  test("GET /api/consent/policy/latest serves the production statement (not the NON-LEGAL placeholder)", async () => {
    const res = await api(API, "/api/consent/policy/latest");
    assert.equal(res.status, 200);
    assert.equal(res.json.version, "2");
    assert.doesNotMatch(res.json.policyText, /NOT LEGAL ADVICE/);
    assert.match(res.json.policyText, /Privacy Policy and Terms of Service/);
  });

  test("legal_documents has exactly one active row per kind", async () => {
    const rows = (await db.query("SELECT kind, COUNT(*)::int AS n FROM legal_documents WHERE active GROUP BY kind")).rows;
    assert.deepEqual(
      rows.map((r) => [r.kind, r.n]).sort(),
      [["privacy-policy", 1], ["terms-of-service", 1]]
    );
  });
});

describe("#68 invariant: legal-document bumps do NOT trigger re-consent", () => {
  test("publishing privacy-policy v2 leaves consent status and policy version untouched", async () => {
    const parent = await createVerifiedParentAndConsent(API);

    const before = await api(API, "/api/consent/status", { token: parent.token });
    assert.equal(before.status, 200);
    assert.equal(before.json.consentCurrent, true);
    assert.equal(before.json.currentPolicyVersion, "2");

    // Ops flow: publish a new privacy-policy version (insert + flip active).
    await db.query("UPDATE legal_documents SET active = false WHERE kind = 'privacy-policy'");
    await db.query(
      "INSERT INTO legal_documents (kind, version, locale, body, active) VALUES ('privacy-policy', '2', 'en-US', $1, true)",
      ["privacy policy v2 test body"]
    );

    const policyAfter = await api(API, "/api/consent/policy/latest");
    assert.equal(policyAfter.json.version, "2", "consent policy version unchanged by the legal bump");

    const statusAfter = await api(API, "/api/consent/status", { token: parent.token });
    assert.equal(statusAfter.json.consentCurrent, true, "legal-document bump must NOT decurrent consent");
    assert.equal(statusAfter.json.currentPolicyVersion, "2");

    // And child creation still works (no consent-required loop).
    const created = await api(API, "/api/students", {
      method: "POST",
      token: parent.token,
      body: { nickname: "LegalBump", username: `legalbump${++seq}`, currentGrade: "kindergarten", pin: "4455" }
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));

    // Restore the seeded v1 active (test hygiene).
    await db.query("DELETE FROM legal_documents WHERE kind = 'privacy-policy' AND version = '2'");
    await db.query("UPDATE legal_documents SET active = true WHERE kind = 'privacy-policy' AND version = '1'");
  });

  test("by contrast, a consent-policy bump DOES decurrent consent (machinery sanity)", async () => {
    const parent = await createVerifiedParentAndConsent(API);
    await db.query("UPDATE consent_policy_versions SET active = false WHERE version = '2'");
    await db.query(
      "INSERT INTO consent_policy_versions (version, locale, policy_text, active) VALUES ('3', 'en-US', $1, true)",
      ["v3 test policy — bumped text"]
    );
    const status = await api(API, "/api/consent/status", { token: parent.token });
    assert.equal(status.json.consentCurrent, false);
    assert.equal(status.json.currentPolicyVersion, "3");
    // Restore.
    await db.query("DELETE FROM consent_policy_versions WHERE version = '3'");
    await db.query("UPDATE consent_policy_versions SET active = true WHERE version = '2'");
  });
});

describe("SR-1: GET /api/students production data minimization", () => {
  // Parents/students are created through the DEV server (the production
  // server suppresses the dev verification-token seam, as it must); both
  // servers share the same database, so tokens minted on one resolve on
  // the other.
  test("production mode: anonymous listing refused with 401", async () => {
    const res = await api(API_PROD, "/api/students");
    assert.equal(res.status, 401);
    assert.equal(res.json.type, "https://balashikshana.dev/problems/unauthorized");
  });

  test("production mode: parent token refused with 403 wrong-token-type", async () => {
    const parent = await createVerifiedParentAndConsent(API);
    const res = await api(API_PROD, "/api/students", { token: parent.token });
    assert.equal(res.status, 403);
    assert.equal(res.json.type, "https://balashikshana.dev/problems/wrong-token-type");
  });

  test("production mode: student session receives ONLY its own card + summary", async () => {
    const parent = await createVerifiedParentAndConsent(API);
    const a = await api(API, "/api/students", {
      method: "POST",
      token: parent.token,
      body: { nickname: "ProdKidA", username: `prodkida${++seq}`, currentGrade: "kindergarten", pin: "3131" }
    });
    assert.equal(a.status, 201, JSON.stringify(a.json));
    const b = await api(API, "/api/students", {
      method: "POST",
      token: parent.token,
      body: { nickname: "ProdKidB", username: `prodkidb${++seq}`, currentGrade: "kindergarten", pin: "3232" }
    });
    assert.equal(b.status, 201, JSON.stringify(b.json));

    const listing = await api(API_PROD, "/api/students", { token: b.json.token });
    assert.equal(listing.status, 200);
    assert.equal(listing.json.students.length, 1, "only the caller's own card, never a directory");
    assert.equal(listing.json.students[0].studentId, b.json.student.studentId);
    assert.equal(listing.json.ownSummary.studentId, b.json.student.studentId);
  });

  test("dev mode unchanged: anonymous full listing still serves the harness", async () => {
    const parent = await createVerifiedParentAndConsent(API);
    const created = await api(API, "/api/students", {
      method: "POST",
      token: parent.token,
      body: { nickname: "DevKid", username: `devkid${++seq}`, currentGrade: "kindergarten", pin: "3434" }
    });
    assert.equal(created.status, 201);
    const res = await api(API, "/api/students");
    assert.equal(res.status, 200);
    assert.ok(res.json.students.length >= 1);
  });

  test("production mode: child-device session also receives ONLY its own card", async () => {
    const parent = await createVerifiedParentAndConsent(API);
    const child = await api(API, "/api/students", {
      method: "POST",
      token: parent.token,
      body: { nickname: "ProdCDT", username: `prodcdt${++seq}`, currentGrade: "kindergarten", pin: "3535" }
    });
    assert.equal(child.status, 201, JSON.stringify(child.json));

    // Mint a child-device token through the parent surface (dev server).
    const minted = await api(API, `/api/parent/children/${child.json.student.studentId}/device-sessions`, {
      method: "POST",
      token: parent.token,
      body: { clientDeviceId: "prod-cdt-test-device", platform: "ios" }
    });
    assert.equal(minted.status, 201, JSON.stringify(minted.json));

    // Earlier tests in this suite created other students in the SHARED
    // test database, so "length === 1" proves the filtering for the third
    // token kind (the suite runs fast; one parent per test keeps the
    // signup route bucket honest).
    const listing = await api(API_PROD, "/api/students", { token: minted.json.token });
    assert.equal(listing.status, 200);
    assert.equal(listing.json.students.length, 1, "child-device callers see only their bound child");
    assert.equal(listing.json.students[0].studentId, child.json.student.studentId);
    assert.equal(listing.json.ownSummary.studentId, child.json.student.studentId);
  });
});

describe("docs/legal mirrors stay byte-identical to the canonical migration seeds", () => {
  test("privacy-policy, terms-of-service, and consent-statement mirrors match migration 014", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const migration = readFileSync(resolve(here, "../migrations/014_legal_documents.cjs"), "utf8");

    const extract = (name) => {
      const m = migration.match(new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`));
      assert.ok(m, `migration 014 must define ${name}`);
      return m[1];
    };

    const mirror = (file) => readFileSync(resolve(here, "../../../docs/legal", file), "utf8");

    for (const [file, constant] of [
      ["privacy-policy.md", "PRIVACY_POLICY_BODY"],
      ["terms-of-service.md", "TERMS_OF_SERVICE_BODY"],
      ["consent-statement.md", "CONSENT_POLICY_V2_TEXT"]
    ]) {
      const doc = mirror(file);
      const body = extract(constant);
      // The mirror = frontmatter header + the exact seed body.
      assert.ok(doc.endsWith(body), `${file} must carry the canonical seed body verbatim (regenerate, never hand-edit)`);
    }
  });
});
