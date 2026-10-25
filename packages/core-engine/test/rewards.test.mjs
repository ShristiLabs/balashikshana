// Vitest specs for the gamification reward rules (issue #55, roadmap D9):
// XP accrual (per-attempt fluency weighting + session outcome bonuses),
// the level curve's threshold boundaries, coin derivation (the exact
// pre-#55 server formulas), streak-day accrual incl. day-boundary and
// timezone edges, the beat-the-target share, and the badge catalog's
// award rules (positive + negative for every badge).

import { describe, test, expect } from "vitest";
import {
  XP_PER_CORRECT_ATTEMPT_BY_GRADE,
  TOPIC_PASS_XP_BASE,
  XP_PER_CROWN,
  GATE_PASS_XP,
  GOLD_UPGRADE_XP,
  GATE_PASS_COINS,
  MAX_LEVEL,
  xpForAttempt,
  awardXpForAttempts,
  awardXpForSessionOutcome,
  deriveSessionRewards,
  coinsForTopicPass,
  xpThresholdForLevel,
  levelForXp,
  dayKeyForMs,
  dayKeysApart,
  nextStreakState,
  beatTargetSharePct,
  BADGE_CATALOG,
  badgeById,
  evaluateBadges
} from "../src/index.mjs";

// --- Per-attempt XP ---------------------------------------------------------

describe("xpForAttempt (fluency-weighted, incorrect always 0)", () => {
  test("correct answers earn by grade: 1->0, 2->1, 3->2, 4->3", () => {
    expect(xpForAttempt({ isCorrect: true, fluencyGrade: 2 })).toBe(1);
    expect(xpForAttempt({ isCorrect: true, fluencyGrade: 3 })).toBe(2);
    expect(xpForAttempt({ isCorrect: true, fluencyGrade: 4 })).toBe(3);
    // Grade 1 is the engine's incorrect grade; a "correct" row can never
    // carry it in practice, but the rule stays deterministic: 0.
    expect(xpForAttempt({ isCorrect: true, fluencyGrade: 1 })).toBe(0);
  });

  test("incorrect answers earn 0 at every grade", () => {
    for (const fluencyGrade of [1, 2, 3, 4]) {
      expect(xpForAttempt({ isCorrect: false, fluencyGrade })).toBe(0);
    }
  });

  test("unknown or malformed grades safely earn 0", () => {
    expect(xpForAttempt({ isCorrect: true, fluencyGrade: 0 })).toBe(0);
    expect(xpForAttempt({ isCorrect: true, fluencyGrade: 99 })).toBe(0);
    expect(xpForAttempt({ isCorrect: true, fluencyGrade: Number.NaN })).toBe(0);
    expect(xpForAttempt({ isCorrect: true })).toBe(0);
    expect(xpForAttempt({})).toBe(0);
  });

  test("the frozen table matches the documented weights", () => {
    expect(XP_PER_CORRECT_ATTEMPT_BY_GRADE).toEqual({ 1: 0, 2: 1, 3: 2, 4: 3 });
  });
});

describe("awardXpForAttempts", () => {
  test("sums across a mixed session", () => {
    const attempts = [
      { isCorrect: true, fluencyGrade: 4 },
      { isCorrect: true, fluencyGrade: 3 },
      { isCorrect: false, fluencyGrade: 1 },
      { isCorrect: true, fluencyGrade: 2 }
    ];
    // 3 + 2 + 0 + 1
    expect(awardXpForAttempts(attempts)).toBe(6);
  });

  test("empty and missing lists are 0", () => {
    expect(awardXpForAttempts([])).toBe(0);
    expect(awardXpForAttempts()).toBe(0);
  });
});

// --- Session outcome XP -----------------------------------------------------

