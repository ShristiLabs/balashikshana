// Quantile math matrix (issue #66, tester pass): histogramQuantile is
// verified against an INDEPENDENT translation of Prometheus's
// bucketQuantile (promql/quantile.go) — the algorithm the runbook pins
// as the p95 definition. Hand-computed literal expectations anchor a
// few canonical cases so a shared bug in both implementations cannot
// pass silently; then a q-grid sweeps full distributions.

import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { histogramQuantile } from "../observability/metrics.mjs";

// Reference implementation translated from Prometheus
// promql/quantile.go bucketQuantile(), operating on the registry's
// per-bucket form (finite bounds + trailing +Inf slot):
//   - rank = q * observations
//   - advance b while the CUMULATIVE count of bucket b is < rank
//   - b landing on the +Inf slot -> clamp to the last finite bound
//   - otherwise linear interpolation inside bucket b
function prometheusRef(q, perBucket, bounds) {
  if (!Number.isFinite(q)) return Number.NaN;
  if (q < 0) return -Infinity;
  if (q > 1) return Infinity;
  const cum = [];
  let running = 0;
  for (const c of perBucket) {
    running += c;
    cum.push(running);
  }
  if (running === 0) return Number.NaN; // Prometheus: no observations -> NaN
  const rank = q * running;
  let b = 0;
  while (b < perBucket.length - 1 && cum[b] < rank) b += 1;
  if (b === perBucket.length - 1) return bounds[bounds.length - 1];
  let bucketStart = 0;
  let count = cum[b];
  let r = rank;
  if (b > 0) {
    bucketStart = bounds[b - 1];
    count -= cum[b - 1];
    r -= cum[b - 1];
  }
  return bucketStart + (bounds[b] - bucketStart) * (r / count);
}

const B = [0.1, 0.5, 1, 5]; // +Inf slot implied at index 4
// The production latency bucket set (api-metrics.mjs).
const PROD = [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.4, 0.8, 1.5, 3, 5, 10];

describe("hand-computed anchors (known Prometheus outputs)", () => {
  test("all observations in the first bucket interpolate from 0", () => {
    // counts [10,0,0,0,0], q=0.5: rank 5 -> 0 + 0.1*(5/10) = 0.05
    assert.equal(histogramQuantile(0.5, [10, 0, 0, 0, 0], B), 0.05);
  });

  test("empty leading buckets interpolate inside the first NON-empty bucket", () => {
    // counts [0,0,4,0,0], q=0.5: rank 2 lands in bucket [0.5,1):
    // 0.5 + 0.5*(2-0)/4 = 0.75
    assert.equal(histogramQuantile(0.5, [0, 0, 4, 0, 0], B), 0.75);
  });

  test("rank exactly on a cumulative boundary returns that bucket's upper edge", () => {
    // counts [2,3,0,0,0], q=0.4: rank 2 == cumulative[0] -> 0.1 exactly
    assert.equal(histogramQuantile(0.4, [2, 3, 0, 0, 0], B), 0.1);
  });

  test("observations above every finite bucket clamp to the last finite bound", () => {
    // counts [0,0,0,0,7]: everything in +Inf -> 5 (Prometheus behavior)
    assert.equal(histogramQuantile(0.5, [0, 0, 0, 0, 7], B), 5);
    assert.equal(histogramQuantile(0.999, [0, 0, 0, 0, 7], B), 5);
  });

  test("p95/p99 on a realistic production-bucket distribution", () => {
    // counts over PROD, total 100:
    // cum = 10,25,45,70,82,90,94,97,99,100,100,100,100
    // p95: rank 95 -> bucket 7 ([0.4,0.8)) prev 94 count 3 ->
    //      0.4 + 0.4*(1/3)
    // p99: rank 99 -> bucket 8 cumulative == 99 -> upper edge 1.5
    const counts = [10, 15, 20, 25, 12, 8, 4, 3, 2, 1, 0, 0, 0];
    assert.ok(Math.abs(histogramQuantile(0.95, counts, PROD) - (0.4 + 0.4 / 3)) < 1e-12);
    assert.equal(histogramQuantile(0.99, counts, PROD), 1.5);
  });

  test("q=1 tops at the top non-empty bucket's upper bound; q=0 floors to 0", () => {
    const counts = [0, 5, 0, 0, 0];
    assert.equal(histogramQuantile(1, counts, B), 0.5);
    assert.equal(histogramQuantile(0, [5, 0, 0, 0, 0], B), 0);
  });
});

describe("documented divergences from Prometheus at the extremes", () => {
  test("empty histogram and invalid q return null (Prometheus: NaN/Inf) — the runbook contract", () => {
    assert.equal(histogramQuantile(0.5, [0, 0, 0, 0, 0], B), null);
    assert.equal(histogramQuantile(1.5, [1, 0, 0, 0, 0], B), null);
    assert.equal(histogramQuantile(-0.1, [1, 0, 0, 0, 0], B), null);
    assert.equal(histogramQuantile(Number.NaN, [1, 0, 0, 0, 0], B), null);
  });

  test("q=0 with an EMPTY first bucket: documented 0-floor instead of Prometheus's 0/0 NaN", () => {
    // The only reachable divergence: rank 0 selects bucket 0 which has
    // zero observations. Prometheus divides 0/0 -> NaN; the runbook
    // floors to 0 (a p0 of "no slower than bucket floor" reading).
    assert.equal(histogramQuantile(0, [0, 5, 0, 0, 0], B), 0);
  });
});

describe("full-grid agreement with the Prometheus reference", () => {
  const distributions = [
    { name: "uniform across buckets", counts: [5, 5, 5, 5, 5] },
    { name: "front-loaded", counts: [40, 3, 2, 1, 0] },
    { name: "empty leading", counts: [0, 0, 7, 1, 2] },
    { name: "single middle spike", counts: [0, 1, 30, 1, 0] },
    { name: "everything over max", counts: [0, 0, 0, 0, 11] },
    { name: "single observation", counts: [0, 0, 0, 0, 1] },
    { name: "boundary-heavy", counts: [1, 1, 1, 1, 1] },
    { name: "production-shaped", counts: [10, 15, 20, 25, 12, 8, 4, 3, 2, 1, 0, 0, 0] }
  ];
  const boundsFor = (counts) =>
    counts.length === 13 ? PROD : B;

  for (const dist of distributions) {
    test(`${dist.name}: agrees with the Prometheus formula for q=0.01..1`, () => {
      const bounds = boundsFor(dist.counts);
      for (let i = 1; i <= 100; i += 1) {
        const q = i / 100;
        const ours = histogramQuantile(q, dist.counts, bounds);
        const ref = prometheusRef(q, dist.counts, bounds);
        assert.ok(
          Math.abs(ours - ref) < 1e-12,
          `q=${q}: ours ${ours} vs Prometheus ${ref} for ${dist.name}`
        );
      }
    });
  }

  test("quantiles are monotone non-decreasing in q for every distribution", () => {
    for (const dist of distributions) {
      const bounds = boundsFor(dist.counts);
      let prev = -Infinity;
      for (let i = 0; i <= 200; i += 1) {
        const q = i / 200;
        const v = histogramQuantile(q, dist.counts, bounds);
        if (v === null) continue;
        assert.ok(v >= prev - 1e-12, `quantile decreased at q=${q} for ${dist.name}`);
        prev = v;
      }
    }
  });
});
