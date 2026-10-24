/**
 * Manifest + detached signatures (issue #46).
 *
 * Each pack gets a manifest entry carrying size, SHA-256 checksum, and a
 * detached Ed25519 signature over the pack file bytes. The index document
 * served at GET /api/content/packs is the canonical-JSON list of entries.
 * No timestamps: the index is as deterministic as the packs themselves.
 */
import crypto from "node:crypto";
import { PACK_FORMAT_VERSION, PACK_INDEX_FORMAT_VERSION, packArtifactName } from "./constants.mjs";
import { stableDocument } from "./canonical.mjs";
import { signBytes } from "./keys.mjs";

export function sha256Hex(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * Build one manifest entry for a finished pack artifact.
 * `packBytes` are the exact bytes stored at the artifact path.
 */
export function buildManifestEntry({ gradeId, gradeName, contentVersion, registryVersion, counts, packBytes, keyId, privateKeyPem }) {
  const signature = signBytes(packBytes, privateKeyPem);
  return {
    formatVersion: PACK_FORMAT_VERSION,
    gradeId,
    gradeName,
    contentVersion,
    registryVersion,
    artifact: packArtifactName(gradeId, contentVersion),
    sizeBytes: packBytes.length,
    sha256: sha256Hex(packBytes),
    keyId,
    // Detached Ed25519 signature over the artifact bytes (base64).
    signature: signature.toString("base64"),
    unitCount: counts.unitCount,
    topicCount: counts.topicCount,
    questionCount: counts.questionCount,
  };
}

/** Canonical index document for a set of manifest entries. */
export function buildIndexDocument(entries, registryVersion) {
  return stableDocument({
    formatVersion: PACK_INDEX_FORMAT_VERSION,
    registryVersion,
    packs: [...entries].sort((a, b) => a.gradeId.localeCompare(b.gradeId)),
  });
}
