/**
 * Spaced-repetition review queue (issue #47).
 *
 * Due-topic selection over the local topic_progress projection using the
 * engine's retrievability curve. Age caps come from the per-grade
 * registry policy the pack carries (sr_max_interval_days:
 * pre-k 21 / kindergarten 30 / grade-1 45 / grade-2+grade-3 60) — the
 * cap itself is applied inside updateTopicMemoryStability by the
 * projector; this module enforces it again when scheduling so a stale
 * row (e.g. migrated from an older cap) can never exceed the cap.
 */
import { computeRetrievabilityPct } from "@balashikshana/core-engine";
import type { GradeSrPolicy, TopicProgressRecord } from "./types";

export interface ReviewQueueItem {
  topicId: string;
  unitId: string;
  stabilityDays: number;
  /** Engine retrievability at `nowMs` — lower = more due. */
  retrievabilityPct: number;
}

export interface ReviewQueueInput {
  nowMs: number;
  policy: GradeSrPolicy;
  rows: TopicProgressRecord[];
}

/**
 * Due topics: next_review_at in the past (or never scheduled with at
 * least one review), ordered by retrievability ascending (most-forgotten
 * first). The queue is pure — callers persist nothing here.
 */
export function buildReviewQueue(input: ReviewQueueInput): ReviewQueueItem[] {
  const MS_PER_DAY = 86_400_000;
  const due = input.rows.filter((row) => row.nextReviewAt <= input.nowMs && row.lastReviewedAt > 0);
  const items: ReviewQueueItem[] = due.map((row) => {
    const elapsedDays = Math.max(0, (input.nowMs - row.lastReviewedAt) / MS_PER_DAY);
    return {
      topicId: row.topicId,
      unitId: row.unitId,
      stabilityDays: row.stabilityDays,
      retrievabilityPct: computeRetrievabilityPct(elapsedDays, row.stabilityDays || 1.0),
    };
  });
  items.sort(
    (a, b) => a.retrievabilityPct - b.retrievabilityPct || a.topicId.localeCompare(b.topicId),
  );
  return items;
}

/**
 * Cap check used after projection: an interval can never exceed the
 * grade's max. Returns the capped next-review timestamp.
 */
export function capNextReviewAt(
  nextReviewAt: number,
  lastReviewedAt: number,
  policy: GradeSrPolicy,
): number {
  const capMs = lastReviewedAt + policy.srMaxIntervalDays * 86_400_000;
  return Math.min(nextReviewAt, capMs);
}

/** Grade policy lookup helper (pack grades table row). */
export function policyForGrade(gradeId: string, policies: GradeSrPolicy[]): GradeSrPolicy | null {
  return policies.find((p) => p.gradeId === gradeId) ?? null;
}
