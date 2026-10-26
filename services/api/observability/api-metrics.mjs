// The API's metric vocabulary (issue #66), declared in ONE place so
// server.mjs and the cross-consistency tests (alert rules, dashboards)
// share the exact same exported set. Labels are bounded by validators:
// route classes are Fastify route patterns (fixed inventory), methods
// and outcomes are enums; guard failures are rejected by the registry
// and counted on metrics_observations_rejected_total.

import { enumLabel, regexLabel } from "./metrics.mjs";
import { UNMATCHED_ROUTE_CLASS, HTTP_METHODS } from "./route-classes.mjs";

export function declareApiMetrics(metrics) {
  // Route classes are Fastify route patterns ("/api/students/:id") or
  // the literal "unmatched" bucket (404s / pre-route short-circuits).
  const ROUTE_CLASS_LABEL = regexLabel(/^(\/[A-Za-z0-9:/_-]{1,63}|unmatched)$/, UNMATCHED_ROUTE_CLASS);
  const STATUS_CLASS_LABEL = enumLabel(["2xx", "3xx", "4xx", "5xx", "other"], "other");
  const METHOD_LABEL = enumLabel([...HTTP_METHODS, "other"], "other");

  const httpRequestsTotal = metrics.counter(
    "http_requests_total",
    "HTTP requests by route class, method, and status class",
    { route_class: ROUTE_CLASS_LABEL, method: METHOD_LABEL, status_class: STATUS_CLASS_LABEL }
  );
  const httpRequestDuration = metrics.histogram(
    "http_request_duration_seconds",
    "HTTP request latency in seconds by route class, method, and status class",
    { route_class: ROUTE_CLASS_LABEL, method: METHOD_LABEL, status_class: STATUS_CLASS_LABEL },
    [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.4, 0.8, 1.5, 3, 5, 10]
  );
  const gateEvaluationsTotal = metrics.counter(
    "gate_evaluate_total",
    "Unit boss-gate evaluations by engine outcome (pass/fail), independent of HTTP status",
    { outcome: enumLabel(["pass", "fail"], "fail") }
  );
  const syncRequestsTotal = metrics.counter(
    "sync_requests_total",
    "Sync protocol requests by endpoint and final outcome (success = 2xx; auth/validation/cap failures = error)",
    {
      endpoint: enumLabel(["attempts", "progress"], "progress"),
      outcome: enumLabel(["success", "error"], "error")
    }
  );
  const errorEventsTotal = metrics.counter(
    "error_events_total",
    "Captured error events by capture outcome (unhandled 5xx captured / flood-capped)",
    { outcome: enumLabel(["captured", "flood-capped", "insert-failed"], "insert-failed") }
  );
  const dbPoolTotal = metrics.gauge("db_pool_total", "Postgres pool clients total", {});
  const dbPoolIdle = metrics.gauge("db_pool_idle", "Postgres pool idle clients", {});
  const dbPoolWaiting = metrics.gauge("db_pool_waiting", "Postgres clients waiting for a pool slot", {});

  return {
    httpRequestsTotal,
    httpRequestDuration,
    gateEvaluationsTotal,
    syncRequestsTotal,
    errorEventsTotal,
    dbPoolTotal,
    dbPoolIdle,
    dbPoolWaiting
  };
}
