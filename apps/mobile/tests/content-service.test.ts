/**
 * ContentPackService lifecycle tests (issue #46) — the full download ->
 * verify -> atomic-install -> prune chain against injected fakes, with
 * REAL Ed25519 signatures (node:crypto signer, device verifier).
 *
 * Atomicity/rollback proof shape: every failure case asserts (a) the
 * staged file is deleted, (b) the previously active pack file and meta
 * row are UNCHANGED, and (c) the result status names the reason.
 */
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { ContentPackService } from "../src/content/service";
import type {
  ContentPackDeps,
  EnsureResult,
  PackInfoRow,
  PackManifestEntry,
  PackMetaRow,
} from "../src/content/types";

function keyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" });
  return {
    publicKeyHex: Buffer.from(spki.subarray(spki.length - 32)).toString("hex"),
    privateKeyObject: privateKey,
  };
}

const signer = keyPair();

function sha256Node(bytes: Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

interface Harness {
  deps: ContentPackDeps;
  files: Map<string, Uint8Array>;
  metaRows: Map<string, PackMetaRow>;
  downloads: number;
  servedBytes: Uint8Array | null;
  servedEntry: PackManifestEntry | null;
  servedIndex: PackManifestEntry[] | null;
  packInfoFor: ((gradeId: string, contentVersion: string) => PackInfoRow) | null;
  failDownload: boolean;
  // IO-failure injections (atomicity probes): each simulates the process
  // dying or the OS failing at one step of the install pipeline.
  fetchIndexThrows: boolean;
  digestNull: boolean;
  readBytesNull: boolean;
  openPackInfoNull: boolean;
  moveThrows: boolean;
  upsertThrows: boolean;
  stagingDeleteThrows: boolean;
}

function makeEntry(
  gradeId: string,
  contentVersion: string,
  bytes: Uint8Array,
  keyId = "dev-local",
): PackManifestEntry {
  return {
    formatVersion: 1,
    gradeId,
    gradeName: gradeId,
    contentVersion,
    registryVersion: contentVersion,
    artifact: `pack-${gradeId}-v${contentVersion}.sqlite`,
    sizeBytes: bytes.length,
    sha256: sha256Node(bytes),
    keyId,
    signature: crypto.sign(null, bytes, signer.privateKeyObject).toString("base64"),
    unitCount: 14,
    topicCount: 56,
    questionCount: 560,
  };
}

function packInfo(gradeId: string, contentVersion: string): PackInfoRow {
  return {
    packFormatVersion: 1,
    packSchemaVersion: 1,
    gradeId,
    gradeName: gradeId,
    contentVersion,
    registryVersion: contentVersion,
    unitCount: 14,
    topicCount: 56,
    questionCount: 560,
  };
}

function makeHarness(): Harness {
  const files = new Map<string, Uint8Array>();
  const metaRows = new Map<string, PackMetaRow>();
  const harness: Harness = {
    files,
    metaRows,
    downloads: 0,
    servedBytes: null,
    servedEntry: null,
    servedIndex: null,
    packInfoFor: null,
    failDownload: false,
    fetchIndexThrows: false,
    digestNull: false,
    readBytesNull: false,
    openPackInfoNull: false,
    moveThrows: false,
    upsertThrows: false,
    stagingDeleteThrows: false,
    deps: null as unknown as ContentPackDeps,
  };

  const deps: ContentPackDeps = {
    async fetchIndex() {
      if (harness.fetchIndexThrows) throw new Error("index-io");
      return harness.servedIndex;
    },
    async download(_url, fileName) {
      harness.downloads += 1;
      if (harness.failDownload || harness.servedBytes === null) throw new Error("network-down");
      files.set(fileName, harness.servedBytes);
    },
    async fileSize(fileName) {
      return files.get(fileName)?.length ?? null;
    },
    async sha256Hex(fileName) {
      if (harness.digestNull) return null;
      const bytes = files.get(fileName);
      return bytes ? sha256Node(bytes) : null;
    },
    async readBytes(fileName) {
      if (harness.readBytesNull) return null;
      return files.get(fileName) ?? null;
    },
    async move(from, to) {
      if (harness.moveThrows) throw new Error("rename-failed");
      const bytes = files.get(from);
      if (bytes === undefined) throw new Error("staging-missing");
      files.delete(from);
      files.set(to, bytes);
    },
    async deleteFile(fileName) {
      if (harness.stagingDeleteThrows && fileName.startsWith(".staging-")) {
        throw new Error("unlink-failed");
      }
      files.delete(fileName);
    },
    async exists(fileName) {
      return files.has(fileName);
    },
    async listArtifacts() {
      return [...files.keys()].filter((name) => name.endsWith(".sqlite") && !name.startsWith("."));
    },
    async openPackInfo(fileName) {
      if (harness.openPackInfoNull) return null;
      if (!files.has(fileName) || !harness.packInfoFor) return null;
      const entry = harness.servedEntry;
      if (!entry) return null;
      return harness.packInfoFor(entry.gradeId, entry.contentVersion);
    },
    meta: {
      async getActive(gradeId) {
        const rows = [...metaRows.values()].filter((r) => r.gradeId === gradeId);
        rows.sort((a, b) => b.installedAt - a.installedAt);
        return rows[0] ?? null;
      },
      async upsert(row) {
        if (harness.upsertThrows) throw new Error("db-write-failed");
        metaRows.set(`${row.gradeId}:${row.contentVersion}`, row);
      },
      async all() {
        return [...metaRows.values()];
      },
      async remove(gradeId, contentVersion) {
        metaRows.delete(`${gradeId}:${contentVersion}`);
      },
    },
    trustedKeys: new Map([["dev-local", signer.publicKeyHex]]),
    packUrl: (gradeId) => `http://api.test/api/content/packs/${gradeId}`,
    now: () => 42,
    log: () => undefined,
  };
  harness.deps = deps;
  return harness;
}

function serve(harness: Harness, entry: PackManifestEntry, bytes: Uint8Array, info = packInfo) {
  harness.servedEntry = entry;
  harness.servedBytes = bytes;
  harness.servedIndex = [entry];
  harness.packInfoFor = info;
}

async function ensure(harness: Harness, gradeId: string): Promise<EnsureResult> {
  return new ContentPackService(harness.deps).ensurePack(gradeId);
}

describe("ContentPackService lifecycle", () => {
  it("installs a verified pack: staging -> atomic move -> meta recorded", async () => {
    const h = makeHarness();
    const bytes = crypto.randomBytes(4096);
    serve(h, makeEntry("pre-k", "1.0.0", bytes), bytes);

    const result = await ensure(h, "pre-k");
    expect(result).toEqual({ status: "installed", gradeId: "pre-k", contentVersion: "1.0.0" });

    expect(h.files.has("pack-pre-k-v1.0.0.sqlite")).toBe(true);
    expect(h.files.has(".staging-pre-k.sqlite")).toBe(false);
    const row = await h.deps.meta.getActive("pre-k");
    expect(row?.artifact).toBe("pack-pre-k-v1.0.0.sqlite");
    expect(row?.installedAt).toBe(42);
  });

  it("reports current when the same version is installed (no download)", async () => {
    const h = makeHarness();
    const bytes = crypto.randomBytes(2048);
    serve(h, makeEntry("pre-k", "1.0.0", bytes), bytes);
    await ensure(h, "pre-k");
    expect(h.downloads).toBe(1);

    const again = await ensure(h, "pre-k");
    expect(again.status).toBe("current");
    expect(h.downloads).toBe(1);
  });

  it("refuses downgrades and keeps serving the newer local pack", async () => {
    const h = makeHarness();
    const v2 = crypto.randomBytes(2048);
    serve(h, makeEntry("pre-k", "2.0.0", v2), v2);
    await ensure(h, "pre-k");

    const v1 = crypto.randomBytes(1024);
    serve(h, makeEntry("pre-k", "1.0.0", v1), v1);
    const result = await ensure(h, "pre-k");
    expect(result.status).toBe("current");
    expect(result.contentVersion).toBe("2.0.0");
    expect(result.reason).toBe("downgrade-refused");
    expect(h.files.has("pack-pre-k-v2.0.0.sqlite")).toBe(true);
  });

  it("upgrades atomically and prunes the superseded version", async () => {
    const h = makeHarness();
    const v1 = crypto.randomBytes(2048);
    serve(h, makeEntry("pre-k", "1.0.0", v1), v1);
    await ensure(h, "pre-k");

    const v2 = crypto.randomBytes(2560);
    serve(h, makeEntry("pre-k", "1.1.0", v2), v2);
    const result = await ensure(h, "pre-k");
    expect(result.status).toBe("upgraded");
    expect(h.files.has("pack-pre-k-v1.1.0.sqlite")).toBe(true);
    expect(h.files.has("pack-pre-k-v1.0.0.sqlite")).toBe(false);
    const rows = await h.deps.meta.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.contentVersion).toBe("1.1.0");
  });

  it("prunes the previous grade's pack on a grade switch", async () => {
    const h = makeHarness();
    const g1 = crypto.randomBytes(2048);
    serve(h, makeEntry("grade-1", "1.0.0", g1), g1);
    await ensure(h, "grade-1");

    const pk = crypto.randomBytes(1024);
    serve(h, makeEntry("pre-k", "1.0.0", pk), pk);
    const result = await ensure(h, "pre-k");
    expect(result.status).toBe("installed");
    expect(h.files.has("pack-grade-1-v1.0.0.sqlite")).toBe(false);
    expect(h.files.has("pack-pre-k-v1.0.0.sqlite")).toBe(true);
    expect(await h.deps.meta.all()).toHaveLength(1);
  });

  it("FAIL CLOSED: tampered download leaves the previous pack intact and deletes staging", async () => {
    const h = makeHarness();
    const good = crypto.randomBytes(2048);
    serve(h, makeEntry("pre-k", "1.0.0", good), good);
    await ensure(h, "pre-k");

    // Server "serves" different bytes than the manifest describes.
    const tampered = crypto.randomBytes(2048);
    serve(h, makeEntry("pre-k", "1.0.1", good), tampered);
    const result = await ensure(h, "pre-k");
    expect(result.status).toBe("failed");
    expect(result.reason).toBeTruthy();

    expect(h.files.has(".staging-pre-k.sqlite")).toBe(false);
    expect(h.files.has("pack-pre-k-v1.0.0.sqlite")).toBe(true);
    expect((await h.deps.meta.getActive("pre-k"))?.contentVersion).toBe("1.0.0");
  });

  it("rejects a wrong-key signature (valid base64, wrong signer)", async () => {
    const h = makeHarness();
    const bytes = crypto.randomBytes(2048);
    const attacker = keyPair();
    const forgedEntry: PackManifestEntry = {
      ...makeEntry("pre-k", "1.0.0", bytes),
      signature: crypto.sign(null, bytes, attacker.privateKeyObject).toString("base64"),
    };
    serve(h, forgedEntry, bytes);
    const result = await ensure(h, "pre-k");
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("signature-mismatch");
    expect([...h.files.keys()]).toHaveLength(0);
  });

  it("rejects an unknown key id outright", async () => {
    const h = makeHarness();
    const bytes = crypto.randomBytes(2048);
    serve(h, makeEntry("pre-k", "1.0.0", bytes, "attacker-key"), bytes);
    const result = await ensure(h, "pre-k");
    expect(result.reason).toBe("key-not-trusted");
  });

  it("rejects a validly-signed pack whose pack_info describes DIFFERENT content (cross-grade substitution)", async () => {
    const h = makeHarness();
    const bytes = crypto.randomBytes(2048);
    serve(h, makeEntry("pre-k", "1.0.0", bytes), bytes, (gradeId, version) =>
      // Artifact claims to be grade-2 content.
      packInfo(gradeId === "pre-k" ? "grade-2" : gradeId, version),
    );
    const result = await ensure(h, "pre-k");
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("pack-content-mismatch");
    expect(h.files.has(".staging-pre-k.sqlite")).toBe(false);
  });

  it("rejects on size mismatch before any crypto work", async () => {
    const h = makeHarness();
    const bytes = crypto.randomBytes(2048);
    const shortServe = crypto.randomBytes(1024);
    serve(h, makeEntry("pre-k", "1.0.0", bytes), shortServe);
    const result = await ensure(h, "pre-k");
    expect(result.reason).toBe("size-mismatch");
  });

  it("enforces the storage budget: refused install, staging deleted, nothing changed", async () => {
    const h = makeHarness();
    const bytes = crypto.randomBytes(600);
    serve(h, makeEntry("pre-k", "1.0.0", bytes), bytes);

    const service = new ContentPackService(h.deps, { budgetBytes: 500 });
    const result = await service.ensurePack("pre-k");
    expect(result.status).toBe("refused");
    expect(result.reason).toBe("storage-budget-exceeded");
    expect(h.files.has(".staging-pre-k.sqlite")).toBe(false);
    expect(await h.deps.meta.all()).toHaveLength(0);
  });

  it("reinstalls when the meta row survives but the artifact file is gone", async () => {
    const h = makeHarness();
    const bytes = crypto.randomBytes(2048);
    serve(h, makeEntry("pre-k", "1.0.0", bytes), bytes);
    await ensure(h, "pre-k");
    h.files.delete("pack-pre-k-v1.0.0.sqlite"); // device cleanup removed it

    const result = await ensure(h, "pre-k");
    expect(result.status).toBe("installed");
    expect(h.files.has("pack-pre-k-v1.0.0.sqlite")).toBe(true);
  });

  it("returns unavailable when the manifest cannot be fetched", async () => {
    const h = makeHarness();
    const result = await ensure(h, "pre-k");
    expect(result).toEqual({
      status: "unavailable",
      gradeId: "pre-k",
      reason: "manifest-unreachable",
    });
  });

  it("returns unavailable for a grade the server does not publish", async () => {
    const h = makeHarness();
    const bytes = crypto.randomBytes(512);
    serve(h, makeEntry("pre-k", "1.0.0", bytes), bytes);
    const result = await ensure(h, "grade-3");
    expect(result.reason).toBe("grade-not-published");
  });

  it("never throws: a download error becomes a failed result", async () => {
    const h = makeHarness();
    const bytes = crypto.randomBytes(512);
    serve(h, makeEntry("pre-k", "1.0.0", bytes), bytes);
    h.failDownload = true;
    const result = await ensure(h, "pre-k");
    expect(result.status).toBe("failed");
    expect(h.files.has(".staging-pre-k.sqlite")).toBe(false);
  });

  it("deduplicates concurrent ensurePack calls for the same grade", async () => {
    const h = makeHarness();
    const bytes = crypto.randomBytes(2048);
    serve(h, makeEntry("pre-k", "1.0.0", bytes), bytes);
    const service = new ContentPackService(h.deps);
    const [a, b] = await Promise.all([service.ensurePack("pre-k"), service.ensurePack("pre-k")]);
    expect(a.status).toBe("installed");
    expect(b.status).toBe("installed");
    expect(h.downloads).toBe(1);
  });
});

