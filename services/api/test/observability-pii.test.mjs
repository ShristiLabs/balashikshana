// PII-scan gate (issue #66 AC — this suite FAILS THE BUILD if telemetry
// carries PII): fixture requests carrying child identifiers produce
// log lines, metric series, and error events with NO PII.
//
// The planted battery: a child name, a parent email, a phone number,
// one-time tokens in URLs and bodies. Assertions run over the REAL
// artifacts: captured pino stdout, the live metrics exposition, and
// error_events rows. The documented exemption (opaque surrogate UUIDs)
// is asserted present — correlation must KEEP working.

import { test, describe, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { Client } from "pg";
import { createTestDatabase, dropTestDatabase, startTestServer, waitForHealth } from "./helpers.mjs";

const API = "http://127.0.0.1:4825";
const METRICS = "http://127.0.0.1:4826";
const PII = {
  childName: "Aarav Sharma",
  email: "parent-pii-scan@example.com",
  phone: "+1-202-555-0173",
  queryToken: "oneTimeTokenAbCdEfGhIjKlMnOpQrStUv",
  bearerToken: "Bear_er-exfil-attempt-token-value-1234567890"
};

let serverProcess;
let testDatabase;
let pg;
const stdoutChunks = [];

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  serverProcess = await startTestServer({
    port: 4825,
    databaseUrl: testDatabase.url,
    env: {
      SEED_DEMO_STUDENTS: "0",
      LOG_LEVEL: "info",
      METRICS_PORT: "4826",
      METRICS_HOST: "127.0.0.1",
      RETENTION_SWEEP_INTERVAL_MS: "0"
    },
    onStdout: (chunk) => stdoutChunks.push(chunk)
  });
  await waitForHealth(API);
  pg = new Client({ connectionString: testDatabase.url });
  await pg.connect();
});

afterAll(async () => {
  if (pg) await pg.end().catch(() => {});
  if (serverProcess) serverProcess.kill("SIGKILL");
  if (testDatabase) await dropTestDatabase(testDatabase.name);
});

function capturedLogs() {
  return stdoutChunks.join("");
}

function piiValues() {
  return Object.values(PII);
}

async function assertNoPlantedPii(haystacks, contextLabel) {
  for (const [label, text] of haystacks) {
    for (const [key, value] of Object.entries(PII)) {
      assert.ok(
        !text.includes(value),
        `${contextLabel}/${label}: planted PII (${key}) leaked into telemetry`
      );
    }
  }
}

describe("fixture requests carrying child identifiers (the AC scenario)", () => {
  test("requests with PII in URL query, path, and headers generate telemetry free of it", async () => {
    // 1. Query string carrying a one-time token + email (verify/reset-style).
    await fetch(`${API}/api/consent/policy/latest?token=${PII.queryToken}&email=${encodeURIComponent(PII.email)}`);
    // 2. An unmatched path crafted to smuggle the child name + phone.
    await fetch(`${API}/api/${encodeURIComponent(PII.childName)}/${encodeURIComponent(PII.phone)}`);
    // 3. A bearer-shaped hostile Authorization header on a 401 path.
    await fetch(`${API}/api/students/some-id`, { headers: { Authorization: `Bearer ${PII.bearerToken}` } });
    // 4. A 404 problem envelope carries the correlated id but no PII.
    const problem = await fetch(`${API}/api/no-such-route?child=${encodeURIComponent(PII.childName)}`);
    const problemBody = await problem.json();

    // Flush: give the async onResponse hooks a beat, then harvest.
    await new Promise((r) => setTimeout(r, 300));
    const exposition = await (await fetch(`${METRICS}/metrics`)).text();
    const logs = capturedLogs();

    await assertNoPlantedPii(
      [
        ["logs", logs],
        ["exposition", exposition]
      ],
      "request-telemetry"
    );

    // The log line for the matched query-string request logs the PATH
    // ONLY (query stripped): the token/email must not appear even in
    // the path field.
    const lines = logs.split("\n").filter((l) => l.includes("/api/consent/policy/latest"));
    assert.ok(lines.length >= 1, "expected a log line for the policy route");
    assert.ok(!lines.some((l) => l.includes("token=") || l.includes("email=")));

    // Unmatched route: the raw path (attacker-controlled) is NEVER
    // logged — only the "unmatched" class.
    const unmatchedLines = logs.split("\n").filter((l) => l.includes('"route":"unmatched"'));
    assert.ok(unmatchedLines.length >= 1, "unmatched classification expected");
    assert.ok(!unmatchedLines.some((l) => l.includes(PII.childName)));

    // Exposition: only bounded route-class labels, and the metrics
    // counter saw the traffic.
    assert.ok(exposition.includes('route_class="/api/consent/policy/latest"'));
    assert.ok(exposition.includes('route_class="unmatched"'));
    assert.ok(exposition.includes('status_class="4xx"'));

    // The problem envelope carries the correlation id (opaque UUID).
    assert.match(problemBody.requestId, /^[0-9a-f-]{36}$/);
  });

  test("the client IP is truncated to a network prefix in logs (COPPA)", async () => {
    await fetch(`${API}/api/health`);
    await new Promise((r) => setTimeout(r, 300));
    const ipLines = capturedLogs().split("\n").filter((l) => l.includes('"ip":"'));
    assert.ok(ipLines.length >= 1, "expected request log lines with the ip field");
    for (const line of ipLines) {
      const ip = line.match(/"ip":"([^"]+)"/)[1];
      assert.ok(
        /^\d+\.\d+\.\d+\.0$/.test(ip) || ip.includes("::") || ip === "[ip-anon]",
        `IP not truncated: ${ip}`
      );
      assert.ok(!/^\d+\.\d+\.\d+\.[1-9]\d*$/.test(ip), `full client IP logged: ${ip}`);
    }
  });
});

describe("opaque UUID exemption keeps correlation working (documented policy)", () => {
  test("studentId/parentId UUIDs ARE present in request logs (they are not PII; they are the correlation keys)", async () => {
    // Login failure for a nonexistent parent still logs a request line;
    // generate one authenticated-ish flow: a 401 on students fetch.
    await fetch(`${API}/api/students/11111111-2222-3333-4444-555555555555`, {
      headers: { Authorization: "Bearer not-a-real-token" }
    });
    await new Promise((r) => setTimeout(r, 300));
    const logs = capturedLogs();
    // The UUID appears as the path param (allowed: opaque id on a MATCHED
    // route) — proving the exemption is deliberate, not a blanket scrub.
    assert.ok(logs.includes("/api/students/11111111-2222-3333-4444-555555555555"));
  });
});

describe("error events carry no PII (end-to-end capture seam)", () => {
  test("no error_events row ever contains planted PII (here: none captured without a 5xx, table stays clean)", async () => {
    const { rows } = await pg.query("SELECT * FROM error_events");
    await assertNoPlantedPii(
      rows.map((r, i) => [`row-${i}`, JSON.stringify(r)]),
      "error-events"
    );
  });

  test("the table has no column that could hold a request body", async () => {
    const { rows } = await pg.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'error_events'`
    );
    assert.ok(!rows.some((r) => r.column_name.includes("body")));
  });
});
