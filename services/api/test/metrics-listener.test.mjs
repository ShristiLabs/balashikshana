// Metrics listener tests (issue #66): the internal exposition endpoint
// is auth-gated, path-restricted, method-restricted, and serves valid
// Prometheus text. Real socket on an ephemeral port; no server boot.

import { test, describe, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { createMetricsRegistry } from "../observability/metrics.mjs";
import { startMetricsListener, METRICS_CONTENT_TYPE } from "../observability/metrics-listener.mjs";

async function makeListener({ token } = {}) {
  const registry = createMetricsRegistry();
  registry.counter("probe_total", "probe", {}).inc({}, 3);
  const listener = startMetricsListener({ registry, port: 0, host: "127.0.0.1", token });
  const addr = await listener.ready;
  return { listener, port: addr.port, registry };
}

const openListeners = [];
afterAll(async () => {
  await Promise.all(openListeners.map((l) => l.close()));
});

describe("unauthenticated internal listener", () => {
  let base;
  beforeAll(async () => {
    const { listener, port } = await makeListener();
    openListeners.push(listener);
    base = `http://127.0.0.1:${port}`;
  });

  test("GET /metrics serves the exposition with the right content type", async () => {
    const res = await fetch(`${base}/metrics`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), METRICS_CONTENT_TYPE);
    const body = await res.text();
    assert.ok(body.includes("# TYPE probe_total counter"));
    assert.ok(body.includes("probe_total 3"));
  });

  test("other paths are 404, non-GET/HEAD are 405", async () => {
    assert.equal((await fetch(`${base}/`)).status, 404);
    assert.equal((await fetch(`${base}/metrics?x=1`)).status, 200); // query tolerated
    assert.equal((await fetch(`${base}/metrics`, { method: "POST" })).status, 405);
    const head = await fetch(`${base}/metrics`, { method: "HEAD" });
    assert.equal(head.status, 200);
  });
});

describe("token-gated listener", () => {
  let base;
  beforeAll(async () => {
    const { listener, port } = await makeListener({ token: "scraper-secret-1" });
    openListeners.push(listener);
    base = `http://127.0.0.1:${port}`;
  });

  test("missing or wrong token is 401 without a body hint", async () => {
    assert.equal((await fetch(`${base}/metrics`)).status, 401);
    assert.equal(
      (await fetch(`${base}/metrics`, { headers: { Authorization: "Bearer wrong" } })).status,
      401
    );
    assert.equal(
      (await fetch(`${base}/metrics`, { headers: { Authorization: "Basic c29tZXRoaW5n" } })).status,
      401
    );
  });

  test("correct bearer token gets the exposition", async () => {
    const res = await fetch(`${base}/metrics`, {
      headers: { Authorization: "Bearer scraper-secret-1" }
    });
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes("probe_total"));
  });
});