describe("injected IO failures: never throws, old pack survives every step", () => {
  // Each test kills one step of the pipeline after the previous pack is
  // active and asserts the contract: a typed failure result, the OLD pack
  // still present and still the active meta row, and no staging leftovers.
  async function withActiveV1(): Promise<Harness> {
    const h = makeHarness();
    const v1 = crypto.randomBytes(2048);
    serve(h, makeEntry("pre-k", "1.0.0", v1), v1);
    await ensure(h, "pre-k");
    return h;
  }

  it("staged bytes unreadable (readBytes null) fails closed with staging deleted", async () => {
    const h = await withActiveV1();
    const v2 = crypto.randomBytes(2560);
    serve(h, makeEntry("pre-k", "1.1.0", v2), v2);
    h.readBytesNull = true;
    const result = await ensure(h, "pre-k");
    expect(result).toEqual({ status: "failed", gradeId: "pre-k", reason: "staging-unreadable" });
    expect(h.files.has(".staging-pre-k.sqlite")).toBe(false);
    expect(h.files.has("pack-pre-k-v1.0.0.sqlite")).toBe(true);
    expect((await h.deps.meta.getActive("pre-k"))?.contentVersion).toBe("1.0.0");
  });

  it("pack_info unopenable (openPackInfo null) fails as content mismatch", async () => {
    const h = await withActiveV1();
    const v2 = crypto.randomBytes(2560);
    serve(h, makeEntry("pre-k", "1.1.0", v2), v2);
    h.openPackInfoNull = true;
    const result = await ensure(h, "pre-k");
    expect(result).toEqual({ status: "failed", gradeId: "pre-k", reason: "pack-content-mismatch" });
    expect(h.files.has(".staging-pre-k.sqlite")).toBe(false);
    expect(h.files.has("pack-pre-k-v1.0.0.sqlite")).toBe(true);
  });

  it("rename failure at the publish boundary leaves the old pack active", async () => {
    const h = await withActiveV1();
    const v2 = crypto.randomBytes(2560);
    serve(h, makeEntry("pre-k", "1.1.0", v2), v2);
    h.moveThrows = true;
    const result = await ensure(h, "pre-k");
    expect(result).toEqual({ status: "failed", gradeId: "pre-k", reason: "install-error" });
    expect(h.files.has("pack-pre-k-v1.0.0.sqlite")).toBe(true);
    expect(h.files.has("pack-pre-k-v1.1.0.sqlite")).toBe(false);
    expect((await h.deps.meta.getActive("pre-k"))?.contentVersion).toBe("1.0.0");
  });

  it("meta write failure after the rename never throws and recovers on retry", async () => {
    const h = await withActiveV1();
    const v2 = crypto.randomBytes(2560);
    serve(h, makeEntry("pre-k", "1.1.0", v2), v2);
    h.upsertThrows = true;
    const crashed = await ensure(h, "pre-k"); // process-equivalent: file moved, meta not recorded
    expect(crashed.status).toBe("failed");
    expect(crashed.reason).toBe("install-error");
    // The old pack is still the one meta serves; the new file is inert.
    expect((await h.deps.meta.getActive("pre-k"))?.contentVersion).toBe("1.0.0");

    h.upsertThrows = false;
    const recovered = await ensure(h, "pre-k");
    expect(recovered.status).toBe("upgraded");
    expect((await h.deps.meta.getActive("pre-k"))?.contentVersion).toBe("1.1.0");
    expect(h.files.has("pack-pre-k-v1.0.0.sqlite")).toBe(false);
    expect([...h.files.keys()].filter((n) => n.startsWith(".staging"))).toHaveLength(0);
  });

  it("a null staged digest neither false-rejects genuine packs nor bypasses tamper checks", async () => {
    // Genuine bytes + unavailable digest -> signature verify is the
    // authority; install still succeeds.
    const h = makeHarness();
    const bytes = crypto.randomBytes(2048);
    serve(h, makeEntry("pre-k", "1.0.0", bytes), bytes);
    h.digestNull = true;
    expect((await ensure(h, "pre-k")).status).toBe("installed");

    // Tampered bytes + unavailable digest -> still caught: the full
    // verifier recomputes the checksum itself, so the native digest
    // shortcut being down is never a bypass.
    const h2 = makeHarness();
    const signed = crypto.randomBytes(2048);
    const tampered = crypto.randomBytes(2048);
    serve(h2, makeEntry("pre-k", "1.0.0", signed), tampered);
    h2.digestNull = true;
    const result = await ensure(h2, "pre-k");
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("checksum-mismatch");
    expect(h2.files.has(".staging-pre-k.sqlite")).toBe(false);
  });

  it("a throwing fetchIndex becomes a typed failure, never an exception", async () => {
    const h = makeHarness();
    h.fetchIndexThrows = true;
    const result = await ensure(h, "pre-k");
    expect(result).toEqual({ status: "failed", gradeId: "pre-k", reason: "unexpected-error" });
  });

  it("staging cleanup failure during rejection is non-fatal (result still typed)", async () => {
    const h = await withActiveV1();
    const signed = crypto.randomBytes(2048);
    const tampered = crypto.randomBytes(1024);
    serve(h, makeEntry("pre-k", "1.1.0", signed), tampered);
    h.stagingDeleteThrows = true;
    const result = await ensure(h, "pre-k");
    expect(result.status).toBe("failed");
    expect(result.reason).toBe("size-mismatch");
    // Old pack untouched regardless of the unlink failure.
    expect(h.files.has("pack-pre-k-v1.0.0.sqlite")).toBe(true);
  });
});
