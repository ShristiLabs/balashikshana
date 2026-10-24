/**
 * Progress projector unit tests (issue #47): crowns matrix, fluency
 * grading, merge semantics (GREATEST/LEAST, sticky MASTERED, key
 * COALESCE), empty-session behavior, and per-attempt derivation rules
 * (audio 0 on the topic path, audio-aware on the gate path).
 */
import { describe, expect, it } from "vitest";
import {
  deriveAttempt,
  deriveTopicSession,
  mergeTopicProgress,
  mergeUnitProgress,
  type SessionResponse,
} from "../src/practice/progressProjector";
import type { TopicProgressRecord, UnitProgressRecord } from "../src/practice/types";

const NOW = 1_700_000_000_000;
const SR = { gradeGrowthFactor: 1.85, maxIntervalCapDays: 30 };
const TARGET = 6;

function topicSession(responses: SessionResponse[], prev: TopicProgressRecord | null = null) {
  return deriveTopicSession({
    studentId: "s1",
    unitId: "K-M2",
    topicId: "K-M2-G",
    topicCode: "G",
    responses,
    motorBaselineSec: 0.42,
    targetSpeedSec: TARGET,
    srPolicy: SR,
    prev,
    nowMs: NOW,
  });
}

function resp(isCorrect: boolean, rawTimeSec: number): SessionResponse {
  return { topicCode: "G", isCorrect, rawTimeSec };
}

describe("crowns matrix (mirrors the server rule)", () => {
  it("3 crowns at >= 95% accuracy AND median speed at target", () => {
    // 20/20 correct at 2.0 s raw -> cog 1.58, med 1.58 <= 6 -> 100% fast.
    const responses = Array.from({ length: 20 }, () => resp(true, 2.0));
    const d = topicSession(responses);
    expect(d.accuracyPct).toBe(100);
    expect(d.crowns).toBe(3);
  });

  it("2 crowns at >= 85% accuracy (speed not required)", () => {
    const responses = [
      ...Array.from({ length: 17 }, () => resp(true, 5.0)),
      resp(false, 5.0),
      resp(false, 5.0),
      resp(false, 5.0),
    ];
    const d = topicSession(responses);
    expect(d.accuracyPct).toBe(85);
    expect(d.crowns).toBe(2);
  });

  it("1 crown at >= 80% accuracy", () => {
    const responses = [
      ...Array.from({ length: 16 }, () => resp(true, 5.0)),
      ...Array.from({ length: 4 }, () => resp(false, 5.0)),
    ];
    const d = topicSession(responses);
    expect(d.accuracyPct).toBe(80);
    expect(d.crowns).toBe(1);
    expect(d.passedTopic).toBe(true);
  });

  it("0 crowns below 80% accuracy", () => {
    const responses = [
      ...Array.from({ length: 15 }, () => resp(true, 5.0)),
      ...Array.from({ length: 5 }, () => resp(false, 5.0)),
    ];
    const d = topicSession(responses);
    expect(d.accuracyPct).toBe(75);
    expect(d.crowns).toBe(0);
    expect(d.passedTopic).toBe(false);
  });

  it("95% but slow gets 2 crowns, not 3", () => {
    const responses = [...Array.from({ length: 19 }, () => resp(true, 20.0)), resp(false, 20.0)];
    const d = topicSession(responses);
    expect(d.accuracyPct).toBe(95);
    expect(d.medianCogSpeedSec).toBeGreaterThan(TARGET);
    expect(d.crowns).toBe(2);
  });
});

describe("empty and degenerate sessions (server Math.max(1, n) behavior)", () => {
  it("empty session: 0% accuracy, crown 0, fluency 1, stability floored", () => {
    const d = topicSession([]);
    expect(d.accuracyPct).toBe(0);
    expect(d.crowns).toBe(0);
    expect(d.fluencyGrade).toBe(1);
    expect(d.medianCogSpeedSec).toBe(0);
    expect(d.fresh.completed).toBe(0);
  });
});

describe("topic merge semantics", () => {
  it("keeps maxima, min speed, accumulates attempts, takes latest schedule", () => {
    const first = topicSession(Array.from({ length: 10 }, () => resp(true, 4.0)));
    const mergedFirst = mergeTopicProgress(null, first.fresh);
    expect(mergedFirst.attemptsCount).toBe(1);

    const second = topicSession(
      Array.from({ length: 10 }, () => resp(true, 2.0)),
      mergedFirst,
    );
    const merged = mergeTopicProgress(mergedFirst, second.fresh);
    expect(merged.attemptsCount).toBe(2);
    expect(merged.bestAccuracyPct).toBe(100);
    expect(merged.bestMedianSpeedSec).toBeLessThan(
      second.fresh.bestMedianSpeedSec === 0 ? 1 : second.fresh.bestMedianSpeedSec + 1,
    );
    expect(merged.bestMedianSpeedSec).toBe(
      Math.min(mergedFirst.bestMedianSpeedSec, second.fresh.bestMedianSpeedSec),
    );
    expect(merged.stabilityDays).toBe(second.fresh.stabilityDays);
    expect(merged.nextReviewAt).toBe(second.fresh.nextReviewAt);
    expect(merged.provisional).toBe(true);
  });

  it("a previously-zero speed measurement is replaced, not min-clamped", () => {
    const first = topicSession([]); // median 0 -> best speed stored as 0
    expect(first.fresh.bestMedianSpeedSec).toBe(0);
    const second = topicSession(Array.from({ length: 5 }, () => resp(true, 3.0)));
    const merged = mergeTopicProgress(mergeTopicProgress(null, first.fresh), second.fresh);
    expect(merged.bestMedianSpeedSec).toBe(second.fresh.bestMedianSpeedSec);
  });
});

