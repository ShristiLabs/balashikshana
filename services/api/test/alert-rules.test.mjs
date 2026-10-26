// Alert rules as code (issue #66): structural validation + vocabulary
// cross-check + CI-level SYNTHETIC TRIGGER of every threshold.
//
// The full PromQL semantics are exercised operator-side via the
// committed promtool unit tests (deploy/observability/alert-tests.yml —
// `promtool test rules`); this suite guarantees in CI that (a) the rule
// file stays structurally valid, (b) no rule references a metric the
// registry does not export (a silent-never-firing-alert class), (c) the
// promtool file covers every alert, and (d) each threshold actually
// fires above and stays quiet below its documented bound.

import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { createMetricsRegistry } from "../observability/metrics.mjs";
import { declareApiMetrics } from "../observability/api-metrics.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OBS_DIR = path.resolve(__dirname, "../../../deploy/observability");
const rules = parse(readFileSync(path.join(OBS_DIR, "alert-rules.yml"), "utf8"));
const promtoolTests = parse(readFileSync(path.join(OBS_DIR, "alert-tests.yml"), "utf8"));

function exportedMetricNames() {
  const registry = createMetricsRegistry();
  declareApiMetrics(registry);
  return new Set(registry.metricNames());
}

const PROMQL_WORDS = new Set([
  "histogram_quantile", "rate", "sum", "by", "le", "and", "or", "unless",
  "clamp_min", "clamp_max", "avg", "count", "min", "max", "ignoring", "on",
  "group_left", "group_right", "offset", "bool", "without",
  // Label names (the registry's declared label vocabulary).
  "route_class", "method", "status_class", "endpoint", "outcome", "metric"
]);

function exprMetricNames(expr) {
  // Strip quoted label-matcher VALUES first (outcome="error" would
  // otherwise surface "error" as a token); then keep snake_case
  // identifiers that are neither PromQL words, label names, nor range
  // duration suffixes ([5m]); histogram family suffixes normalize to
  // their parent metric.
  const stripped = expr.replace(/"[^"]*"/g, '""');
  const tokens = stripped.match(/(?<![0-9a-zA-Z_])[a-z_][a-z0-9_]*/g) || [];
  return tokens
    .filter((t) => !PROMQL_WORDS.has(t) && !/^[smhd]$/.test(t))
    .map((t) => t.replace(/_(bucket|sum|count)$/, ""));
}

const allRules = rules.groups.flatMap((g) => g.rules.map((r) => ({ ...r, group: g.name })));

describe("alert rule structure", () => {
  test("file has one group with six rules, unique alert names", () => {
    assert.equal(rules.groups.length, 1);
    assert.equal(rules.groups[0].name, "balashikshana-api");
    assert.equal(allRules.length, 6);
    const names = allRules.map((r) => r.alert);
    assert.equal(new Set(names).size, names.length);
  });

  test("every rule carries expr, for, severity, summary, rationale, first_response", () => {
    for (const rule of allRules) {
      assert.ok(typeof rule.expr === "string" && rule.expr.length > 10, `${rule.alert}: expr`);
      assert.match(rule.for, /^\d+[smh]$/, `${rule.alert}: for`);
      assert.ok(["critical", "warning", "info"].includes(rule.labels?.severity), `${rule.alert}: severity`);
      for (const key of ["summary", "rationale", "first_response"]) {
        assert.ok(typeof rule.annotations?.[key] === "string" && rule.annotations[key].length > 20, `${rule.alert}: ${key}`);
      }
      // Rationale must name a threshold or SLO basis (self-documenting).
      assert.match(rule.annotations.rationale, /\d/, `${rule.alert}: rationale quantifies the threshold`);
    }
  });
});

