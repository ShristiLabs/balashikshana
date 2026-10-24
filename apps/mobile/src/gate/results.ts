/**
 * Gate results derivation (issue #51) — PURE view-model builders.
 *
 * Turns the engine verdict (GateSessionSummary — the SAME
 * evaluateMasteryGateAttempt output the server produces) into the
 * per-condition rows, per-topic rows, and remediation routing the
 * results screen renders. No thresholds are re-implemented here: every
 * pass/fail flag comes from the engine's `conditions` map; these
 * builders only pair each flag with its metric and threshold TEXT.
 */
import type { GateSessionSummary } from "../practice/practiceEngine";

export const REMEDIATION_ROUTES = {
  CONCEPT_GAP: {
    label: "Review the guidebook, then practice the tricky topics",
    route: "/practice",
  },
  IMPULSIVE_RUSHING: {
    label: "Slow-and-steady practice builds think-first habits",
    route: "/practice",
  },
  LOW_AUTOMATICITY: { label: "Practice again to build faster recall", route: "/practice" },
  SINGLE_TOPIC_BLINDSPOT: {
    label: "A focused practice on the tricky topic will help",
    route: "/practice",
  },
} as const;

/** Engine condition keys (evaluateMasteryGateAttempt's conditions map). */
export const CONDITION_KEYS = [
  "overallAccuracyPassed",
  "perTopicFloorPassed",
  "medianSpeedPassed",
  "tailLatencyP80Passed",
  "challengeStreakAndNoGuessingPassed",
] as const;

export type ConditionKey = (typeof CONDITION_KEYS)[number];

export interface ConditionRow {
  key: ConditionKey;
  /** Shape-first pass/fail glyph (redundant with color + text). */
  glyph: "check" | "retry";
  passed: boolean;
  /** Metric the child/parent just achieved. */
  metric: string;
  /** Threshold text ("needs >= 85%"). */
  threshold: string;
}

export interface TopicRow {
  code: string;
  name: string;
  accuracyPct: number;
  passed: boolean;
}

export interface ResultsView {
  passed: boolean;
  headline: string;
  subline: string;
  conditions: ConditionRow[];
  topics: TopicRow[];
  /** Next-step routing per the engine's remediation mode (pass -> null). */
  nextStep: { label: string; route: string; topicCode?: string } | null;
}

function pct(value: number): string {
  return `${Number(value).toFixed(1)}%`;
}

/**
 * Builds the per-condition/per-topic view model. `summary.conditions`
 * is the engine's map; a missing key counts as failed (defensive — the
 * empty-responses early return omits the map entirely).
 */
export function resultsView(summary: GateSessionSummary): ResultsView {
  const conditions = CONDITION_KEYS.map<ConditionRow>((key) => {
    const passed = summary.conditions[key] === true;
    const glyph = passed ? "check" : "retry";
    switch (key) {
      case "overallAccuracyPassed":
        return {
          key,
          glyph,
          passed,
          metric: `Accuracy ${pct(summary.overallAccuracyPct)}`,
          threshold: `needs ${pct(summary.requiredAccuracyPct)} or more`,
        };
      case "perTopicFloorPassed":
        return {
          key,
          glyph,
          passed,
          metric:
            summary.failedTopics.length === 0
              ? "Every topic above the floor"
              : `${summary.failedTopics.length} topic${summary.failedTopics.length > 1 ? "s" : ""} below the floor`,
          threshold: "every topic needs 75% or more",
        };
      case "medianSpeedPassed":
        return {
          key,
          glyph,
          passed,
          metric: `Median speed ${summary.medianCogSpeedSec}s`,
          threshold: `target ${summary.targetSpeedSec}s`,
        };
      case "tailLatencyP80Passed":
        return {
          key,
          glyph,
          passed,
          metric: `Slowest-tail speed ${summary.p80CogSpeedSec}s`,
          threshold: `up to ${summary.maxTailAllowedSec}s allowed`,
        };
      case "challengeStreakAndNoGuessingPassed":
        return {
          key,
          glyph,
          passed,
          metric:
            summary.rapidGuessViolations > 0
              ? `${summary.rapidGuessViolations} too-fast guesses`
              : "No too-fast guesses",
          threshold: `final ${summary.challengeStreakRequired} in a row, zero fast guesses`,
        };
    }
  });

  const topics = summary.topicBreakdown.map<TopicRow>((topic) => ({
    code: topic.code,
    name: topic.name,
    accuracyPct: topic.accuracyPct,
    passed: topic.accuracyPct >= 75,
  }));

  const nextStep = summary.passed
    ? null
    : remediationStep(summary.remediationMode, summary.failedTopics[0]);

  return {
    passed: summary.passed,
    headline: summary.passed ? "Boss gate passed!" : "So close!",
    subline: summary.passed
      ? "A Silver key is on its way."
      : "Every hero retrains and tries again. Here is what to practice.",
    conditions,
    topics,
    nextStep,
  };
}

/** Routes the engine's REMEDIATION_MODE to the practice surface. */
export function remediationStep(
  remediationMode: string,
  failedTopicCode?: string,
): { label: string; route: string; topicCode?: string } {
  switch (remediationMode) {
    case "IMPULSIVE_RUSHING":
      return { ...REMEDIATION_ROUTES.IMPULSIVE_RUSHING };
    case "SINGLE_TOPIC_BLINDSPOT":
      return {
        ...REMEDIATION_ROUTES.SINGLE_TOPIC_BLINDSPOT,
        topicCode: failedTopicCode && !failedTopicCode.includes("-") ? failedTopicCode : undefined,
      };
    case "LOW_AUTOMATICITY":
      return { ...REMEDIATION_ROUTES.LOW_AUTOMATICITY };
    case "CONCEPT_GAP":
    default:
      return { ...REMEDIATION_ROUTES.CONCEPT_GAP };
  }
}
