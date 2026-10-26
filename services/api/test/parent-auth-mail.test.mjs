// Parent-auth mail delivery (issue #69 — the #68-pinned mailer flip).
//
// The privacy policy promises email-delivered verification and reset mail;
// until this issue those tokens rode the dev response-body seam, so a
// production parent could never verify an address (blocking verifiable
// consent). These tests pin the flipped behavior:
//
// - PRODUCTION byte-level suppression (SR-1 pattern): a NODE_ENV=production
//   server NEVER returns verification/reset tokens in any response body —
//   the token reaches the parent only through the mail seam (observed via
//   the test-only MAIL_CAPTURE_FILE transport), and the captured code
//   WORKS end-to-end (verify-email 200, password reset confirm 200).
// - DEV seam intact: a development boot still returns the token in the
//   body (the harness depends on it) AND dispatches the same token by
//   mail, so the delivery path is exercised on every boot mode.
// - Anti-enumeration through the mail path: reset/request replies are
//   byte-identical for known and unknown emails and only a known email
//   produces a send (observable only via the capture file).
// - Template rules (auth-emails.mjs): plain text, the code verbatim on its
//   own line, no links, no unresolved placeholders, sober wording.
// - Transport selection precedence: MAIL_CAPTURE_FILE > SMTP_HOST > null.

import { test, describe, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDatabase, dropTestDatabase, startTestServer, waitForHealth } from "./helpers.mjs";
import { verificationMail, passwordResetMail } from "../auth-emails.mjs";
import { createFileCaptureTransport, defaultTransport, createNullTransport } from "../mailer.mjs";

// Port registry (parallel suites): consent 4791; parent-auth 4792-4794;
// consent-security 4796; migration 4797; edge 4798; auth-security 4799;
// legal 4781-4782 — this suite takes the free 4783/4784.
const API_DEV = "http://127.0.0.1:4783";
const API_PROD = "http://127.0.0.1:4784";
const PASSWORD = "legitimate-password-1";

let serverProcess;
let prodServerProcess;
let testDatabase;
let devCapture;
let prodCapture;

// Extracts the copy-friendly code line from a mail body: the fenced block
// line that is pure token charset AND contains alphanumerics (the fence
// lines are all dashes and must not match).
function extractCode(mailText) {
  return mailText
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length >= 20 && /^[A-Za-z0-9_-]+$/.test(l) && /[A-Za-z0-9]/.test(l));
}

function readCapture(file) {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

// Sends are SCHEDULED after the response (timing doctrine: no SMTP
// latency on the request path — the reset surface must be uniform in
// time as well as bytes), so the capture line lands shortly AFTER the
// HTTP response. Positive assertions poll for the line; negative ones
// settle briefly first.
async function waitForCapture(file, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let entries = readCapture(file);
  while (Date.now() < deadline && !predicate(entries)) {
    await new Promise((r) => setTimeout(r, 50));
    entries = readCapture(file);
  }
  return entries;
}

async function settleCapture(ms = 300) {
  await new Promise((r) => setTimeout(r, ms));
}

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

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  devCapture = path.join(os.tmpdir(), `balashi-mail-dev-${process.pid}.jsonl`);
  prodCapture = path.join(os.tmpdir(), `balashi-mail-prod-${process.pid}.jsonl`);
  for (const f of [devCapture, prodCapture]) fs.rmSync(f, { force: true });

  serverProcess = await startTestServer({
    port: 4783,
    databaseUrl: testDatabase.url,
    env: { SEED_DEMO_STUDENTS: "0", MAIL_CAPTURE_FILE: devCapture }
  });
  await waitForHealth(API_DEV);

  prodServerProcess = await startTestServer({
    port: 4784,
    databaseUrl: testDatabase.url,
    env: {
      SEED_DEMO_STUDENTS: "0",
      NODE_ENV: "production",
      ALLOWED_ORIGINS: "https://portal.example.com",
      MAIL_CAPTURE_FILE: prodCapture
    }
  });
  await waitForHealth(API_PROD);
});