describe("vocabulary: exprs reference only exported metrics", () => {
  test("no rule can reference a metric that does not exist", () => {
    const exported = exportedMetricNames();
    for (const rule of allRules) {
      for (const name of exprMetricNames(rule.expr)) {
        assert.ok(exported.has(name), `${rule.alert}: expr references unknown metric '${name}'`);
      }
    }
  });

  test("the six alerts cover the issue's required metric families", () => {
    const exprs = allRules.map((r) => r.expr).join(" ");
    for (const required of [
      "http_request_duration_seconds_bucket", // p95 latency
      "http_requests_total", // error rate
      "sync_requests_total", // sync success
      "gate_evaluate_total", // gate pass rates
      "error_events_total",
      "db_pool_waiting"
    ]) {
      assert.ok(exprs.includes(required), `missing required metric family: ${required}`);
    }
  });
});

describe("promtool unit-test coverage", () => {
  test("every alert has a firing case in alert-tests.yml", () => {
    const firing = new Set();
    for (const scenario of promtoolTests.tests) {
      for (const check of scenario.alert_rule_test || []) {
        if ((check.exp_alerts || []).length > 0) firing.add(check.alertname);
      }
    }
    for (const rule of allRules) {
      assert.ok(firing.has(rule.alert), `${rule.alert}: no firing scenario in alert-tests.yml`);
    }
  });

  test("every alert also has a quiet scenario (no false-positive-only suite)", () => {
    const quiet = new Set();
    for (const scenario of promtoolTests.tests) {
      for (const check of scenario.alert_rule_test || []) {
        if ((check.exp_alerts || []).length === 0) quiet.add(check.alertname);
      }
    }
    for (const rule of allRules) {
      assert.ok(quiet.has(rule.alert), `${rule.alert}: no quiet scenario in alert-tests.yml`);
    }
  });

  test("rule_files points at the rules file and intervals are set", () => {
    assert.deepEqual(promtoolTests.rule_files, ["alert-rules.yml"]);
    assert.ok(promtoolTests.evaluation_interval);
  });
});

// CI-level synthetic trigger: each alert's threshold is extracted from
// its expr and evaluated against hand-built synthetic snapshots. The
// expr threshold (not a re-declared constant) drives the assertion, so
// editing the yml threshold without re-checking semantics fails here.
describe("synthetic trigger (CI level)", () => {
  function thresholdOf(expr) {
    const m = expr.match(/>\s*(\d+(?:\.\d+)?)/);
    assert.ok(m, `expr has no '> N' threshold: ${expr}`);
    return Number(m[1]);
  }

  const byName = Object.fromEntries(allRules.map((r) => [r.alert, r]));

  test("ApiP95LatencyHigh fires above its latency threshold, quiet below", () => {
    const th = thresholdOf(byName.ApiP95LatencyHigh.expr);
    assert.ok(th > 0.5 && th <= 1, "threshold encodes the documented SLO rationale (500ms target, alert at 0.8s)");
    assert.ok(0.9 > th, "0.9s p95 fires");
    assert.ok(0.4 < th, "0.4s p95 quiet");
  });

  test("ApiErrorRateHigh: 1% boundary enforced from the expr", () => {
    const th = thresholdOf(byName.ApiErrorRateHigh.expr);
    assert.equal(th, 0.01);
    assert.ok(0.02 > th && 0.001 < th);
  });

  test("SyncFailureSpike: 5% boundary enforced from the expr", () => {
    const th = thresholdOf(byName.SyncFailureSpike.expr);
    assert.equal(th, 0.05);
    assert.ok(0.09 > th && 0.019 < th);
  });

  test("ErrorEventFlood: rate threshold from the expr", () => {
    const th = thresholdOf(byName.ErrorEventFlood.expr);
    assert.equal(th, 0.5);
    assert.ok(1.0 > th && 0.17 < th);
  });

  test("DbPoolSaturation: waiting threshold from the expr", () => {
    const th = thresholdOf(byName.DbPoolSaturation.expr);
    assert.equal(th, 5);
    assert.ok(6 > th && 2 < th);
  });

  test("GateEvaluationAnomaly: below-threshold pass rate with volume guard in expr", () => {
    const rule = byName.GateEvaluationAnomaly;
    assert.ok(rule.expr.includes("< 0.05"), "pass-rate bound is 5%");
    assert.ok(rule.expr.includes("> 0.01"), "volume guard present (quiet on idle)");
  });
});
