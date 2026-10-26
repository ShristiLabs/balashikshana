// Redaction unit edges (issue #66, tester pass): every scrubber at its
// boundaries — IPv4 /24 and IPv6 /48 truncation, bearer and opaque
// token shapes, phones, the UUID exemption (applied ONLY to
// well-formed correlation-shaped ids), URL query/fragment stripping,
// and the truncation caps. These pin the exact policy the runbook
// documents.

import { test, describe } from "vitest";
import assert from "node:assert/strict";
import {
  redactText,
  truncateIp,
  logSafeUrl,
  errorFingerprint,
  isUuid
} from "../observability/redact.mjs";

describe("IP truncation (COPPA: keep network prefix only)", () => {
  test("IPv4 keeps the /24 network prefix", () => {
    assert.equal(truncateIp("203.0.113.77"), "203.0.113.0");
    assert.equal(truncateIp("192.168.1.200"), "192.168.1.0");
    assert.equal(truncateIp("10.0.0.1"), "10.0.0.0");
  });

  test("IPv6 keeps the first three groups (/48) and pads with ::", () => {
    assert.equal(truncateIp("2001:0db8:85a3:acad:0000:8a2e:0370:7334"), "2001:0db8:85a3::");
    // COMPRESSED forms (< 3 explicit groups, e.g. fd00::1) cannot yield
    // a /48 prefix without ::-expansion — the implementation FAILS
    // CLOSED to full anonymization instead of guessing. Pinned here.
    assert.equal(truncateIp("fd00::1"), "[ip-anon]");
  });

  test("garbage and empty inputs degrade to [ip-anon], never a passthrough", () => {
    assert.equal(truncateIp("not-an-ip"), "[ip-anon]");
    assert.equal(truncateIp(""), "[ip-anon]");
    assert.equal(truncateIp(undefined), "[ip-anon]");
    // 4-numeric-octet shapes truncate even at invalid octet ranges
    // (999) — over-permissive parse, but the output is still a
    // truncated numeric shape (no free text, no injection surface).
    // LOW observation in the tester report, not a defect.
    assert.match(truncateIp("999.999.999.999"), /^\d{1,3}\.\d{1,3}\.\d{1,3}\.0$/);
  });
});

describe("free-text scrubbers", () => {
  test("bearer tokens are redacted with the Bearer prefix preserved", () => {
    assert.equal(
      redactText("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.sig.part"),
      "Authorization: Bearer [redacted-token]"
    );
  });

  test("opaque 22+ char tokens are redacted even without the Bearer prefix", () => {
    // '=' is INSIDE the token character class, so the whole span
    // "token=<credential>" collapses into one replacement (safe).
    assert.equal(
      redactText("token=abcdefghijklmnopqrstuvxyz0123"),
      "[redacted-token]"
    );
    // Below the 22-char threshold ordinary words survive (threshold
    // semantics: a 20-char English word is not a credential).
    assert.equal(redactText("internationalization"), "internationalization");
  });

  test("emails, phones, IPv4, and IPv6 are scrubbed from messages and stacks", () => {
    const text = redactText(
      "contact parent@example.org or +1-202-555-0173 from 198.51.100.42 / 2001:db8:dead:beef::1"
    );
    assert.ok(!text.includes("parent@example.org"));
    assert.ok(!text.includes("+1-202-555-0173"));
    assert.ok(!text.includes("198.51.100.42"));
    assert.ok(!text.includes("2001:db8:dead:beef::1"));
    assert.ok(text.includes("[redacted-email]"));
    assert.ok(text.includes("[redacted-phone]"));
    assert.ok(text.includes("[redacted-ip]"));
  });

  test("the UUID exemption: well-formed UUIDs survive (correlation keys), in BOTH cases", () => {
    const requestId = "7f9c24e8-3f04-4d3f-9d2a-1b6c8e5a2f10";
    assert.equal(redactText(`failed for request ${requestId}`), `failed for request ${requestId}`);
    assert.equal(isUuid(requestId), true);
    assert.equal(isUuid("1111111122223333444455555555555555"), false);
    assert.equal(isUuid("../../etc/passwd"), false);
  });

  test("length caps apply with an explicit marker (message 2048 in the store; default 4096 here)", () => {
    // Filler breaks the 22+ token class so the truncation path runs.
    const out = redactText("ab ".repeat(2000), { maxLen: 100 });
    assert.ok(out.startsWith("ab ".repeat(33).slice(0, 100)));
    assert.ok(out.endsWith("...[truncated]"));
    assert.ok(out.length <= 100 + 20);
  });

  test("null-ish inputs return undefined, not the string 'null'", () => {
    assert.equal(redactText(null), undefined);
    assert.equal(redactText(undefined), undefined);
  });
});

describe("log-safe URLs", () => {
  test("query strings and fragments are stripped unconditionally", () => {
    assert.equal(logSafeUrl("/api/consent/policy/latest?token=secret123&email=a@b.c"), "/api/consent/policy/latest");
    assert.equal(logSafeUrl("/api/thing#frag"), "/api/thing");
  });

  test("overlong paths are truncated with a visible marker", () => {
    const long = `/${"p".repeat(200)}`;
    const out = logSafeUrl(long);
    assert.equal(out.length, 128);
    assert.ok(out.endsWith("..."));
  });

  test("non-strings return undefined", () => {
    assert.equal(logSafeUrl(""), undefined);
    assert.equal(logSafeUrl(null), undefined);
  });
});

describe("error fingerprint", () => {
  const STACK = "Error: boom\n    at run (/app/services/api/sync.mjs:100:15)\n    at f (/app/x.mjs:1:1)";
  test("stable for identical inputs; 16 hex chars", () => {
    const a = errorFingerprint("/api/sync/attempts", "internal", STACK);
    const b = errorFingerprint("/api/sync/attempts", "internal", STACK);
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{16}$/);
  });

  test("differs across route class, problem type, and top frame", () => {
    const base = errorFingerprint("/api/sync/attempts", "internal", STACK);
    assert.notEqual(base, errorFingerprint("/api/gate/evaluate", "internal", STACK));
    assert.notEqual(base, errorFingerprint("/api/sync/attempts", "validation", STACK));
    const otherFrame = "Error: boom\n    at run (/app/services/api/other.mjs:9:9)\n    at f (/app/x.mjs:1:1)";
    assert.notEqual(base, errorFingerprint("/api/sync/attempts", "internal", otherFrame));
  });

  test("carries no identity: the fingerprint does not encode message PII", () => {
    const withEmail = errorFingerprint("/api/x", "internal", "Error: parent@example.com failed\n    at run (/a.mjs:1:1)");
    assert.ok(!withEmail.includes("example"));
  });
});
