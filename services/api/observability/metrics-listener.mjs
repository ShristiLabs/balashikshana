// Internal metrics exposition listener (issue #66).
//
// Serves the Prometheus text format on a SEPARATE listener from the
// public app — deliberately NOT a route on the Fastify app:
//   - the public port is child-facing (behind the Dwara edge, which
//     routes only /api/* — an origin /metrics route would also be a
//     NEW public surface the OpenAPI baseline would have to own);
//   - a dedicated port lets operators SG-restrict scraping to the
//     Prometheus host only (infra/modules/api_service wiring).
// The listener binds METRICS_HOST (default 127.0.0.1) so a bare local
// run never exposes it, and supports an optional bearer token
// (METRICS_TOKEN) as defense in depth for shared private networks.
//
// GET/HEAD /metrics only; everything else is 404/405. The server is
// unref'd — observability never holds the process open.

import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

function authorizedToken(authHeader, token) {
  // Compare sha256 digests with timingSafeEqual — hashing both sides
  // first normalizes length (the digest is fixed-size), so the
  // comparison leaks nothing about the token.
  const given = createHash("sha256").update(String(authHeader || "")).digest();
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  return timingSafeEqual(given, expected);
}

export function startMetricsListener({ registry, port, host = "127.0.0.1", token } = {}) {
  // port 0 is valid (kernel-assigned ephemeral port — used by tests);
  // production gating (METRICS_PORT > 0) happens at the caller.
  if (!registry || !Number.isInteger(port) || port < 0) {
    throw new Error("startMetricsListener requires a registry and a non-negative integer port");
  }

  const server = http.createServer((req, res) => {
    const method = (req.method || "GET").toUpperCase();
    const path = (req.url || "/").split("?")[0];

    if (path !== "/metrics") {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" });
      res.end("method not allowed");
      return;
    }
    if (token && !authorizedToken(req.headers.authorization, token)) {
      res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("unauthorized");
      return;
    }
    const body = registry.render();
    res.writeHead(200, { "Content-Type": METRICS_CONTENT_TYPE });
    res.end(method === "HEAD" ? undefined : body);
  });

  server.unref();
  server.listen(port, host);
  const ready = new Promise((resolve, reject) => {
    server.once("listening", () => resolve(server.address()));
    server.once("error", reject);
  });

  return {
    server,
    ready,
    port,
    host,
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    }
  };
}
