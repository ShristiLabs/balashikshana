/**
 * Narration SSML adaptation (issue #45) - PURE module.
 *
 * expo-speech has no SSML support, so registry SSML prompts
 * (<speak><prosody rate="110wpm">...<break time="300ms"/>...</speak>)
 * are adapted per platform: tags stripped to plain text, the prosody WPM
 * extracted as the rate source, and break durations preserved for the
 * duration estimate. The SSML forms themselves stay canonical in the
 * registry; platforms that gain SSML support later consume them directly.
 *
 * Tolerance rules: only input that starts with <speak (after trimming) is
 * treated as SSML - narration lines legitimately contain "<" (math
 * comparisons). Malformed SSML degrades to tag-stripped text, never to a
 * crash or an empty utterance.
 */

export interface AdaptedNarration {
  /** Tag-free text to hand the platform engine. */
  plainText: string;
  /** WPM extracted from prosody rate="110wpm", when present. */
  rateWpm: number | null;
  /** Total explicit <break time="..."/> duration in milliseconds. */
  breakMs: number;
  /**
   * Platform pitch multiplier extracted from prosody pitch="+5%"
   * (1.05), when present and representable. Non-percent pitches
   * (labels like "x-low") and absent attributes degrade to null —
   * the caller then uses the platform default (1.0), never a guess.
   */
  pitchMultiplier: number | null;
}

const SPEAK_OPEN = /^\s*<speak\b/i;
const BREAK_TAG = /<break\b[^>]*\/?>/gi;
const ANY_TAG = /<\/?[a-zA-Z][^>]*>/g;
/** Unterminated tag fragment at end of malformed input. */
const DANGLING_TAG = /<[^>]*$/;
const PROSODY_RATE = /<prosody\b[^>]*\brate="(\d+(?:\.\d+)?)\s*wpm"/i;
const PROSODY_PITCH = /<prosody\b[^>]*\bpitch="([+-]?\d+(?:\.\d+)?)\s*%"/i;
const BREAK_TIME = /<break\b[^>]*\btime="(\d+(?:\.\d+)?)\s*(ms|s)"/gi;

/** expo-speech documents the useful pitch range as [0.5, 2.0]. */
export const PITCH_MULT_MIN = 0.5;
export const PITCH_MULT_MAX = 2;

function prosodyPitch(text: string): number | null {
  const match = PROSODY_PITCH.exec(text);
  if (!match) return null;
  const pct = Number.parseFloat(match[1] ?? "");
  if (!Number.isFinite(pct)) return null;
  const multiplier = 1 + pct / 100;
  if (!Number.isFinite(multiplier)) return null;
  return Math.min(PITCH_MULT_MAX, Math.max(PITCH_MULT_MIN, multiplier));
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function isSsml(text: string): boolean {
  return SPEAK_OPEN.test(text);
}

export function adaptNarration(text: string): AdaptedNarration {
  if (!isSsml(text)) {
    return {
      plainText: collapseWhitespace(decodeEntities(text)),
      rateWpm: null,
      breakMs: 0,
      pitchMultiplier: null,
    };
  }

  let breakMs = 0;
  for (const match of text.matchAll(BREAK_TIME)) {
    const value = Number.parseFloat(match[1] ?? "0");
    const unit = (match[2] ?? "ms").toLowerCase();
    breakMs += unit === "s" ? value * 1000 : value;
  }

  const prosody = PROSODY_RATE.exec(text);
  const rateWpm = prosody ? Number.parseFloat(prosody[1] ?? "") : null;

  // Breaks are pauses: they become a space so words never concatenate.
  // All other tags vanish so punctuation stays attached to words
  // ("</emphasis>!" -> "!", not " !").
  const plain = text
    .replace(BREAK_TAG, " ")
    .replace(ANY_TAG, "")
    .replace(DANGLING_TAG, " ")
    .replace(/&(?!amp;|lt;|gt;|quot;|apos;|#39;|nbsp;)/g, "&amp;");
  const plainText = collapseWhitespace(decodeEntities(plain));

  return {
    plainText,
    rateWpm: rateWpm !== null && Number.isFinite(rateWpm) ? rateWpm : null,
    breakMs: Math.round(breakMs),
    pitchMultiplier: prosodyPitch(text),
  };
}
