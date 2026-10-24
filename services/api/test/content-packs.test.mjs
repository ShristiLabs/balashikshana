/**
 * Content-pack hosting route tests (issue #46).
 *
 * Uses synthetic pack bytes + a hand-written index (the server never
 * verifies signatures — that is the device's job), exercising: index
 * shape, artifact streaming with content-length/etag, unknown grade 404,
 * missing-dir/index 503, and the size-drift consistency guard 503.
 *
 * Port note: 4190 is on the WHATWG fetch bad-port blocklist (undici
 * refuses it with "bad port"), so this suite uses 4280.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDatabase, dropTestDatabase, startTestServer, waitForHealth } from "./helpers.mjs";

const PORT = 4280;
const API = `http://127.0.0.1:${PORT}`;

let serverChild;
let database;
const packsDir = fs.mkdtempSync(path.join(os.tmpdir(), "packs-api-"));

function writeIndex(entries) {
  fs.writeFileSync(
    path.join(packsDir, "index.json"),
    JSON.stringify({ formatVersion: 1, registryVersion: "1.0.0", packs: entries }),
  );
}

const PACK_BYTES = Buffer.alloc(4096, 7);

beforeAll(async () => {
  database = await createTestDatabase();
  fs.writeFileSync(path.join(packsDir, "pack-pre-k-v1.0.0.sqlite"), PACK_BYTES);
  fs.writeFileSync(path.join(packsDir, "pack-grade-3-v1.0.0.sqlite"), Buffer.concat([PACK_BYTES, Buffer.alloc(512, 1)]));
  writeIndex([
    {
      formatVersion: 1,
      gradeId: "pre-k",
      gradeName: "Pre-Kindergarten",
      contentVersion: "1.0.0",
      registryVersion: "1.0.0",
      artifact: "pack-pre-k-v1.0.0.sqlite",
      sizeBytes: PACK_BYTES.length,
      sha256: "a".repeat(64),
      keyId: "test-key",
      signature: Buffer.alloc(64, 1).toString("base64"),
      unitCount: 14,
      topicCount: 56,
      questionCount: 560,
    },
    {
      formatVersion: 1,
      gradeId: "grade-3",
      gradeName: "Grade 3",
      contentVersion: "1.0.0",
      registryVersion: "1.0.0",
      artifact: "pack-grade-3-v1.0.0.sqlite",
      sizeBytes: PACK_BYTES.length + 512,
      sha256: "b".repeat(64),
      keyId: "test-key",
      signature: Buffer.alloc(64, 2).toString("base64"),
      unitCount: 31,
      topicCount: 153,
      questionCount: 1530,
    },
  ]);

  serverChild = await startTestServer({
    port: PORT,
    databaseUrl: database.url,
    env: { BALASHIKSHANA_CONTENT_PACKS_DIR: packsDir, SEED_DEMO_STUDENTS: "0" },
    onStderr: (chunk) => { process.stderr.write(`[content-packs-srv] ${chunk}`); },
  });
  await waitForHealth(API);
}, 180_000);

afterAll(async () => {
  if (serverChild) serverChild.kill("SIGTERM");
  if (database) await dropTestDatabase(database.name);
});

describe("GET /api/content/packs", () => {
  it("serves the manifest index with per-grade entries", async () => {
    const res = await fetch(`${API}/api/content/packs`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.formatVersion).toBe(1);
    expect(body.packs).toHaveLength(2);
    const prek = body.packs.find((p) => p.gradeId === "pre-k");
    expect(prek.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(prek.keyId).toBe("test-key");
    expect(prek.questionCount).toBe(560);
    expect(typeof prek.signature).toBe("string");
  });
});

describe("GET /api/content/packs/:gradeId", () => {
  it("streams the artifact bytes with content-length and etag", async () => {
    const res = await fetch(`${API}/api/content/packs/pre-k`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-length")).toBe(String(PACK_BYTES.length));
    expect(res.headers.get("etag")).toBe(`"${"a".repeat(64)}"`);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.length).toBe(PACK_BYTES.length);
    expect(bytes.equals(PACK_BYTES)).toBe(true);
  });

  it("404s for an unknown grade (problem envelope)", async () => {
    const res = await fetch(`${API}/api/content/packs/grade-12`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.status).toBe(404);
  });

  it("rejects path-traversal-shaped grade ids", async () => {
    const res = await fetch(`${API}/api/content/packs/..%2Findex.json`);
    expect([400, 404]).toContain(res.status);
  });
});

describe("publish consistency guards", () => {
  it("503s when the index references a missing artifact", async () => {
    const saved = fs.readFileSync(path.join(packsDir, "pack-grade-3-v1.0.0.sqlite"));
    fs.unlinkSync(path.join(packsDir, "pack-grade-3-v1.0.0.sqlite"));
    try {
      const res = await fetch(`${API}/api/content/packs/grade-3`);
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.status).toBe(503);
    } finally {
      fs.writeFileSync(path.join(packsDir, "pack-grade-3-v1.0.0.sqlite"), saved);
    }
  });

  it("503s when the artifact size drifted from the manifest (partial rebuild)", async () => {
    const saved = fs.readFileSync(path.join(packsDir, "pack-pre-k-v1.0.0.sqlite"));
    fs.writeFileSync(path.join(packsDir, "pack-pre-k-v1.0.0.sqlite"), PACK_BYTES.subarray(0, 1000));
    try {
      const res = await fetch(`${API}/api/content/packs/pre-k`);
      expect(res.status).toBe(503);
    } finally {
      fs.writeFileSync(path.join(packsDir, "pack-pre-k-v1.0.0.sqlite"), saved);
    }
  });

  it("503s on the index route when no index is published", async () => {
    const indexPath = path.join(packsDir, "index.json");
    const saved = fs.readFileSync(indexPath);
    fs.unlinkSync(indexPath);
    try {
      const res = await fetch(`${API}/api/content/packs`);
      expect(res.status).toBe(503);
      const artifact = await fetch(`${API}/api/content/packs/pre-k`);
      expect(artifact.status).toBe(503);
    } finally {
      fs.writeFileSync(indexPath, saved);
    }
  });
});

describe("forged index guards (canonical artifact naming)", () => {
  const indexPath = path.join(packsDir, "index.json");

  function forgePrekEntry(overrides) {
    return {
      formatVersion: 1,
      gradeId: "pre-k",
      gradeName: "Pre-Kindergarten",
      contentVersion: "1.0.0",
      registryVersion: "1.0.0",
      artifact: "pack-pre-k-v1.0.0.sqlite",
      sizeBytes: PACK_BYTES.length,
      sha256: "a".repeat(64),
      keyId: "test-key",
      signature: Buffer.alloc(64, 1).toString("base64"),
      unitCount: 14,
      topicCount: 56,
      questionCount: 560,
      ...overrides,
    };
  }

  it("503s on a traversal-shaped artifact before any file access, even when the target exists and matches sizeBytes", async () => {
    // Decoy OUTSIDE packsDir whose size matches the forged manifest. If the
    // canonical-name guard were absent, stat would succeed, the size check
    // would pass, and the server would stream the decoy (200). A 503 with
    // the artifact-invalid problem type proves rejection happens at name
    // validation, before the filesystem is touched.
    const decoyDir = fs.mkdtempSync(path.join(os.tmpdir(), "packs-decoy-"));
    const decoyPath = path.join(decoyDir, "decoy.db");
    fs.writeFileSync(decoyPath, Buffer.alloc(PACK_BYTES.length, 9));
    const saved = fs.readFileSync(indexPath);
    try {
      writeIndex([
        forgePrekEntry({ artifact: `../${path.basename(decoyDir)}/decoy.db` }),
      ]);
      const res = await fetch(`${API}/api/content/packs/pre-k`);
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.status).toBe(503);
      expect(body.type).toBe("https://balashikshana.dev/problems/content-pack-artifact-invalid");
    } finally {
      fs.writeFileSync(indexPath, saved);
      fs.rmSync(decoyDir, { recursive: true, force: true });
    }
  });

  it("503s on absolute-path and self-inconsistent artifact names", async () => {
    const saved = fs.readFileSync(indexPath);
    try {
      writeIndex([forgePrekEntry({ artifact: "/etc/passwd" })]);
      const abs = await fetch(`${API}/api/content/packs/pre-k`);
      expect(abs.status).toBe(503);
      const absBody = await abs.json();
      expect(absBody.type).toBe("https://balashikshana.dev/problems/content-pack-artifact-invalid");

      // Canonical shape but disagrees with the entry's own contentVersion.
      writeIndex([forgePrekEntry({ artifact: "pack-pre-k-v9.9.9.sqlite" })]);
      const mismatch = await fetch(`${API}/api/content/packs/pre-k`);
      expect(mismatch.status).toBe(503);
      const mismatchBody = await mismatch.json();
      expect(mismatchBody.type).toBe("https://balashikshana.dev/problems/content-pack-artifact-invalid");
    } finally {
      fs.writeFileSync(indexPath, saved);
    }
  });
});
