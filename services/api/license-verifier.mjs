// B2B license verification seam (issue #70, roadmap D10): offline
// verification of ShristiLabs licensing-core license files — Ed25519-signed
// seat licenses for school/district accounts.
//
// WHY A JS VERIFIER (the language-boundary decision): licensing-core is a
// Rust crate (private git dependency of ShristiLabs products). The API is a
// Node service and cannot import Rust directly, so this module implements
// licensing-core's EXACT wire contract in JS via the audited
// @noble/ed25519 (already the mobile runtime pattern for signed content
// packs — apps/mobile/src/content/verify.ts). Ed25519 is deterministic per
// RFC 8032: a signature produced here over canonical claims is
// byte-identical to ed25519-dalek's for the same seed+message, which the
// pinned GOLDEN VECTOR test exploits to prove format compatibility without
// a Rust toolchain. The seam stays behind this injectable factory so a
// future adapter (licensing-server HTTP activation, or a WASM build of
// licensing-core) can replace the implementation without touching callers.
//
// Reference semantics mirrored 1:1 from crates/licensing-core/src
// (claims.rs / canonical.rs / verifier.rs / keys.rs):
// - Claims v2 fields: license_id, product_id, customer, plan, seats (u32),
//   instance_id, issued_at, expires_at, features (string array). The
//   license file adds a base64 `signature` alongside (serde flatten), so
//   the on-disk shape is ONE flat object.
// - The signature is a detached Ed25519 signature over the claims
//   serialized as CANONICAL JSON: every object's keys sorted recursively
//   (lexicographically by Unicode code point == serde_json's BTreeMap
//   UTF-8 byte order), compact (no whitespace), array order preserved.
// - Verification order: strict base64 decode (STANDARD alphabet, padded)
//   -> 64-byte length -> signature check -> expires_at check (now >
//   expires_at => expired) -> optional instance_id pin -> optional
//   product_id pin. Error taxonomy: parse / invalid-signature / expired /
//   instance-mismatch / product-mismatch.
// - Timestamps: chrono serializes DateTime<Utc> as RFC 3339 UTC with a
//   trailing Z and AutoSi sub-second precision (3/6/9 digits, only when
//   non-zero). The signature is computed over the PARSED-THEN-RESERIALIZED
//   value in Rust, so a real licensing-core license always carries
//   timestamp strings ALREADY in chrono's canonical form. This verifier
//   therefore canonicalizes with the ORIGINAL string bytes and enforces
//   the canonical RFC 3339 shape up front (a non-canonical timestamp could
//   never verify against a genuine licensing-core signature — Rust would
//   have re-serialized it — so rejecting it as a parse error is the
//   faithful behavior, not a divergence).
// - Unknown extra fields in the file JSON are IGNORED (Rust serde's
//   default tolerant deserialization); the signature covers only the
//   known claims fields re-serialized canonically. Pinned by the
//   extra-field-parity test.
//
// KEY HYGIENE (issue AC): products embed ONLY their public key. The
// Balashikshana product public key arrives via the
// BALASHIKSHANA_LICENSE_PUBLIC_KEY env var (base64-encoded 32 bytes — the
// MADHYAMAS_LICENSE_PUBLIC_KEY pattern). The development fallback is
// licensing-core's PUBLIC deterministic dev keypair (keys.rs: the seed is
// public by design, "never use in production"); it is DERIVED here from
// the same public seed constant, never copied from the licensing repo's
// gitignored keys/ directory. No signing material beyond that public dev
// seed exists in this repo, and nothing here can SIGN — verification only.

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";

// @noble/ed25519 requires the caller to supply SHA-512 (the package stays
// Web-Crypto-free); wired exactly like apps/mobile/src/content/verify.ts.
// Module-level ONCE: every import shares the same configuration.
{
  const mergeMessages = (messages) => {
    const total = messages.reduce((n, m) => n + m.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const m of messages) {
      out.set(m, offset);
      offset += m.length;
    }
    return out;
  };
  ed.etc.sha512Sync = (...m) => sha512(mergeMessages(m));
  ed.etc.sha512Async = async (...m) => sha512(mergeMessages(m));
}

// The product code licenses must be scoped to (defense in depth on top of
// the per-product key: a license issued for another ShristiLabs product
// cannot be replayed here even under improbable key reuse). Mirrors
// LicenseVerifier::with_expected_product_id.
export const EXPECTED_PRODUCT_ID = "balashikshana";

