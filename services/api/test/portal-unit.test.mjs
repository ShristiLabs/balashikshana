// Portal pure-logic unit tests (issue #61) — the aggregation math and
// enforcement rules WITHOUT a database: ISO-week bucketing (Monday UTC),
// zero-filled weeks, first-mastery anchoring, quadrant classification
// (incl. degenerate inputs), time-limit verdicts (cap boundaries, pure
// backfill, UTC day flips), and content-control verdicts (grade
// ordering, subject vocabulary).

import { test, describe } from "vitest";
import assert from "node:assert/strict";
import {
  isoWeekStartMs,
  buildWeeklySeries,
  classifyQuadrantPoint,
  buildQuadrantPoints,
  TOPIC_PASS_ACCURACY_PCT
} from "../portal-analytics.mjs";
import {
  timeLimitVerdict,
  unitContentVerdict,
  filterPackIndexForChild,
  parentSettingsBlock,
  DEFAULT_CHILD_SETTINGS,
  utcDayKey,
  SUBJECTS,
  GRADE_ORDER
} from "../enforcement.mjs";

// 2026-10-19 is a Monday. Fixed clock keeps every bucket assertion exact.
const MONDAY = Date.UTC(2026, 9, 19, 0, 0, 0);
const TUESDAY = MONDAY + 86400000;
const SUNDAY = MONDAY + 6 * 86400000;
const PREV_SUNDAY = MONDAY - 86400000; // the day BEFORE the ISO week starts

describe("isoWeekStartMs", () => {
  test("Monday maps to itself", () => {
    assert.equal(isoWeekStartMs(MONDAY), MONDAY);
  });
  test("mid-week maps back to Monday", () => {
    assert.equal(isoWeekStartMs(TUESDAY + 3600000), MONDAY);
  });
  test("Sunday belongs to the week that STARTED six days earlier", () => {
    assert.equal(isoWeekStartMs(SUNDAY + 86399999), MONDAY);
  });
  test("the day before Monday belongs to the previous week", () => {
    assert.equal(isoWeekStartMs(PREV_SUNDAY), MONDAY - 604800000);
  });
  test("UTC anchoring: midnight UTC regardless of local tz", () => {
    const d = new Date(MONDAY + 23 * 3600000); // Sunday 23:00 UTC
    assert.equal(isoWeekStartMs(d.getTime()), MONDAY);
  });
  test("ISO year edge: Sunday 2025-12-28 belongs to the 2025-12-22 week", () => {
    assert.equal(isoWeekStartMs(Date.UTC(2025, 11, 28, 12, 0, 0)), Date.UTC(2025, 11, 22));
  });
  test("ISO year edge: Monday 2025-12-29 starts a new week (and ISO year)", () => {
    assert.equal(isoWeekStartMs(Date.UTC(2025, 11, 29, 0, 0, 0)), Date.UTC(2025, 11, 29));
    // Thursday Jan 1 2026 still belongs to the week that began Dec 29 2025.
    assert.equal(isoWeekStartMs(Date.UTC(2026, 0, 1, 23, 0, 0)), Date.UTC(2025, 11, 29));
  });
});

