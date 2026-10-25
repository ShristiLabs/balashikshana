/**
 * Celebration narration lines (issue #58; the asset folded into the
 * unified narration-lines asset by #59) — the topic's registry
 * celebrationPrompts, voiced through the #45 TTS coordinator.
 *
 * Data source: apps/mobile/src/audio/topicNarration.ts (the single
 * narration binding asset for ALL registry line kinds — #59); this
 * module keeps the celebration PICK POLICY (deterministic rotation +
 * generic fallback) and its tested API. Pinned 1:1 against
 * voice-narration-manifest.json by tests/narration-coverage.test.ts.
 * Pure module: no React Native.
 */
import { narrationTopicCount, topicNarrationFor } from "../audio/topicNarration";

/** Generic fallback when a topic has no registry lines (defensive only). */
export const FALLBACK_CELEBRATION_LINE = "Awesome job! Keep that focus going!";

/** All registry celebration lines for a topic (empty array when unknown). */
export function celebrationLinesForTopic(topicId: string): string[] {
  const item = topicNarrationFor(topicId);
  return item ? [...item.celebration] : [];
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
  // Re-exported through the narration module so the count can never
  // drift from the unified asset.
  return narrationTopicCount();
}
