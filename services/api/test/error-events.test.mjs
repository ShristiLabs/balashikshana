// First-party error tracking tests (issue #66): the error_events table
// (migration 013), redaction-at-capture with PLANTED PII, the flood
// cap, and retention purge. Throwaway Postgres DB per suite.

import { test, describe, beforeAll, afterAll, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { Client } from "pg";
import { createTestDatabase, dropTestDatabase, startTestServer, waitForHealth } from "./helpers.mjs";
import { captureErrorEvent, purgeErrorEvents, resetFloodWindows, ERROR_EVENT_FLOOD_CAP } from "../observability/error-store.mjs";

const API = "http://127.0.0.1:4823";
let serverProcess;
let testDatabase;
let pg;

function facade(client) {
  return { run: (sql, params) => client.query(sql, params) };
}

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  serverProcess = await startTestServer({
    port: 4823,
    databaseUrl: testDatabase.url,
    env: { SEED_DEMO_STUDENTS: "0", RETENTION_SWEEP_INTERVAL_MS: "0", LOG_LEVEL: "silent" }
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

describe("error_events schema (migration 013)", () => {
  test("table exists with the capture contract columns and NO body column", async () => {
    const { rows } = await pg.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'error_events' ORDER BY column_name`
    );
    const names = rows.map((r) => r.column_name);
    for (const expected of [
      "id", "captured_at", "request_id", "route_class", "problem_type",
      "status_code", "message_redacted", "stack_redacted", "fingerprint", "environment"
    ]) {
      assert.ok(names.includes(expected), `missing column ${expected}`);
    }
    // The D5 capture contract: there is NOTHING to store a request or
    // response body in, by construction.
    assert.ok(!names.some((n) => n.includes("body")), `body-ish column present: ${names}`);
  });

  test("indexes exist for the purge path and fingerprint aggregation", async () => {
    const { rows } = await pg.query(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'error_events'`
    );
    const names = rows.map((r) => r.indexname);
    assert.ok(names.some((n) => n.includes("captured_at")));
    assert.ok(names.some((n) => n.includes("fingerprint")));
  });
});

describe("captureErrorEvent redaction (planted PII)", () => {
  beforeEach(() => resetFloodWindows());

  test("emails, bearer tokens, and IPs are scrubbed from message and stack before persist", async () => {
    const plantedEmail = "parent-leak@example.com";
    const plantedToken = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdefghijklmnop";
    const plantedIp = "203.0.113.77";
    const outcome = await captureErrorEvent(facade(pg), {
      requestId: "11111111-2222-3333-4444-555555555555",
      routeClass: "/api/sync/attempts",
      problemType: "internal",
      statusCode: 500,
      message: `db failure for ${plantedEmail} from ${plantedIp}`,
      stack: `Error: boom\n    at run (/app/services/api/sync.mjs:100:15) token=${plantedToken}`,
      environment: "test"
    });
    assert.equal(outcome.captured, true);
    const { rows } = await pg.query("SELECT * FROM error_events ORDER BY id DESC LIMIT 1");
    const row = rows[0];
    assert.ok(!row.message_redacted.includes(plantedEmail));
    assert.ok(!row.message_redacted.includes(plantedIp));
    assert.ok(!row.stack_redacted.includes(plantedToken));
    assert.ok(row.message_redacted.includes("[redacted-email]"));
    assert.ok(row.stack_redacted.includes("[redacted-token]"));
    assert.equal(row.request_id, "11111111-2222-3333-4444-555555555555");
    assert.ok(row.fingerprint.length === 16);
  });

  test("non-UUID request ids are stored as NULL (no free text in the id column)", async () => {
    await captureErrorEvent(facade(pg), {
      requestId: "../../etc/passwd\ninjected",
      routeClass: "/api/health",
      problemType: "internal",
      statusCode: 500,
      message: "x",
      environment: "test"
    });
    const { rows } = await pg.query("SELECT request_id FROM error_events ORDER BY id DESC LIMIT 1");
    assert.equal(rows[0].request_id, null);
  });

  test("oversized messages are truncated, not stored whole", async () => {
    const big = "E".repeat(100000);
    await captureErrorEvent(facade(pg), {
      requestId: null,
      routeClass: "/api/health",
      problemType: "internal",
      statusCode: 500,
      message: big,
      environment: "test"
    });
    const { rows } = await pg.query("SELECT length(message_redacted) AS len FROM error_events ORDER BY id DESC LIMIT 1");
    assert.ok(rows[0].len <= 2048 + 20, `message length ${rows[0].len} exceeds cap`);
  });
});

describe("flood cap", () => {
  test("at most ERROR_EVENT_FLOOD_CAP events per fingerprint per window; rest skipped, not stored", async () => {
    resetFloodWindows();
    const captured = [];
    for (let i = 0; i < ERROR_EVENT_FLOOD_CAP + 5; i += 1) {
      captured.push(await captureErrorEvent(facade(pg), {
        requestId: null,
        routeClass: "/api/gate/evaluate",
        problemType: "internal",
        statusCode: 500,
        message: `flood ${i}`,
        stack: "Error: same\n    at run (/app/server.mjs:1:1)",
        environment: "test"
      }));
    }
    assert.equal(captured.filter((o) => o.captured).length, ERROR_EVENT_FLOOD_CAP);
    assert.equal(captured.filter((o) => !o.captured && o.reason === "flood-capped").length, 5);
    const { rows } = await pg.query("SELECT COUNT(*)::int AS n FROM error_events WHERE route_class = '/api/gate/evaluate'");
    assert.equal(rows[0].n, ERROR_EVENT_FLOOD_CAP);
  });

  test("a new window admits events again (window rollover)", async () => {
    resetFloodWindows();
    const first = await captureErrorEvent(facade(pg), {
      requestId: null, routeClass: "/api/health", problemType: "rollover",
      statusCode: 500, message: "x", stack: "Error: r\n    at f (/a.mjs:1:1)", environment: "test"
    }, { now: 1000 });
    const second = await captureErrorEvent(facade(pg), {
      requestId: null, routeClass: "/api/health", problemType: "rollover",
      statusCode: 500, message: "x", stack: "Error: r\n    at f (/a.mjs:1:1)", environment: "test"
    }, { now: 1000 + 61_000 });
    assert.equal(first.captured, true);
    assert.equal(second.captured, true);
  });
});

describe("retention purge", () => {
  test("rows older than the window are purged; fresh rows survive", async () => {
    await pg.query("DELETE FROM error_events");
    const now = new Date("2026-01-15T00:00:00Z");
    // Explicit timestamps on the INJECTED clock (deterministic boundary).
    await pg.query(
      `INSERT INTO error_events (captured_at, route_class, problem_type, status_code, message_redacted, fingerprint, environment)
       VALUES
         ($1, '/api/old', 'internal', 500, 'old', 'deadbeefdeadbeef', 'test'),
         ($2, '/api/new', 'internal', 500, 'new', 'deadbeefdeadbeef', 'test')`,
      [
        new Date(now.getTime() - 40 * 86400000).toISOString(),
        new Date(now.getTime() - 2 * 86400000).toISOString()
      ]
    );
    const purged = await purgeErrorEvents(facade(pg), { now, retentionDays: 30 });
    assert.equal(purged, 1);
    const { rows } = await pg.query("SELECT route_class FROM error_events");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].route_class, "/api/new");
  });
});
