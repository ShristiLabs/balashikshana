#!/usr/bin/env node
/**
 * Animation asset budget check (issue #58, roadmap D7 + AGENTS.md).
 *
 * Enforces the animation-asset rules on assets/animations/:
 *   1. every .riv file is under 50KB (the Rive budget — trivially green
 *      today with zero .riv files; the check stands ready for real art);
 *   2. zero raster media (png/jpg/jpeg/gif/webp/bmp) — SVG/Rive only;
 *   3. the animations manifest exists and is valid JSON with topics.
 *
 * Exit 0 = pass; exit 1 = violation listing. Runs in CI
 * (.github/workflows/ci.yml) and in the local regression gate.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ANIMATIONS_DIR = path.join(repoRoot, "assets", "animations");
const RIVE_BUDGET_BYTES = 50 * 1024;
const RASTER_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);

const violations = [];

const entries = await readdir(ANIMATIONS_DIR, { withFileTypes: true }).catch(() => {
  violations.push(`missing animations directory: ${ANIMATIONS_DIR}`);
  return [];
});

let rivCount = 0;
for (const entry of entries) {
  if (!entry.isFile()) continue;
  const ext = path.extname(entry.name).toLowerCase();
  const filePath = path.join(ANIMATIONS_DIR, entry.name);
  if (ext === ".riv") {
    rivCount += 1;
    const size = (await stat(filePath)).size;
    if (size >= RIVE_BUDGET_BYTES) {
      violations.push(
        `Rive asset over 50KB budget: ${entry.name} (${String(size)} bytes, budget ${String(RIVE_BUDGET_BYTES)})`,
      );
    }
  } else if (RASTER_EXTENSIONS.has(ext)) {
    violations.push(`raster media forbidden in assets/animations (SVG/Rive only): ${entry.name}`);
  }
}

const manifestPath = path.join(ANIMATIONS_DIR, "animations-manifest.json");
const manifestRaw = await readFile(manifestPath, "utf8").catch(() => null);
if (manifestRaw === null) {
  violations.push(`missing animations manifest: ${manifestPath}`);
} else {
  try {
    const manifest = JSON.parse(manifestRaw);
    if (!Array.isArray(manifest.items) || manifest.items.length === 0) {
      violations.push("animations-manifest.json has no items");
    }
  } catch (error) {
    violations.push(`animations-manifest.json is not valid JSON: ${String(error)}`);
  }
}

if (violations.length > 0) {
  console.error("animation asset budget check FAILED:");
  for (const violation of violations) console.error(` - ${violation}`);
  process.exit(1);
}
console.log(
  `animation asset budget check passed (rive files: ${String(rivCount)}, all under 50KB; zero raster media)`,
);