describe("buildWeeklySeries", () => {
  const att = (ms, { correct = true, cog = 30, topic = "K-M2-I-A", session = "s1" } = {}) => ({
    attemptedAtMs: ms,
    cognitiveTimeSec: cog,
    isCorrect: correct,
    topicId: topic,
    sessionId: session
  });

  test("zero-fills weeks with no activity (zeroed, not errors; accuracy null)", () => {
    const series = buildWeeklySeries([att(MONDAY)], { weeks: 4, nowMs: MONDAY + 1000 });
    assert.equal(series.length, 4);
    const empty = series[1];
    assert.equal(empty.attempts, 0);
    assert.equal(empty.correct, 0);
    assert.equal(empty.accuracyPct, null);
    assert.equal(empty.activeMinutes, 0);
    assert.equal(empty.topicsPracticed, 0);
    assert.equal(empty.topicsFirstMastered, 0);
  });

  test("aggregates attempts, accuracy, active minutes, distinct topics per week", () => {
    const rows = [
      att(MONDAY, { correct: true, cog: 30, topic: "t1" }),
      att(MONDAY + 1000, { correct: false, cog: 30, topic: "t2" }),
      att(MONDAY + 2000, { correct: true, cog: 60, topic: "t1" })
    ];
    const series = buildWeeklySeries(rows, { weeks: 1, nowMs: MONDAY + 3000 });
    assert.equal(series.length, 1);
    const w = series[0];
    assert.equal(w.attempts, 3);
    assert.equal(w.correct, 2);
    assert.equal(w.accuracyPct, 66.7);
    assert.equal(w.activeMinutes, 2); // 120s
    assert.equal(w.topicsPracticed, 2);
  });

  test("attempts before the window are excluded from buckets but anchor mastery", () => {
    const old = [att(MONDAY - 604800000, { correct: true, topic: "old-topic", session: "so" })];
    const series = buildWeeklySeries(old, { weeks: 1, nowMs: MONDAY + 1000 });
    assert.equal(series[0].attempts, 0);
    assert.equal(series[0].cumulativeTopicsMastered, 1); // pre-window pass counts
  });

  test("first mastery: a passing session anchors the topic to its first week only", () => {
    const rows = [
      // Week 1: session s1 on t1 with 100% accuracy -> first mastery week 1.
      att(MONDAY, { correct: true, topic: "t1", session: "s1" }),
      // Week 2: session s2 on t1 passes again (no re-count) and t2 fails.
      att(MONDAY + 604800000, { correct: true, topic: "t1", session: "s2" }),
      att(MONDAY + 604800000, { correct: false, topic: "t2", session: "s3" })
    ];
    const series = buildWeeklySeries(rows, { weeks: 2, nowMs: MONDAY + 604800000 + 1000 });
    assert.equal(series[0].topicsFirstMastered, 1);
    assert.equal(series[1].topicsFirstMastered, 0);
    assert.equal(series[1].cumulativeTopicsMastered, 1);
  });

  test("session accuracy is session-scoped: one wrong answer in a passing session still passes at 80%", () => {
    const rows = [
      att(MONDAY, { correct: true, topic: "t1", session: "s1" }),
      att(MONDAY, { correct: true, topic: "t1", session: "s1" }),
      att(MONDAY, { correct: true, topic: "t1", session: "s1" }),
      att(MONDAY, { correct: true, topic: "t1", session: "s1" }),
      att(MONDAY, { correct: false, topic: "t1", session: "s1" }) // 80% exactly
    ];
    const series = buildWeeklySeries(rows, { weeks: 1, nowMs: MONDAY + 5000 });
    assert.equal(series[0].topicsFirstMastered, 1);
  });

  test("degenerate: empty child -> all-zero series, no throw", () => {
    const series = buildWeeklySeries([], { weeks: 8, nowMs: MONDAY });
    assert.equal(series.length, 8);
    assert.ok(series.every((w) => w.attempts === 0 && w.accuracyPct === null));
  });

  test("weeks is clamped to 1..26", () => {
    assert.equal(buildWeeklySeries([], { weeks: 99, nowMs: MONDAY }).length, 26);
    assert.equal(buildWeeklySeries([], { weeks: 0, nowMs: MONDAY }).length, 1);
  });

  test("weekStartIso is a Monday 00:00 UTC", () => {
    const series = buildWeeklySeries([], { weeks: 1, nowMs: TUESDAY });
    assert.equal(new Date(series[0].weekStartIso).getUTCDay(), 1);
    assert.equal(new Date(series[0].weekStartIso).getUTCHours(), 0);
  });
  test("ISO year edge: attempts on Dec 28 (Sun) and Dec 29 (Mon) land in different weeks", () => {
    const series = buildWeeklySeries(
      [
        att(Date.UTC(2025, 11, 28, 1, 0, 0), { topic: "t1", session: "s1" }),
        att(Date.UTC(2025, 11, 29, 1, 0, 0), { topic: "t1", session: "s2" })
      ],
      // Thursday Jan 1 2026 -> window = [week of Dec 22, week of Dec 29].
      { weeks: 2, nowMs: Date.UTC(2026, 0, 1, 12, 0, 0) }
    );
    assert.equal(series[0].weekStartMs, Date.UTC(2025, 11, 22));
    assert.equal(series[0].attempts, 1); // the Sunday
    assert.equal(series[1].weekStartMs, Date.UTC(2025, 11, 29));
    assert.equal(series[1].attempts, 1); // the Monday
  });
});

