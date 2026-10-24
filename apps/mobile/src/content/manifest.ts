/**
 * Manifest parsing + canonical JSON (issue #46).
 *
 * Mirrors tools/content-pipeline/src/{canonical,manifest}.mjs: every field
 * is type-checked before the verifier ever sees the entry, and unknown or
 * malformed entries are dropped (fail closed) rather than trusted.
 */

export const PACK_FORMAT_VERSION = 1;
export const GRADE_ID_RE = /^[a-z0-9-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse and validate one raw index entry; null when malformed. */
export function parseManifestEntry(raw: unknown): PackManifest | null {
  if (!isRecord(raw)) return null;
  const r = raw;
  if (r.formatVersion !== PACK_FORMAT_VERSION || typeof r.formatVersion === "boolean") return null;
  if (typeof r.gradeId !== "string" || !GRADE_ID_RE.test(r.gradeId)) return null;
  if (typeof r.gradeName !== "string") return null;
  if (typeof r.contentVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(r.contentVersion))
    return null;
  if (typeof r.registryVersion !== "string") return null;
  if (typeof r.artifact !== "string" || r.artifact.length === 0) return null;
  if (typeof r.sizeBytes !== "number" || !Number.isInteger(r.sizeBytes) || r.sizeBytes <= 0)
    return null;
  if (typeof r.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(r.sha256)) return null;
  if (typeof r.keyId !== "string" || r.keyId.length === 0) return null;
  if (typeof r.signature !== "string" || r.signature.length === 0) return null;
  if (!isCount(r.unitCount) || !isCount(r.topicCount) || !isCount(r.questionCount)) return null;
  return {
    formatVersion: r.formatVersion,
    gradeId: r.gradeId,
    gradeName: r.gradeName,
    contentVersion: r.contentVersion,
    registryVersion: r.registryVersion,
    artifact: r.artifact,
    sizeBytes: r.sizeBytes,
    sha256: r.sha256,
    keyId: r.keyId,
    signature: r.signature,
    unitCount: r.unitCount,
    topicCount: r.topicCount,
    questionCount: r.questionCount,
  };
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export type PackManifest = {
  formatVersion: number;
  gradeId: string;
  gradeName: string;
  contentVersion: string;
  registryVersion: string;
  artifact: string;
  sizeBytes: number;
  sha256: string;
  keyId: string;
  signature: string;
  unitCount: number;
  topicCount: number;
  questionCount: number;
};

/** Parse the whole index document; malformed entries are dropped. */
export function parseManifestIndex(raw: unknown): PackManifest[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.packs)) return null;
  const entries = raw.packs.map(parseManifestEntry).filter((e): e is PackManifest => e !== null);
  if (entries.length === 0) return null;
  return entries;
}
