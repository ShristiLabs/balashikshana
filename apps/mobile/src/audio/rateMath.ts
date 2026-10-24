/**
 * TTS rate calibration (issue #45) - PURE module.
 *
 * Roadmap Risk 5 (TTS variance across devices) is mitigated here: every
 * speaking rate derives from the registry's per-topic speakingRateWpm,
 * clamped at runtime to [110, 150] WPM, then converted to the platform
 * multiplier. The per-grade defaults are the registry's uniform values:
 *
 *   pre-k 110, kindergarten 120, grade-1 130, grade-2 140, grade-3 150
 *
 * (docs/us-curriculum-registry.json voiceNarration.speakingRateWpm - 614
 * topics; tests cross-check this table against the registry file).
 */

import type { GradeId } from "../onboarding/types";

/** Registry floor for narration WPM (issue body: always clamped 110-150). */
export const MIN_WPM = 110;
/** Registry ceiling for narration WPM. */
export const MAX_WPM = 150;

/**
 * WPM the platform means by rate 1.0. iOS AVSpeechUtterance defaultRate
 * (0.5) is commonly treated as ~180 WPM and Android's normal speech rate
 * is the same ballpark; the clamp below keeps the multiplier well inside
 * both platforms' supported ranges even if the anchor drifts.
 */
export const REFERENCE_WPM = 180;

/** Safe platform rate-multiplier bounds (expo-speech accepts 0.01..2+). */
export const MIN_RATE = 0.5;
export const MAX_RATE = 2;

export const GRADE_DEFAULT_WPM: Record<GradeId, number> = {
  "pre-k": 110,
  kindergarten: 120,
  "grade-1": 130,
  "grade-2": 140,
  "grade-3": 150,
};

export function clampWpm(wpm: number): number {
  if (!Number.isFinite(wpm)) return GRADE_DEFAULT_WPM["pre-k"];
  return Math.min(MAX_WPM, Math.max(MIN_WPM, Math.round(wpm)));
}

/**
 * Resolve the effective WPM for an utterance: an explicit registry value
 * wins over the grade default; the result is always clamped to 110-150.
 */
export function resolveWpm(input: { grade?: GradeId; wpm?: number }): number {
  if (typeof input.wpm === "number") return clampWpm(input.wpm);
  if (input.grade) return GRADE_DEFAULT_WPM[input.grade];
  // Unknown grade without an explicit WPM: slowest (Pre-K) calibration.
  return GRADE_DEFAULT_WPM["pre-k"];
}

/** Convert clamped WPM to the expo-speech rate multiplier. */
export function wpmToRate(wpm: number): number {
  const raw = clampWpm(wpm) / REFERENCE_WPM;
  return Math.min(MAX_RATE, Math.max(MIN_RATE, Math.round(raw * 1000) / 1000));
}

/** Number of spoken words in a narration line (SSML already stripped). */
export function countWords(plainText: string): number {
  const trimmed = plainText.trim();
  if (trimmed === "") return 0;
  return trimmed.split(/\s+/).length;
}

/**
 * Pure duration estimate for practice timing when the platform reports no
 * start/terminal events: words / WPM plus explicit SSML break durations.
 * Small floor so a single short word still registers as audible time.
 */
export function estimateSpeechDurationSec(plainText: string, wpm: number, breakMs = 0): number {
  const words = countWords(plainText);
  const speakingSec = (words / clampWpm(wpm)) * 60;
  const pauseSec = breakMs / 1000;
  return Math.max(0.3, Math.round((speakingSec + pauseSec) * 100) / 100);
}
