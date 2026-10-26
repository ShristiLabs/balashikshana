/**
 * Accessibility announcement messages (issue #67 audit fix).
 *
 * The #67 audit found the single systemic screen-reader gap: dynamic
 * content changes (feedback bars, question transitions, the Gold-check
 * countdown) render visually but are never ANNOUNCED — VoiceOver and
 * TalkBack only speak focus moves, so a screen-reader child learns
 * nothing happened after tapping CHECK. These builders produce the
 * announcement text; nativeAnnounce.ts carries it to
 * AccessibilityInfo.announceForAccessibility at the screen call sites.
 *
 * Pure by construction (node-testable, no react-native import): the
 * message text parallels what the feedback bars render,
 * information-for-information. The spoken outcome headline is
 * deliberately literal ("Correct!" / "Almost.") where the visual bars
 * say "Awesome!" / "Yes!" — same information, clearer for speech.
 */

/** A checked answer in either the practice runner or the boss gate. */
export interface CheckedAnswerSummary {
  isCorrect: boolean;
  /** Present on incorrect answers: the revealed correct answer. */
  correctAnswer?: string;
  /** Seconds the child spent before tapping CHECK. */
  cognitiveTimeSec: number;
  /** Gate only: the answer was rejected as a rapid guess. */
  wasRapidGuess?: boolean;
}

function sharedOutcome(checked: CheckedAnswerSummary): string {
  if (checked.isCorrect) return "Correct!";
  if (checked.wasRapidGuess) return "Take a breath. Quick taps need a second look.";
  return "Almost. Let's look again.";
}

/** Spoken counterpart of the practice runner's FeedbackBar. */
export function practiceFeedbackMessage(
  checked: CheckedAnswerSummary,
  targetSpeedSec: number,
): string {
  const parts = [sharedOutcome(checked)];
  if (checked.isCorrect) {
    // Mirrors the visible bar: thinking time always, target clause only
    // when the topic carries a speed target.
    parts.push(
      `Thinking time ${checked.cognitiveTimeSec} seconds${
        targetSpeedSec > 0 ? `, target ${targetSpeedSec}` : ""
      }.`,
    );
  } else if (checked.correctAnswer !== undefined && checked.correctAnswer !== "") {
    parts.push(`The answer is ${checked.correctAnswer}.`);
  }
  return parts.filter((part) => part !== "").join(" ");
}

/** Spoken counterpart of the boss gate's feedback line. */
export function gateFeedbackMessage(checked: CheckedAnswerSummary): string {
  const parts = [sharedOutcome(checked)];
  if (!checked.isCorrect && checked.correctAnswer !== undefined && checked.correctAnswer !== "") {
    parts.push(`The answer is ${checked.correctAnswer}.`);
  }
  return parts.filter((part) => part !== "").join(" ");
}

/**
 * Announced when a new question appears (both runners). One-based:
 * the progress bars already say "Question N of T" — speech matches.
 */
export function questionTransitionMessage(indexZeroBased: number, total: number): string {
  return `Question ${indexZeroBased + 1} of ${total}.`;
}

/** Countdown thresholds that deserve speech (chatty per-second is worse). */
export const TIMER_ANNOUNCE_SECONDS = [30, 10] as const;

/**
 * Gold-check countdown crossover: returns the announcement only when a
 * threshold in TIMER_ANNOUNCE_SECONDS is crossed downward between the
 * previous and current second readings, else null (nothing to say).
 */
export function timerCrossoverMessage(prevSec: number | null, nextSec: number): string | null {
  for (const threshold of TIMER_ANNOUNCE_SECONDS) {
    // Fresh baseline (null): only an exact landing speaks, so arming a
    // 60-second budget stays silent while a mid-threshold arm tells
    // the truth about where the countdown already is.
    const crossed =
      prevSec === null ? nextSec === threshold : prevSec > threshold && nextSec <= threshold;
    if (crossed) return `${threshold} seconds left.`;
  }
  return null;
}
