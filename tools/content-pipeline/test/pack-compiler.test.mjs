/**
 * Compiler acceptance tests (issue #46):
 * - determinism: same registry -> byte-identical packs + index, across
 *   builds AND across CLI process invocations
 * - completeness: per-grade unit/topic/question counts vs the registry
 * - parity: pack question rows match what the server seeds (spot checks of
 *   the interaction columns #50 renders)
 * - pack_info consistency + no raster media inside packs
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  GRADE_IDS,
  buildAllPacks,
  generateSigningKeyPair,
  sha256Hex,
  verifyPackBytes,
  publicKeyHexFromPrivate,
} from "../src/index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");
const REGISTRY = JSON.parse(fs.readFileSync(path.join(ROOT, "docs/us-curriculum-registry.json"), "utf8"));

const EXPECTED = {
  "pre-k": { units: 14, topics: 56, questions: 560 },
  kindergarten: { units: 28, topics: 133, questions: 1330 },
  "grade-1": { units: 28, topics: 131, questions: 1310 },
  "grade-2": { units: 29, topics: 141, questions: 1410 },
  "grade-3": { units: 31, topics: 153, questions: 1530 },
};
const TOTALS = { units: 130, topics: 614, questions: 6140 };

function buildTo(dir, keyPair) {
  return buildAllPacks({
    registry: REGISTRY,
    outDir: dir,
    privateKeyPem: keyPair.privateKeyPem,
    keyId: "test-key",
    tempDir: path.join(dir, ".staging"),
  });
}

function makeKeyPair() {
  return generateSigningKeyPair();
}

describe("pack compiler", () => {
  const keyPair = makeKeyPair();
  const trusted = new Map([["test-key", keyPair.publicKeyHex]]);

  it("builds byte-identical artifacts and index for the same input (determinism)", () => {
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "packs-a-"));
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "packs-b-"));
    buildTo(dirA, keyPair);
    buildTo(dirB, keyPair);
    for (const gradeId of GRADE_IDS) {
      const artifact = `pack-${gradeId}-v${REGISTRY.version}.sqlite`;
      const a = fs.readFileSync(path.join(dirA, artifact));
      const b = fs.readFileSync(path.join(dirB, artifact));
      expect(sha256Hex(b)).toBe(sha256Hex(a));
    }
    expect(sha256Hex(fs.readFileSync(path.join(dirB, "index.json")))).toBe(
      sha256Hex(fs.readFileSync(path.join(dirA, "index.json"))),
    );
  });

  it("is deterministic across CLI process invocations", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "packs-cli-"));
    const keyPath = path.join(dir, "signing.key");
    fs.writeFileSync(keyPath, keyPair.privateKeyPem, { mode: 0o600 });
    const cli = path.join(ROOT, "tools/content-pipeline/src/cli.mjs");
    const outRel = path.relative(ROOT, dir);
    const run = () =>
      execFileSync(process.execPath, [
        "--experimental-sqlite",
        cli,
        "build",
        "--registry",
        "docs/us-curriculum-registry.json",
        "--out",
        outRel,
        "--key",
        path.relative(ROOT, keyPath),
        "--key-id",
        "test-key",
      ], { cwd: ROOT, stdio: "pipe" });
    run();
    const first = Object.fromEntries(
      GRADE_IDS.map((g) => [g, sha256Hex(fs.readFileSync(path.join(dir, `pack-${g}-v${REGISTRY.version}.sqlite`)))]),
    );
    fs.rmSync(path.join(dir, "index.json"));
    run();
    for (const gradeId of GRADE_IDS) {
      expect(sha256Hex(fs.readFileSync(path.join(dir, `pack-${gradeId}-v${REGISTRY.version}.sqlite`)))).toBe(first[gradeId]);
    }
  }, 120_000);

  it("produces complete per-grade content matching the registry counts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "packs-counts-"));
    const { entries } = buildTo(dir, keyPair);
    expect(entries).toHaveLength(5);
    const totals = { units: 0, topics: 0, questions: 0 };
    for (const entry of entries) {
      const expected = EXPECTED[entry.gradeId];
      expect(entry.unitCount).toBe(expected.units);
      expect(entry.topicCount).toBe(expected.topics);
      expect(entry.questionCount).toBe(expected.questions);
      totals.units += entry.unitCount;
      totals.topics += entry.topicCount;
      totals.questions += entry.questionCount;

      const db = new DatabaseSync(path.join(dir, entry.artifact), { readOnly: true });
      try {
        const info = db.prepare("SELECT * FROM pack_info WHERE id = 1").get();
        expect(info.grade_id).toBe(entry.gradeId);
        expect(info.content_version).toBe(REGISTRY.version);
        expect(info.pack_schema_version).toBe(1);
        expect(db.prepare("SELECT COUNT(*) n FROM units").get().n).toBe(expected.units);
        expect(db.prepare("SELECT COUNT(*) n FROM skill_topics").get().n).toBe(expected.topics);
        expect(db.prepare("SELECT COUNT(*) n FROM practice_questions").get().n).toBe(expected.questions);
        expect(db.prepare("SELECT COUNT(*) n FROM topic_sounds").get().n).toBe(expected.topics);
        expect(db.prepare("SELECT COUNT(*) n FROM topic_narration").get().n).toBe(expected.topics);
      } finally {
        db.close();
      }
    }
    expect(totals).toEqual(TOTALS);
  });

  it("carries the interaction columns the #50 practice runner renders, with server-parity values", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "packs-parity-"));
    buildTo(dir, keyPair);
    const db = new DatabaseSync(path.join(dir, `pack-kindergarten-v${REGISTRY.version}.sqlite`), { readOnly: true });
    try {
      const interactionTypes = db
        .prepare("SELECT DISTINCT interaction_type FROM practice_questions ORDER BY interaction_type")
        .all()
        .map((r) => r.interaction_type);
      for (const type of interactionTypes) {
        expect(typeof type).toBe("string");
        expect(type.length).toBeGreaterThan(0);
      }

      // Same id + difficulty scheme as the server seed (db.mjs).
      const first = db.prepare("SELECT question_id FROM practice_questions ORDER BY question_id LIMIT 1").get();
      expect(first.question_id).toMatch(/-Q1$/);
      const q = db
        .prepare("SELECT * FROM practice_questions WHERE question_id = ?")
        .get(first.question_id);
      expect(q).toBeTruthy();
      expect(q.difficulty_level).toBe(1);
      expect(JSON.parse(q.choices_json)).toBeInstanceOf(Array);
      expect(q.correct_answer.length).toBeGreaterThan(0);
      const q10 = db.prepare("SELECT difficulty_level FROM practice_questions WHERE question_id = ?").get(`${first.question_id.slice(0, -2)}Q10`);
      expect(q10.difficulty_level).toBe(3);

      // tile-builder questions carry tile_bank_json; every question has
      // interaction_type + prompt + explanation.
      const tileBuilders = db
        .prepare("SELECT COUNT(*) n FROM practice_questions WHERE tile_bank_json IS NOT NULL")
        .get().n;
      expect(tileBuilders).toBeGreaterThan(0);
      const missing = db
        .prepare("SELECT COUNT(*) n FROM practice_questions WHERE interaction_type IS NULL OR prompt IS NULL OR explanation IS NULL")
        .get().n;
      expect(missing).toBe(0);

      // mastery-gate rules are present on every unit row.
      const badGates = db
        .prepare("SELECT COUNT(*) n FROM units WHERE gate_question_count <= 0 OR gate_min_accuracy_pct <= 0")
        .get().n;
      expect(badGates).toBe(0);
    } finally {
      db.close();
    }
  });

  it("contains no raster media: visual aids are SVG path refs only", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "packs-media-"));
    buildTo(dir, keyPair);
    for (const gradeId of GRADE_IDS) {
      const db = new DatabaseSync(path.join(dir, `pack-${gradeId}-v${REGISTRY.version}.sqlite`), { readOnly: true });
      try {
        const raster = db
          .prepare("SELECT COUNT(*) n FROM practice_questions WHERE visual_aid_svg LIKE '%.png' OR visual_aid_svg LIKE '%.jpg' OR visual_aid_svg LIKE '%.jpeg' OR visual_aid_svg LIKE '%.webp'")
          .get().n;
        expect(raster).toBe(0);
      } finally {
        db.close();
      }
    }
  });

  it("self-verifies every produced artifact against its own signature", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "packs-verify-"));
    const { entries } = buildTo(dir, keyPair);
    for (const entry of entries) {
      const bytes = fs.readFileSync(path.join(dir, entry.artifact));
      expect(entry.sizeBytes).toBe(bytes.length);
      expect(verifyPackBytes({ bytes, entry, trustedKeys: trusted })).toEqual({ ok: true, reason: null });
    }
  });

  it("emits a manifest index that round-trips as strict JSON with string names", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "packs-index-"));
    buildTo(dir, keyPair);
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf8"));
    expect(parsed.formatVersion).toBe(1);
    expect(parsed.packs).toHaveLength(5);
    for (const entry of parsed.packs) {
      expect(typeof entry.gradeName).toBe("string");
      expect(entry.gradeName.length).toBeGreaterThan(0);
      expect(entry.artifact).toBe(`pack-${entry.gradeId}-v${REGISTRY.version}.sqlite`);
    }
  });

  it("derives the public key from the private PEM consistently", () => {
    expect(publicKeyHexFromPrivate(keyPair.privateKeyPem)).toBe(keyPair.publicKeyHex);
  });
});
