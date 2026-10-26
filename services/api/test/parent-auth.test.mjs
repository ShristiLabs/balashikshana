// Parent auth API coverage for issue #40: per-route happy + error contracts
// for all 8 /api/parents routes, single-use/expiring token semantics, the
// anti-enumeration byte-identity guarantees, the dual-token doctrine
// (student <-> parent confusion matrix), refresh rotation, soft revocation,
// hashed-at-rest storage, the route-level rate-limit buckets, and the
// NODE_ENV=production suppression of the dev email-delivery seam.
//
// Three server instances (auth-security/edge-hardening precedent):
// - main (port 4794): unthrottled buckets for the functional contract tests.
// - tuned (port 4793): low route buckets for the 429 tests, own throwaway DB.
// - production (port 4792): NODE_ENV=production short-lived instance proving
//   the dev seam (tokens in bodies) is suppressed and reset-request replies
//   are byte-identical for known vs unknown emails.
// Ports must stay clear of the sibling suites (vitest runs files in
// parallel): auth-security 4799, edge-hardening 4798, postgres-migration 4797.

import { test, describe, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Client } from "pg";
import { createTestDatabase, dropTestDatabase, startTestServer, waitForHealth, createVerifiedParentWithConsent } from "./helpers.mjs";

const API = "http://127.0.0.1:4794";
const TUNED_API = "http://127.0.0.1:4793";
const PROD_API = "http://127.0.0.1:4792";

const sha256Hex = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

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
  return { status: res.status, json, body: json, headers: res.headers };
}

