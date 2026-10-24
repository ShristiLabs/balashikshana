/**
 * Ed25519 signing keys for content packs (issue #46).
 *
 * Scheme (orchestrator decision, recorded in the delivery log): detached
 * Ed25519 signatures (RFC 8032) produced here with node:crypto at build
 * time, verified on-device with the pure-JS @noble/ed25519 (same curve,
 * audited implementation) against public keys pinned in the app. The
 * private half NEVER enters the repo (gitignored *.key); CI builds and
 * signs with a throwaway keypair to prove the pipeline.
 *
 * Raw-key helpers exist because node:crypto exports SPKI/PKCS8 envelopes
 * while @noble/ed25519 (device side) consumes the raw 32-byte forms: for
 * Ed25519 both envelopes are a fixed prefix around the raw key material.
 */
import crypto from "node:crypto";
import fs from "node:fs";

const SPKI_RAW_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const PKCS8_RAW_TAIL_BYTES = 32;

/** Generate an Ed25519 signing keypair. */
export function generateSigningKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" });
  return {
    // Raw 32-byte public key, hex-encoded (what the app pins).
    publicKeyHex: Buffer.from(spki.subarray(spki.length - 32)).toString("hex"),
    // PEM forms for node:crypto sign/verify.
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
    // Raw 32-byte private key, hex-encoded (for @noble interop tests only).
    privateKeyHex: Buffer.from(pkcs8.subarray(pkcs8.length - PKCS8_RAW_TAIL_BYTES)).toString("hex"),
  };
}

/** Build a node:crypto KeyObject from a raw 32-byte public key (hex). */
export function publicKeyFromHex(publicKeyHex) {
  if (!/^[0-9a-f]{64}$/.test(publicKeyHex)) {
    throw new Error("Ed25519 public key must be 32 bytes of hex");
  }
  const der = Buffer.concat([SPKI_RAW_PREFIX, Buffer.from(publicKeyHex, "hex")]);
  return crypto.createPublicKey({ key: der, format: "der", type: "spki" });
}

/** Detached Ed25519 signature over exact message bytes. */
export function signBytes(bytes, privateKeyPem) {
  const key = crypto.createPrivateKey(privateKeyPem);
  return crypto.sign(null, bytes, key);
}

/** RFC 8032 verification with node:crypto (build-time self-check). */
export function verifyBytes(bytes, signature, publicKeyHex) {
  try {
    return crypto.verify(null, bytes, publicKeyFromHex(publicKeyHex), signature);
  } catch {
    return false;
  }
}

export function writeKeyFiles(outDir, baseName, { force = false } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const keyPath = `${outDir}/${baseName}.key`;
  const pubPath = `${outDir}/${baseName}.pub.hex`;
  if (!force && (fs.existsSync(keyPath) || fs.existsSync(pubPath))) {
    throw new Error(`Refusing to overwrite existing keys at ${keyPath} (pass --force)`);
  }
  const pair = generateSigningKeyPair();
  fs.writeFileSync(keyPath, pair.privateKeyPem, { mode: 0o600 });
  fs.writeFileSync(pubPath, `${pair.publicKeyHex}\n`);
  return { keyPath, pubPath, publicKeyHex: pair.publicKeyHex };
}

export function readPrivateKeyPem(keyPath) {
  return fs.readFileSync(keyPath, "utf8");
}
