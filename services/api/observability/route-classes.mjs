// Route classification for metrics labels (issue #66).
//
// BOUNDED BY CONSTRUCTION: the class IS the Fastify route pattern
// (`req.routeOptions.url`, e.g. "/api/students/:studentId") — the
// server's own registered route inventory, a fixed set (pinned by the
// route-classes test against the OpenAPI baseline path list). Requests
// that match no route classify as "unmatched" — the raw URL NEVER
// becomes a label value, so a crafted path cannot explode label
// cardinality or smuggle text into the exposition.
//
// A hand-maintained regex table was considered and rejected: it can
// drift from the real route set; the route table itself cannot.

export const UNMATCHED_ROUTE_CLASS = "unmatched";

// Fastify route patterns use :param syntax; the OpenAPI baseline uses
// {param}. Normalizing baseline paths to Fastify form lets the test
// pin the metric vocabulary to the documented contract.
export function openApiPathToRouteClass(path) {
  return String(path).replace(/\{([^}]+)\}/g, ":$1");
}

export function routeClassFor(req) {
  const pattern = req?.routeOptions?.url;
  if (typeof pattern !== "string" || pattern.length === 0) {
    return UNMATCHED_ROUTE_CLASS;
  }
  // Defense in depth: even route patterns must stay short and plain.
  if (pattern.length > 64 || !/^[A-Za-z0-9:/_-]+$/.test(pattern)) {
    return UNMATCHED_ROUTE_CLASS;
  }
  return pattern;
}

export function statusClassFor(statusCode) {
  if (typeof statusCode !== "number" || !Number.isFinite(statusCode)) return "other";
  const bucket = Math.floor(statusCode / 100);
  if (bucket >= 2 && bucket <= 5) return `${bucket}xx`;
  return "other";
}

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export function methodFor(req) {
  const method = String(req?.method || "").toUpperCase();
  return HTTP_METHODS.includes(method) ? method : "other";
}
