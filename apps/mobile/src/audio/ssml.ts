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
}

const SPEAK_OPEN = /^\s*<speak\b/i;
const BREAK_TAG = /<break\b[^>]*\/?>/gi;
const ANY_TAG = /<\/?[a-zA-Z][^>]*>/g;
/** Unterminated tag fragment at end of malformed input. */
const DANGLING_TAG = /<[^>]*$/;
const PROSODY_RATE = /<prosody\b[^>]*\brate="(\d+(?:\.\d+)?)\s*wpm"/i;
const BREAK_TIME = /<break\b[^>]*\btime="(\d+(?:\.\d+)?)\s*(ms|s)"/gi;

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
    return { plainText: collapseWhitespace(decodeEntities(text)), rateWpm: null, breakMs: 0 };
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
  };
}