describe("awardXpForSessionOutcome", () => {
  test("topic/game pass: 10 base + 5 per crown (crowns 0..3 -> 10/15/20/25)", () => {
    for (const crowns of [0, 1, 2, 3]) {
      expect(awardXpForSessionOutcome({ sessionType: "TOPIC_PRACTICE", passed: true, crowns })).toBe(
        TOPIC_PASS_XP_BASE + crowns * XP_PER_CROWN
      );
      expect(awardXpForSessionOutcome({ sessionType: "GAME", passed: true, crowns })).toBe(
        TOPIC_PASS_XP_BASE + crowns * XP_PER_CROWN
      );
    }
    expect(awardXpForSessionOutcome({ sessionType: "TOPIC_PRACTICE", passed: true, crowns: 0 })).toBe(10);
    expect(awardXpForSessionOutcome({ sessionType: "TOPIC_PRACTICE", passed: true, crowns: 3 })).toBe(25);
  });

  test("failed sessions never earn a bonus", () => {
    expect(awardXpForSessionOutcome({ sessionType: "TOPIC_PRACTICE", passed: false, crowns: 3 })).toBe(0);
    expect(awardXpForSessionOutcome({ sessionType: "GATE", passed: false })).toBe(0);
    expect(awardXpForSessionOutcome({ sessionType: "GAME", passed: false, crowns: 2 })).toBe(0);
  });

  test("gate pass earns the flat gate bonus; gold upgrade earns only via goldUpgraded", () => {
    expect(awardXpForSessionOutcome({ sessionType: "GATE", passed: true })).toBe(GATE_PASS_XP);
    expect(GATE_PASS_XP).toBe(25);
    expect(awardXpForSessionOutcome({ sessionType: "GOLD_VERIFICATION", goldUpgraded: true })).toBe(GOLD_UPGRADE_XP);
    expect(awardXpForSessionOutcome({ sessionType: "GOLD_VERIFICATION", goldUpgraded: false })).toBe(0);
    expect(awardXpForSessionOutcome({ sessionType: "GOLD_VERIFICATION" })).toBe(0);
    expect(GOLD_UPGRADE_XP).toBe(20);
  });

  test("unknown session types earn 0 even when passed", () => {
    expect(awardXpForSessionOutcome({ sessionType: "MYSTERY", passed: true, crowns: 3 })).toBe(0);
    expect(awardXpForSessionOutcome({})).toBe(0);
  });
});

describe("deriveSessionRewards (composed amounts)", () => {
  test("topic pass with mixed attempts composes XP and coins", () => {
    const rewards = deriveSessionRewards({
      sessionType: "TOPIC_PRACTICE",
      attempts: [
        { isCorrect: true, fluencyGrade: 4 },
        { isCorrect: true, fluencyGrade: 3 },
        { isCorrect: false, fluencyGrade: 1 }
      ],
      passed: true,
      crowns: 2
    });
    expect(rewards).toEqual({ attemptXp: 5, sessionBonusXp: 20, totalXp: 25, coins: 25 });
  });

  test("failed topic session: attempt XP only, no coins", () => {
    const rewards = deriveSessionRewards({
      sessionType: "TOPIC_PRACTICE",
      attempts: [{ isCorrect: true, fluencyGrade: 3 }],
      passed: false,
      crowns: 0
    });
    expect(rewards).toEqual({ attemptXp: 2, sessionBonusXp: 0, totalXp: 2, coins: 0 });
  });

  test("gate pass: flat bonus + flat coins", () => {
    const rewards = deriveSessionRewards({
      sessionType: "GATE",
      attempts: [{ isCorrect: true, fluencyGrade: 4 }],
      passed: true
    });
    expect(rewards).toEqual({ attemptXp: 3, sessionBonusXp: 25, totalXp: 28, coins: GATE_PASS_COINS });
  });
});

// --- Coins ------------------------------------------------------------------

describe("coinsForTopicPass (the historical server formula, now shared)", () => {
  test("15 + crowns * 5 for crowns 0..3", () => {
    expect(coinsForTopicPass(0)).toBe(15);
    expect(coinsForTopicPass(1)).toBe(20);
    expect(coinsForTopicPass(2)).toBe(25);
    expect(coinsForTopicPass(3)).toBe(30);
  });

  test("missing crowns default to the 1-crown-free floor", () => {
    expect(coinsForTopicPass()).toBe(15);
  });

  test("gate coins stay the historical 50", () => {
    expect(GATE_PASS_COINS).toBe(50);
  });
});

// --- Level curve ------------------------------------------------------------