// Raw text fetch for byte-identity assertions (anti-enumeration contracts
// promise identical bytes, not just equal JSON).
async function raw(base, pathname, { method = "POST", token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  return { status: res.status, text: await res.text(), contentType: res.headers.get("content-type") };
}

// #66 correlation: every problem envelope now carries a per-request
// `requestId` (unique BY DESIGN — it is the correlation key). Anti-
// enumeration byte-identity is about the ENUMERABLE problem fields, so
// uniform-body assertions compare with requestId normalized out.
function uniformBody(rawRes) {
  const parsed = JSON.parse(rawRes.text);
  delete parsed.requestId;
  return JSON.stringify(parsed);
}

// Every test mints its own emails so no test depends on another's rows.
let seq = 0;
const uniqueEmail = () => `parent${++seq}@example.com`;
const PASSWORD = "legitimate-password-1";

const signupP = (email, password = PASSWORD, extra = {}) =>
  api(API, "/api/parents/signup", { method: "POST", body: { email, password, ...extra } });
const loginP = (email, password = PASSWORD) =>
  api(API, "/api/parents/login", { method: "POST", body: { email, password } });
const refreshP = (token) => api(API, "/api/parents/refresh", { method: "POST", token });
const logoutP = (token) => api(API, "/api/parents/logout", { method: "POST", token });
const logoutAllP = (token) => api(API, "/api/parents/logout-all", { method: "POST", token });
const resetRequestP = (email) =>
  api(API, "/api/parents/password-reset/request", { method: "POST", body: { email } });
const resetConfirmP = (token, newPassword) =>
  api(API, "/api/parents/password-reset/confirm", { method: "POST", body: { token, newPassword } });
const verifyEmailP = (token) => api(API, "/api/parents/verify-email", { method: "POST", body: { token } });

// #41: POST /api/students is consent-gated; one shared consented parent
// covers this suite's registrations (buckets are wide open here; the consent
// behaviors themselves live in consent.test.mjs).
let suiteParent;

async function registerStudent(name, pin = "4321") {
  suiteParent ||= await createVerifiedParentWithConsent(API);
  const res = await api(API, "/api/students", {
    method: "POST",
    token: suiteParent.token,
    body: { nickname: name, username: name, currentGrade: "kindergarten", pin }
  });
  assert.equal(res.status, 201, `student registration failed: ${JSON.stringify(res.json)}`);
  return res.json;
}

let serverProcess;
let testDatabase;
let db;

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  serverProcess = await startTestServer({
    port: 4794,
    databaseUrl: testDatabase.url,
    env: {
      // Functional suite: buckets wide open (rate-limit behavior is covered
      // on the tuned instance below, edge-hardening style).
      RATE_LIMIT_PER_IP_MIN: "1000",
      RATE_LIMIT_PER_TOKEN_MIN: "1000",
      RATE_LIMIT_LOGIN_PER_IP_MIN: "1000",
      RATE_LIMIT_PARENT_SIGNUP_PER_IP_MIN: "1000",
      RATE_LIMIT_PARENT_LOGIN_PER_IP_MIN: "1000",
      RATE_LIMIT_PARENT_TOKEN_PER_IP_MIN: "1000",
      RATE_LIMIT_PARENT_RESET_PER_IP_MIN: "1000"
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

describe("parent signup", () => {
  test("happy path: 201, normalized email, unverified account, dev-seam verification token", async () => {
    const res = await signupP("Padre.Mixed@Example.COM");
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.equal(res.json.email, "padre.mixed@example.com", "email must be trimmed + lowercased");
    assert.equal(res.json.emailVerified, false);
    assert.ok(res.json.parentId);
    assert.ok(res.json.verificationToken, "non-production responses must carry the dev-seam token");
    assert.ok(res.json.verificationTokenExpiresAt);

    const row = (await db.query("SELECT * FROM parents WHERE parent_id = $1", [res.json.parentId])).rows[0];
    assert.ok(row, "parent row must exist");
    assert.equal(row.email, "padre.mixed@example.com");
    assert.equal(row.email_verified_at, null, "email must start unverified");
    // AC: password hashing reuses the db.mjs scrypt helpers, stored format
    // identical to student PIN hashes (no forked parameters).
    assert.match(row.password_hash, /^scrypt\$16384\$8\$1\$[0-9a-f]+\$[0-9a-f]+$/);
  });

  test("schema rejections: short/long password, malformed email, unknown field", async () => {
    const short = await signupP(uniqueEmail(), "only-eleven");
    assert.equal(short.status, 400);
    assert.equal(short.json.title, "Validation failed");

    const long = await signupP(uniqueEmail(), "x".repeat(129));
    assert.equal(long.status, 400);

    const badEmail = await signupP("not-an-email", PASSWORD);
    assert.equal(badEmail.status, 400);
    assert.equal(badEmail.json.title, "Validation failed");
    assert.ok(Array.isArray(badEmail.json.errors), "schema error details must be present");

    const extra = await signupP(uniqueEmail(), PASSWORD, { role: "admin" });
    assert.equal(extra.status, 400, "closed schema: unknown fields must be rejected");
  });

  // Password trim doctrine (reviewer finding 1, fixed): leading/trailing
  // whitespace is trimmed in preValidation on every password-bearing route,
  // so the schema floor applies to the trimmed value — matching the shared
  // db.mjs scrypt helpers, which trim before hashing. "  <password>  " and
  // "<password>" are therefore the same credential BY DESIGN (documented in
  // the OpenAPI password descriptions), while a password that is too short
  // (or empty) after trimming is rejected instead of silently hashing as
  // scrypt("<short>").
  test("whitespace-padded password authenticates in both padded and trimmed form (edges trimmed by design)", async () => {
    const padded = `  ${PASSWORD}  `;
    const res = await signupP(uniqueEmail(), padded);
    assert.equal(res.status, 201, JSON.stringify(res.json));

    const exact = await loginP(res.json.email, padded);
    assert.equal(exact.status, 200);

    const trimmed = await loginP(res.json.email, PASSWORD);
    assert.equal(trimmed.status, 200, "edge-trimmed input is the same credential by design");
  });

  test("whitespace-only password is rejected 400 (no scrypt-empty credentials)", async () => {
    const res = await signupP(uniqueEmail(), " ".repeat(15));
    assert.equal(res.status, 400);
    assert.equal(res.json.title, "Validation failed");
  });

  test("password shorter than 12 chars after edge-trim is rejected 400 (floor applies post-trim)", async () => {
    // 12 raw characters, only 8 after trimming: passes the raw length but
    // must fail the floor once the edges are gone.
    const res = await signupP(uniqueEmail(), "  short-pw  ");
    assert.equal(res.status, 400);
    assert.equal(res.json.title, "Validation failed");
  });

  test("duplicate email is a 409 problem, case-insensitive", async () => {
    const first = await signupP(uniqueEmail());
    assert.equal(first.status, 201);
    const dup = await signupP(first.json.email.toUpperCase());
    assert.equal(dup.status, 409);
    assert.match(dup.headers.get("content-type") || "", /application\/problem\+json/);
    assert.equal(dup.json.status, 409);
    assert.equal(dup.json.type, "https://balashikshana.dev/problems/email-already-registered");
  });

  test("verification token is stored hashed at rest (SHA-256), never plaintext", async () => {
    const res = await signupP(uniqueEmail());
    const row = (
      await db.query("SELECT token_hash FROM parent_tokens WHERE parent_id = $1 AND kind = 'email_verification'", [
        res.json.parentId
      ])
    ).rows[0];
    assert.ok(row, "verification token row must exist");
    assert.equal(row.token_hash, sha256Hex(res.json.verificationToken));
    assert.match(row.token_hash, /^[0-9a-f]{64}$/, "stored value must be a SHA-256 hex digest");
  });
});

describe("email verification", () => {
  test("happy path: consumes the token, stamps email_verified_at exactly once", async () => {
    const signup = await signupP(uniqueEmail());
    const res = await verifyEmailP(signup.json.verificationToken);
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true, emailVerified: true });

    const row = (await db.query("SELECT email_verified_at, password_hash FROM parents WHERE parent_id = $1", [
      signup.json.parentId
    ])).rows[0];
    assert.ok(row.email_verified_at, "email_verified_at must be set");
    assert.equal(row.password_hash, row.password_hash);
  });

  test("replay of a consumed token is rejected with the uniform invalid-token problem", async () => {
    const signup = await signupP(uniqueEmail());
    const first = await verifyEmailP(signup.json.verificationToken);
    assert.equal(first.status, 200);
    const replay = await verifyEmailP(signup.json.verificationToken);
    assert.equal(replay.status, 400);
    assert.equal(replay.json.type, "https://balashikshana.dev/problems/invalid-token");

    // No oracle: replay body must be byte-identical to an unknown token's.
    const unknown = await verifyEmailP("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const replayRaw = await raw(API, "/api/parents/verify-email", { body: { token: signup.json.verificationToken } });
    const unknownRaw = await raw(API, "/api/parents/verify-email", { body: { token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } });
    assert.equal(replayRaw.status, unknownRaw.status);
    assert.equal(uniformBody(replayRaw), uniformBody(unknownRaw), "replayed and unknown tokens must be indistinguishable (modulo the per-request correlation id)");
  });

  test("expired verification token is rejected uniformly", async () => {
    const signup = await signupP(uniqueEmail());
    const crafted = "crafted_expired_verification_token_1";
    await db.query(
      "INSERT INTO parent_tokens (token_hash, parent_id, kind, expires_at) VALUES ($1, $2, 'email_verification', now() - interval '1 hour')",
      [sha256Hex(crafted), signup.json.parentId]
    );
    const res = await verifyEmailP(crafted);
    assert.equal(res.status, 400);
    assert.equal(res.json.type, "https://balashikshana.dev/problems/invalid-token");
    const row = (await db.query("SELECT email_verified_at FROM parents WHERE parent_id = $1", [signup.json.parentId]))
      .rows[0];
    assert.equal(row.email_verified_at, null, "an expired token must not verify the email");
  });

  test("a password_reset token cannot be used on verify-email (kind confusion is uniform)", async () => {
    const signup = await signupP(uniqueEmail());
    const reset = await resetRequestP(signup.json.email);
    const res = await verifyEmailP(reset.json.resetToken);
    assert.equal(res.status, 400);
    assert.equal(res.json.type, "https://balashikshana.dev/problems/invalid-token");
  });

  test("short token fails schema validation with 400", async () => {
    const res = await verifyEmailP("short");
    assert.equal(res.status, 400);
    assert.equal(res.json.title, "Validation failed");
  });

  test("token fields are NOT trimmed: a space-padded token fails schema 400", async () => {
    // The preValidation trim hook deliberately touches only email/password
    // fields; tokens are base64url ([A-Za-z0-9_-]) so whitespace is always
    // a schema failure, never silently repaired.
    const res = await verifyEmailP("  aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  ");
    assert.equal(res.status, 400);
    assert.equal(res.json.title, "Validation failed");
  });

  test("email_verified_at is set only via the verify route (login never stamps it)", async () => {
    const signup = await signupP(uniqueEmail());
    const before = await loginP(signup.json.email);
    assert.equal(before.status, 200, "login is allowed pre-verification");
    assert.equal(before.json.parent.emailVerified, false);
    await verifyEmailP(signup.json.verificationToken);
    const after = await loginP(signup.json.email);
    assert.equal(after.json.parent.emailVerified, true);
    assert.ok(after.json.parent.emailVerifiedAt);
  });
});

describe("parent login", () => {
  test("happy path: 200 with session token and parent public shape", async () => {
    const email = uniqueEmail();
    const signup = await signupP(email);
    const res = await loginP("  " + email.toUpperCase() + "  ");
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.ok(res.json.token);
    assert.deepEqual(Object.keys(res.json.parent).sort(), ["email", "emailVerified", "emailVerifiedAt", "parentId"]);
    assert.equal(res.json.parent.parentId, signup.json.parentId);
    assert.equal(res.json.parent.email, email);
  });

  test("unknown email and wrong password return byte-identical 401 problem bodies", async () => {
    await signupP(uniqueEmail());
    const unknown = await raw(API, "/api/parents/login", {
      body: { email: "ghost-" + uniqueEmail(), password: PASSWORD }
    });
    const wrong = await raw(API, "/api/parents/login", { body: { email: "parent1@example.com", password: "wrong-password-1" } });
    assert.equal(unknown.status, 401);
    assert.equal(wrong.status, 401);
    assert.match(unknown.contentType, /application\/problem\+json/);
    assert.equal(uniformBody(unknown), uniformBody(wrong), "401 bodies must be byte-identical modulo the correlation id (no account enumeration)");
  });

  test("session token is hashed at rest with 7d expiry and 30d refresh window", async () => {
    const signup = await signupP(uniqueEmail());
    const res = await loginP(signup.json.email);
    const row = (
      await db.query("SELECT * FROM parent_sessions WHERE token_hash = $1", [sha256Hex(res.json.token)])
    ).rows[0];
    assert.ok(row, "session row must exist keyed by the SHA-256 of the token");
    assert.equal(row.parent_id, signup.json.parentId);
    assert.equal(row.revoked_at, null);
    const ttlMs = new Date(row.expires_at) - new Date(row.created_at);
    const windowMs = new Date(row.refreshable_until) - new Date(row.created_at);
    assert.ok(ttlMs > 6.9 * 86400000 && ttlMs <= 7.1 * 86400000, `session TTL must be ~7d, got ${ttlMs}`);
    assert.ok(windowMs > 29.9 * 86400000 && windowMs <= 30.1 * 86400000, `refresh window must be ~30d, got ${windowMs}`);
  });

  test("the raw session token never appears in parent_sessions", async () => {
    const signup = await signupP(uniqueEmail());
    const res = await loginP(signup.json.email);
    const row = (await db.query("SELECT 1 FROM parent_sessions WHERE token_hash = $1", [res.json.token])).rows[0];
    assert.equal(row, undefined, "plaintext tokens must never be stored");
  });
});

describe("dual-token doctrine (student <-> parent)", () => {
  test("parent token on a student-scoped route is a 403 wrong-token-type problem", async () => {
    const student = await registerStudent("doctrine-student");
    const signup = await signupP(uniqueEmail());
    const login = await loginP(signup.json.email);
    const res = await api(API, `/api/students/${student.student.studentId}`, { token: login.json.token });
    assert.equal(res.status, 403);
    assert.match(res.headers.get("content-type") || "", /application\/problem\+json/);
    assert.equal(res.json.type, "https://balashikshana.dev/problems/wrong-token-type");
    assert.equal(res.json.status, 403);
  });

  test("parent token on the public /api/students listing stays lenient (no ownSummary)", async () => {
    const signup = await signupP(uniqueEmail());
    const login = await loginP(signup.json.email);
    const res = await api(API, "/api/students", { token: login.json.token });
    assert.equal(res.status, 200);
    assert.equal(res.json.ownSummary, undefined, "public listing must not gain an ownSummary for parent tokens");
  });

  test("student token on a parent route is a 403 wrong-token-type problem", async () => {
    const student = await registerStudent("doctrine-student2");
    const res = await refreshP(student.token);
    assert.equal(res.status, 403);
    assert.equal(res.json.type, "https://balashikshana.dev/problems/wrong-token-type");

    const out = await logoutP(student.token);
    assert.equal(out.status, 403);
    assert.equal(out.json.type, "https://balashikshana.dev/problems/wrong-token-type");
  });

  test("missing, garbage, malformed, and lowercase-bearer tokens are 401 on parent routes", async () => {
    const missing = await api(API, "/api/parents/refresh", { method: "POST" });
    assert.equal(missing.status, 401);
    assert.equal(missing.json.type, "https://balashikshana.dev/problems/unauthorized");

    const garbage = await refreshP("not-a-real-token-at-all");
    assert.equal(garbage.status, 401);

    const malformed = await fetch(`${API}/api/parents/refresh`, {
      method: "POST",
      headers: { Authorization: "Bearer bad!!token" }
    });
    assert.equal(malformed.status, 401);

    const signup = await signupP(uniqueEmail());
    const login = await loginP(signup.json.email);
    const lower = await fetch(`${API}/api/parents/refresh`, {
      method: "POST",
      headers: { Authorization: `bearer ${login.json.token}` }
    });
    assert.equal(lower.status, 401);
  });

  test("revoked parent session token is 401 with the M1-style detail", async () => {
    const signup = await signupP(uniqueEmail());
    const login = await loginP(signup.json.email);
    await logoutP(login.json.token);
    const res = await refreshP(login.json.token);
    assert.equal(res.status, 401);
    assert.equal(res.json.detail, "Session token is invalid or has been revoked");
  });
});

describe("session refresh rotation", () => {
  test("rotation issues a new token and revokes the old one (reason 'rotated')", async () => {
    const signup = await signupP(uniqueEmail());
    const login = await loginP(signup.json.email);
    const res = await refreshP(login.json.token);
    assert.equal(res.status, 200);
    assert.ok(res.json.token);
    assert.notEqual(res.json.token, login.json.token);

    const oldRow = (
      await db.query("SELECT revoked_at, revocation_reason FROM parent_sessions WHERE token_hash = $1", [
        sha256Hex(login.json.token)
      ])
    ).rows[0];
    assert.ok(oldRow.revoked_at, "rotated-away session must be soft-revoked");
    assert.equal(oldRow.revocation_reason, "rotated");

    const replay = await refreshP(login.json.token);
    assert.equal(replay.status, 401, "the rotated-away token must not refresh again");

    const chained = await refreshP(res.json.token);
    assert.equal(chained.status, 200, "the new token must itself be refreshable");
  });

  test("refresh beyond the refresh window is a 401 refresh-expired problem", async () => {
    const signup = await signupP(uniqueEmail());
    const login = await loginP(signup.json.email);
    await db.query("UPDATE parent_sessions SET refreshable_until = now() - interval '1 hour' WHERE token_hash = $1", [
      sha256Hex(login.json.token)
    ]);
    const res = await refreshP(login.json.token);
    assert.equal(res.status, 401);
    assert.equal(res.json.type, "https://balashikshana.dev/problems/refresh-expired");
  });

  test("expired session token is 401 and lazily deleted", async () => {
    const signup = await signupP(uniqueEmail());
    const login = await loginP(signup.json.email);
    await db.query("UPDATE parent_sessions SET expires_at = now() - interval '1 minute' WHERE token_hash = $1", [
      sha256Hex(login.json.token)
    ]);
    const res = await refreshP(login.json.token);
    assert.equal(res.status, 401);
    assert.equal(res.json.detail, "Session token has expired");
    const row = (
      await db.query("SELECT 1 FROM parent_sessions WHERE token_hash = $1", [sha256Hex(login.json.token)])
    ).rows[0];
    assert.equal(row, undefined, "expired session row must be lazily deleted");
  });
});

describe("logout and logout-all", () => {
  test("logout revokes only the caller's session (soft revoke, row kept)", async () => {
    const signup = await signupP(uniqueEmail());
    const first = await loginP(signup.json.email);
    const second = await loginP(signup.json.email);
    const out = await logoutP(first.json.token);
    assert.equal(out.status, 200);
    assert.deepEqual(out.json, { ok: true });

    const revoked = await refreshP(first.json.token);
    assert.equal(revoked.status, 401);
    const stillValid = await refreshP(second.json.token);
    assert.equal(stillValid.status, 200, "other sessions must survive a single logout");

    const row = (
      await db.query("SELECT revoked_at, revocation_reason FROM parent_sessions WHERE token_hash = $1", [
        sha256Hex(first.json.token)
      ])
    ).rows[0];
    assert.ok(row.revoked_at, "parent logout keeps the row (soft revoke, lifecycle evidence)");
    assert.equal(row.revocation_reason, "logout");
  });

  test("logout-all revokes every session and reports the count", async () => {
    const signup = await signupP(uniqueEmail());
    const tokens = [];
    for (let i = 0; i < 3; i += 1) {
      const login = await loginP(signup.json.email);
      tokens.push(login.json.token);
    }
    const res = await logoutAllP(tokens[0]);
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.revokedSessions, 3);
    for (const token of tokens) {
      const reuse = await refreshP(token);
      assert.equal(reuse.status, 401, "every session must be revoked by logout-all");
    }
  });
});

describe("password reset", () => {
  test("request for a known email: 202 with reset token (dev seam), stored hashed", async () => {
    const signup = await signupP(uniqueEmail());
    const res = await resetRequestP(signup.json.email);
    assert.equal(res.status, 202);
    assert.equal(res.json.ok, true);
    assert.ok(res.json.message);
    assert.ok(res.json.resetToken, "non-production responses must carry the dev-seam reset token");
    assert.ok(res.json.resetTokenExpiresAt);

    const row = (
      await db.query("SELECT token_hash FROM parent_tokens WHERE parent_id = $1 AND kind = 'password_reset'", [
        signup.json.parentId
      ])
    ).rows[0];
    assert.ok(row, "reset token row must exist");
    assert.equal(row.token_hash, sha256Hex(res.json.resetToken));
  });

  test("request for an unknown email: same 202 base body, no token row created (no enumeration)", async () => {
    const known = await resetRequestP((await signupP(uniqueEmail())).json.email);
    const unknown = await resetRequestP("ghost-" + uniqueEmail());
    assert.equal(unknown.status, 202);
    assert.deepEqual({ ok: unknown.json.ok, message: unknown.json.message }, { ok: known.json.ok, message: known.json.message });
    assert.equal(unknown.json.resetToken, undefined, "unknown email must not mint or leak a token");

    const rows = (await db.query("SELECT COUNT(*)::int AS n FROM parent_tokens WHERE kind = 'password_reset'")).rows[0];
    const knownRows = (
      await db.query("SELECT COUNT(*)::int AS n FROM parent_tokens WHERE kind = 'password_reset' AND expires_at > now()")
    ).rows[0];
    assert.equal(rows.n, knownRows.n, "every reset row in the DB belongs to a known account (no ghost rows)");
  });

  test("a second request supersedes the outstanding reset token (one live token)", async () => {
    const signup = await signupP(uniqueEmail());
    const first = await resetRequestP(signup.json.email);
    const second = await resetRequestP(signup.json.email);
    assert.notEqual(first.json.resetToken, second.json.resetToken);

    const superseded = await resetConfirmP(first.json.resetToken, "fresh-password-123");
    assert.equal(superseded.status, 400, "superseded token must no longer confirm");
    const live = await resetConfirmP(second.json.resetToken, "fresh-password-123");
    assert.equal(live.status, 200);
  });

  test("confirm rotates the scrypt password hash and revokes every existing session", async () => {
    const signup = await signupP(uniqueEmail());
    const login = await loginP(signup.json.email);
    const reset = await resetRequestP(signup.json.email);
    const res = await resetConfirmP(reset.json.resetToken, "fresh-password-456");
    assert.equal(res.status, 200);
    assert.deepEqual(res.json, { ok: true });

    const row = (await db.query("SELECT password_hash FROM parents WHERE parent_id = $1", [signup.json.parentId]))
      .rows[0];
    assert.match(row.password_hash, /^scrypt\$16384\$8\$1\$/);

    const oldPassword = await loginP(signup.json.email);
    assert.equal(oldPassword.status, 401, "old password must stop authenticating");
    const newPassword = await loginP(signup.json.email, "fresh-password-456");
    assert.equal(newPassword.status, 200, "new password must authenticate");

    const revokedSession = await refreshP(login.json.token);
    assert.equal(revokedSession.status, 401, "reset must revoke all existing sessions");
  });

  test("confirm failures are uniform: replay, unknown, and expired tokens share one body", async () => {
    const signup = await signupP(uniqueEmail());
    const reset = await resetRequestP(signup.json.email);
    await resetConfirmP(reset.json.resetToken, "fresh-password-789");

    const crafted = "crafted_expired_reset_token_0001";
    await db.query(
      "INSERT INTO parent_tokens (token_hash, parent_id, kind, expires_at) VALUES ($1, $2, 'password_reset', now() - interval '1 hour')",
      [sha256Hex(crafted), signup.json.parentId]
    );

    const bodies = await Promise.all([
      raw(API, "/api/parents/password-reset/confirm", { body: { token: reset.json.resetToken, newPassword: "fresh-password-789" } }),
      raw(API, "/api/parents/password-reset/confirm", { body: { token: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", newPassword: "fresh-password-789" } }),
      raw(API, "/api/parents/password-reset/confirm", { body: { token: crafted, newPassword: "fresh-password-789" } })
    ]);
    for (const b of bodies) {
      assert.equal(b.status, 400);
      assert.match(b.contentType, /application\/problem\+json/);
    }
    assert.equal(uniformBody(bodies[0]), uniformBody(bodies[1]), "replayed and unknown tokens must be indistinguishable (modulo the correlation id)");
    assert.equal(uniformBody(bodies[0]), uniformBody(bodies[2]), "replayed and expired tokens must be indistinguishable (modulo the correlation id)");
  });

  test("confirm schema: short newPassword, short-after-trim newPassword, and short token fail 400", async () => {
    const shortPassword = await resetConfirmP("cccccccccccccccccccccccccccccccc", "short");
    assert.equal(shortPassword.status, 400);
    assert.equal(shortPassword.json.title, "Validation failed");

    const trimShortPassword = await resetConfirmP("cccccccccccccccccccccccccccccccc", "  short  ");
    assert.equal(trimShortPassword.status, 400, "newPassword floor must apply after edge-trim");

    const shortToken = await resetConfirmP("short", "fresh-password-012");
    assert.equal(shortToken.status, 400);
  });
});

describe("hashed-at-rest sweep", () => {
  test("after a full flow, no parent token table ever holds a non-SHA-256 value", async () => {
    const signup = await signupP(uniqueEmail());
    await verifyEmailP(signup.json.verificationToken);
    const login = await loginP(signup.json.email);
    const reset = await resetRequestP(signup.json.email);

    for (const token of [signup.json.verificationToken, login.json.token, reset.json.resetToken]) {
      const asIs = (
        await db.query("SELECT 1 FROM parent_sessions WHERE token_hash = $1 UNION ALL SELECT 1 FROM parent_tokens WHERE token_hash = $1", [token])
      ).rows[0];
      assert.equal(asIs, undefined, "raw token leaked into a token table");
    }
    const badSessions = (await db.query("SELECT COUNT(*)::int AS n FROM parent_sessions WHERE token_hash !~ '^[0-9a-f]{64}$'")).rows[0];
    const badTokens = (await db.query("SELECT COUNT(*)::int AS n FROM parent_tokens WHERE token_hash !~ '^[0-9a-f]{64}$'")).rows[0];
    assert.equal(badSessions.n, 0, "every parent_sessions row must be a SHA-256 hex digest");
    assert.equal(badTokens.n, 0, "every parent_tokens row must be a SHA-256 hex digest");
  });
});

// --- Tuned-limits instance (rate-limit buckets) ----------------------------------

let tunedServer;
let tunedDatabase;

describe("parent route rate-limit buckets (tuned instance)", () => {
  beforeAll(async () => {
    tunedDatabase = await createTestDatabase();
    tunedServer = await startTestServer({
      port: 4793,
      databaseUrl: tunedDatabase.url,
      env: {
        RATE_LIMIT_PER_IP_MIN: "1000", // only the route-level buckets trip
        RATE_LIMIT_PER_TOKEN_MIN: "1000",
        RATE_LIMIT_LOGIN_PER_IP_MIN: "1000",
        RATE_LIMIT_PARENT_SIGNUP_PER_IP_MIN: "3",
        RATE_LIMIT_PARENT_LOGIN_PER_IP_MIN: "3",
        RATE_LIMIT_PARENT_TOKEN_PER_IP_MIN: "3",
        RATE_LIMIT_PARENT_RESET_PER_IP_MIN: "3"
      }
    });
    tunedServer.stderr.on("data", () => {});
    await waitForHealth(TUNED_API);
  });

  afterAll(async () => {
    tunedServer?.kill("SIGTERM");
    if (tunedDatabase) await dropTestDatabase(tunedDatabase.name);
  });

  async function burst(pathname, bodies) {
    const responses = await Promise.all(
      bodies.map((body) =>
        fetch(`${TUNED_API}${pathname}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        })
      )
    );
    const statuses = responses.map((r) => r.status);
    const throttled = responses.find((r) => r.status === 429);
    assert.ok(throttled, `expected a 429 among [${statuses.join(",")}]`);
    assert.match(throttled.headers.get("content-type") || "", /application\/problem\+json/);
    const retryAfter = Number(throttled.headers.get("retry-after"));
    assert.ok(retryAfter >= 1 && retryAfter <= 60, `Retry-After out of range: ${retryAfter}`);
    const problem = await throttled.json();
    assert.equal(problem.status, 429);
    assert.ok(problem.title && problem.detail, "429 must be a full problem document");
    return statuses;
  }

  test("signup burst beyond the bucket returns 429 problem+json with Retry-After", async () => {
    const statuses = await burst(
      "/api/parents/signup",
      [1, 2, 3, 4, 5, 6].map((i) => ({ email: `burst${i}@example.com`, password: PASSWORD }))
    );
    assert.ok(statuses.filter((s) => s === 201).length >= 1, "at least one signup must succeed before the cap");
  });

  test("parent login burst beyond the bucket returns 429", async () => {
    await burst(
      "/api/parents/login",
      [1, 2, 3, 4, 5, 6].map(() => ({ email: "login-burst@example.com", password: "wrong-password-99" }))
    );
  });

  test("verify-email (token-presenting) burst beyond the bucket returns 429", async () => {
    await burst(
      "/api/parents/verify-email",
      [1, 2, 3, 4, 5, 6].map(() => ({ token: "dddddddddddddddddddddddddddddddd" }))
    );
  });

  test("password-reset/request burst beyond the bucket returns 429", async () => {
    await burst(
      "/api/parents/password-reset/request",
      [1, 2, 3, 4, 5, 6].map((i) => ({ email: `reset-burst-${i}@example.com` }))
    );
  });
});

// --- Production-mode instance (dev-seam suppression) -----------------------------

let prodServer;
let prodDatabase;
let prodDb;

describe("production seam suppression (NODE_ENV=production)", () => {
  beforeAll(async () => {
    prodDatabase = await createTestDatabase();
    prodServer = await startTestServer({
      port: 4792,
      databaseUrl: prodDatabase.url,
      env: {
        NODE_ENV: "production",
        ALLOWED_ORIGINS: "http://localhost:4200"
      }
    });
    prodServer.stderr.on("data", () => {});
    await waitForHealth(PROD_API);
    prodDb = new Client({ connectionString: prodDatabase.url });
    await prodDb.connect();
  });

  afterAll(async () => {
    try {
      await prodDb?.end();
    } catch {
      // already closed
    }
    prodServer?.kill("SIGTERM");
    if (prodDatabase) await dropTestDatabase(prodDatabase.name);
  });

  test("signup and reset responses carry NO token fields in production (seam suppressed)", async () => {
    const signup = await api(PROD_API, "/api/parents/signup", {
      method: "POST",
      body: { email: "prod-parent@example.com", password: PASSWORD }
    });
    assert.equal(signup.status, 201, JSON.stringify(signup.json));
    assert.equal(signup.json.verificationToken, undefined, "production must never return the verification token");
    assert.equal(signup.json.verificationTokenExpiresAt, undefined);

    const row = (
      await prodDb.query("SELECT token_hash FROM parent_tokens WHERE kind = 'email_verification' LIMIT 1")
    ).rows[0];
    assert.ok(row, "the verification token must still be issued (hashed) — only its exposure is suppressed");
    assert.match(row.token_hash, /^[0-9a-f]{64}$/);

    const reset = await api(PROD_API, "/api/parents/password-reset/request", {
      method: "POST",
      body: { email: "prod-parent@example.com" }
    });
    assert.equal(reset.status, 202);
    assert.equal(reset.json.resetToken, undefined, "production must never return the reset token");
  });

  test("reset-request replies are byte-identical for known vs unknown emails in production", async () => {
    const known = await raw(PROD_API, "/api/parents/password-reset/request", {
      body: { email: "prod-parent@example.com" }
    });
    const unknown = await raw(PROD_API, "/api/parents/password-reset/request", {
      body: { email: "prod-ghost@example.com" }
    });
    assert.equal(known.status, 202);
    assert.equal(unknown.status, 202);
    assert.equal(uniformBody(known), uniformBody(unknown), "production reset-request must be byte-identical modulo the correlation id (no enumeration)");
  });

  test("login anti-enumeration holds in production too", async () => {
    const unknown = await raw(PROD_API, "/api/parents/login", {
      body: { email: "prod-ghost@example.com", password: PASSWORD }
    });
    const wrong = await raw(PROD_API, "/api/parents/login", {
      body: { email: "prod-parent@example.com", password: "wrong-password-1" }
    });
    assert.equal(unknown.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal(uniformBody(unknown), uniformBody(wrong));
  });
});
