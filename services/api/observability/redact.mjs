// PII redaction for the observability seam (issue #66, D5/COPPA): no
// child identifiers or PII in logs, metrics, or error events.
//
// Policy (docs/observability.md "Redaction policy"):
//   - Direct identifiers (emails, phone numbers, bearer/verification
//     tokens, IP addresses) are pattern-scrubbed from ANY free text
//     (log fields, error messages, stack traces) before emission or
//     persistence.
//   - Request/response bodies are NEVER captured into telemetry at all
//     (the error store records problem type + route class + redacted
//     stack/message only).
//   - URLs are logged as the ROUTE TEMPLATE (path pattern) — raw query
//     strings never enter logs (they can carry one-time tokens), and
//     unmatched paths are never logged verbatim.
//   - OPAQUE SURROGATE UUIDs (studentId, parentId, requestId) are the
//     documented exemption: they are random identifiers with no
//     semantic link to a person, they are the correlation keys the
//     issue's correlation-ID acceptance criterion needs, and they are
//     only resolvable through an authorized database query. Scrubbing
//     them would break correlation without removing identifiability
//     (the database remains the only join point, as with every other
//     API surface).
//   - Arbitrary child NAMES cannot be pattern-detected in free text;
//     the mitigation is structural: telemetry never captures body or
//     body-derived text, so names have no path into it. The PII-scan
//     test enforces this end-to-end with planted names.

import crypto from "node:crypto";

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g;
// Coarse IPv6 (4+ colon-separated groups) — enough for redaction duty;
// false positives here only over-redact telemetry text.
const IPV6_RE = /\b(?:[A-Fa-f0-9]{1,4}:){3,7}[A-Fa-f0-9]{1,4}\b/g;
const BEARER_RE = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi;
// Opaque token-shaped strings: >= 22 contiguous base64url/hex chars
// with no dashes (UUIDs contain dashes and are exempt).
const TOKEN_RE = /\b[A-Za-z0-9_~+/=]{22,}\b/g;

export function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

// Truncate an IP for logging: keep network prefix only (IPv4 /24,
// IPv6 /48). COPPA reads IP addresses as personal information when
// persistable; the truncated form preserves abuse-routing signal
// (ISP/network) without a persistent per-device identifier.
export function truncateIp(ip) {
  if (typeof ip !== "string" || ip.length === 0) return "[ip-anon]";
  if (ip.includes(".")) {
    const octets = ip.split(".");
    if (octets.length === 4 && octets.every((o) => /^\d{1,3}$/.test(o))) {
      return `${octets[0]}.${octets[1]}.${octets[2]}.0`;
    }
  }
  if (ip.includes(":")) {
    const groups = ip.split(":").filter(Boolean);
    if (groups.length >= 3) return `${groups.slice(0, 3).join(":")}::`;
  }
  return "[ip-anon]";
}

// Log-safe URL: PATH ONLY. Query strings are dropped unconditionally —
// they can carry one-time verification/reset material, and route
// templates (not raw paths) are the analytics key anyway.
export function logSafeUrl(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return undefined;
  const path = rawUrl.split("?")[0].split("#")[0];
  if (path.length > 128) return `${path.slice(0, 125)}...`;
  return path;
}

// Scrub direct identifiers from free text (error messages, stack
// traces). Order matters: bearer tokens before the generic token shape.
export function redactText(text, { maxLen = 4096 } = {}) {
  if (text === null || text === undefined) return undefined;
  let out = String(text);
  out = out.replace(BEARER_RE, "$1[redacted-token]");
  out = out.replace(TOKEN_RE, "[redacted-token]");
  out = out.replace(EMAIL_RE, "[redacted-email]");
  out = out.replace(PHONE_RE, "[redacted-phone]");
  out = out.replace(IPV6_RE, "[redacted-ip]");
  out = out.replace(IPV4_RE, "[redacted-ip]");
  if (out.length > maxLen) {
    out = `${out.slice(0, maxLen)}...[truncated]`;
  }
  return out;
}

// Stack traces: redacted + frame-preserving + hard length cap. Never
// contains request bodies by construction (only Error internals).
export function redactStack(stack, { maxLen = 8192 } = {}) {
  return redactText(stack, { maxLen });
}

// Stable grouping fingerprint for error events: route class + problem
// type + top stack frame. Deliberately NOT identity-bearing.
export function errorFingerprint(routeClass, problemType, stack) {
  const firstFrame = typeof stack === "string" ? (stack.split("\n").find((l) => l.trim().startsWith("at ")) || "").trim() : "";
  const raw = `${routeClass}|${problemType}|${firstFrame}`;
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}
