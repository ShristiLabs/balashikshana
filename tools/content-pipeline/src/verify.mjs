/**
 * Build-side pack verification (issue #46) — the node mirror of the
 * device-side verifier in apps/mobile/src/content/verify.ts.
 *
 * Same checks, same order, same fail-closed semantics: unknown format,
 * unknown key id, size mismatch, checksum mismatch, or signature mismatch
 * => reject. The build self-check and the compiler tests both run this so
 * an artifact that leaves the pipeline is always one the device accepts.
 */
import { verifyBytes } from "./keys.mjs";
import { sha256Hex } from "./manifest.mjs";
import { PACK_FORMAT_VERSION } from "./constants.mjs";

/**
 * @param {{ bytes: Uint8Array, entry: object, trustedKeys: Map<string, string> }} input
 *   trustedKeys: keyId -> raw public key hex
 * @returns {{ ok: boolean, reason: string | null }}
 */
export function verifyPackBytes({ bytes, entry, trustedKeys }) {
  if (!entry || typeof entry !== "object") return { ok: false, reason: "manifest-entry-missing" };
  if (entry.formatVersion !== PACK_FORMAT_VERSION) return { ok: false, reason: "format-version-unsupported" };
  if (typeof entry.gradeId !== "string" || !/^[a-z0-9-]+$/.test(entry.gradeId)) {
    return { ok: false, reason: "grade-id-invalid" };
  }
  if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
    return { ok: false, reason: "checksum-malformed" };
  }
  if (!Number.isInteger(entry.sizeBytes) || entry.sizeBytes <= 0) {
    return { ok: false, reason: "size-malformed" };
  }
  if (typeof entry.signature !== "string" || entry.signature.length === 0) {
    return { ok: false, reason: "signature-malformed" };
  }
  const keyHex = trustedKeys.get(entry.keyId);
  if (!keyHex) return { ok: false, reason: "key-not-trusted" };
  if (bytes.length !== entry.sizeBytes) return { ok: false, reason: "size-mismatch" };
  if (sha256Hex(bytes) !== entry.sha256) return { ok: false, reason: "checksum-mismatch" };
  let signature;
  try {
    signature = Buffer.from(entry.signature, "base64");
  } catch {
    return { ok: false, reason: "signature-malformed" };
  }
  if (signature.length !== 64) return { ok: false, reason: "signature-malformed" };
  if (!verifyBytes(Buffer.from(bytes), signature, keyHex)) {
    return { ok: false, reason: "signature-mismatch" };
  }
  return { ok: true, reason: null };
}
