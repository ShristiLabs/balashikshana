// Vitest specs for the grade-tiered hearts policy (issue #56, roadmap
// D6): the mount predicate over ALL five registry grades x both game
// stages (the roadmap M4 verification gate: "hearts UI absent in
// Pre-K–G1 builds") plus unknown-grade fail-closed behavior, the
// bounded loss transition (first-answer misses only — re-queues never
// double-penalize), the end-reason taxonomy, the rest-refill progress
// boundaries via explicit epoch-ms inputs (no clock in the module),
// and the shared wire-validation rule the #48 sync ingestion enforces.

import { describe, test, expect } from "vitest";
import {
  HEART_COUNT,
  HEARTS_GRADES,
  HEARTS_END_REASONS,
  HEART_REGROW_MS_PER_HEART,
  shouldMountHearts,
  heartStateAfterResponse,
  heartsSessionEndReason,
  heartsRegrowProgress,
  heartsOutcomeProblem,
} from "../src/hearts.mjs";

// The five registry grade ids (docs/us-curriculum-registry.json), the
// two registry game stages — the full mount matrix the issue's
// acceptance criteria enumerate.
const ALL_GRADES = ["pre-k", "kindergarten", "grade-1", "grade-2", "grade-3"];

describe("shouldMountHearts (D6 tier rule)", () => {
  test("true ONLY for grade-2/grade-3 fluency sprints", () => {
    expect(ALL_GRADES.map((g) => shouldMountHearts(g, "fluency"))).toEqual([
      false,
      false,
      false,
      true,
      true,
    ]);
  });

  test("false for EVERY grade on the guided (untimed) stage", () => {
    for (const grade of ALL_GRADES) {
      expect(shouldMountHearts(grade, "guided")).toBe(false);
    }
  });

  test("fail-closed for unrecognized grade ids", () => {
    for (const unknown of ["", "grade-4", "Grade-2", "PRE-K", "unknown", null, undefined, 7]) {
      expect(shouldMountHearts(unknown, "fluency")).toBe(false);
      expect(shouldMountHearts(unknown, "guided")).toBe(false);
    }
  });

  test("fail-closed for non-fluency stage values", () => {
    expect(shouldMountHearts("grade-2", "guided")).toBe(false);
    expect(shouldMountHearts("grade-2", "")).toBe(false);
    expect(shouldMountHearts("grade-2", undefined)).toBe(false);
    expect(shouldMountHearts("grade-3", "practice")).toBe(false);
  });

  test("constants: bounded count, frozen tier + reason data", () => {
    expect(HEART_COUNT).toBe(5);
    expect(HEARTS_GRADES).toEqual(["grade-2", "grade-3"]);
    expect(Object.isFrozen(HEARTS_GRADES)).toBe(true);
    expect(HEARTS_END_REASONS).toEqual(["completed", "hearts-empty"]);
    expect(Object.isFrozen(HEARTS_END_REASONS)).toBe(true);
    expect(HEART_REGROW_MS_PER_HEART).toBe(30000);
  });
});

describe("heartStateAfterResponse (bounded loss transition)", () => {
  test("a first-answer miss costs exactly one heart", () => {
    expect(heartStateAfterResponse(5, { isCorrect: false, isRequeue: false })).toEqual({
      remaining: 4,
      lost: true,
    });
    expect(heartStateAfterResponse(1, { isCorrect: false, isRequeue: false })).toEqual({
      remaining: 0,
      lost: true,
    });
  });

  test("a correct answer never costs a heart", () => {
    expect(heartStateAfterResponse(5, { isCorrect: true, isRequeue: false })).toEqual({
      remaining: 5,
      lost: false,
    });
    expect(heartStateAfterResponse(2, { isCorrect: true, isRequeue: true })).toEqual({
      remaining: 2,
      lost: false,
    });
  });

  test("a re-queued repeat never costs a second heart (no double penalty)", () => {
    expect(heartStateAfterResponse(4, { isCorrect: false, isRequeue: true })).toEqual({
      remaining: 4,
      lost: false,
    });
    expect(heartStateAfterResponse(1, { isCorrect: false, isRequeue: true })).toEqual({
      remaining: 1,
      lost: false,
    });
  });

  test("floors at zero and never goes negative", () => {
    expect(heartStateAfterResponse(0, { isCorrect: false, isRequeue: false })).toEqual({
      remaining: 0,
      lost: false,
    });
  });

  test("adversarial inputs clamp into range instead of throwing", () => {
    expect(heartStateAfterResponse(99, { isCorrect: false, isRequeue: false })).toEqual({
      remaining: 4,
      lost: true,
    });
    expect(heartStateAfterResponse(-3, { isCorrect: false, isRequeue: false })).toEqual({
      remaining: 4,
      lost: true,
    });
    expect(heartStateAfterResponse(2.9, { isCorrect: false, isRequeue: false })).toEqual({
      remaining: 1,
      lost: true,
    });
    expect(heartStateAfterResponse(Number.NaN, { isCorrect: false, isRequeue: false })).toEqual({
      remaining: 4,
      lost: true,
    });
  });
});

describe("heartsSessionEndReason (terminal taxonomy)", () => {
  test("zero hearts is hearts-empty; anything else completed", () => {
    expect(heartsSessionEndReason(0)).toBe("hearts-empty");
    expect(heartsSessionEndReason(1)).toBe("completed");
    expect(heartsSessionEndReason(5)).toBe("completed");
  });

  test("negative safety-clamps to hearts-empty", () => {
    expect(heartsSessionEndReason(-1)).toBe("hearts-empty");
  });
});

