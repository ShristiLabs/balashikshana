// Route classification tests (issue #66): the metric label vocabulary is
// the Fastify route inventory — bounded, pinned to the OpenAPI baseline,
// and immune to crafted-URL label injection.

import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  routeClassFor,
  statusClassFor,
  methodFor,
  openApiPathToRouteClass,
  UNMATCHED_ROUTE_CLASS
} from "../observability/route-classes.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE = path.resolve(__dirname, "../../../docs/openapi/baseline.yaml");

describe("routeClassFor", () => {
  test("uses the Fastify route pattern, not the raw URL", () => {
    assert.equal(routeClassFor({ routeOptions: { url: "/api/students/:studentId" }, raw: { url: "/api/students/stu-abc-123?x=1" } }), "/api/students/:studentId");
    assert.equal(routeClassFor({ routeOptions: { url: "/api/sync/attempts" } }), "/api/sync/attempts");
  });

  test("no route (404s, OPTIONS short-circuits) classifies as unmatched — attacker paths never become labels", () => {
    assert.equal(routeClassFor({ routeOptions: {} }), UNMATCHED_ROUTE_CLASS);
    assert.equal(routeClassFor({}), UNMATCHED_ROUTE_CLASS);
    assert.equal(routeClassFor(null), UNMATCHED_ROUTE_CLASS);
    // Even a "route pattern" that somehow carried URL junk is refused.
    assert.equal(routeClassFor({ routeOptions: { url: "/api/victim@example.com?token=1" } }), UNMATCHED_ROUTE_CLASS);
    assert.equal(routeClassFor({ routeOptions: { url: `/${"a".repeat(100)}` } }), UNMATCHED_ROUTE_CLASS);
    assert.equal(routeClassFor({ routeOptions: { url: '/x"y' } }), UNMATCHED_ROUTE_CLASS);
  });
});

describe("statusClassFor and methodFor", () => {
  test("status classes are the 2xx-5xx buckets, everything else other", () => {
    assert.equal(statusClassFor(200), "2xx");
    assert.equal(statusClassFor(204), "2xx");
    assert.equal(statusClassFor(301), "3xx");
    assert.equal(statusClassFor(401), "4xx");
    assert.equal(statusClassFor(429), "4xx");
    assert.equal(statusClassFor(500), "5xx");
    assert.equal(statusClassFor(100), "other");
    assert.equal(statusClassFor(undefined), "other");
    assert.equal(statusClassFor("200"), "other");
  });

  test("methods are the known HTTP verbs, else other", () => {
    for (const m of ["GET", "POST", "PUT", "OPTIONS"]) assert.equal(methodFor({ method: m }), m);
    assert.equal(methodFor({ method: "get" }), "GET");
    assert.equal(methodFor({ method: "PROPFIND" }), "other");
    assert.equal(methodFor({}), "other");
  });
});

describe("metric vocabulary is pinned to the OpenAPI baseline", () => {
  test("every baseline path maps to a bounded route class; the whole vocabulary fits the label budget", () => {
    const yaml = readFileSync(BASELINE, "utf8");
    const paths = [...yaml.matchAll(/^  (\/[A-Za-z0-9/_-]*\{[^}]+\}[A-Za-z0-9/_-]*|\/[A-Za-z0-9/_-]+):$/gm)].map((m) => m[1]);
    assert.ok(paths.length >= 38, `expected the full baseline path list, got ${paths.length}`);
    const classes = paths.map(openApiPathToRouteClass);
    for (const c of classes) {
      assert.ok(c.startsWith("/api/"), `non-API path in baseline: ${c}`);
      assert.ok(c.length <= 64);
      assert.match(c, /^[A-Za-z0-9:/_-]+$/);
    }
    // Cardinality budget arithmetic (registry cap is 512 series per
    // metric): the full route vocabulary x 2 methods x 5 status classes
    // must fit — pathological growth past that is REJECTED by the cap
    // (counted on metrics_observations_rejected_total), never
    // allocated. This pins the vocabulary so the budget stays honest.
    const worstCaseSeries = (classes.length + 1) * 2 * 5;
    assert.ok(
      worstCaseSeries <= 512,
      `route-class vocabulary grew past the cardinality budget: ${worstCaseSeries} > 512`
    );
  });
});
