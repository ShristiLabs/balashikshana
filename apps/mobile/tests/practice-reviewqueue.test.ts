/**
 * Review queue tests (issue #47): due selection, retrievability
 * ordering, per-grade interval caps (21/30/45/60 registry policy), and
 * the cap clamp on scheduling.
 */
import { describe, expect, it } from "vitest";
import { buildReviewQueue, capNextReviewAt, policyForGrade } from "../src/practice/reviewQueue";
import type { GradeSrPolicy, TopicProgressRecord } from "../src/practice/types";

const MS_DAY = 86_400_000;
const NOW = 1_700_000_000_000;

const POLICIES: GradeSrPolicy[] = [
  {
    gradeId: "pre-k",
    srGrowthFactor: 1.7,
    srMaxIntervalDays: 21,
    baseScheduleDays: [0.2, 1, 2, 4, 7, 12, 21],
  },
  {
    gradeId: "kindergarten",
    srGrowthFactor: 1.85,
    srMaxIntervalDays: 30,
    baseScheduleDays: [1, 2, 4, 8, 15, 30],
  },
  {
    gradeId: "grade-1",
    srGrowthFactor: 2.0,
    srMaxIntervalDays: 45,
    baseScheduleDays: [1, 3, 6, 12, 24, 45],
  },
  {
    gradeId: "grade-2",
    srGrowthFactor: 2.15,
    srMaxIntervalDays: 60,
    baseScheduleDays: [1, 3, 7, 15, 32, 60],
  },
  {
    gradeId: "grade-3",
    srGrowthFactor: 2.25,
    srMaxIntervalDays: 60,
    baseScheduleDays: [1, 3, 7, 16, 36, 60],
  },
];

function topicRow(overrides: Partial<TopicProgressRecord>): TopicProgressRecord {
  return {
    studentId: "s1",
    topicId: "K-M2-G",
    unitId: "K-M2",
    topicCode: "G",
    completed: 1,
    crowns: 1,
    masteryScore: 85,
    bestAccuracyPct: 85,
    bestMedianSpeedSec: 3,
    attemptsCount: 1,
    fluencyGrade: 3,
    stabilityDays: 4,
    nextReviewAt: NOW - MS_DAY,
    lastReviewedAt: NOW - 5 * MS_DAY,
    provisional: true,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("registry age caps (21/30/45/60)", () => {
  it("maps every grade to its registry maxIntervalCapDays", () => {
    expect(policyForGrade("pre-k", POLICIES)?.srMaxIntervalDays).toBe(21);
    expect(policyForGrade("kindergarten", POLICIES)?.srMaxIntervalDays).toBe(30);
    expect(policyForGrade("grade-1", POLICIES)?.srMaxIntervalDays).toBe(45);
    expect(policyForGrade("grade-2", POLICIES)?.srMaxIntervalDays).toBe(60);
    expect(policyForGrade("grade-3", POLICIES)?.srMaxIntervalDays).toBe(60);
    expect(policyForGrade("grade-4", POLICIES)).toBeNull();
  });

  it("capNextReviewAt clamps an over-cap schedule to the grade cap", () => {
    const policy = POLICIES[0]!; // pre-k, 21 days
    const lastReviewedAt = NOW;
    const overCap = NOW + 60 * MS_DAY;
    expect(capNextReviewAt(overCap, lastReviewedAt, policy)).toBe(NOW + 21 * MS_DAY);
    const withinCap = NOW + 10 * MS_DAY;
    expect(capNextReviewAt(withinCap, lastReviewedAt, policy)).toBe(withinCap);
  });
});

describe("buildReviewQueue", () => {
  it("selects only due topics (next_review_at in the past) with at least one review", () => {
    const queue = buildReviewQueue({
      nowMs: NOW,
      policy: POLICIES[1]!,
      rows: [
        topicRow({ topicId: "due-1" }),
        topicRow({ topicId: "future", nextReviewAt: NOW + MS_DAY }),
        topicRow({ topicId: "never-reviewed", nextReviewAt: 0, lastReviewedAt: 0 }),
      ],
    });
    expect(queue.map((i) => i.topicId)).toEqual(["due-1"]);
  });

  it("orders most-forgotten first (retrievability ascending)", () => {
    const queue = buildReviewQueue({
      nowMs: NOW,
      policy: POLICIES[1]!,
      rows: [
        topicRow({ topicId: "fresh", stabilityDays: 10, lastReviewedAt: NOW - MS_DAY }),
        topicRow({ topicId: "stale", stabilityDays: 1, lastReviewedAt: NOW - 10 * MS_DAY }),
        topicRow({ topicId: "mid", stabilityDays: 4, lastReviewedAt: NOW - 4 * MS_DAY }),
      ],
    });
    expect(queue.map((i) => i.topicId)).toEqual(["stale", "mid", "fresh"]);
    for (let i = 1; i < queue.length; i += 1) {
      expect(queue[i]!.retrievabilityPct).toBeGreaterThanOrEqual(queue[i - 1]!.retrievabilityPct);
    }
  });

  it("deterministic tie-break on topicId", () => {
    const queue = buildReviewQueue({
      nowMs: NOW,
      policy: POLICIES[1]!,
      rows: [
        topicRow({ topicId: "b", stabilityDays: 4, lastReviewedAt: NOW - 4 * MS_DAY }),
        topicRow({ topicId: "a", stabilityDays: 4, lastReviewedAt: NOW - 4 * MS_DAY }),
      ],
    });
    expect(queue.map((i) => i.topicId)).toEqual(["a", "b"]);
  });
});
