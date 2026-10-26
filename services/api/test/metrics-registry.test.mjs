// Metrics registry unit tests (issue #66): histogram math, cumulative
// bucket correctness, p95 interpolation matrices, and the CARDINALITY
// GUARDS (the DoS-via-labels attack surface). Pure — no server, no DB.

import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { createMetricsRegistry, enumLabel, regexLabel, histogramQuantile } from "../observability/metrics.mjs";

function makeRegistry() {
  return createMetricsRegistry();
}

describe("counter and gauge basics", () => {
  test("counter increments per label set and independently", () => {
    const r = makeRegistry();
    const c = r.counter("test_total", "h", { k: enumLabel(["a", "b"], "a") });
    assert.equal(c.inc({ k: "a" }), true);
    assert.equal(c.inc({ k: "a" }, 4), true);
    assert.equal(c.inc({ k: "b" }), true);
    const snap = r.snapshot().test_total;
    const a = snap.series.find((s) => s.labels.k === "a");
    const b = snap.series.find((s) => s.labels.k === "b");
    assert.equal(a.value, 5);
    assert.equal(b.value, 1);
  });

  test("gauge set overwrites; counter inc accumulates", () => {
    const r = makeRegistry();
    const g = r.gauge("g_val", "h", {});
    g.set({}, 3);
    g.set({}, 7);
    assert.equal(r.snapshot().g_val.series[0].value, 7);
  });

  test("invalid observation values are rejected, never recorded", () => {
    const r = makeRegistry();
    const c = r.counter("c_val", "h", {});
    assert.equal(c.inc({}, -1), false);
    assert.equal(c.inc({}, Number.NaN), false);
    assert.equal(c.inc({}, Infinity), false);
    assert.equal(c.inc({}, "3"), false);
    assert.equal(r.snapshot().c_val.series.length, 0);
    assert.equal(r.snapshot().metrics_observations_rejected_total.series[0].value, 4);
  });
});

describe("histogram bucket math", () => {
  const BUCKETS = [0.1, 0.5, 1, 5];

  test("observations land in the right PER-BUCKET slots; sum equals count", () => {
    const r = makeRegistry();
    const h = r.histogram("lat", "h", {}, BUCKETS);
    h.observe({}, 0.05);
    h.observe({}, 0.3);
    h.observe({}, 0.7);
    h.observe({}, 3);
    h.observe({}, 100);
    const s = r.snapshot().lat.series[0];
    // Per-bucket counts (registry internal form): last slot is +Inf.
    assert.deepEqual(s.bucketCounts, [1, 1, 1, 1, 1]);
    assert.equal(s.count, 5);
    assert.equal(s.bucketCounts.reduce((a, b) => a + b, 0), s.count);
    assert.ok(Math.abs(s.sum - 104.05) < 1e-9);
    // The EXPOSITION is cumulative and its +Inf line equals count.
    const infLine = r.render().split("\n").find((l) => l.includes('le="+Inf"'));
    assert.ok(infLine.endsWith(" 5"), infLine);
  });

  test("boundary values land in the bucket whose le they equal", () => {
    const r = makeRegistry();
    const h = r.histogram("lat", "h", {}, BUCKETS);
    h.observe({}, 0.1);
    h.observe({}, 0.5);
    let s = r.snapshot().lat.series[0];
    assert.equal(s.bucketCounts[0], 1);
    assert.equal(s.bucketCounts[1], 1);
    h.observe({}, 0.1000001);
    s = r.snapshot().lat.series[0];
    assert.equal(s.bucketCounts[0], 1); // strictly greater goes to next
    assert.equal(s.bucketCounts[1], 2);
  });

  test("exposition renders ascending le buckets ending +Inf, count last", () => {
    const r = makeRegistry();
    const h = r.histogram("lat", "h", {}, [0.1, 1]);
    h.observe({ m: enumLabel(["GET"], "GET") ? "GET" : "GET" }, 0.2);
    const text = r.render();
    const leLines = text.split("\n").filter((l) => l.startsWith("lat_bucket"));
    const les = leLines.map((l) => l.match(/le="([^"]+)"/)[1]);
    assert.deepEqual(les, ["0.1", "1", "+Inf"]);
    const inf = leLines[2];
    assert.ok(inf.endsWith(" 1"));
    assert.ok(text.includes("# TYPE lat histogram"));
    assert.ok(text.includes("lat_sum"));
    assert.ok(text.includes("lat_count 1"));
  });
});