function unitRow(overrides: Partial<UnitProgressRecord>): UnitProgressRecord {
  return {
    studentId: "s1",
    unitId: "K-M2",
    status: "MASTERED",
    keyState: "SILVER_KEY",
    bestAccuracyPct: 90,
    bestMedianSpeedSec: 3,
    attemptsCount: 1,
    stabilityDays: 4,
    lastReviewedAt: NOW,
    cpaStage: "PICTORIAL_STATIC",
    provisional: true,
    silverAwardedAt: NOW - 86_400_000,
    goldVerifiedAt: 0,
    updatedAt: NOW,
    ...overrides,
  };
}

describe("unit merge semantics", () => {
  it("MASTERED is sticky across a later failure", () => {
    const prev = unitRow({});
    const fresh = unitRow({ status: "REMEDIATION_REQUIRED", keyState: null });
    const merged = mergeUnitProgress(prev, fresh);
    expect(merged.status).toBe("MASTERED");
  });

  it("a null key never erases an existing key (COALESCE)", () => {
    const prev = unitRow({ keyState: "SILVER_KEY" });
    const fresh = unitRow({ keyState: null });
    expect(mergeUnitProgress(prev, fresh).keyState).toBe("SILVER_KEY");
  });

  it("best accuracy max, best speed min-once-measured, attempts accumulate", () => {
    const prev = unitRow({ bestAccuracyPct: 92, bestMedianSpeedSec: 3.5, attemptsCount: 2 });
    const fresh = unitRow({ bestAccuracyPct: 88, bestMedianSpeedSec: 3.1, attemptsCount: 1 });
    const merged = mergeUnitProgress(prev, fresh);
    expect(merged.bestAccuracyPct).toBe(92);
    expect(merged.bestMedianSpeedSec).toBe(3.1);
    expect(merged.attemptsCount).toBe(3);
  });

  it("two-key timestamps never move backwards", () => {
    const prev = unitRow({ silverAwardedAt: 1000, goldVerifiedAt: 2000 });
    const fresh = unitRow({ silverAwardedAt: 0, goldVerifiedAt: 0 });
    const merged = mergeUnitProgress(prev, fresh);
    expect(merged.silverAwardedAt).toBe(1000);
    expect(merged.goldVerifiedAt).toBe(2000);
  });
});

describe("per-attempt derivation (audio rules per session type)", () => {
  it("topic attempts compute cognitive time with audio 0 (server parity)", () => {
    const d = deriveAttempt({
      response: { topicCode: "G", isCorrect: true, rawTimeSec: 4.0, audioDurationSec: 2.5 },
      sessionType: "TOPIC_PRACTICE",
      motorBaselineSec: 0.42,
      targetSpeedSec: TARGET,
    });
    // 4.0 - 0.42 - 0 = 3.58 (audio IGNORED on the topic path, like the server)
    expect(d.cognitiveTimeSec).toBe(3.58);
  });

  it("gate attempts compute cognitive time audio-aware (engine parity)", () => {
    const d = deriveAttempt({
      response: { topicCode: "G", isCorrect: true, rawTimeSec: 4.0, audioDurationSec: 2.5 },
      sessionType: "GATE",
      motorBaselineSec: 0.42,
      targetSpeedSec: TARGET,
    });
    // 4.0 - 0.42 - 2.5 = 1.08
    expect(d.cognitiveTimeSec).toBe(1.08);
  });

  it("fluency grade thresholds mirror the engine", () => {
    // cog = raw - 0.42; grades at target 6 s: ratio <= 0.75 -> 4,
    // (0.75, 1.25] -> 3, > 1.25 -> 2, wrong -> 1.
    const fast = deriveAttempt({
      response: { topicCode: "G", isCorrect: true, rawTimeSec: 1.0 },
      sessionType: "TOPIC_PRACTICE",
      motorBaselineSec: 0.42,
      targetSpeedSec: TARGET,
    });
    const mid = deriveAttempt({
      response: { topicCode: "G", isCorrect: true, rawTimeSec: 5.5 },
      sessionType: "TOPIC_PRACTICE",
      motorBaselineSec: 0.42,
      targetSpeedSec: TARGET,
    });
    const slow = deriveAttempt({
      response: { topicCode: "G", isCorrect: true, rawTimeSec: 9.0 },
      sessionType: "TOPIC_PRACTICE",
      motorBaselineSec: 0.42,
      targetSpeedSec: TARGET,
    });
    const wrong = deriveAttempt({
      response: { topicCode: "G", isCorrect: false, rawTimeSec: 1.0 },
      sessionType: "TOPIC_PRACTICE",
      motorBaselineSec: 0.42,
      targetSpeedSec: TARGET,
    });
    expect(fast.fluencyGrade).toBe(4);
    expect(mid.fluencyGrade).toBe(3);
    expect(slow.fluencyGrade).toBe(2);
    expect(wrong.fluencyGrade).toBe(1);
  });
});
