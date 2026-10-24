// RFC 9457 problem+json envelope shared by server.mjs and the parent-auth
// plugin (issue #40). Extracted from server.mjs so route modules can send
// problems without a circular import; server.mjs re-exports sendProblem.

export const PROBLEM_BASE = "https://balashikshana.dev/problems";

export const STATUS_TITLES = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  413: "Payload Too Large",
  414: "URI Too Long",
  429: "Too Many Requests",
  500: "Internal Server Error"
};

export function sendProblem(reply, status, { type, title, detail, errors, retryAfterSec } = {}) {
  const body = {
    type: type || "about:blank",
    title: title || STATUS_TITLES[status] || "Error",
    status,
    detail: detail || STATUS_TITLES[status] || "Error",
    instance: reply.request.url
  };
  if (errors) body.errors = errors;
  if (retryAfterSec !== undefined) {
    reply.header("Retry-After", String(Math.max(1, Math.ceil(retryAfterSec))));
  }
  reply.code(status).type("application/problem+json; charset=utf-8").send(body);
}