describe("p95 interpolation (histogramQuantile)", () => {
  const B = [0.1, 0.5, 1, 5];
  test("empty series returns null", () => {
    assert.equal(histogramQuantile(0.95, [0, 0, 0, 0, 0], B), null);
  });
  test("all in first bucket interpolates from 0", () => {
    // 10 obs, all <= 0.1: rank 9.5, lower 0, upper 0.1 -> 0.095
    const q = histogramQuantile(0.95, [10, 0, 0, 0, 0], B);
    assert.ok(Math.abs(q - 0.095) < 1e-9);
  });
  test("rank landing inside a middle bucket interpolates linearly", () => {
    // counts per bucket: [0, 8, 2, 0, 0]; total 10; rank 9.5 -> bucket 2
    // (cumulative 10 >= 9.5): lower 0.5, upper 1, prevCum 8, inBucket 2
    // -> 0.5 + (9.5-8)/2 * 0.5 = 0.875
    const perBucket = [0, 8, 2, 0, 0];
    const q = histogramQuantile(0.95, perBucket, B);
    assert.ok(Math.abs(q - 0.875) < 1e-9);
  });
  test("per-bucket form is the contract: registry snapshot feeds the same function", () => {
    const r = makeRegistry();
    const h = r.histogram("q_lat", "h", {}, B);
    for (const v of [0.05, 0.6, 0.7, 0.8, 0.9, 6, 7]) h.observe({}, v);
    const snap = r.snapshot().q_lat.series[0];
    // The snapshot's bucketCounts ARE the registry's per-bucket form.
    assert.equal(snap.bucketCounts.reduce((a, b) => a + b, 0), snap.count);
    const q = histogramQuantile(0.95, snap.bucketCounts, B);
    // counts [1,0,4,0,2]: rank 6.65 -> +Inf slot -> last finite bound 5
    assert.equal(q, 5);
  });
  test("everything above every finite bucket returns the last finite bound", () => {
    // all obs > 5: bucket counts [0,0,0,0,4], rank 3.8 -> +Inf slot,
    // i is the +Inf index: lower = bounds[last] = 5, upper = 5 -> 5.
    const q = histogramQuantile(0.95, [0, 0, 0, 0, 4], B);
    assert.equal(q, 5);
  });
  test("q=0 floors to 0; q=1 tops at the top bucket", () => {
    assert.equal(histogramQuantile(0, [1, 1, 1, 1, 1], B), 0);
    const q1 = histogramQuantile(1, [0, 8, 2, 0, 0], B);
    assert.ok(Math.abs(q1 - 1) < 1e-9);
  });
  test("invalid q returns null", () => {
    assert.equal(histogramQuantile(1.5, [1, 1, 1, 1, 1], B), null);
    assert.equal(histogramQuantile(-0.1, [1, 1, 1, 1, 1], B), null);
  });
});

