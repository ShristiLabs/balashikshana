/**
 * On-device pack verification (issue #46) — fail closed, always.
 *
 * Mirrors tools/content-pipeline/src/verify.mjs: same checks, same order,
 * same reasons. The signature scheme is detached Ed25519 (RFC 8032):
 * compiled and signed with node:crypto at build time, verified here with
 * the audited pure-JS @noble/ed25519 against public keys pinned in keys.ts.
 * Interop is proven in-repo by tools/content-pipeline/test/signing.test.mjs
 * (noble accepts node:crypto signatures over real artifacts).
 *
 * No unverified pack is ever moved out of staging — the service enforces
 * that; this module only computes the verdict.
 */
import * as ed from "@noble/ed25519";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import { GRADE_ID_RE, PACK_FORMAT_VERSION, type PackManifest } from "./manifest";

function mergeMessages(messages: Uint8Array[]): Uint8Array {
  const total = messages.reduce((n, m) => n + m.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const m of messages) {
    merged.set(m, offset);
    offset += m.length;
  }
  return merged;
}

// @noble/ed25519 requires the caller to supply SHA-512 (keeps the package
// dependency-free); both the sync and async entry points are configured.
ed.etc.sha512Sync = (...messages) => sha512(mergeMessages(messages));
ed.etc.sha512Async = async (...messages) => sha512(mergeMessages(messages));

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Dependency-free base64 decode (Hermes/RN safe). Returns null on junk. */
export function base64Decode(input: string): Uint8Array | null {
  const clean = input.replace(/=+$/, "");
  let bits = 0;
  let accumulator = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const value = BASE64_ALPHABET.indexOf(ch);
    if (value === -1) return null;
    accumulator = (accumulator << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((accumulator >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

export type VerifyReason =
  | "format-version-unsupported"
  | "grade-id-invalid"
  | "checksum-malformed"
  | "size-malformed"
  | "signature-malformed"
  | "key-not-trusted"
  | "size-mismatch"
  | "checksum-mismatch"
  | "signature-mismatch";

export interface VerifyVerdict {
  ok: boolean;
  reason: VerifyReason | null;
}

/**
 * @param bytes exact artifact bytes (the service reads them from the
 *        staging file before anything is installed)
 * @param entry manifest entry describing the artifact
 * @param trustedKeys keyId -> raw 32-byte public key (hex)
 */
export function verifyPackArtifact(
  bytes: Uint8Array,
  entry: PackManifest,
  trustedKeys: Map<string, string>,
): VerifyVerdict {
  if (entry.formatVersion !== PACK_FORMAT_VERSION) {
    return { ok: false, reason: "format-version-unsupported" };
  }
  if (!GRADE_ID_RE.test(entry.gradeId)) return { ok: false, reason: "grade-id-invalid" };
  if (!/^[0-9a-f]{64}$/.test(entry.sha256)) return { ok: false, reason: "checksum-malformed" };
  if (!Number.isInteger(entry.sizeBytes) || entry.sizeBytes <= 0) {
    return { ok: false, reason: "size-malformed" };
  }
  const keyHex = trustedKeys.get(entry.keyId);
  if (keyHex === undefined) return { ok: false, reason: "key-not-trusted" };
  if (bytes.length !== entry.sizeBytes) return { ok: false, reason: "size-mismatch" };

  const checksum = Buffer_toHex(sha256(bytes));
  if (checksum !== entry.sha256) return { ok: false, reason: "checksum-mismatch" };

  const signature = base64Decode(entry.signature);
  if (signature === null || signature.length !== 64) {
    return { ok: false, reason: "signature-malformed" };
  }
  const keyBytes = hexToBytes(keyHex);
  if (keyBytes === null || keyBytes.length !== 32) {
    return { ok: false, reason: "key-not-trusted" };
  }
  const valid = ed.verify(signature, bytes, keyBytes);
  if (!valid) return { ok: false, reason: "signature-mismatch" };
  return { ok: true, reason: null };
}

function Buffer_toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export { Buffer_toHex as bytesToHex };

export function hexToBytes(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]*$/.test(hex) || hex.length % 2 !== 0) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