describe("classifyQuadrantPoint / buildQuadrantPoints", () => {
  test("fluent: accurate and at/under target speed", () => {
    assert.equal(classifyQuadrantPoint({ attempts: 10, correct: 9, medianSpeedSec: 2, targetSpeedSec: 3 }), "fluent");
  });
  test("accurate-slow: accurate but over target", () => {
    assert.equal(classifyQuadrantPoint({ attempts: 10, correct: 10, medianSpeedSec: 5, targetSpeedSec: 3 }), "accurate-slow");
  });
  test("rushing: fast but under the pass line", () => {
    assert.equal(classifyQuadrantPoint({ attempts: 10, correct: 7, medianSpeedSec: 1, targetSpeedSec: 3 }), "rushing");
  });
  test("needs-review: slow and inaccurate", () => {
    assert.equal(classifyQuadrantPoint({ attempts: 10, correct: 5, medianSpeedSec: 9, targetSpeedSec: 3 }), "needs-review");
  });
  test("exactly at the 80% pass line is accurate", () => {
    assert.equal(classifyQuadrantPoint({ attempts: 5, correct: 4, medianSpeedSec: 3, targetSpeedSec: 3 }), "fluent");
  });
  test("null quadrant without a usable target speed (plotted, not classified)", () => {
    assert.equal(classifyQuadrantPoint({ attempts: 5, correct: 5, medianSpeedSec: 2, targetSpeedSec: 0 }), null);
    assert.equal(classifyQuadrantPoint({ attempts: 5, correct: 5, medianSpeedSec: 2, targetSpeedSec: null }), null);
  });
  test("degenerate inputs classify null", () => {
    assert.equal(classifyQuadrantPoint({ attempts: 0, correct: 0, medianSpeedSec: 1, targetSpeedSec: 3 }), null);
    assert.equal(classifyQuadrantPoint({ attempts: 3, correct: 3, medianSpeedSec: NaN, targetSpeedSec: 3 }), null);
  });
  test("buildQuadrantPoints adds accuracyPct and preserves row fields; empty input stays empty", () => {
    const out = buildQuadrantPoints([
      { topicId: "t", topicName: "T", attempts: 4, correct: 3, medianSpeedSec: 2.5, targetSpeedSec: 3 }
    ]);
    assert.equal(out[0].accuracyPct, 75);
    assert.equal(out[0].quadrant, "rushing");
    assert.equal(out[0].topicName, "T");
    assert.deepEqual(buildQuadrantPoints([]), []);
  });
  test("pass line constant is 80", () => {
    assert.equal(TOPIC_PASS_ACCURACY_PCT, 80);
  });
});

describe("timeLimitVerdict", () => {
  const overUsage = { usedMinutesToday: 30, nowMs: MONDAY };

  test("no limit configured -> never limited", () => {
    const v = timeLimitVerdict({ dailyLimitMinutes: null }, overUsage, [{ answeredAtMs: MONDAY }]);
    assert.equal(v.limited, false);
    assert.equal(v.limitMinutes, null);
  });

  test("under the cap -> not limited even for today's batch", () => {
    const v = timeLimitVerdict({ dailyLimitMinutes: 60 }, { usedMinutesToday: 59.9, nowMs: MONDAY }, [
      { answeredAtMs: MONDAY }
    ]);
    assert.equal(v.limited, false);
  });

  test("at the cap EXACTLY + today-dated batch -> limited (boundary is >=)", () => {
    const v = timeLimitVerdict({ dailyLimitMinutes: 30 }, overUsage, [{ answeredAtMs: MONDAY }]);
    assert.equal(v.limited, true);
    assert.equal(v.limitMinutes, 30);
    assert.equal(v.usedMinutes, 30);
    assert.equal(v.resetsAtUtc, "2026-10-20T00:00:00.000Z");
  });

  test("over the cap but pure backfill of an earlier UTC day -> not limited", () => {
    const v = timeLimitVerdict({ dailyLimitMinutes: 30 }, overUsage, [{ answeredAtMs: MONDAY - 86400000 }]);
    assert.equal(v.limited, false);
  });

  test("over the cap, empty batch -> not limited", () => {
    const v = timeLimitVerdict({ dailyLimitMinutes: 30 }, overUsage, []);
    assert.equal(v.limited, false);
  });

  test("mixed batch (backfill + today) over the cap -> limited (fails closed)", () => {
    const v = timeLimitVerdict({ dailyLimitMinutes: 30 }, overUsage, [
      { answeredAtMs: MONDAY - 86400000 },
      { answeredAtMs: MONDAY }
    ]);
    assert.equal(v.limited, true);
  });

  test("utcDayKey slices the ISO date", () => {
    assert.equal(utcDayKey(Date.UTC(2026, 9, 19, 23, 59, 59)), "2026-10-19");
    assert.equal(utcDayKey(Date.UTC(2026, 9, 20, 0, 0, 0)), "2026-10-20");
  });
});

