/**
 * Content-pipeline CLI (issue #46).
 *
 *   keys  --out tools/content-pipeline/keys [--base-name dev-signing] [--force]
 *         Generate an Ed25519 signing keypair. The .key file is private
 *         (gitignored; chmod 600) and the .pub.hex file is committed so
 *         devices can pin it.
 *
 *   build --registry docs/us-curriculum-registry.json
 *         --out services/api/content-packs
 *         --key tools/content-pipeline/keys/dev-signing.key
 *         --key-id dev-local
 *         [--grades pre-k,kindergarten,...]
 *   Compile per-grade packs, sign them, verify (fail closed), publish the
 *   manifest index, and print a size table for the low-end-Android budget
 *   review. Needs --experimental-sqlite on Node 22 (see package.json).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GRADE_IDS } from "./constants.mjs";
import { writeKeyFiles, readPrivateKeyPem } from "./keys.mjs";
// build.mjs pulls in node:sqlite (experimental on Node 22); import it
// lazily so `keys` runs on a bare node invocation.
/** @type {typeof import('./build.mjs')} */
let buildModule = null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function fail(message) {
  console.error(`content-pipeline: ${message}`);
  process.exit(1);
}

const command = process.argv[2];

if (command === "keys") {
  const args = parseArgs(process.argv.slice(3));
  const outDir = path.resolve(ROOT, String(args.out ?? "tools/content-pipeline/keys"));
  const baseName = String(args["base-name"] ?? "dev-signing");
  const result = writeKeyFiles(outDir, baseName, { force: args.force === true });
  console.log(`Private key: ${result.keyPath} (KEEP SECRET; gitignored)`);
  console.log(`Public key:  ${result.pubPath} (pin this in the app key registry)`);
  console.log(`publicKeyHex=${result.publicKeyHex}`);
  process.exit(0);
}

if (command === "build") {
  const args = parseArgs(process.argv.slice(3));
  const registryPath = path.resolve(ROOT, String(args.registry ?? "docs/us-curriculum-registry.json"));
  const outDir = path.resolve(ROOT, String(args.out ?? "services/api/content-packs"));
  const keyPath = path.resolve(ROOT, String(args.key ?? "tools/content-pipeline/keys/dev-signing.key"));
  const keyId = String(args["key-id"] ?? "dev-local");
  const gradeIds = args.grades ? String(args.grades).split(",").map((s) => s.trim()).filter(Boolean) : GRADE_IDS;

  if (!fs.existsSync(registryPath)) fail(`registry not found: ${registryPath}`);
  if (!fs.existsSync(keyPath)) fail(`signing key not found: ${keyPath} (run: npm run keys)`);

  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  const privateKeyPem = readPrivateKeyPem(keyPath);
  buildModule = await import("./build.mjs");

  const started = Date.now();
  const { entries, sizes } = await buildModule.buildAllPacks({
    registry,
    outDir,
    privateKeyPem,
    keyId,
    gradeIds,
    tempDir: path.join(outDir, ".staging"),
  });

  console.log(`Compiled ${entries.length} grade pack(s) from registry v${registry.version} in ${Date.now() - started}ms (keyId=${keyId})`);
  console.log("grade         units  topics  questions  size (KiB)");
  let total = 0;
  for (const entry of entries) {
    const size = sizes[entry.gradeId] ?? 0;
    total += size;
    console.log(
      `${entry.gradeId.padEnd(13)} ${String(entry.unitCount).padStart(5)}  ${String(entry.topicCount).padStart(6)}  ${String(entry.questionCount).padStart(10)}  ${(size / 1024).toFixed(1)}`,
    );
  }
  console.log(`total: ${(total / 1024).toFixed(1)} KiB across ${entries.length} pack(s)`);
  console.log(`index: ${path.join(outDir, "index.json")}`);
  process.exit(0);
}

fail(`unknown or missing command (use: keys | build)`);