describe("cardinality guards (adversarial)", () => {
  test("label values outside the declared vocabulary are rejected, no series created", () => {
    const r = makeRegistry();
    const c = r.counter("c_total", "h", { k: enumLabel(["a", "b"], "a") });
    // The adversarial attempt: an attacker-controlled "email" label value.
    assert.equal(c.inc({ k: "victim@example.com" }), false);
    assert.equal(c.inc({ k: "x".repeat(200) }), false);
    assert.equal(c.inc({ k: 'a"injected' }), false);
    const snap = r.snapshot();
    assert.equal(snap.c_total.series.length, 0);
    assert.equal(snap.metrics_observations_rejected_total.series[0].value, 3);
  });

  test("regex labels enforce pattern, length, and reject exposition metacharacters", () => {
    const r = makeRegistry();
    const c = r.counter("r_total", "h", {
      route: regexLabel(/^\/[a-z:/_-]{1,64}$/, "unmatched")
    });
    assert.equal(c.inc({ route: "/api/health" }), true);
    assert.equal(c.inc({ route: "/api/students/:id" }), true);
    assert.equal(c.inc({ route: "/api/health?email=a@b.co" }), false);
    assert.equal(c.inc({ route: `/${"a".repeat(100)}` }), false);
    assert.equal(c.inc({ route: '/api/x"y' }), false);
    assert.equal(c.inc({ route: "/api/x\\y" }), false);
    assert.equal(c.inc({ route: "/api/x\ny" }), false);
  });

  test("missing label value falls back to the declared fallback (bounded)", () => {
    const r = makeRegistry();
    const c = r.counter("f_total", "h", { k: enumLabel(["a"], "unmatched") });
    c.inc({ k: undefined });
    c.inc({});
    const snap = r.snapshot().f_total;
    assert.equal(snap.series.length, 1);
    assert.equal(snap.series[0].labels.k, "unmatched");
    assert.equal(snap.series[0].value, 2);
  });

  test("max-series cap: the 257th distinct series is rejected, memory bounded", () => {
    const r = createMetricsRegistry({ maxSeries: 4 });
    const c = r.counter("m_total", "h", {
      k: regexLabel(/^v\d{1,3}$/, "unmatched") // adversarially wide-but-valid
    });
    for (let i = 0; i < 10; i += 1) c.inc({ k: `v${i}` });
    const snap = r.snapshot();
    assert.equal(snap.m_total.series.length, 4); // hard cap held
    assert.equal(snap.metrics_observations_rejected_total.series[0].value, 6);
  });

  test("undefined/unknown label keys never create series", () => {
    const r = makeRegistry();
    const c = r.counter("u_total", "h", { k: enumLabel(["a"], "a") });
    assert.equal(c.inc({ k: "a", rogue: "evil" }), true);
    const snap = r.snapshot().u_total;
    assert.equal(snap.series.length, 1);
    assert.equal(JSON.stringify(snap.series[0].labels), '{"k":"a"}'); // rogue dropped by canonical key? no — validateLabels only reads declared names
  });
});

describe("exposition format validity", () => {
  test("every non-comment line parses as name{labels} value; families grouped", () => {
    const r = makeRegistry();
    const c = r.counter("z_total", "h", { k: enumLabel(["a", "b"], "a") });
    const g = r.gauge("a_gauge", "h", {});
    const h = r.histogram("h_lat", "h", {}, [0.1, 1]);
    c.inc({ k: "a" });
    c.inc({ k: "b" });
    g.set({}, 2);
    h.observe({}, 0.3);
    h.observe({}, 2);
    const text = r.render();

    const lines = text.split("\n").filter((l) => l.length > 0);
    let lastFamily = null;
    for (const line of lines) {
      if (line.startsWith("# HELP ")) {
        lastFamily = line.split(" ")[2];
        continue;
      }
      if (line.startsWith("# TYPE ")) {
        assert.equal(line.split(" ")[2], lastFamily);
        continue;
      }
      const m = line.match(/^([a-z_][a-z0-9_]*)(\{.*\})? (-?\d+(\.\d+)?)$/);
      assert.ok(m, `unparseable exposition line: ${line}`);
      const family = m[1].replace(/_(bucket|sum|count)$/, "");
      assert.equal(family, lastFamily, `line ${line} outside its family block`);
    }
    // Deterministic render: twice is byte-identical.
    assert.equal(text, r.render());
  });

  test("float rendering avoids floating-point artifacts", () => {
    const r = makeRegistry();
    const h = r.histogram("s_lat", "h", {}, [1]);
    h.observe({}, 0.1);
    h.observe({}, 0.2);
    const sumLine = r.render().split("\n").find((l) => l.startsWith("s_lat_sum"));
    assert.ok(!sumLine.includes("0.30000000000000004"), sumLine);
    assert.ok(sumLine.endsWith("0.3"));
  });

  test("unlabeled counter renders a zero series before first observation", () => {
    const r = makeRegistry();
    r.counter("boot_total", "h", {});
    assert.ok(r.render().includes("boot_total 0"));
  });
});
