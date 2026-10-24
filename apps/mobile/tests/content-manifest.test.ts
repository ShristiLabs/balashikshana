/**
 * Manifest parsing tests (issue #46): every malformed shape is dropped
 * (fail closed) and only exact valid entries survive to the verifier.
 */
import { describe, expect, it } from "vitest";
import { parseManifestEntry, parseManifestIndex } from "../src/content/manifest";

const validEntry = {
  formatVersion: 1,
  gradeId: "pre-k",
  gradeName: "Pre-Kindergarten",
  contentVersion: "1.0.0",
  registryVersion: "1.0.0",
  artifact: "pack-pre-k-v1.0.0.sqlite",
  sizeBytes: 4096,
  sha256: "a".repeat(64),
  keyId: "dev-local",
  signature: Buffer.alloc(64, 1).toString("base64"),
  unitCount: 14,
  topicCount: 56,
  questionCount: 560,
};

describe("parseManifestEntry", () => {
  it("accepts a valid entry", () => {
    expect(parseManifestEntry(validEntry)).toEqual(validEntry);
  });

  it("rejects non-objects and arrays", () => {
    expect(parseManifestEntry(null)).toBeNull();
    expect(parseManifestEntry("x")).toBeNull();
    expect(parseManifestEntry([validEntry])).toBeNull();
  });

  it("rejects unknown format versions (forward-compat guard)", () => {
    expect(parseManifestEntry({ ...validEntry, formatVersion: 2 })).toBeNull();
  });

  it("rejects malformed grade ids (including path shapes)", () => {
    expect(parseManifestEntry({ ...validEntry, gradeId: "../etc" })).toBeNull();
    expect(parseManifestEntry({ ...validEntry, gradeId: "Pre-K" })).toBeNull();
    expect(parseManifestEntry({ ...validEntry, gradeId: "" })).toBeNull();
  });

  it("rejects malformed checksums, sizes, versions, and signatures", () => {
    expect(parseManifestEntry({ ...validEntry, sha256: "XYZ" })).toBeNull();
    expect(parseManifestEntry({ ...validEntry, sizeBytes: 0 })).toBeNull();
    expect(parseManifestEntry({ ...validEntry, sizeBytes: 12.5 })).toBeNull();
    expect(parseManifestEntry({ ...validEntry, contentVersion: "1.0" })).toBeNull();
    expect(parseManifestEntry({ ...validEntry, contentVersion: "latest" })).toBeNull();
    expect(parseManifestEntry({ ...validEntry, signature: "" })).toBeNull();
    expect(parseManifestEntry({ ...validEntry, keyId: "" })).toBeNull();
    expect(parseManifestEntry({ ...validEntry, unitCount: "14" })).toBeNull();
  });

  it("rejects missing fields", () => {
    const { keyId, ...withoutKey } = validEntry;
    void keyId;
    expect(parseManifestEntry(withoutKey)).toBeNull();
  });
});

describe("parseManifestIndex", () => {
  it("parses the index and drops malformed entries", () => {
    const parsed = parseManifestIndex({
      formatVersion: 1,
      registryVersion: "1.0.0",
      packs: [validEntry, { ...validEntry, gradeId: "bad grade" }, null],
    });
    expect(parsed).not.toBeNull();
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.gradeId).toBe("pre-k");
  });

  it("returns null for non-index shapes and empty indexes", () => {
    expect(parseManifestIndex(null)).toBeNull();
    expect(parseManifestIndex({ packs: "no" })).toBeNull();
    expect(parseManifestIndex({ packs: [] })).toBeNull();
    expect(parseManifestIndex({ packs: [{ ...validEntry, formatVersion: 99 }] })).toBeNull();
  });
});
