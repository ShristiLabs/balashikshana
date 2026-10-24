// Shared harness helpers for API tests: each suite gets a throwaway
// PostgreSQL database (created from the server's maintenance connection)
// so tests never touch dev data and run in parallel safely.

import { Client } from "pg";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(__dirname, "../server.mjs");

const BASE_DATABASE_URL =
  process.env.DATABASE_URL || "postgres://balashikshana:balashikshana_dev@localhost:5432/balashikshana_db";

export async function createTestDatabase() {
  const admin = new Client({ connectionString: BASE_DATABASE_URL, database: "postgres" });
  await admin.connect();
  const dbName = `balashikshana_test_${process.pid}_${Math.floor(Math.random() * 100000)}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();

  const url = new URL(BASE_DATABASE_URL);
  url.pathname = `/${dbName}`;

  return { name: dbName, url: url.toString() };
}

export async function dropTestDatabase(name) {
  const admin = new Client({ connectionString: BASE_DATABASE_URL, database: "postgres" });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.end();
}

export async function startTestServer({ port, databaseUrl, env = {}, onStdout, onStderr }) {
  const child = spawn(process.execPath, ["--no-warnings", SERVER], {
    env: { ...process.env, ...env, PORT: String(port), DATABASE_URL: databaseUrl },
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (onStdout) child.stdout.on("data", (c) => onStdout(String(c)));
  if (onStderr) child.stderr.on("data", (c) => onStderr(String(c)));
  return child;
}

export async function waitForHealth(api, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${api}/api/health`);
      if (res.ok) return;
    } catch {
      // not up yet (migrations + seed can take a few seconds on a cold DB)
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("API server did not become healthy in time");
}

// --- Consented student creation (issue #41) ---------------------------------
// POST /api/students is consent-gated: it requires a verified parent session
// whose latest consent record matches the active policy version. Suites that
// create students go through these helpers (fresh parent per call by
// default so no suite depends on shared rows or shared token buckets).

let consentSeq = 0;

async function jsonCall(api, pathname, { method = "GET", token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${api}${pathname}`, {
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

// signup -> verify-email (dev seam returns the token in the body) -> login
// -> consent capture at the ACTIVE policy version. Returns
// { parentId, token, policyVersion, email } with consentCurrent=true, or
// throws with the failing step.
export async function createVerifiedParentWithConsent(api, { password = "legitimate-password-1" } = {}) {
  const email = `consent-parent${++consentSeq}@example.com`;

  const signup = await jsonCall(api, "/api/parents/signup", { method: "POST", body: { email, password } });
  if (signup.status !== 201) throw new Error(`parent signup failed: ${JSON.stringify(signup.json)}`);
  // Dev seam: the verification token is in the response body (suppressed in
  // production; see parent-auth.mjs).
  const verify = await jsonCall(api, "/api/parents/verify-email", {
    method: "POST",
    body: { token: signup.json.verificationToken }
  });
  if (verify.status !== 200) throw new Error(`verify-email failed: ${JSON.stringify(verify.json)}`);

  const login = await jsonCall(api, "/api/parents/login", { method: "POST", body: { email, password } });
  if (login.status !== 200) throw new Error(`parent login failed: ${JSON.stringify(login.json)}`);

  const policy = await jsonCall(api, "/api/consent/policy/latest");
  if (policy.status !== 200) throw new Error(`policy/latest failed: ${JSON.stringify(policy.json)}`);

  const consent = await jsonCall(api, "/api/consent/records", {
    method: "POST",
    token: login.json.token,
    body: { policyVersion: policy.json.version }
  });
  if (consent.status !== 201) throw new Error(`consent capture failed: ${JSON.stringify(consent.json)}`);

  return {
    parentId: login.json.parent.parentId,
    email,
    token: login.json.token,
    policyVersion: policy.json.version,
    consent
  };
}

// Full consented registration: consented parent + POST /api/students with
// the parent token (the gated route). Returns the 201 registration body
// ({ token, student, summary }) or throws.
export async function registerConsentedStudent(api, studentPayload = {}, parent) {
  const who = parent || (await createVerifiedParentWithConsent(api));
  const res = await jsonCall(api, "/api/students", {
    method: "POST",
    token: who.token,
    body: { nickname: "Explorer", currentGrade: "kindergarten", pin: "5533", ...studentPayload }
  });
  if (res.status !== 201) {
    throw new Error(`consented student registration failed: ${JSON.stringify(res.json)}`);
  }
  return { ...res.json, parent: who };
}
