/**
 * Topic narration lines (issue #59) — the registry's voiceNarration
 * lines for every topic, voiced through the #45 TTS coordinator.
 *
 * Source of truth: assets/narration/narration-lines.json, derived
 * verbatim from voice-narration-manifest.json by
 * scripts/build-narration-lines.mjs, pinned 1:1 (and byte-deterministic)
 * by tests/narration-coverage.test.ts. The compact asset is imported
 * directly (the #45 sounds-manifest import precedent); the full SSML
 * manifest stays unbundled. All line kinds flow through the SAME
 * lookup — one narration binding source for every speaking surface.
 *
 * Line kinds: intro (session-opening prompt), hint (guided hint),
 * remediation (gentle-retry coaching), celebration (mastery/goal
 * praise). Question prompts ("instruction") come from live question
 * data, not this asset. Pure module: JSON in, strings out — no React
 * Native; SSML adaptation happens inside the coordinator (ssml.ts).
 */
import rawNarration from "../../../../assets/narration/narration-lines.json";

import { warnOnce } from "./coordinator";

export interface TopicNarrationLines {
  topicId: string;
  grade: string;
  /** Registry introPromptSsml (SSML document, spoken verbatim source). */
  intro: string;
  /** Registry guidedHintSsml. */
  hint: string;
  /** Registry remediationSsml. */
  remediation: string;
  /** Registry celebrationPrompts (plain text). */
  celebration: string[];
}

interface NarrationLinesAsset {
  totalTopics: number;
  items: TopicNarrationLines[];
}

const asset = rawNarration as unknown as NarrationLinesAsset;

const BY_TOPIC = new Map<string, TopicNarrationLines>(
  asset.items.map((item) => [item.topicId, item]),
);

/** All registry narration kinds for a topic (null when unknown). */
export function topicNarrationFor(topicId: string): TopicNarrationLines | null {
  return BY_TOPIC.get(topicId) ?? null;
}

/** Topic count in the asset (completeness pin vs the source manifest). */
export function narrationTopicCount(): number {
  return asset.items.length;
}

/**
 * Single-kind lookup with the #59 fallback contract: a missing line is
 * a WARN + silent skip — never dead air as a blocking wait, never a
 * crash. (The 1:1 pin test makes misses impossible on a green tree;
 * this is the defensive runtime seam for asset drift.)
 */
function lineFor(topicId: string, kind: "intro" | "hint" | "remediation"): string | null {
  const item = BY_TOPIC.get(topicId);
  const line = item?.[kind];
  if (typeof line === "string" && line.length > 0) return line;
  warnOnce(
    `narration-missing:${kind}:${topicId}`,
    `no ${kind} narration line for topic "${topicId}" - skipping (asset drift; 1:1 pin test should have caught this)`,
  );
  return null;
}

/** The topic's session-opening line (SSML), or null (skip silently). */
export function introLineForTopic(topicId: string): string | null {
  return lineFor(topicId, "intro");
}

/** The topic's guided-hint line (SSML), or null (skip silently). */
export function hintLineForTopic(topicId: string): string | null {
  return lineFor(topicId, "hint");
}

/** The topic's remediation line (SSML), or null (skip silently). */
export function remediationLineForTopic(topicId: string): string | null {
  return lineFor(topicId, "remediation");
}
