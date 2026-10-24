/**
 * Monster Phoneme Feeder archetype module (issue #54, pack B) - PURE
 * logic, no React Native imports, node-testable in vitest.
 *
 * The ELA feeding surface: the item's own tile bank (letters,
 * digraphs, affix tiles - the pack stores them in tile_bank_json)
 * becomes the monster's food tiles, and the child feeds them in the
 * order that blends the target word. The draft is the placed tiles'
 * labels joined with single spaces - EXACTLY the choice-label shape
 * the pack stores ("f a n"), so the framework's draft ===
 * correctAnswer comparison grades the feeding by construction.
 *
 * Parsing stays ANCHORED to the phoneme vocabulary (#53 advisory): a
 * label segments only when it is >= 2 whitespace-separated tokens of
 * 1-4 lowercase letters each, and the plan mounts only when the
 * bank's multiset covers every target segment. Anything else -
 * whole-word multiple-choice rows (no tile bank), uppercase, or a
 * bank that cannot build the target - rides the shared QuestionBody
 * substrate (the choice grid is the universal answer surface). No
 * curriculum data lives here; the module knows only the structural
 * segment grammar.
 *
 * Audio: the item's narration (prompt text via the #45 coordinator,
 * voiceNarration-paced) IS the phoneme/word audio. The renderer never
 * touches the coordinator - it calls the framework's onReplayPrompt
 * seam and never blocks on audio.
 */
import type { PracticeQuestion } from "../practice/types";
import { deterministicShuffle, type RunnerOption } from "../runner/questionShapes";

/** Anchored phoneme-segment grammar: 1-4 lowercase letters (letters,
 * digraphs like "ch", affixes like "ing"). Nothing else segments. */
const PHONEME_SEGMENT = /^[a-z]{1,4}$/;

/** Which surface the renderer mounts for one question. */
export type FeederPlanKind = "feed" | "substrate";

export interface FeederPlan {
  kind: FeederPlanKind;
  /** Ordered target segments (the correct answer split; [] when substrate). */
  targetSegments: string[];
  /** The monster's food tiles: target + distractors, seeded shuffle. */
  bank: RunnerOption[];
  /** Distractor tiles the bank carries beyond the target. */
  distractorCount: number;
}

const SUBSTRATE_PLAN: FeederPlan = {
  kind: "substrate",
  targetSegments: [],
  bank: [],
  distractorCount: 0,
};

/**
 * Segment a choice/answer label into phoneme tiles, or null when the
 * label is not a multi-segment phoneme sequence (single whole words,
 * uppercase, punctuation, numbers - all refuse to segment).
 */
export function phonemeSegmentsForLabel(label: string): string[] | null {
  const parts = label.trim().split(/\s+/);
  if (parts.length < 2) return null;
  if (parts.some((part) => !PHONEME_SEGMENT.test(part))) return null;
  return parts;
}

/**
 * The feeding plan for one question. Mounts "feed" only when ALL of:
 *   - the row carries a real tile_bank array (whole-word multiple
 *     choice rows have none - they are substrate by design),
 *   - every bank token passes the anchored segment grammar,
 *   - the correct answer segments, and
 *   - the bank's MULTISET covers the target (duplicates respected:
 *     "a x a" needs a bank holding two "a" tiles).
 */
export function feederPlanFor(question: PracticeQuestion): FeederPlan {
  const rawBank = question.tileBank;
  if (!Array.isArray(rawBank) || rawBank.length === 0) return SUBSTRATE_PLAN;
  const bankTokens = rawBank.map((token) => String(token).trim());
  if (bankTokens.some((token) => !PHONEME_SEGMENT.test(token))) return SUBSTRATE_PLAN;
  const target = phonemeSegmentsForLabel(String(question.correctAnswer ?? ""));
  if (target === null) return SUBSTRATE_PLAN;
  // Multiset cover check (splice consumes each matched tile once).
  const remaining = [...bankTokens];
  for (const segment of target) {
    const at = remaining.indexOf(segment);
    if (at === -1) return SUBSTRATE_PLAN;
    remaining.splice(at, 1);
  }
  const bank: RunnerOption[] = bankTokens.map((label, index) => ({
    key: `${question.questionId}-feed-${index}`,
    label,
  }));
  return {
    kind: "feed",
    targetSegments: target,
    bank: deterministicShuffle(bank, question.questionId),
    distractorCount: remaining.length,
  };
}

/**
 * The draft for a placed tile sequence: labels joined with single
 * spaces (the pack's exact choice-label shape). Null when nothing is
 * placed - same contract as every other manipulative.
 */
export function draftForPlaced(placed: readonly RunnerOption[]): string | null {
  return placed.length > 0 ? placed.map((option) => option.label).join(" ") : null;
}

/**
 * Deterministic guided hint chain for feeding (one line per state):
 *   nothing fed  -> invite + full sound count
 *   partially fed -> sounds remaining
 *   all fed      -> celebrate + point at Check
 * Fluency suppresses the line entirely (recall pacing).
 */
export function guidedHintForFeed(placedCount: number, targetSegments: readonly string[]): string {
  if (targetSegments.length === 0) return "Listen, then feed the tiles in order.";
  if (placedCount === 0) {
    return `Feed the sounds in order - ${targetSegments.length} sounds to go.`;
  }
  const left = targetSegments.length - placedCount;
  if (left <= 0) return `You fed all ${targetSegments.length} sounds! Tap Check.`;
  return left === 1 ? "One sound left. Feed the last tile, then Check." : `${left} sounds left.`;
}
