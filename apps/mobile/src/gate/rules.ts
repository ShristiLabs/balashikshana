/**
 * Boss-gate session rules (issue #51).
 *
 * Registry contract (docs/us-curriculum-registry.json,
 * globalMasteryRules — the pack artifact carries per-grade SR policy but
 * not these GLOBAL rules, so they are pinned here with the registry as
 * the cited source; same doctrine as goldKey.ts's TWO_KEY_RULES):
 *   antiGuessingMinResponseTimeSec:  1.2   (a WRONG answer faster than
 *                                          this is a rapid-guess
 *                                          violation — the engine's
 *                                          evaluateMasteryGateAttempt
 *                                          counting rule, default
 *                                          parameter antiGuessingMinRawSec)
 *   antiGuessingFreezePenaltySec:    2.0   (UI freeze after a violation)
 *   interleavedSpiralMix:            70 / 20 / 10
 *                                     (AGENTS.md: "Stage 3 Fluency games
 *                                      and Stage 4 Gates must blend 70%
 *                                      current unit, 20% contrastive
 *                                      prerequisite units, and 10% due
 *                                      spaced-review units")
 *
 * The 60-second Gold-check budget is pinned from the product spec
 * (AGENTS.md mastery-gate rule: "a 60-second, 5-item verification check
 * upgrades the unit"; issue #51 acceptance criterion enforces the
 * 5-item / 60-second / >=4-of-5 rule in logic tests). The 5-item and
 * >=4-of-5 halves live in goldKey.ts's TWO_KEY_RULES (14 h window,
 * 5 items, 4 minimum) — never re-declared here.
 *
 * The per-unit registry assessments blocks ALSO carry a per-skill-topic
 * unitBossGateQuotaItems and a CONFLICTING per-unit
 * twoKeySleepConsolidation.day2VerificationItems (2). The GLOBAL rules
 * are authoritative on both counts: the seeded pack's
 * gate_question_count already derives from the per-topic quota, and the
 * two-key machine on BOTH sides (goldKey.ts and
 * services/api/derivations.mjs) pins 5 items / >= 4. The per-unit
 * verification value is registry data debt (do not fork to it).
 */

/** Rapid-guess counting + freeze rule (registry globalMasteryRules). */
export const ANTI_GUESS = {
  /** An INCORRECT answer with raw time below this is a violation. */
  minRawSec: 1.2,
  /** UI freeze after a violation (gentle "think first" pause). */
  freezePenaltySec: 2.0,
} as const;

/** Total answer budget for the Gold verification check, in seconds. */
export const GOLD_CHECK_BUDGET_SEC = 60;

/** Spiral-mix weights for the boss-gate session (sum = 100). */
export const SPIRAL_MIX = {
  currentUnitPercent: 70,
  prerequisitePercent: 20,
  spacedReviewPercent: 10,
} as const;

/**
 * The engine's rapid-guess counting rule, mirrored for the UI freeze so
 * the screen can NEVER freeze on an answer the engine would not count
 * (a fast CORRECT answer is fluency, not guessing).
 */
export function isRapidGuessViolation(isCorrect: boolean, rawTimeSec: number): boolean {
  return !isCorrect && rawTimeSec < ANTI_GUESS.minRawSec;
}