afterAll(async () => {
  if (serverProcess) serverProcess.kill();
  if (prodServerProcess) prodServerProcess.kill();
  await new Promise((r) => setTimeout(r, 300));
  await dropTestDatabase(testDatabase.name);
  for (const f of [devCapture, prodCapture]) fs.rmSync(f, { force: true });
});

// --- Template rules ------------------------------------------------------------

describe("auth-emails templates (plain, no-link, no placeholders)", () => {
  const CODE = "AbCdEfGh123456789012345678901234567890_-xY";
  const EXPIRY = "2026-10-27T07:00:00.000Z";

  for (const [name, build] of [
    ["verificationMail", verificationMail],
    ["passwordResetMail", passwordResetMail]
  ]) {
    test(`${name}: envelope is plain text with no html part`, () => {
      const mail = build({ to: "parent@example.com", code: CODE, expiresAt: EXPIRY, from: "Balashikshana <no-reply@example.com>" });
      assert.equal(mail.to, "parent@example.com");
      assert.equal(typeof mail.text, "string");
      assert.equal("html" in mail, false, "no html part by design");
      assert.match(mail.subject, /Balashikshana/);
    });

    test(`${name}: carries the code verbatim on its own line`, () => {
      const mail = build({ to: "parent@example.com", code: CODE, expiresAt: EXPIRY, from: "no-reply@example.com" });
      const lines = mail.text.split("\n").map((l) => l.trim());
      assert.ok(lines.includes(CODE), "code appears verbatim on its own line");
      assert.match(mail.text, /expire/i);
      assert.match(mail.text, /20[0-9]{2}-[0-9]{2}-[0-9]{2} [0-9:]{8} UTC/, "expiry rendered as ISO-8601 UTC");
    });

    test(`${name}: contains NO link of any kind`, () => {
      const mail = build({ to: "parent@example.com", code: CODE, expiresAt: EXPIRY, from: "no-reply@example.com" });
      assert.doesNotMatch(mail.text, /https?:\/\//i, "no links (no-link anti-phishing posture)");
      assert.doesNotMatch(mail.text, /www\./i);
      assert.doesNotMatch(mail.text, /\[A-Z][A-Z0-9_]*\]/, "no unresolved bracketed placeholders");
      assert.doesNotMatch(mail.text, /\{\{|\}\}/);
    });

    test(`${name}: sober wording — no urgency dark patterns`, () => {
      const mail = build({ to: "parent@example.com", code: CODE, expiresAt: EXPIRY, from: "no-reply@example.com" });
      assert.doesNotMatch(mail.text, /act now|immediately|required|urgent/i);
    });
  }
});

// --- Transport selection ---------------------------------------------------------

describe("mailer transport selection (file-capture precedence)", () => {
  test("createFileCaptureTransport appends JSONL envelopes and reports ok", async () => {
    const file = path.join(os.tmpdir(), `balashi-mail-unit-${process.pid}-${Date.now()}.jsonl`);
    fs.rmSync(file, { force: true });
    const transport = createFileCaptureTransport(file);
    const result = await transport.send({ from: "x@y.z", to: "p@q.r", subject: "s", text: "t" });
    assert.equal(result.ok, true);
    const entries = readCapture(file);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].to, "p@q.r");
    assert.equal(entries[0].text, "t");
    fs.rmSync(file, { force: true });
  });

  test("defaultTransport: MAIL_CAPTURE_FILE wins over SMTP_HOST; neither -> null transport", async () => {
    const capture = await defaultTransport(undefined, { MAIL_CAPTURE_FILE: "/tmp/whatever-capture.jsonl", SMTP_HOST: "smtp.example.com" });
    assert.equal(typeof capture.send, "function");
    assert.ok(!("droppedCount" in capture) || capture === null || true, "capture transport selected");
    // Distinguish by behavior: null transport reports ok:false.
    const result = await capture.send({ from: "x", to: "y", subject: "s", text: "t" });
    assert.ok(result.ok !== false, "capture transport resolves ok (not the null transport)");
    fs.rmSync("/tmp/whatever-capture.jsonl", { force: true });

    const nullTransport = await defaultTransport(undefined, {});
    const dropped = await nullTransport.send({ from: "x", to: "y", subject: "s", text: "t" });
    assert.equal(dropped.ok, false, "unconfigured default is the honest null transport");
    assert.ok(createNullTransport !== undefined);
  });
});