describe("xpThresholdForLevel (25 * level * (level-1))", () => {
  test("the first rungs: 0, 50, 150, 300, 500", () => {
    expect(xpThresholdForLevel(1)).toBe(0);
    expect(xpThresholdForLevel(2)).toBe(50);
    expect(xpThresholdForLevel(3)).toBe(150);
    expect(xpThresholdForLevel(4)).toBe(300);
    expect(xpThresholdForLevel(5)).toBe(500);
  });

  test("out-of-range levels clamp into [1, MAX_LEVEL]", () => {
    expect(xpThresholdForLevel(0)).toBe(0);
    expect(xpThresholdForLevel(-3)).toBe(0);
    expect(xpThresholdForLevel(7.9)).toBe(xpThresholdForLevel(7));
    expect(xpThresholdForLevel(999)).toBe(xpThresholdForLevel(MAX_LEVEL));
  });
});

describe("levelForXp", () => {
  test("0 XP (and clamped negatives/non-finite) is level 1", () => {
    for (const xp of [0, -5, Number.NaN, Number.POSITIVE_INFINITY * 0, undefined]) {
      expect(levelForXp(xp).level).toBe(1);
    }
  });

  test("exact threshold boundaries land ON the level (>=, not >)", () => {
    expect(levelForXp(49).level).toBe(1);
    expect(levelForXp(50).level).toBe(2);
    expect(levelForXp(149).level).toBe(2);
    expect(levelForXp(150).level).toBe(3);
    expect(levelForXp(299).level).toBe(3);
    expect(levelForXp(300).level).toBe(4);
  });

  test("progress shape inside a level", () => {
    const l = levelForXp(175); // level 3 (floor 150, next 300)
    expect(l).toMatchObject({
      level: 3,
      maxed: false,
      levelFloorXp: 150,
      nextLevelXp: 300,
      xpIntoLevel: 25,
      xpToNextLevel: 125,
      maxLevel: MAX_LEVEL
    });
  });

  test("fractional XP floors to integer progress", () => {
    const l = levelForXp(50.9);
    expect(l.level).toBe(2);
    expect(l.xpIntoLevel).toBe(0);
    expect(l.xpToNextLevel).toBe(100);
  });

  test("the ladder caps at MAX_LEVEL with null next fields", () => {
    const capXp = xpThresholdForLevel(MAX_LEVEL);
    const l = levelForXp(capXp);
    expect(l.maxed).toBe(true);
    expect(l.level).toBe(MAX_LEVEL);
    expect(l.nextLevelXp).toBeNull();
    expect(l.xpToNextLevel).toBeNull();
    expect(l.xpIntoLevel).toBe(0);
    // Far beyond the cap: still maxed, into-level keeps growing.
    const far = levelForXp(capXp + 100000);
    expect(far.level).toBe(MAX_LEVEL);
    expect(far.maxed).toBe(true);
    expect(far.xpIntoLevel).toBe(100000);
  });

  test("one below the cap is not maxed", () => {
    const below = xpThresholdForLevel(MAX_LEVEL) - 1;
    expect(levelForXp(below).maxed).toBe(false);
    expect(levelForXp(below).level).toBe(MAX_LEVEL - 1);
  });
});

// --- Streak days ------------------------------------------------------------

describe("dayKeyForMs", () => {
  test("UTC day keys at the day boundary", () => {
    expect(dayKeyForMs(Date.parse("2026-10-23T23:59:59.999Z"))).toBe("2026-10-23");
    expect(dayKeyForMs(Date.parse("2026-10-24T00:00:00.000Z"))).toBe("2026-10-24");
  });

  test("a UTC offset shifts the local day (a 23:00 UTC play is same-day at -60)", () => {
    const ms = Date.parse("2026-10-23T23:00:00Z");
    expect(dayKeyForMs(ms, 0)).toBe("2026-10-23");
    expect(dayKeyForMs(ms, -60)).toBe("2026-10-23"); // 22:00 local
    expect(dayKeyForMs(ms, 90)).toBe("2026-10-24"); // 00:30 next local day
  });

  test("invalid input yields the empty key", () => {
    expect(dayKeyForMs(Number.NaN)).toBe("");
    expect(dayKeyForMs(undefined)).toBe("");
  });
});

