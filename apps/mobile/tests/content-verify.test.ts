/**
 * On-device verification tests (issue #46) with REAL cryptography:
 * signatures are produced by node:crypto Ed25519 exactly like the compiler,
 * then verified by the device path (@noble/ed25519 via verifyPackArtifact).
 * This is the in-repo proof that the device accepts compiler signatures
 * and fails closed on every tamper class.
 */
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { base64Decode, bytesToHex, hexToBytes, verifyPackArtifact } from "../src/content/verify";
import { DEV_SIGNING_KEY, RELEASE_KEY, trustedKeysForEnvironment } from "../src/content/keys";
import type { PackManifest } from "../src/content/manifest";

function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return {
    publicKeyHex: Buffer.from(spki.subarray(spki.length - 32)).toString("hex"),
    privateKeyPem: privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    privateKeyObject: privateKey,
  };
}

function sha256Node(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function makeSignedEntry(
  bytes: Uint8Array,
  signer: ReturnType<typeof keyPair>,
  keyId = "dev-local",
): PackManifest {
  const signature = crypto.sign(null, bytes, signer.privateKeyObject).toString("base64");
  return {
    formatVersion: 1,
    gradeId: "pre-k",
    gradeName: "Pre-Kindergarten",
    contentVersion: "1.0.0",
    registryVersion: "1.0.0",
    artifact: "pack-pre-k-v1.0.0.sqlite",
    sizeBytes: bytes.length,
    sha256: sha256Node(bytes),
    keyId,
    signature,
    unitCount: 14,
    topicCount: 56,
    questionCount: 560,
  };
}

describe("verifyPackArtifact (real Ed25519: node:crypto signer, @noble verifier)", () => {
  const signer = keyPair();
  const attacker = keyPair();
  const trusted = new Map([["dev-local", signer.publicKeyHex]]);

  // Realistic multi-KB payload like an actual pack artifact.
  const packBytes = crypto.randomBytes(8192);
  const entry = makeSignedEntry(packBytes, signer);

  it("accepts a genuine compiler-style signature", () => {
    expect(verifyPackArtifact(packBytes, entry, trusted)).toEqual({ ok: true, reason: null });
  });

  it("rejects a single flipped byte (checksum + signature both catch it)", () => {
    for (const index of [0, 100, 4000, packBytes.length - 1]) {
      const tampered = Uint8Array.from(packBytes);
      tampered[index] = (tampered[index] ?? 0) ^ 0x01;
      const verdict = verifyPackArtifact(tampered, entry, trusted);
      expect(verdict.ok).toBe(false);
      expect(["checksum-mismatch", "signature-mismatch"]).toContain(verdict.reason);
    }
  });

  it("rejects truncated and padded artifacts (size mismatch)", () => {
    expect(verifyPackArtifact(packBytes.subarray(0, 4000), entry, trusted).reason).toBe(
      "size-mismatch",
    );
    const padded = Uint8Array.from([...packBytes, 1, 2, 3]);
    expect(verifyPackArtifact(padded, entry, trusted).reason).toBe("size-mismatch");
  });

  it("rejects signatures by a different (untrusted) key", () => {
    const forged = makeSignedEntry(packBytes, attacker, "dev-local");
    expect(verifyPackArtifact(packBytes, forged, trusted).reason).toBe("signature-mismatch");
  });

  it("rejects unknown key ids even with valid signatures", () => {
    const unknownKey = makeSignedEntry(packBytes, attacker, "attacker-key");
    expect(verifyPackArtifact(packBytes, unknownKey, trusted).reason).toBe("key-not-trusted");
  });

  it("rejects a checksum field that does not match the bytes", () => {
    // Deterministic tamper: force a first hex char DIFFERENT from the
    // real one (random bytes give a leading "0" 1-in-16 runs, which made
    // the old `0 + slice(1)` tamper a no-op and the test flaky).
    const flip = entry.sha256.startsWith("0") ? "1" : "0";
    const tamperedChecksum = { ...entry, sha256: `${flip}${entry.sha256.slice(1)}` };
    expect(verifyPackArtifact(packBytes, tamperedChecksum, trusted).reason).toBe(
      "checksum-mismatch",
    );
  });

  it("rejects unsupported format versions", () => {
    expect(verifyPackArtifact(packBytes, { ...entry, formatVersion: 99 }, trusted).reason).toBe(
      "format-version-unsupported",
    );
  });

  it("rejects malformed signatures (wrong length, junk base64)", () => {
    const shortSig = { ...entry, signature: Buffer.alloc(32, 9).toString("base64") };
    expect(verifyPackArtifact(packBytes, shortSig, trusted).reason).toBe("signature-malformed");
    const junkSig = { ...entry, signature: "****" };
    expect(verifyPackArtifact(packBytes, junkSig, trusted).reason).toBe("signature-malformed");
  });

  it("rejects everything when the trust list is empty (production fail-closed)", () => {
    expect(verifyPackArtifact(packBytes, entry, new Map()).reason).toBe("key-not-trusted");
  });
});

describe("encoding helpers", () => {
  it("base64Decode round-trips RFC 4648 and rejects junk", () => {
    const bytes = crypto.randomBytes(64);
    const decoded = base64Decode(bytes.toString("base64"));
    expect(decoded).not.toBeNull();
    expect(Buffer.from(decoded ?? []).equals(bytes)).toBe(true);
    expect(base64Decode("!!!")).toBeNull();
  });

  it("hex helpers round-trip", () => {
    const bytes = crypto.randomBytes(32);
    expect(hexToBytes(bytesToHex(bytes))).not.toBeNull();
    expect(Buffer.from(hexToBytes(bytesToHex(bytes)) ?? []).equals(bytes)).toBe(true);
    expect(hexToBytes("zz")).toBeNull();
    expect(hexToBytes("abc")).toBeNull();
  });
});

describe("trusted key registry (fail-closed pinning)", () => {
  it("development trusts exactly the pinned dev key (32-byte hex)", () => {
    const dev = trustedKeysForEnvironment(true);
    expect(dev.size).toBe(1);
    expect(dev.get("dev-local")).toBe(DEV_SIGNING_KEY.publicKeyHex);
    expect(DEV_SIGNING_KEY.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it("production trusts NOTHING until the release key is provisioned (M6)", () => {
    const prod = trustedKeysForEnvironment(false);
    expect(prod.size).toBe(0);
    // The dev key must never leak into production trust semantics.
    expect(prod.has("dev-local")).toBe(false);
    // The slot itself is intentionally empty — documented, not an accident.
    expect(RELEASE_KEY).toBeNull();
  });
});
