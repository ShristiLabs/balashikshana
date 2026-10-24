/**
 * Full pack build: registry -> signed artifacts + manifest index.
 *
 * Deterministic end to end: same registry + same key -> byte-identical
 * artifacts and index. The build FAILS if any produced artifact does not
 * verify against the signer's own public key (fail closed at the source:
 * a corrupt artifact never leaves the pipeline).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GRADE_IDS, PACK_FORMAT_VERSION } from "./constants.mjs";
import { extractGradeRows } from "./rows.mjs";
import { writeGradePack, readPackInfo } from "./packDb.mjs";
import { buildManifestEntry, buildIndexDocument } from "./manifest.mjs";
import { verifyPackBytes } from "./verify.mjs";

export function contentVersionFromRegistry(registry) {
  const raw = String(registry.version ?? "0.0.0").trim();
  if (!/^\d+\.\d+\.\d+$/.test(raw)) {
    throw new Error(`Registry version must be semver-like (x.y.z), got "${raw}"`);
  }
  return raw;
}

/** Raw 32-byte public key hex derived from a PKCS8 Ed25519 private PEM. */
export function publicKeyHexFromPrivate(privateKeyPem) {
  const priv = crypto.createPrivateKey(privateKeyPem);
  const spki = crypto.createPublicKey(priv).export({ format: "der", type: "spki" });
  return Buffer.from(spki.subarray(spki.length - 32)).toString("hex");
}

/**
 * @param {object} options
 *   registry      parsed registry JSON (docs/us-curriculum-registry.json)
 *   outDir        artifact output directory (default services/api/content-packs)
 *   privateKeyPem Ed25519 signing key (PEM)
 *   keyId         key identifier recorded in each manifest entry
 *   gradeIds      grades to build (default: all five)
 *   tempDir       scratch dir for staging builds so outDir only ever
 *                 contains finished, verified artifacts
 * @returns {{ entries: object[], indexBytes: Buffer, sizes: Record<string, number> }}
 */
export function buildAllPacks({ registry, outDir, privateKeyPem, keyId, gradeIds = GRADE_IDS, tempDir }) {
  const contentVersion = contentVersionFromRegistry(registry);
  fs.mkdirSync(outDir, { recursive: true });
  if (tempDir) fs.mkdirSync(tempDir, { recursive: true });

  // Trust set for the self-check: the signer's own public key.
  const trusted = new Map([[keyId, publicKeyHexFromPrivate(privateKeyPem)]]);

  const entries = [];
  const sizes = {};
  for (const gradeId of gradeIds) {
    const extracted = extractGradeRows(registry, gradeId);
    const meta = { packFormatVersion: PACK_FORMAT_VERSION, contentVersion, registryVersion: contentVersion };
    const artifact = `pack-${gradeId}-v${contentVersion}.sqlite`;
    const artifactPath = path.join(outDir, artifact);

    // Build into staging; publish only after verification passes.
    const stagingPath = tempDir
      ? path.join(tempDir, `${artifact}.build`)
      : `${artifactPath}.build`;
    fs.rmSync(stagingPath, { force: true });

    writeGradePack(stagingPath, extracted, meta);

    const packBytes = fs.readFileSync(stagingPath);
    const entry = buildManifestEntry({
      gradeId,
      gradeName: extracted.grade.grade_name,
      contentVersion,
      registryVersion: contentVersion,
      counts: extracted.counts,
      packBytes,
      keyId,
      privateKeyPem,
    });

    // Fail-closed self-check before the artifact is published.
    const verdict = verifyPackBytes({ bytes: packBytes, entry, trustedKeys: trusted });
    if (!verdict.ok) {
      fs.rmSync(stagingPath, { force: true });
      throw new Error(`Build self-check failed for ${gradeId}: ${verdict.reason}`);
    }

    // Row-level cross-check: pack_info counts must equal actual rows and
    // both must equal the extracted counts.
    const info = readPackInfo(stagingPath);
    if (
      info.grade_id !== gradeId ||
      info.content_version !== contentVersion ||
      info.counts.units !== extracted.counts.unitCount ||
      info.counts.topics !== extracted.counts.topicCount ||
      info.counts.questions !== extracted.counts.questionCount
    ) {
      fs.rmSync(stagingPath, { force: true });
      throw new Error(`pack_info cross-check failed for ${gradeId}`);
    }

    fs.renameSync(stagingPath, artifactPath);
    entries.push(entry);
    sizes[gradeId] = packBytes.length;
  }

  const indexBytes = Buffer.from(buildIndexDocument(entries, contentVersion), "utf8");
  fs.writeFileSync(path.join(outDir, "index.json"), indexBytes);
  return { entries, indexBytes, sizes };
}
