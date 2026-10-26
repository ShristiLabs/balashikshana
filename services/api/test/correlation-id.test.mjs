// Correlation-ID tests (issue #66 AC): ids survive the full path —
// inbound header honored when a well-formed UUID, echoed on the reply
// header AND inside the problem+json envelope; anything else is
// replaced (no reflection, no log injection).

import { test, describe, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { createTestDatabase, dropTestDatabase, startTestServer, waitForHealth } from "./helpers.mjs";

const API = "http://127.0.0.1:4824";
let serverProcess;
let testDatabase;

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  serverProcess = await startTestServer({
    port: 4824,
    databaseUrl: testDatabase.url,
    env: { SEED_DEMO_STUDENTS: "0", LOG_LEVEL: "silent" }
  });
  await waitForHealth(API);
});

afterAll(async () => {
  if (serverProcess) serverProcess.kill("SIGKILL");
  if (testDatabase) await dropTestDatabase(testDatabase.name);
});

const VALID = "7f9c24e8-3f04-4d3f-9d2a-1b6c8e5a2f10";

describe("inbound X-Request-Id continuity", () => {
  test("valid UUID is honored: same id on reply header and in the problem body", async () => {
    const res = await fetch(`${API}/api/no-such-route`, { headers: { "X-Request-Id": VALID } });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("x-request-id"), VALID);
    const body = await res.json();
    assert.equal(body.requestId, VALID);
  });

  test("health responses carry the id too (success path)", async () => {
    const res = await fetch(`${API}/api/health`, { headers: { "X-Request-Id": VALID } });
    assert.equal(res.headers.get("x-request-id"), VALID);
  });

  test("uppercase UUID form is honored (case-insensitive parse)", async () => {
    const res = await fetch(`${API}/api/no-such-route`, {
      headers: { "X-Request-Id": VALID.toUpperCase() }
    });
    const echoed = res.headers.get("x-request-id");
    assert.ok(echoed);
    assert.equal(echoed.toLowerCase(), VALID);
  });
});

describe("inbound id validation (no reflection, no injection)", () => {
  const hostileValues = [
    "not-a-uuid",
    // HTTP stacks reject literal newlines client-side; the URL-ENCODED
    // CRLF smuggling probe is what actually reaches the server (seen
    // literally, never reflected).
    "11111111-2222-3333-4444-555555555555%0d%0aX-Injected:%201",
    "../../../etc/passwd",
    `${"a".repeat(64)}-2222-3333-4444-555555555555`,
    "1111111122223333444455555555555555", // right length, wrong shape
    "11111111-2222-3333-4444-55555555555Z"
  ];

  for (const hostile of hostileValues) {
    test(`hostile value ${JSON.stringify(hostile.slice(0, 24))} gets a FRESH server UUID, never reflected`, async () => {
      const res = await fetch(`${API}/api/no-such-route`, { headers: { "X-Request-Id": hostile } });
      const echoed = res.headers.get("x-request-id");
      assert.ok(echoed);
      assert.notEqual(echoed, hostile);
      assert.match(echoed, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      const body = await res.json();
      assert.equal(body.requestId, echoed);
      assert.ok(!JSON.stringify(body).includes("X-Injected"));
    });
  }

  test("no header at all: fresh UUID on header and problem body", async () => {
    const res = await fetch(`${API}/api/no-such-route`);
    const echoed = res.headers.get("x-request-id");
    assert.match(echoed, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal((await res.json()).requestId, echoed);
  });
});