describe("unitContentVerdict / filterPackIndexForChild", () => {
  test("restricted subject -> subject-restricted", () => {
    const v = unitContentVerdict({ restrictedSubjects: ["math"], gradeCeiling: null }, { subject: "math", gradeId: "grade-1" });
    assert.deepEqual(v, { restricted: true, reason: "subject-restricted" });
  });
  test("unit above the ceiling -> grade-ceiling", () => {
    const v = unitContentVerdict({ restrictedSubjects: [], gradeCeiling: "grade-1" }, { subject: "ela", gradeId: "grade-2" });
    assert.deepEqual(v, { restricted: true, reason: "grade-ceiling" });
  });
  test("unknown ceiling string fails CLOSED (registry growth beyond GRADE_ORDER)", () => {
    // Reviewer finding: raw indexOf semantics gave ceilingIdx=-1, so a
    // grade-9 unit under a grade-9 ceiling slipped through (-1 > -1 is
    // false) — the above-ceiling bypass this guard closes.
    const both = unitContentVerdict({ restrictedSubjects: [], gradeCeiling: "grade-9" }, { subject: "ela", gradeId: "grade-9" });
    assert.deepEqual(both, { restricted: true, reason: "grade-ceiling" });
    const knownLow = unitContentVerdict({ restrictedSubjects: [], gradeCeiling: "grade-9" }, { subject: "ela", gradeId: "pre-k" });
    assert.deepEqual(knownLow, { restricted: true, reason: "grade-ceiling" });
  });
  test("unknown unit gradeId is treated as ABOVE the ceiling", () => {
    // unitIdx=-1 must never compare "below" a known ceiling.
    const v = unitContentVerdict({ restrictedSubjects: [], gradeCeiling: "grade-2" }, { subject: "ela", gradeId: "grade-9" });
    assert.deepEqual(v, { restricted: true, reason: "grade-ceiling" });
    // With NO ceiling set, an unknown grade is simply not gated.
    const ungated = unitContentVerdict({ restrictedSubjects: [], gradeCeiling: null }, { subject: "ela", gradeId: "grade-9" });
    assert.deepEqual(ungated, { restricted: false, reason: null });
  });
  test("unit AT the ceiling is allowed (inclusive)", () => {
    const v = unitContentVerdict({ restrictedSubjects: [], gradeCeiling: "grade-1" }, { subject: "ela", gradeId: "grade-1" });
    assert.deepEqual(v, { restricted: false, reason: null });
  });
  test("no controls -> unrestricted", () => {
    const v = unitContentVerdict(DEFAULT_CHILD_SETTINGS, { subject: "math", gradeId: "grade-3" });
    assert.deepEqual(v, { restricted: false, reason: null });
  });
  test("defaults: nothing restricted, no ceiling, reminders off", () => {
    assert.equal(DEFAULT_CHILD_SETTINGS.dailyLimitMinutes, null);
    assert.deepEqual(DEFAULT_CHILD_SETTINGS.restrictedSubjects, []);
    assert.equal(DEFAULT_CHILD_SETTINGS.gradeCeiling, null);
    assert.equal(DEFAULT_CHILD_SETTINGS.remindersEnabled, false);
    assert.equal(DEFAULT_CHILD_SETTINGS.reminderHour, 17); // #57 engine default
  });
  test("grade ordering is registry order", () => {
    assert.deepEqual([...GRADE_ORDER], ["pre-k", "kindergarten", "grade-1", "grade-2", "grade-3"]);
  });
  test("subject vocabulary matches units.subject", () => {
    assert.deepEqual([...SUBJECTS].sort(), ["ela", "math", "science", "socialStudies"]);
  });

  test("pack index filtered to the ceiling; no ceiling keeps everything", () => {
    const packs = GRADE_ORDER.map((gradeId) => ({ gradeId, contentVersion: "1.0.0" }));
    const limited = filterPackIndexForChild(packs, { gradeCeiling: "kindergarten" });
    assert.deepEqual(limited.map((p) => p.gradeId), ["pre-k", "kindergarten"]);
    assert.equal(filterPackIndexForChild(packs, { gradeCeiling: null }).length, packs.length);
  });
});

describe("parentSettingsBlock", () => {
  test("default settings render the off/unlimited posture with live usage", () => {
    const block = parentSettingsBlock(DEFAULT_CHILD_SETTINGS, { usedMinutesToday: 12.5 });
    assert.equal(block.timeLimits.dailyLimitMinutes, null);
    assert.equal(block.timeLimits.usedMinutesToday, 12.5);
    assert.equal(block.timeLimits.exceeded, false);
    assert.deepEqual(block.contentControls.restrictedSubjects, []);
    assert.equal(block.notifications.remindersEnabled, false);
    assert.equal(block.notifications.reminderHour, 17);
  });
  test("exceeded reflects cap vs usage", () => {
    const block = parentSettingsBlock({ ...DEFAULT_CHILD_SETTINGS, dailyLimitMinutes: 10 }, { usedMinutesToday: 10 });
    assert.equal(block.timeLimits.exceeded, true);
  });
});