// licensing-core's PUBLIC development seed (crates/licensing-core/src/
// keys.rs DEV_KEY_SEED — ASCII, 32 bytes, public by design). Used ONLY as
// the dev/test fallback verifier key; production deployments must set
// BALASHIKSHANA_LICENSE_PUBLIC_KEY.
export const DEV_LICENSE_KEY_SEED = "shristilabs-dev-license-key-seed";

export const PUBLIC_KEY_ENV_VAR = "BALASHIKSHANA_LICENSE_PUBLIC_KEY";

// Claims v2 field inventory (single source for extraction + validation).
const STRING_FIELDS = ["license_id", "product_id", "customer", "plan", "instance_id"];
const U32_MAX = 4294967295;

// chrono RFC 3339 UTC canonical form: date-time with 'Z' and AutoSi
// sub-second precision (3, 6, or 9 digits, only when non-zero).
const CANONICAL_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3}|\.\d{6}|\.\d{9})?Z$/;

// Strict STANDARD base64 (padded, full alphabet) — Buffer's base64 decoder
// is lenient (ignores invalid characters), so shape is enforced first,
// exactly like Rust's base64::engine::general_purpose::STANDARD.
const STRICT_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

// Code-point ordering (== UTF-8 byte ordering == serde_json BTreeMap).
// The default JS string compare is UTF-16 code-UNIT order, which diverges
// from code-point order for supplementary-plane characters; canonical
// bytes must match Rust exactly, so compare by code points.
function compareCodePoints(a, b) {
  const ai = Array.from(a);
  const bi = Array.from(b);
  const n = Math.min(ai.length, bi.length);
  for (let i = 0; i < n; i++) {
    const d = ai[i].codePointAt(0) - bi[i].codePointAt(0);
    if (d !== 0) return d;
  }
  return ai.length - bi.length;
}

function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value !== null && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort(compareCodePoints)) {
      out[key] = sortCanonical(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Canonical JSON of a claims object: recursively key-sorted, compact.
 * Byte-identical to licensing-core's canonical_json (canonical.rs).
 */
export function canonicalClaimsJson(claims) {
  return JSON.stringify(sortCanonical(claims));
}

function isNonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

/**
 * Extract + validate the LicenseClaims v2 fields from a parsed license
 * file object (unknown fields are ignored, mirroring serde's tolerant
 * default). Returns { ok: true, claims } or { ok: false, code,
 * message } with code 'parse-error'. Does not throw.
 */
export function extractClaims(file) {
  if (file === null || typeof file !== "object" || Array.isArray(file)) {
    return { ok: false, code: "parse-error", message: "license file must be a JSON object" };
  }
  for (const field of STRING_FIELDS) {
    if (!isNonEmptyString(file[field])) {
      return { ok: false, code: "parse-error", message: `claim '${field}' must be a non-empty string` };
    }
  }
  if (!Number.isInteger(file.seats) || file.seats < 0 || file.seats > U32_MAX) {
    return { ok: false, code: "parse-error", message: "claim 'seats' must be an integer between 0 and 4294967295" };
  }
  for (const field of ["issued_at", "expires_at"]) {
    if (!isNonEmptyString(file[field]) || !CANONICAL_TIMESTAMP.test(file[field])) {
      return {
        ok: false,
        code: "parse-error",
        message: `claim '${field}' must be an RFC 3339 UTC timestamp with 'Z' (canonical chrono form, e.g. 2026-10-01T00:00:00Z)`
      };
    }
  }
  if (!Array.isArray(file.features) || file.features.some((f) => typeof f !== "string")) {
    return { ok: false, code: "parse-error", message: "claim 'features' must be an array of strings" };
  }
  return {
    ok: true,
    claims: {
      license_id: file.license_id,
      product_id: file.product_id,
      customer: file.customer,
      plan: file.plan,
      seats: file.seats,
      instance_id: file.instance_id,
      issued_at: file.issued_at,
      expires_at: file.expires_at,
      features: [...file.features]
    }
  };
}

function strictBase64Decode(value) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 || !STRICT_BASE64.test(value)) {
    return null;
  }
  const bytes = Buffer.from(value, "base64");
  // Re-encode guard: Buffer silently drops some malformed tails.
  if (bytes.toString("base64") !== value) return null;
  return bytes;
}

/**
 * The Balashikshana product license verifier (licensing-core semantics).
 *
 * `publicKeyB64` omitted/null -> licensing-core's PUBLIC development key
 * (derived from the public dev seed; dev/test only). `publicKeyB64` set but
 * invalid -> the verifier is DISABLED (every verification returns
 * 'verifier-unavailable'): an operator misconfiguration must fail CLOSED,
 * never silently fall back to the dev key in a deployment that clearly
 * intended to configure a real one.
 *
 * `now` is injectable for deterministic expiry-boundary tests.
 */
