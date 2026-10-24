/**
 * Expanding-retrieval scheduler tests (issue #50): the Lag +2/+5/+10
 * ladder pinned to the engine constant, boundary cases (positions,
 * tail clamping, cap, requeue-miss non-extension), and determinism.
 */
import { describe, expect, it } from "vitest";
import { updateTopicMemoryStability } from "@balashikshana/core-engine";
import {
  EXPANDING_LAGS,
  MAX_SESSION_ITEMS,
  applyGradedResponse,
  initialSchedule,
  itemAt,
  requeuedCount,
  scheduledCount,
} from "../src/runner/requeue";

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `q${i + 1}`);

describe("engine pin", () => {
  it("the ladder constant equals the engine's intraSessionExpandingLags on miss", () => {
    expect([...EXPANDING_LAGS]).toEqual([2, 5, 10]);
    expect(updateTopicMemoryStability({ fluencyGrade: 1 }).intraSessionExpandingLags).toEqual([
      2, 5, 10,
    ]);
    expect(updateTopicMemoryStability({ fluencyGrade: 2 }).intraSessionExpandingLags).toEqual([
      2, 5, 10,
    ]);
  });

  it("the engine emits no lags for fluent grades (mirror: no requeue)", () => {
    expect(updateTopicMemoryStability({ fluencyGrade: 3 }).intraSessionExpandingLags).toEqual([]);
    expect(updateTopicMemoryStability({ fluencyGrade: 4 }).intraSessionExpandingLags).toEqual([]);
  });
});

describe("ladder scheduling", () => {
  it("an initial 8-question session schedules exactly the originals", () => {
    const schedule = initialSchedule(ids(8).map((questionId) => ({ questionId })));
    expect(scheduledCount(schedule)).toBe(8);
    expect(requeuedCount(schedule)).toBe(0);
    expect(schedule.items.every((item) => item.origin === "initial")).toBe(true);
  });

  it("a missed original (grade 1) re-queues at +2/+5/+10 with exact spacing in a long session", () => {
    // 12 originals + 3 re-queues = 15 <= MAX_SESSION_ITEMS, so no cap
    // or clamp interference: pure ladder positions.
    const schedule = initialSchedule(ids(12).map((questionId) => ({ questionId })));
    const next = applyGradedResponse(schedule, {
      questionId: "q1",
      origin: "initial",
      fluencyGrade: 1,
      index: 0,
    });
    expect(scheduledCount(next)).toBe(15);
    // Final positions 3, 6, 11 -> exactly 2, 5, 10 intervening items.
    expect(next.items[3]).toMatchObject({ questionId: "q1", origin: "requeue", lagStep: 1 });
    expect(next.items[6]).toMatchObject({ questionId: "q1", origin: "requeue", lagStep: 2 });
    expect(next.items[11]).toMatchObject({ questionId: "q1", origin: "requeue", lagStep: 3 });
  });

  it("in an 8-question session the +10 slot clamps to the tail (exit ticket)", () => {
    const schedule = initialSchedule(ids(8).map((questionId) => ({ questionId })));
    const next = applyGradedResponse(schedule, {
      questionId: "q1",
      origin: "initial",
      fluencyGrade: 1,
      index: 0,
    });
    expect(scheduledCount(next)).toBe(11);
    expect(next.items[3]).toMatchObject({ questionId: "q1", origin: "requeue", lagStep: 1 });
    expect(next.items[6]).toMatchObject({ questionId: "q1", origin: "requeue", lagStep: 2 });
    // Only 9 intervening slots exist after the first two insertions, so
    // the +10 re-queue lands as the FINAL item: the session exit
    // ticket right before the summary screen.
    const tail = next.items[next.items.length - 1];
    expect(tail).toMatchObject({ questionId: "q1", origin: "requeue", lagStep: 3 });
  });

  it("a slow-but-correct original (grade 2) triggers the same ladder", () => {
    const schedule = initialSchedule(ids(8).map((questionId) => ({ questionId })));
    const next = applyGradedResponse(schedule, {
      questionId: "q4",
      origin: "initial",
      fluencyGrade: 2,
      index: 3,
    });
    expect(requeuedCount(next)).toBe(3);
    expect(next.items[6]).toMatchObject({ questionId: "q4", lagStep: 1 });
  });

  it("fluent grades (3, 4) schedule nothing extra", () => {
    const schedule = initialSchedule(ids(8).map((questionId) => ({ questionId })));
    for (const fluencyGrade of [3, 4]) {
      const next = applyGradedResponse(schedule, {
        questionId: "q1",
        origin: "initial",
        fluencyGrade,
        index: 0,
      });
      expect(scheduledCount(next)).toBe(8);
    }
  });

  it("a miss on an already re-queued item does NOT extend the ladder", () => {
    const schedule = initialSchedule(ids(8).map((questionId) => ({ questionId })));
    const withLadder = applyGradedResponse(schedule, {
      questionId: "q1",
      origin: "initial",
      fluencyGrade: 1,
      index: 0,
    });
    const afterRequeueMiss = applyGradedResponse(withLadder, {
      questionId: "q1",
      origin: "requeue",
      fluencyGrade: 1,
      index: 3,
    });
    expect(scheduledCount(afterRequeueMiss)).toBe(11);
  });

  it("the +10 slot clamps to the tail when it would land past the end (exit ticket)", () => {
    // Miss on the LAST item of a short session: all three land at tail.
    const schedule = initialSchedule(ids(3).map((questionId) => ({ questionId })));
    const next = applyGradedResponse(schedule, {
      questionId: "q3",
      origin: "initial",
      fluencyGrade: 1,
      index: 2,
    });
    expect(scheduledCount(next)).toBe(6);
    const tail = next.items.slice(3);
    expect(tail.every((item) => item.questionId === "q3" && item.origin === "requeue")).toBe(true);
    expect(tail.map((item) => item.lagStep)).toEqual([1, 2, 3]);
  });

  it("respects the session cap (never exceeds MAX_SESSION_ITEMS)", () => {
    let current = initialSchedule(ids(8).map((questionId) => ({ questionId })));
    // Miss every ORIGINAL at its live schedule position (insertions
    // shift later originals, so positions are looked up, not assumed).
    for (let n = 1; n <= 8; n += 1) {
      const questionId = `q${n}`;
      const position = current.items.findIndex(
        (item) => item.questionId === questionId && item.origin === "initial",
      );
      expect(position).toBeGreaterThanOrEqual(0);
      current = applyGradedResponse(current, {
        questionId,
        origin: "initial",
        fluencyGrade: 1,
        index: position,
      });
      expect(scheduledCount(current)).toBeLessThanOrEqual(MAX_SESSION_ITEMS);
    }
    // 8 originals + cap 16 -> exactly at the ceiling.
    expect(scheduledCount(current)).toBe(MAX_SESSION_ITEMS);
  });

  it("purity: the input schedule is never mutated", () => {
    const schedule = initialSchedule(ids(8).map((questionId) => ({ questionId })));
    const before = JSON.stringify(schedule);
    applyGradedResponse(schedule, {
      questionId: "q1",
      origin: "initial",
      fluencyGrade: 1,
      index: 0,
    });
    expect(JSON.stringify(schedule)).toBe(before);
  });

  it("itemAt reads bounds safely", () => {
    const schedule = initialSchedule(ids(2).map((questionId) => ({ questionId })));
    expect(itemAt(schedule, 0)?.questionId).toBe("q1");
    expect(itemAt(schedule, 5)).toBeNull();
  });
});