describe("heartsRegrowProgress (rest-refill, presentation only)", () => {
  const endedAt = 1_000_000;

  test("zero elapsed time regrows nothing", () => {
    expect(heartsRegrowProgress({ lostHearts: 5, endedAtMs: endedAt, nowMs: endedAt })).toEqual({
      regrown: 0,
      stillGrowing: true,
    });
  });

  test("negative elapsed (clock skew) clamps to zero progress", () => {
    expect(
      heartsRegrowProgress({ lostHearts: 3, endedAtMs: endedAt, nowMs: endedAt - 60_000 }),
    ).toEqual({ regrown: 0, stillGrowing: true });
  });

  test("exactly one heart's worth of rest regrows exactly one", () => {
    expect(
      heartsRegrowProgress({
        lostHearts: 5,
        endedAtMs: endedAt,
        nowMs: endedAt + HEART_REGROW_MS_PER_HEART,
      }),
    ).toEqual({ regrown: 1, stillGrowing: true });
  });

  test("partial rest is floored, never rounded up", () => {
    expect(
      heartsRegrowProgress({ lostHearts: 5, endedAtMs: endedAt, nowMs: endedAt + 29_999 }),
    ).toEqual({ regrown: 0, stillGrowing: true });
    expect(
      heartsRegrowProgress({ lostHearts: 5, endedAtMs: endedAt, nowMs: endedAt + 74_999 }),
    ).toEqual({ regrown: 2, stillGrowing: true });
  });

  test("full rest regrows all lost hearts and stops growing", () => {
    expect(
      heartsRegrowProgress({
        lostHearts: 5,
        endedAtMs: endedAt,
        nowMs: endedAt + 5 * HEART_REGROW_MS_PER_HEART,
      }),
    ).toEqual({ regrown: 5, stillGrowing: false });
    // Far past full rest: bounded, never more than lost.
    expect(
      heartsRegrowProgress({
        lostHearts: 5,
        endedAtMs: endedAt,
        nowMs: endedAt + 100 * HEART_REGROW_MS_PER_HEART,
      }),
    ).toEqual({ regrown: 5, stillGrowing: false });
  });

  test("zero lost hearts: nothing to grow", () => {
    expect(heartsRegrowProgress({ lostHearts: 0, endedAtMs: endedAt, nowMs: endedAt + 10_000 })).toEqual(
      { regrown: 0, stillGrowing: false },
    );
  });

  test("adversarial inputs clamp instead of throwing", () => {
    expect(heartsRegrowProgress({ lostHearts: 99, endedAtMs: endedAt, nowMs: endedAt })).toEqual({
      regrown: 0,
      stillGrowing: true,
    });
    expect(
      heartsRegrowProgress({ lostHearts: Number.NaN, endedAtMs: endedAt, nowMs: endedAt }),
    ).toEqual({ regrown: 0, stillGrowing: false });
    // A non-positive custom pace falls back to the default constant.
    expect(
      heartsRegrowProgress({ lostHearts: 2, endedAtMs: endedAt, nowMs: endedAt, msPerHeart: 0 }),
    ).toEqual({ regrown: 0, stillGrowing: true });
  });
});

describe("heartsOutcomeProblem (shared wire validation)", () => {
  test("accepts every consistent terminal outcome", () => {
    expect(
      heartsOutcomeProblem({ heartsLost: 0, heartsRemaining: 5, endReason: "completed" }),
    ).toBeNull();
    expect(
      heartsOutcomeProblem({ heartsLost: 2, heartsRemaining: 3, endReason: "completed" }),
    ).toBeNull();
    expect(
      heartsOutcomeProblem({ heartsLost: 5, heartsRemaining: 0, endReason: "hearts-empty" }),
    ).toBeNull();
  });

  test("rejects out-of-range and non-integer counts", () => {
    expect(
      heartsOutcomeProblem({ heartsLost: -1, heartsRemaining: 6, endReason: "completed" }),
    ).toBe("hearts-counts-out-of-range");
    expect(
      heartsOutcomeProblem({ heartsLost: 6, heartsRemaining: -1, endReason: "completed" }),
    ).toBe("hearts-counts-out-of-range");
    expect(
      heartsOutcomeProblem({ heartsLost: 1.5, heartsRemaining: 3.5, endReason: "completed" }),
    ).toBe("hearts-counts-out-of-range");
  });

  test("rejects counts that do not account for every heart", () => {
    expect(
      heartsOutcomeProblem({ heartsLost: 2, heartsRemaining: 2, endReason: "completed" }),
    ).toBe("hearts-counts-do-not-sum");
    expect(
      heartsOutcomeProblem({ heartsLost: 1, heartsRemaining: 5, endReason: "completed" }),
    ).toBe("hearts-counts-do-not-sum");
  });

  test("rejects unknown end reasons", () => {
    expect(
      heartsOutcomeProblem({ heartsLost: 5, heartsRemaining: 0, endReason: "gave-up" }),
    ).toBe("hearts-end-reason-unknown");
    expect(
      heartsOutcomeProblem({ heartsLost: 0, heartsRemaining: 5, endReason: "" }),
    ).toBe("hearts-end-reason-unknown");
  });

  test("rejects end-reason/count contradictions", () => {
    expect(
      heartsOutcomeProblem({ heartsLost: 4, heartsRemaining: 1, endReason: "hearts-empty" }),
    ).toBe("hearts-empty-with-hearts-left");
    expect(
      heartsOutcomeProblem({ heartsLost: 5, heartsRemaining: 0, endReason: "completed" }),
    ).toBe("hearts-completed-with-no-hearts");
  });
});
