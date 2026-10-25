#!/usr/bin/env node
/**
 * Build assets/narration/narration-lines.json (issue #59).
 *
 * Derives the compact narration-lines asset from the canonical
 * voice-narration manifest: one entry per topic carrying ALL registry
 * line kinds — intro/hint/remediation SSML (verbatim; the runtime SSML
 * adaptation layer owns degradation) and the plain-text celebration
 * lines. This SUPERSEDES the #58 celebration-only asset (folded in —
 * one compact asset, one generator, one 1:1 pin). The mobile
 * topicNarration module imports the compact asset instead of the full
 * 688KB SSML manifest (the #45 sounds-manifest import precedent);
 * tests pin the compact asset 1:1 against the source manifest AND
 * byte-compare a regeneration so the derivation cannot drift.
 *
 * Output is minified (single JSON line + trailing newline) and
 * deterministic: items sorted by topicId, fixed key order, no
 * timestamps — same input bytes always produce the same output bytes.
 *
 * Usage: node scripts/build-narration-lines.mjs
 */
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(repoRoot, "assets", "narration", "voice-narration-manifest.json");
const TARGET = path.join(repoRoot, "assets", "narration", "narration-lines.json");

const manifest = JSON.parse(await readFile(SOURCE, "utf8"));
if (!Array.isArray(manifest.items)) {
  throw new Error("voice-narration-manifest.json has no items array");
}

const items = [];
for (const item of manifest.items) {
  const celebration = Array.isArray(item.celebrationPrompts)
    ? item.celebrationPrompts.filter((line) => typeof line === "string" && line.length > 0)
    : [];
  items.push({
    topicId: item.topicId,
    grade: item.grade,
    intro: item.introPromptSsml,
    hint: item.guidedHintSsml,
    remediation: item.remediationSsml,
    celebration,
  });
}

items.sort((a, b) => (a.topicId < b.topicId ? -1 : a.topicId > b.topicId ? 1 : 0));

const out = { totalTopics: items.length, items };
await writeFile(TARGET, `${JSON.stringify(out)}\n`, "utf8");
console.log(`wrote ${TARGET} (${items.length} topics, 4 line kinds each)`);