describe("dayKeysApart", () => {
  test("consecutive, same, gap, and reversed days", () => {
    expect(dayKeysApart("2026-10-23", "2026-10-24")).toBe(1);
    expect(dayKeysApart("2026-10-23", "2026-10-23")).toBe(0);
    expect(dayKeysApart("2026-10-23", "2026-10-25")).toBe(2);
    expect(dayKeysApart("2026-10-24", "2026-10-23")).toBe(-1);
    // Month and year boundaries
    expect(dayKeysApart("2026-10-31", "2026-11-01")).toBe(1);
    expect(dayKeysApart("2026-12-31", "2027-01-01")).toBe(1);
  });

  test("malformed keys are NaN", () => {
    expect(dayKeysApart("not-a-day", "2026-10-23")).toBeNaN();
    expect(dayKeysApart("", "2026-10-23")).toBeNaN();
  });
});

describe("nextStreakState", () => {
  test("a first-ever session starts the streak at 1", () => {
    expect(nextStreakState({ currentStreakDays: 0, lastActiveDayKey: "", sessionDayKey: "2026-10-23" })).toEqual({
      streakDays: 1,
      lastActiveDayKey: "2026-10-23",
      changed: true
    });
  });

  test("same-day sessions are idempotent (never grow, never reset)", () => {
    const r = nextStreakState({ currentStreakDays: 4, lastActiveDayKey: "2026-10-23", sessionDayKey: "2026-10-23" });
    expect(r).toEqual({ streakDays: 4, lastActiveDayKey: "2026-10-23", changed: false });
  });

  test("a consecutive day extends the streak", () => {
    const r = nextStreakState({ currentStreakDays: 4, lastActiveDayKey: "2026-10-23", sessionDayKey: "2026-10-24" });
    expect(r).toEqual({ streakDays: 5, lastActiveDayKey: "2026-10-24", changed: true });
  });

  test("a one-day gap resets to 1", () => {
    const r = nextStreakState({ currentStreakDays: 6, lastActiveDayKey: "2026-10-23", sessionDayKey: "2026-10-25" });
    expect(r).toEqual({ streakDays: 1, lastActiveDayKey: "2026-10-25", changed: true });
  });

  test("an out-of-order (earlier) session day is a no-op — streaks never move backwards", () => {
    const r = nextStreakState({ currentStreakDays: 6, lastActiveDayKey: "2026-10-24", sessionDayKey: "2026-10-23" });
    expect(r).toEqual({ streakDays: 6, lastActiveDayKey: "2026-10-24", changed: false });
  });

  test("an empty session day key is a no-op (callers skip persisting)", () => {
    const r = nextStreakState({ currentStreakDays: 3, lastActiveDayKey: "2026-10-23", sessionDayKey: "" });
    expect(r).toEqual({ streakDays: 3, lastActiveDayKey: "2026-10-23", changed: false });
  });

  test("midnight boundary: 23:59:59 then 00:00:00 is exactly one consecutive day", () => {
    const late = dayKeyForMs(Date.parse("2026-10-23T23:59:59.999Z"));
    const next = dayKeyForMs(Date.parse("2026-10-24T00:00:00.000Z"));
    const r = nextStreakState({ currentStreakDays: 2, lastActiveDayKey: late, sessionDayKey: next });
    expect(r.streakDays).toBe(3);
    expect(r.changed).toBe(true);
  });
});

// --- Beat-the-target share --------------------------------------------------

describe("beatTargetSharePct", () => {
  test("counts at-or-below as beat, one decimal", () => {
    expect(beatTargetSharePct([2, 3, 4, 5], 4)).toBe(75);
    expect(beatTargetSharePct([1, 2], 2)).toBe(100);
    expect(beatTargetSharePct([5, 6], 4)).toBe(0);
    expect(beatTargetSharePct([2, 2, 3, 3, 3, 3, 3, 3, 3, 3], 3)).toBe(100);
  });

  test("exactly-at-target beats (<=), matching the session model's rule", () => {
    expect(beatTargetSharePct([4], 4)).toBe(100);
  });

  test("non-positive or non-finite targets yield 0 (untimed guided stage)", () => {
    expect(beatTargetSharePct([1, 2], 0)).toBe(0);
    expect(beatTargetSharePct([1, 2], -3)).toBe(0);
    expect(beatTargetSharePct([1, 2], Number.NaN)).toBe(0);
    expect(beatTargetSharePct([1, 2], Number.POSITIVE_INFINITY)).toBe(0);
  });

  test("empty list yields 0; non-finite times never beat", () => {
    expect(beatTargetSharePct([], 4)).toBe(0);
    expect(beatTargetSharePct([Number.NaN, 2, 3], 3)).toBe(66.7);
  });
});