export function createLicenseVerifier({ publicKeyB64, expectedProductId = EXPECTED_PRODUCT_ID, expectedInstanceId = null, now = () => Date.now() } = {}) {
  let publicKey = null;
  let disabled = false;
  if (publicKeyB64 === undefined || publicKeyB64 === null || String(publicKeyB64).trim() === "") {
    publicKey = ed.getPublicKey(Buffer.from(DEV_LICENSE_KEY_SEED, "utf8"));
  } else {
    const bytes = strictBase64Decode(String(publicKeyB64).trim());
    if (bytes === null || bytes.length !== 32) {
      disabled = true;
    } else {
      publicKey = new Uint8Array(bytes);
    }
  }

  return {
    /** 'dev' | 'env' | 'disabled' — for boot logging and tests. */
    source: disabled ? "disabled" : publicKeyB64 ? "env" : "dev",

    /**
     * Verify a parsed license file object. NEVER THROWS; returns
     * { ok: true, claims, canonical } or { ok: false, code, message }
     * with codes from the licensing-core taxonomy:
     * verifier-unavailable | parse-error | invalid-signature | expired |
     * instance-mismatch | product-mismatch.
     */
    verifyLicenseFile(file) {
      if (disabled) {
        return {
          ok: false,
          code: "verifier-unavailable",
          message: "license public key is configured but invalid — refusing all licenses (fail closed)"
        };
      }
      if (typeof file?.signature !== "string" || file.signature.length === 0) {
        return { ok: false, code: "parse-error", message: "license file must carry a 'signature' string" };
      }
      const extracted = extractClaims(file);
      if (!extracted.ok) return extracted;

      const canonical = canonicalClaimsJson(extracted.claims);
      const sigBytes = strictBase64Decode(file.signature);
      if (sigBytes === null || sigBytes.length !== 64) {
        return { ok: false, code: "invalid-signature", message: "signature must be base64-encoded 64 bytes" };
      }
      const valid = ed.verify(new Uint8Array(sigBytes), new TextEncoder().encode(canonical), publicKey);
      if (!valid) {
        return { ok: false, code: "invalid-signature", message: "signature does not verify against the product public key" };
      }
      // Whole-claims taxonomy: expiry AFTER signature (a forged expiry is
      // an invalid signature; only genuine licenses reach these checks).
      if (now() > Date.parse(extracted.claims.expires_at)) {
        return { ok: false, code: "expired", message: "license has passed its expires_at" };
      }
      if (expectedInstanceId !== null && extracted.claims.instance_id !== expectedInstanceId) {
        return { ok: false, code: "instance-mismatch", message: "license was issued for a different instance" };
      }
      if (expectedProductId !== null && extracted.claims.product_id !== expectedProductId) {
        return { ok: false, code: "product-mismatch", message: `license was issued for product '${extracted.claims.product_id}'` };
      }
      return { ok: true, claims: extracted.claims, canonical };
    }
  };
}

/**
 * Boot-time resolution for server.mjs: returns { verifier, source } per
 * the env var + production posture. In production without the env var the
 * verifier still constructs with the dev key (so the process boots), but
 * the caller MUST log the loud boot error this helper reports — the SMTP
 * precedent: never take dev/staging ECS tasks down, never hide the
 * misconfiguration either.
 */
export function resolveLicenseVerifier(env = process.env, { isProduction = false } = {}) {
  const raw = String(env[PUBLIC_KEY_ENV_VAR] || "").trim();
  if (raw === "") {
    return {
      verifier: createLicenseVerifier({}),
      source: "dev",
      bootError: isProduction
        ? `PRODUCTION BOOT WITHOUT ${PUBLIC_KEY_ENV_VAR}: B2B license verification falls back to the PUBLIC licensing-core dev key — dev-signed licenses would be accepted. Set ${PUBLIC_KEY_ENV_VAR} to the product public key before enabling any B2B flow.`
        : null
    };
  }
  const probe = createLicenseVerifier({ publicKeyB64: raw });
  if (probe.source === "disabled") {
    return {
      verifier: probe,
      source: "disabled",
      bootError: `${PUBLIC_KEY_ENV_VAR} is set but not a valid base64-encoded 32-byte Ed25519 public key — B2B license verification is DISABLED (fail closed) until fixed.`
    };
  }
  return { verifier: probe, source: "env", bootError: null };
}
