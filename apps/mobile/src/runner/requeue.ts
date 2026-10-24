/**
 * In-session expanding-retrieval scheduler (issue #50) - PURE module.
 *
 * MIRROR, DO NOT FORK: the lag ladder is the engine's
 * updateTopicMemoryStability intraSessionExpandingLags constant
 * ([2, 5, 10] when fluencyGrade <= 2). The pinned constant below is
 * asserted equal to the engine's in tests/runner-requeue.test.ts, so
 * the scheduler can never drift from packages/core-engine.
 *
 * Semantics (docs/spaced-repetition-science.md Pillar 1):
 * - A response graded 1 (missed) or 2 (slow) on an ORIGINAL item
 *   re-queues that item at Lag +2, +5, and +10 intervening items.
 * - The +10 slot clamps to the tail of the queue when it would land
 *   past the end: the "session exit ticket" - a final unhinted variant
 *   before the summary screen.
 * - A miss on an ALREADY re-queued item does not extend the ladder
 *   (bounded, gentle sessions; the engine emits exactly [2,5,10],
 *   never a growing list).
 * - The queue is capped at MAX_SESSION_ITEMS for the kid-attention
 *   budget; re-queues that would exceed the cap are dropped (the
 *   cross-session spaced-repetition schedule still owns the topic).
 */
export const EXPANDING_LAGS = [2, 5, 10] as const;

/** Ceiling on total presented items (originals + re-queues) per session. */
export const MAX_SESSION_ITEMS = 16;

/** Whether a graded response triggers the expanding ladder. */
export const REQUEUE_FLUENCY_GRADES: readonly number[] = [1, 2];

export type ItemOrigin = "initial" | "requeue";

/** One scheduled presentation of a question. */
export interface ScheduledItem {
  questionId: string;
  origin: ItemOrigin;
  /** Ladder step (1 -> +2, 2 -> +5, 3 -> +10) for re-queued items. */
  lagStep: 1 | 2 | 3 | null;
}

export interface RequeueSchedule {
  items: ScheduledItem[];
}

/** The initial schedule: one item per session question, in order. */
export function initialSchedule(questions: readonly { questionId: string }[]): RequeueSchedule {
  return {
    items: questions.map((question) => ({
      questionId: question.questionId,
      origin: "initial" as const,
      lagStep: null,
    })),
  };
}

export interface GradedResponseInput {
  questionId: string;
  /** Origin of the presentation that was just graded. */
  origin: ItemOrigin;
  /** Engine per-attempt fluency grade (1-4) from submitResponse. */
  fluencyGrade: number;
  /** Index of the graded presentation in the schedule. */
  index: number;
}

/**
 * Applies one graded response to the schedule. When the response
 * triggers the ladder on an original item, three re-queue entries are
 * inserted at +2/+5/+10 intervening items after the current index
 * (final positions index+lag+1: splicing smallest-lag-first at nominal
 * positions keeps the final distances exact since each earlier
 * insertion precedes the later nominal slots). Positions past the
 * current tail clamp to the tail (the +10 "session exit ticket"), and
 * the queue never exceeds MAX_SESSION_ITEMS. Pure: new schedule.
 */
export function applyGradedResponse(
  schedule: RequeueSchedule,
  graded: GradedResponseInput,
): RequeueSchedule {
  if (!REQUEUE_FLUENCY_GRADES.includes(graded.fluencyGrade)) return schedule;
  if (graded.origin !== "initial") return schedule;

  const items = [...schedule.items];
  const ladder: readonly { lag: (typeof EXPANDING_LAGS)[number]; step: 1 | 2 | 3 }[] = [
    { lag: EXPANDING_LAGS[0], step: 1 },
    { lag: EXPANDING_LAGS[1], step: 2 },
    { lag: EXPANDING_LAGS[2], step: 3 },
  ];
  for (const { lag, step } of ladder) {
    if (items.length >= MAX_SESSION_ITEMS) break;
    const rawPosition = graded.index + lag + 1;
    const position = Math.min(rawPosition, items.length);
    items.splice(position, 0, {
      questionId: graded.questionId,
      origin: "requeue",
      lagStep: step,
    });
  }
  return { items };
}

/** Total presentations currently scheduled (progress denominator). */
export function scheduledCount(schedule: RequeueSchedule): number {
  return schedule.items.length;
}

/** The item at an index, or null past the end. */
export function itemAt(schedule: RequeueSchedule, index: number): ScheduledItem | null {
  return schedule.items[index] ?? null;
}

/** How many re-queued presentations the schedule carries (summary stat). */
export function requeuedCount(schedule: RequeueSchedule): number {
  return schedule.items.filter((item) => item.origin === "requeue").length;
}