// --- Badge catalog + evaluation ---------------------------------------------

describe("BADGE_CATALOG (engine data)", () => {
  test("ids are unique and fields complete", () => {
    const ids = new Set(BADGE_CATALOG.map((b) => b.id));
    expect(ids.size).toBe(BADGE_CATALOG.length);
    for (const b of BADGE_CATALOG) {
      expect(typeof b.id).toBe("string");
      expect(typeof b.title).toBe("string");
      expect(typeof b.description).toBe("string");
      expect(["bronze", "silver", "gold"]).toContain(b.tier);
      expect(typeof b.metric).toBe("string");
      expect(typeof b.gte).toBe("number");
    }
  });

  test("the catalog is frozen (data, not code)", () => {
    expect(Object.isFrozen(BADGE_CATALOG)).toBe(true);
    for (const b of BADGE_CATALOG) expect(Object.isFrozen(b)).toBe(true);
  });

  test("badgeById resolves and rejects", () => {
    expect(badgeById("first-steps").title).toBe("First Steps");
    expect(badgeById("nope")).toBeUndefined();
  });
});

describe("evaluateBadges (every rule, positive + negative)", () => {
  // The zero context earns nothing.
  test("an all-zero context earns no badges", () => {
    expect(evaluateBadges({})).toEqual([]);
    expect(
      evaluateBadges({
        sessionsCompleted: 0,
        topicsCompleted: 0,
        threeCrownTopics: 0,
        perfectTopics: 0,
        silverKeys: 0,
        goldKeys: 0,
        bestBeatTargetPct: 0,
        starCoins: 0,
        streakDays: 0
      })
    ).toEqual([]);
  });

  // Threshold-1 / threshold matrix for every catalog badge.
  test("each badge flips exactly at its own threshold", () => {
    const below = {
      sessionsCompleted: 0,
      topicsCompleted: 0,
      threeCrownTopics: 0,
      perfectTopics: 0,
      silverKeys: 0,
      goldKeys: 0,
      bestBeatTargetPct: 0,
      starCoins: 0,
      streakDays: 0
    };
    for (const badge of BADGE_CATALOG) {
      const under = { ...below, [badge.metric]: badge.gte - 0.1 };
      const at = { ...below, [badge.metric]: badge.gte };
      expect(evaluateBadges(under)).not.toContain(badge.id);
      expect(evaluateBadges(at)).toContain(badge.id);
    }
  });

  test("a rich context earns the matching set, in catalog order, no duplicates", () => {
    const earned = evaluateBadges({
      sessionsCompleted: 30,
      topicsCompleted: 6,
      threeCrownTopics: 1,
      perfectTopics: 1,
      silverKeys: 1,
      goldKeys: 0,
      bestBeatTargetPct: 80,
      starCoins: 210,
      streakDays: 3
    });
    expect(earned).toEqual([
      "first-steps",
      "practice-fan",
      "topic-explorer",
      "crown-earner",
      "perfect-aim",
      "gate-conqueror",
      "lightning-learner",
      "coin-collector",
      "streak-spark"
    ]);
  });

  test("the speed badge boundary: 79.9 does not earn, 80 does", () => {
    expect(evaluateBadges({ bestBeatTargetPct: 79.9 })).not.toContain("lightning-learner");
    expect(evaluateBadges({ bestBeatTargetPct: 80 })).toContain("lightning-learner");
  });

  test("missing and non-finite metrics count as 0 (never NaN comparisons)", () => {
    expect(evaluateBadges({ sessionsCompleted: Number.NaN })).toEqual([]);
    expect(evaluateBadges({ starCoins: Number.POSITIVE_INFINITY })).toEqual([]);
    expect(evaluateBadges(undefined)).toEqual([]);
  });

  test("streak badges are scope-independent of session count (metric isolation)", () => {
    // A 7-day streak with zero sessions elsewhere still earns exactly the
    // two streak badges — no metric leaks into another rule.
    expect(evaluateBadges({ streakDays: 7 })).toEqual(["streak-spark", "streak-star"]);
  });
});
