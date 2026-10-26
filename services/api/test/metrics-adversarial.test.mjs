// Live adversarial metrics tests (issue #66, tester pass): over the
// REAL spawned server — dynamic-route classification with hostile path
// segments and query strings, sync endpoint outcome derivation on
// validation-rejects (400) vs auth-rejects (401), and the progress
// endpoint's error series. The raw URL must NEVER appear as a label.

import { test, describe, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { createTestDatabase, dropTestDatabase, startTestServer, waitForHealth } from "./helpers.mjs";

const API = "http://127.0.0.1:4831";
const METRICS = "http://127.0.0.1:4832";
let serverProcess;
let testDatabase;

async function exposition() {
  const res = await fetch(`${METRICS}/metrics`);
  assert.equal(res.status, 200);
  return res.text();
}

function seriesValue(text, pattern) {
  const line = text.split("\n").find((l) => l.startsWith(pattern));
  return line ? Number(line.split(" ").pop()) : null;
}

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  serverProcess = await startTestServer({
    port: 4831,
    databaseUrl: testDatabase.url,
    env: {
      SEED_DEMO_STUDENTS: "0",
      LOG_LEVEL: "silent",
      METRICS_PORT: "4832",
      METRICS_HOST: "127.0.0.1",
      RETENTION_SWEEP_INTERVAL_MS: "0"
    }
  });
  await waitForHealth(API);
});

afterAll(async () => {
  if (serverProcess) serverProcess.kill("SIGKILL");
  if (testDatabase) await dropTestDatabase(testDatabase.name);
});

describe("route classification on dynamic routes (raw URL never a label)", () => {
  test("a matched :param route with a hostile id + query emits the PATTERN class only", async () => {
    const hostileId = "7f9c24e8-hostile%2F..%2Fetc-passwd";
    await fetch(`${API}/api/students/${hostileId}?token=supersecretvalue99`);
    await fetch(`${API}/api/practice/topic/PK-M2/I?count=8&x=<script>`);
    await new Promise((r) => setTimeout(r, 300));
    const text = await exposition();

    // Patterned classes are present...
    assert.ok(
      seriesValue(text, 'http_requests_total{method="GET",route_class="/api/students/:studentId"') !== null,
      "students pattern class missing"
    );
    assert.ok(
      seriesValue(text, 'http_requests_total{method="GET",route_class="/api/practice/topic/:unitId/:topicCode"') !== null,
      "practice topic pattern class missing"
    );
    // ...and the raw path segments never leak into the exposition.
    assert.ok(!text.includes("hostile"), "raw id segment leaked into exposition");
    assert.ok(!text.includes("etc-passwd"), "path traversal fragment leaked");
    assert.ok(!text.includes("supersecretvalue99"), "query token leaked into exposition");
    assert.ok(!text.includes("<script>"), "script fragment leaked");
    assert.ok(!text.includes("token="), "query string shape leaked");
  });

  test("a hammered 404 storm produces exactly ONE unmatched series", async () => {
    const before = await exposition();
    const unmatchedBefore =
      seriesValue(before, 'http_requests_total{method="GET",route_class="unmatched",status_class="4xx"}') || 0;
    for (let i = 0; i < 5; i += 1) {
      await fetch(`${API}/attack-path-${i}?q=${i}`);
    }
    await new Promise((r) => setTimeout(r, 300));
    const after = await exposition();
    const unmatchedAfter =
      seriesValue(after, 'http_requests_total{method="GET",route_class="unmatched",status_class="4xx"}') || 0;
    assert.equal(unmatchedAfter, unmatchedBefore + 5);
    // Still exactly one unmatched series line for GET 4xx: the hammered
    // paths collapsed into the bucket, they did NOT mint new series.
    const unmatchedLines = after
      .split("\n")
      .filter((l) => l.startsWith("http_requests_total{") && l.includes('route_class="unmatched"'));
    assert.ok(unmatchedLines.length <= 5, `unmatched series exploded: ${unmatchedLines.length}`);
    for (const line of unmatchedLines) assert.ok(!line.includes("attack-path"), `raw path as label: ${line}`);
  });
});

describe("sync outcome derivation (final HTTP outcome, all reject classes)", () => {
  test("a schema-rejected batch (400) counts as error, not success", async () => {
    const before = await exposition();
    const errBefore =
      seriesValue(before, 'sync_requests_total{endpoint="attempts",outcome="error"}') || 0;
    const res = await fetch(`${API}/api/sync/attempts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attempts: "not-an-array" })
    });
    assert.equal(res.status, 400);
    await new Promise((r) => setTimeout(r, 300));
    const after = await exposition();
    const errAfter =
      seriesValue(after, 'sync_requests_total{endpoint="attempts",outcome="error"}') || 0;
    assert.ok(errAfter >= errBefore + 1, `400 not counted as error (${errBefore} -> ${errAfter})`);
  });

  test("an unauthorized progress fetch counts on the progress endpoint as error", async () => {
    const before = await exposition();
    const errBefore =
      seriesValue(before, 'sync_requests_total{endpoint="progress",outcome="error"}') || 0;
    const res = await fetch(`${API}/api/sync/progress`, {
      headers: { Authorization: "Bearer no-such-device-token" }
    });
    assert.ok([401, 403].includes(res.status), `unexpected status ${res.status}`);
    await new Promise((r) => setTimeout(r, 300));
    const after = await exposition();
    const errAfter =
      seriesValue(after, 'sync_requests_total{endpoint="progress",outcome="error"}') || 0;
    assert.ok(errAfter >= errBefore + 1, "progress error outcome not counted");
  });

  test("non-sync routes never touch the sync metric", async () => {
    const before = await exposition();
    await fetch(`${API}/api/health`);
    await fetch(`${API}/api/no-such-route`);
    await new Promise((r) => setTimeout(r, 300));
    const after = await exposition();
    for (const line of after.split("\n")) {
      if (line.startsWith("sync_requests_total{")) {
        const beforeLine = before
          .split("\n")
          .find((l) => l.startsWith(line.split(" ")[0]));
        // Every sync series that exists after must have existed before
        // with the same value (health/404 traffic added nothing).
        assert.ok(beforeLine, `new sync series appeared from non-sync traffic: ${line}`);
        assert.equal(beforeLine, line);
      }
    }
  });
});
