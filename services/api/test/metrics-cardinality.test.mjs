// Cardinality adversarial tests (issue #66, tester pass): the
// DoS-via-label-explosion surface. The DEFAULT 512-series cap, reject
// (never evict) semantics, per-metric isolation, and hostile label
// values — including PII-shaped ones that must never reach the
// exposition.

import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { createMetricsRegistry, regexLabel } from "../observability/metrics.mjs";

// The production route-class validator shape (api-metrics.mjs).
const ROUTE = () => regexLabel(/^(\/[A-Za-z0-9:/_-]{1,63}|unmatched)$/, "unmatched");

describe("default 512-series cap under a label hammer", () => {
  test("exactly 512 series materialize; the rest are rejected and counted", () => {
    const r = createMetricsRegistry(); // default cap = 512
    const c = r.counter("hammer_total", "h", { route_class: ROUTE() });
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < 600; i += 1) {
      if (c.inc({ route_class: `/api/hammer-${i}` })) accepted += 1;
      else rejected += 1;
    }
    assert.equal(accepted, 512);
    assert.equal(rejected, 88);
    const snap = r.snapshot();
    assert.equal(snap.hammer_total.series.length, 512);
    const rej = snap.metrics_observations_rejected_total.series.find(
      (s) => s.labels.metric === "hammer_total"
    );
    assert.equal(rej.value, 88);
  });

  test("the capped registry still renders parseable, bounded output", () => {
    const r = createMetricsRegistry();
    const c = r.counter("hammer2_total", "h", { route_class: ROUTE() });
    for (let i = 0; i < 700; i += 1) c.inc({ route_class: `/api/h-${i}` });
    const text = r.render();
    const sampleLines = text.split("\n").filter((l) => l.startsWith("hammer2_total{"));
    assert.equal(sampleLines.length, 512);
    for (const line of sampleLines) assert.match(line, /^hammer2_total\{route_class="\/api\/h-\d+"\} 1$/);
  });

  test("no eviction: capped-out registries keep counting EXISTING series", () => {
    const r = createMetricsRegistry();
    const c = r.counter("evict_total", "h", { route_class: ROUTE() });
    c.inc({ route_class: "/api/first" });
    for (let i = 0; i < 600; i += 1) c.inc({ route_class: `/api/flood-${i}` });
    // The pre-existing series must still be live (reject, never evict).
    assert.equal(c.inc({ route_class: "/api/first" }, 9), true);
    const snap = r.snapshot();
    const first = snap.evict_total.series.find((s) => s.labels.route_class === "/api/first");
    assert.equal(first.value, 10);
    // And no new series appeared beyond the cap.
    assert.equal(snap.evict_total.series.length, 512);
  });

  test("the cap is PER METRIC — a saturated metric does not starve others", () => {
    const r = createMetricsRegistry();
    const a = r.counter("sat_a", "h", { route_class: ROUTE() });
    const b = r.counter("sat_b", "h", { route_class: ROUTE() });
    for (let i = 0; i < 600; i += 1) a.inc({ route_class: `/api/a-${i}` });
    assert.equal(b.inc({ route_class: "/api/b-fine" }), true);
    assert.equal(r.snapshot().sat_b.series.length, 1);
  });
});

describe("hostile and PII-shaped label values never reach telemetry", () => {
  const hostile = [
    "parent@example.com",              // email in a label
    "Aarav Sharma",                    // child name (spaces)
    "/api/x\"><script>",               // injection-shaped
    "/api/x\nline2",                   // newline smuggling
    "/api/\\backslash",                // escape probe
    `/api/${"l".repeat(70)}`,          // over-length (65 > 64 cap)
    "/api/üñïçødé",                    // non-ASCII
    "/api/thing?token=abcdef",         // query-bearing pseudo-path
    "1234:5678:9abc:def0:1234:5678:9abc:def0" // IPv6-shaped
  ];

  test("regex label rejects every hostile value and counts the rejection", () => {
    const r = createMetricsRegistry();
    const c = r.counter("host_total", "h", { route_class: ROUTE() });
    for (const value of hostile) {
      assert.equal(c.inc({ route_class: value }), false, `should reject: ${JSON.stringify(value)}`);
    }
    const snap = r.snapshot();
    assert.equal(snap.host_total.series.length, 0);
    const rej = snap.metrics_observations_rejected_total.series.find(
      (s) => s.labels.metric === "host_total"
    );
    assert.equal(rej.value, hostile.length);
  });

  test("rejected values are absent from the rendered exposition", () => {
    const r = createMetricsRegistry();
    const c = r.counter("host2_total", "h", { route_class: ROUTE() });
    for (const value of hostile) c.inc({ route_class: value });
    const text = r.render();
    for (const value of hostile) {
      assert.ok(!text.includes(value), `hostile label value rendered: ${value}`);
    }
    assert.ok(!text.includes("example.com"));
    assert.ok(!text.includes("Aarav"));
    assert.ok(!text.includes("script"));
  });
});
