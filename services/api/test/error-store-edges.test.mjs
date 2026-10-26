// Error-store boundary edges (issue #66, tester pass): purge equality,
// insert-failure isolation, the flood-window rollover boundary, and
// optional-field handling at the capture seam. Throwaway Postgres DB.

import { test, describe, beforeAll, afterAll, beforeEach } from "vitest";
import assert from "node:assert/strict";
import { Client } from "pg";
import { createTestDatabase, dropTestDatabase, startTestServer, waitForHealth } from "./helpers.mjs";
import {
  captureErrorEvent,
  purgeErrorEvents,
  resetFloodWindows,
  ERROR_EVENT_FLOOD_WINDOW_MS
} from "../observability/error-store.mjs";

const API = "http://127.0.0.1:4833";
let testDatabase;
let pg;
let serverProcess;

function facade(client) {
  return { run: (sql, params) => client.query(sql, params) };
}

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  // Boot the server once so migrations (incl. 013_error_events) apply —
  // the throwaway DB starts empty.
  serverProcess = await startTestServer({
    port: 4833,
    databaseUrl: testDatabase.url,
    env: { SEED_DEMO_STUDENTS: "0", LOG_LEVEL: "silent", RETENTION_SWEEP_INTERVAL_MS: "0" }
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

describe("retention purge boundary", () => {
  beforeEach(async () => {
    await pg.query("DELETE FROM error_events");
  });

  test("a row captured EXACTLY at the cutoff IS purged (inclusive <=)", async () => {
    const now = new Date("2026-06-15T12:00:00Z");
    const cutoff = new Date(now.getTime() - 30 * 86400000);
    await pg.query(
      `INSERT INTO error_events (captured_at, route_class, problem_type, status_code, message_redacted, fingerprint, environment)
       VALUES ($1, '/api/edge', 'internal', 500, 'exactly-at-cutoff', 'aabbccddeeff0011', 'test')`,
      [cutoff.toISOString()]
    );
    const purged = await purgeErrorEvents(facade(pg), { now, retentionDays: 30 });
    assert.equal(purged, 1);
    const { rows } = await pg.query("SELECT COUNT(*)::int AS n FROM error_events");
    assert.equal(rows[0].n, 0);
  });

  test("a row one millisecond inside the window SURVIVES", async () => {
    const now = new Date("2026-06-15T12:00:00Z");
    const justInside = new Date(now.getTime() - 30 * 86400000 + 1);
    await pg.query(
      `INSERT INTO error_events (captured_at, route_class, problem_type, status_code, message_redacted, fingerprint, environment)
       VALUES ($1, '/api/edge2', 'internal', 500, 'inside', 'aabbccddeeff0012', 'test')`,
      [justInside.toISOString()]
    );
    const purged = await purgeErrorEvents(facade(pg), { now, retentionDays: 30 });
    assert.equal(purged, 0);
    const { rows } = await pg.query("SELECT COUNT(*)::int AS n FROM error_events");
    assert.equal(rows[0].n, 1);
  });
});

describe("capture seam robustness", () => {
  beforeEach(() => resetFloodWindows());

  test("an INSERT failure is swallowed and reported as insert-failed (telemetry never throws)", async () => {
    const broken = {
      run: async () => {
        throw new Error("connection refused");
      }
    };
    const outcome = await captureErrorEvent(broken, {
      requestId: null,
      routeClass: "/api/health",
      problemType: "internal",
      statusCode: 500,
      message: "m",
      stack: "Error: s\n    at f (/a.mjs:1:1)",
      environment: "test"
    });
    assert.equal(outcome.captured, false);
    assert.equal(outcome.reason, "insert-failed");
  });

  test("a write to a missing table is insert-failed, not a crash (SQL errors included)", async () => {
    const wrongTable = {
      run: (sql) => pg.query(sql.replace("error_events", "no_such_table_error_events"))
    };
    const outcome = await captureErrorEvent(wrongTable, {
      requestId: null,
      routeClass: "/api/health",
      problemType: "internal",
      statusCode: 500,
      message: "m",
      environment: "test"
    });
    assert.equal(outcome.captured, false);
    assert.equal(outcome.reason, "insert-failed");
  });

  test("missing optional fields persist as NULL, not as the string 'undefined'", async () => {
    const outcome = await captureErrorEvent(facade(pg), {
      routeClass: "/api/sparse",
      problemType: "internal",
      statusCode: 500,
      environment: "test"
    });
    assert.equal(outcome.captured, true);
    const { rows } = await pg.query(
      "SELECT request_id, message_redacted, stack_redacted, status_code FROM error_events ORDER BY id DESC LIMIT 1"
    );
    assert.equal(rows[0].request_id, null);
    assert.equal(rows[0].message_redacted, null);
    assert.equal(rows[0].stack_redacted, null);
    assert.equal(rows[0].status_code, 500);
  });

  test("the flood window rolls over at EXACTLY FLOOD_WINDOW_MS (>= boundary)", async () => {
    const payload = {
      requestId: null,
      routeClass: "/api/window-edge",
      problemType: "internal",
      statusCode: 500,
      message: "x",
      stack: "Error: w\n    at f (/a.mjs:1:1)",
      environment: "test"
    };
    const first = await captureErrorEvent(facade(pg), payload, { now: 5_000 });
    // At now = 5_000 + FLOOD_WINDOW_MS the window has expired (>=).
    const boundary = await captureErrorEvent(facade(pg), payload, {
      now: 5_000 + ERROR_EVENT_FLOOD_WINDOW_MS
    });
    assert.equal(first.captured, true);
    assert.equal(boundary.captured, true);
    // One millisecond BEFORE the boundary it is still the same window:
    // with the cap at 10, exhausting the window then probing t-1 blocks.
    resetFloodWindows();
    const start = 100_000;
    for (let i = 0; i < 10; i += 1) {
      await captureErrorEvent(facade(pg), payload, { now: start });
    }
    const justBefore = await captureErrorEvent(facade(pg), payload, {
      now: start + ERROR_EVENT_FLOOD_WINDOW_MS - 1
    });
    assert.equal(justBefore.captured, false);
    assert.equal(justBefore.reason, "flood-capped");
  });
});
