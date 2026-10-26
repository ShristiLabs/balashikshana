// Grafana dashboard definitions (issue #66): committed JSON stays
// structurally valid and every panel expression references metrics the
// registry actually exports.

import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMetricsRegistry } from "../observability/metrics.mjs";
import { declareApiMetrics } from "../observability/api-metrics.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DASH_DIR = path.resolve(__dirname, "../../../deploy/observability/dashboards");

const registry = createMetricsRegistry();
declareApiMetrics(registry);
const exported = new Set(registry.metricNames());

const PROMQL_WORDS = new Set([
  "histogram_quantile", "rate", "sum", "by", "le", "and", "or", "avg", "without", "ignoring",
  "clamp_min", "clamp_max",
  // Label names (the registry's declared label vocabulary).
  "route_class", "method", "status_class", "endpoint", "outcome", "metric"
]);

function exprMetricNames(expr) {
  const stripped = expr.replace(/"[^"]*"/g, '""');
  const tokens = stripped.match(/(?<![0-9a-zA-Z_])[a-z_][a-z0-9_]*/g) || [];
  return tokens
    .filter((t) => !PROMQL_WORDS.has(t) && !/^[smhd]$/.test(t))
    .map((t) => t.replace(/_(bucket|sum|count)$/, ""));
}

const dashboards = readdirSync(DASH_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ file: f, json: JSON.parse(readFileSync(path.join(DASH_DIR, f), "utf8")) }));

describe("committed Grafana dashboards", () => {
  test("at least one dashboard is committed (AC: dashboard definitions committed)", () => {
    assert.ok(dashboards.length >= 1);
  });

  for (const { file, json } of dashboards) {
    describe(file, () => {
      test("has uid/title/schemaVersion and unique panel titles/ids", () => {
        assert.ok(json.uid && json.title && json.schemaVersion >= 36);
        const titles = json.panels.map((p) => p.title);
        assert.equal(new Set(titles).size, titles.length, "duplicate panel titles");
        const ids = json.panels.map((p) => p.id);
        assert.equal(new Set(ids).size, ids.length, "duplicate panel ids");
      });

      test("every panel expr references exported metrics only", () => {
        for (const panel of json.panels) {
          for (const target of panel.targets || []) {
            assert.ok(typeof target.expr === "string" && target.expr.length > 5, `${panel.title}: missing expr`);
            for (const name of exprMetricNames(target.expr)) {
              assert.ok(exported.has(name), `${panel.title}: unknown metric '${name}'`);
            }
          }
        }
      });

      test("no PII placeholders in dashboard text", () => {
        const text = JSON.stringify(json).toLowerCase();
        for (const banned of ["@example", "child-name", "student@", "bearer "]) {
          assert.ok(!text.includes(banned), `dashboard text contains '${banned}'`);
        }
      });

      test("dashboard JSON serializes deterministically (committed form is canonical)", () => {
        assert.equal(JSON.stringify(json), JSON.stringify(JSON.parse(JSON.stringify(json))));
      });
    });
  }

  test("api-overview covers the issue's required metric families", () => {
    const overview = dashboards.find((d) => d.file === "api-overview.json");
    assert.ok(overview, "api-overview.json missing");
    const exprs = overview.json.panels.flatMap((p) => (p.targets || []).map((t) => t.expr)).join(" ");
    for (const required of [
      "http_request_duration_seconds_bucket",
      "http_requests_total",
      "sync_requests_total",
      "gate_evaluate_total",
      "error_events_total",
      "db_pool_",
      "metrics_observations_rejected_total"
    ]) {
      assert.ok(exprs.includes(required), `dashboard missing metric family: ${required}`);
    }
  });
});
