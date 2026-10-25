/**
 * Celebration narration lines (issue #58) — the topic's registry
 * celebrationPrompts, voiced through the #45 TTS coordinator.
 *
 * Source of truth: assets/narration/celebration-lines.json, derived
 * verbatim from voice-narration-manifest.json by
 * scripts/build-celebration-lines.mjs and pinned 1:1 by
 * tests/mascot-celebrations.test.ts (every topic present, every line
 * equal). The compact asset is imported directly (the #45
 * sounds-manifest import precedent) instead of bundling the full SSML
 * manifest. Pure module: JSON in, strings out — no React Native.
 */
import rawLines from "../../../../assets/narration/celebration-lines.json";

interface CelebrationLinesItem {
  topicId: string;
  grade: string;
  lines: string[];
}
interface CelebrationLinesAsset {
  totalTopics: number;
  items: CelebrationLinesItem[];
}

const asset = rawLines as unknown as CelebrationLinesAsset;

const BY_TOPIC = new Map<string, CelebrationLinesItem>(
  asset.items.map((item) => [item.topicId, item]),
);

/** Generic fallback when a topic has no registry lines (defensive only). */
export const FALLBACK_CELEBRATION_LINE = "Awesome job! Keep that focus going!";

/** All registry celebration lines for a topic (empty array when unknown). */
export function celebrationLinesForTopic(topicId: string): string[] {
  const item = BY_TOPIC.get(topicId);
  return item ? [...item.lines] : [];
}

/**
 * Deterministic line pick: rotates through the topic's lines by
 * occurrence so back-to-back celebrations of the same topic vary while
 * staying reproducible (pure function of the inputs).
 */
export function celebrationLineForTopic(topicId: string, occurrence: number): string {
  const lines = celebrationLinesForTopic(topicId);
  if (lines.length === 0) return FALLBACK_CELEBRATION_LINE;
  const index = ((occurrence % lines.length) + lines.length) % lines.length;
  return lines[index] ?? FALLBACK_CELEBRATION_LINE;
}

/** Topic count in the asset (completeness pin vs the source manifest). */
export function celebrationLineTopicCount(): number {
  return asset.items.length;
}
