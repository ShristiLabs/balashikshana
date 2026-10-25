#!/usr/bin/env node
/**
 * Build assets/narration/celebration-lines.json (issue #58).
 *
 * Derives the compact celebration-lines asset from the canonical
 * voice-narration manifest: topicId -> { grade, lines } where `lines`
 * are the registry's plain-text celebrationPrompts (verbatim). The
 * mobile mascot module imports the compact asset instead of the full
 * 688KB SSML manifest (the #45 sounds-manifest import precedent, at a
 * fraction of the size); tests pin the compact asset 1:1 against the
 * source manifest so the derivation cannot drift.
 *
 * Usage: node scripts/build-celebration-lines.mjs
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(repoRoot, "assets", "narration", "voice-narration-manifest.json");
const TARGET = path.join(repoRoot, "assets", "narration", "celebration-lines.json");

const manifest = JSON.parse(await readFile(SOURCE, "utf8"));
if (!Array.isArray(manifest.items)) {
  throw new Error("voice-narration-manifest.json has no items array");
}

const items = [];
for (const item of manifest.items) {
  const lines = Array.isArray(item.celebrationPrompts)
    ? item.celebrationPrompts.filter((line) => typeof line === "string")
    : [];
  items.push({ topicId: item.topicId, grade: item.grade, lines });
}

items.sort((a, b) => (a.topicId < b.topicId ? -1 : a.topicId > b.topicId ? 1 : 0));

const out = { totalTopics: items.length, items };
await writeFile(TARGET, `${JSON.stringify(out, null, 2)}\n`, "utf8");
console.log(`wrote ${TARGET} (${items.length} topics)`);