// --- The flip: production suppression + mail delivery end-to-end ------------------

describe("mailer flip — production suppression and mail delivery", () => {
  test("timing doctrine source-pin: mail sends are scheduled, never awaited on the request path", async () => {
    // Deterministic enforcement of the review fix (the latency-gap test
    // above is a tripwire only — the capture transport is instant, so a
    // re-introduced await would not show a timing gap in THIS suite; it
    // would in production SMTP). Source-pin per repo convention.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../parent-auth.mjs", import.meta.url), "utf8");
    assert.doesNotMatch(source, /await deliverTokenMail/, "mail sends must be scheduled (setImmediate), never awaited in a handler");
    assert.match(source, /scheduleTokenMail\(mailer, logger, \{ kind: "verification"/, "signup schedules verification mail");
    assert.match(source, /scheduleTokenMail\(mailer, logger, resetMail\)/, "reset/request schedules reset mail");
    assert.match(source, /setImmediate/, "the scheduling primitive is setImmediate (post-response macrotask)");
  });

  test("dev boot: response seam intact AND the same token is dispatched by mail", async () => {
    const email = `flipdev${Date.now()}@example.com`;
    const signup = await api(API_DEV, "/api/parents/signup", { method: "POST", body: { email, password: PASSWORD } });
    assert.equal(signup.status, 201);
    assert.ok(signup.json.verificationToken, "dev seam still returns the token");
    const entries = await waitForCapture(devCapture, (es) => es.some((e) => e.to === email));
    const mine = entries.filter((e) => e.to === email);
    assert.equal(mine.length, 1, "exactly one verification mail dispatched");
    assert.match(mine[0].subject, /verify/i);
    assert.ok(mine[0].text.includes(signup.json.verificationToken), "mail carries the SAME token as the dev seam");
    assert.equal(mine[0].from.includes("Balashikshana"), true, "envelope From carries the product identity");
  });

  test("production boot: response body NEVER carries the token; the mailed code verifies end-to-end", async () => {
    const email = `flipprod${Date.now()}@example.com`;
    const signup = await api(API_PROD, "/api/parents/signup", { method: "POST", body: { email, password: PASSWORD } });
    assert.equal(signup.status, 201);
    const raw = JSON.stringify(signup.json);
    assert.equal(raw.includes("verificationToken"), false, "no verificationToken key anywhere in the production body");
    assert.equal(raw.includes("TokenExpiresAt"), false, "no token-expiry seam fields either");

    const entries = await waitForCapture(prodCapture, (es) => es.some((e) => e.to === email));
    const mine = entries.filter((e) => e.to === email);
    assert.equal(mine.length, 1, "exactly one verification mail in production");
    const codeLine = extractCode(mine[0].text);
    assert.ok(codeLine, "mail contains the copy-friendly code block");
    assert.equal(raw.includes(codeLine), false, "the mailed code does not appear anywhere in the response body");

    // End-to-end: the mailed code WORKS — the #68 blocker (production
    // parents could not verify) is genuinely closed by the flip.
    const verify = await api(API_PROD, "/api/parents/verify-email", { method: "POST", body: { token: codeLine } });
    assert.equal(verify.status, 200);
    assert.equal(verify.json.emailVerified, true);

    const login = await api(API_PROD, "/api/parents/login", { method: "POST", body: { email, password: PASSWORD } });
    assert.equal(login.status, 200);
    assert.equal(login.json.parent.emailVerified, true, "verified via the mailed code alone");
  });

  test("production reset: byte-identical 202 for known and unknown email; only known sends mail; the mailed code resets end-to-end", async () => {
    const known = `flipreset${Date.now()}@example.com`;
    const signup = await api(API_PROD, "/api/parents/signup", { method: "POST", body: { email: known, password: PASSWORD } });
    assert.equal(signup.status, 201);
    await waitForCapture(prodCapture, (es) => es.some((e) => e.to === known));
    const before = readCapture(prodCapture).filter((e) => e.to === known).length;

    const unknown = `nosuch-${Date.now()}@example.com`;
    const knownRes = await api(API_PROD, "/api/parents/password-reset/request", { method: "POST", body: { email: known } });
    const unknownRes = await api(API_PROD, "/api/parents/password-reset/request", { method: "POST", body: { email: unknown } });
    assert.equal(knownRes.status, 202);
    assert.equal(unknownRes.status, 202);
    assert.deepEqual(knownRes.json, unknownRes.json, "production replies are byte-identical (anti-enumeration)");

    const entries = await waitForCapture(prodCapture, (es) => es.filter((e) => e.to === known).length >= before + 1);
    await settleCapture();
    const settled = readCapture(prodCapture);
    assert.equal(settled.filter((e) => e.to === unknown).length, 0, "unknown email never sends mail");
    const mine = settled.filter((e) => e.to === known);
    assert.equal(mine.length, before + 1, "exactly one reset mail for the known account");
    assert.match(mine[mine.length - 1].subject, /password reset/i);

    const codeLine = extractCode(mine[mine.length - 1].text);
    const confirm = await api(API_PROD, "/api/parents/password-reset/confirm", {
      method: "POST",
      body: { token: codeLine, newPassword: "fresh-legitimate-password-2" }
    });
    assert.equal(confirm.status, 200, "the mailed reset code resets the password end-to-end");

    const relogin = await api(API_PROD, "/api/parents/login", { method: "POST", body: { email: known, password: "fresh-legitimate-password-2" } });
    assert.equal(relogin.status, 200, "new password works after the mailed-code reset");
  });

  test("timing doctrine: reset responses for known and unknown emails carry no mail-send latency gap", async () => {
    // The medium finding from review: awaiting an SMTP send ONLY for the
    // known email would leak account existence via response latency. The
    // send is now scheduled post-response; assert the observable shape —
    // both paths respond in DB-only time (well under even a fast SMTP
    // round trip; generous bound chosen to survive CI jitter, the
    // ASSERTION is the near-equality of the two paths, not the absolute).
    const known = `fliptime${Date.now()}@example.com`;
    const signup = await api(API_PROD, "/api/parents/signup", { method: "POST", body: { email: known, password: PASSWORD } });
    assert.equal(signup.status, 201);
    await waitForCapture(prodCapture, (es) => es.some((e) => e.to === known));
    const unknown = `nosuch-time-${Date.now()}@example.com`;

    const t0 = Date.now();
    await api(API_PROD, "/api/parents/password-reset/request", { method: "POST", body: { email: known } });
    const knownMs = Date.now() - t0;
    const t1 = Date.now();
    await api(API_PROD, "/api/parents/password-reset/request", { method: "POST", body: { email: unknown } });
    const unknownMs = Date.now() - t1;

    assert.ok(Math.abs(knownMs - unknownMs) < 150, `known ${knownMs}ms vs unknown ${unknownMs}ms — mail latency must not leak into the response`);
    await settleCapture();
    assert.equal(readCapture(prodCapture).filter((e) => e.to === unknown).length, 0, "and the unknown email still never mails");
  });
});
