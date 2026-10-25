/**
 * Gamification projector + session wiring (issue #55, roadmap D9):
 *
 * - PURE projector transitions: XP/coin accrual per session type, the
 *   transition gating, streak day-keys (idempotent per day, consecutive,
 *   reset), best-share monotonicity, badge aggregation incl. the
 *   earned-key rule (placement-seed keys never count), forward-only
 *   badge merging, server-ledger adoption, and the level summary.
 * - FULL ENGINE WIRING on REAL SQLite (practiceEnv): a topic session, a
 *   game session (per-topic groups + beat-target input), a gate session,
 *   and a gold verification all project the optimistic ledger with the
 *   SAME engine amounts the server's ledger materialization computes —
 *   the mobile side of the D9 agreement (the API suite proves the
 *   server side over the same K-M2 fixtures).
 * - Storage round-trip through the schema-v5 gamification_state row.
 * - NO-FORK source pins: the server's reward writers and the mobile
 *   projector import the ENGINE's functions (never inline formulas), and
 *   the session engine consumes the projector (never its own math).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  awardXpForSessionOutcome,
  coinsForTopicPass,
  levelForXp,
  xpForAttempt,
  GATE_PASS_COINS,
  computeCognitiveTimeSec,
  computeFluencyGrade,
  dayKeyForMs,
  nextStreakState,
} from "@balashikshana/core-engine";
import { PracticeSessionEngine } from "../src/practice/practiceEngine";
import {
  applyGateSession,
  applyGoldUpgrade,
  applyTopicLikeSession,
  adoptServerLedger,
  badgeAggregates,
  evaluateAndMergeBadges,
  gamificationSummary,
  initialGamificationState,
} from "../src/gamification/rewardsProjector";
// eslint-disable-next-line import/no-unresolved
import { DatabaseSync } from "node:sqlite";
import { createPracticeEnv, FIXTURE_UNIT, type PracticeTestEnv } from "./helpers/practiceEnv";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const STUDENT = "s1";
const GRADE = "kindergarten";
const UNIT = FIXTURE_UNIT.unitId; // K-M2 — the same unit the API suite drives
const MOTOR = 0.42;

let env: PracticeTestEnv;

beforeEach(() => {
  env = createPracticeEnv({ prerequisiteUnit: true });
});

/** Test-only pack editor (the games-session-integration precedent):
 *  writes a topic's assets.games block before any reader opens it. */
function setTopicGames(topicCode: string, games: unknown): void {
  const db = new DatabaseSync(`${env.dir}/pack-kindergarten-v1.0.0.sqlite`);
  try {
    db.prepare("UPDATE skill_topics SET assets_json = ? WHERE topic_id = ?").run(
      JSON.stringify({ games }),
      `${UNIT}-${topicCode}`,
    );
  } finally {
    db.close();
  }
}

/** Registry-shaped games block with a fluency speed target. */
function gamesBlockWithTarget(targetResponseSpeedSec: number): Record<string, unknown> {
  return {
    guidedPracticeGame: {
      gameId: "game_guided_test",
      archetype: "block-builder",
      title: "Guided Explorer",
      mechanics: "Untimed explorer with hints.",
      targetMasteryScore: 80,
      minQuestionsToComplete: 8,
    },
    fluencySprintGame: {
      gameId: "game_fluency_test",
      archetype: "block-builder",
      title: "Fluency Sprint",
      mechanics: "Beat the clock.",
      targetResponseSpeedSec,
      spiralMix: { currentTopic: 0.7, contrastivePrerequisite: 0.2, spacedReview: 0.1 },
    },
  };
}

afterEach(() => {
  env.dispose();
});

// The per-attempt grades for the canonical fast-correct fixture
// (rawTimeSec 2, motor 0.42, unit target speed): cognitive 1.58 ->
// grade 4 -> 3 XP. Computed from the engine, never hand-copied.
function attemptInputs(
  count: number,
  rawTimeSec = 2,
): { isCorrect: boolean; fluencyGrade: number; rawTimeSec: number }[] {
  const target = 4.5; // K-M2 gate_max_speed_sec (fixture + registry)
  return Array.from({ length: count }, () => {
    const cSec = computeCognitiveTimeSec(rawTimeSec, MOTOR, 0);
    return { isCorrect: true, fluencyGrade: computeFluencyGrade(true, cSec, target), rawTimeSec };
  });
}

describe("projector transitions (pure)", () => {
  it("a passing 3-crown topic session earns attempt XP + 25 bonus + 30 coins", () => {
    const state = initialGamificationState(STUDENT, 0);
    const t = applyTopicLikeSession(state, {
      sessionType: "TOPIC_PRACTICE",
      attempts: attemptInputs(8),
      passed: true,
      crowns: 3,
      sessionMs: 0,
      nowMs: 1,
    });
    expect(t.xp).toBe(
      8 * 3 + awardXpForSessionOutcome({ sessionType: "TOPIC_PRACTICE", passed: true, crowns: 3 }),
    );
    expect(t.xp).toBe(49);
    expect(t.coins).toBe(coinsForTopicPass(3));
    expect(t.coins).toBe(30);
    expect(state.totalXp).toBe(49);
    expect(state.starCoins).toBe(50 + 30);
    expect(state.sessionsCompleted).toBe(1);
    expect(state.provisional).toBe(true);
  });

  it("a failed topic session earns attempt XP only", () => {
    const state = initialGamificationState(STUDENT, 0);
    const attempts = attemptInputs(8).map((a, i) => ({ ...a, isCorrect: i < 5 }));
    const t = applyTopicLikeSession(state, {
      sessionType: "TOPIC_PRACTICE",
      attempts,
      passed: false,
      crowns: 0,
      sessionMs: 0,
      nowMs: 1,
    });
    expect(t.xp).toBe(5 * 3);
    expect(t.coins).toBe(0);
    expect(state.totalXp).toBe(15);
  });

  it("a gate session earns the flat pass bonus + 50 coins only on pass", () => {
    const failed = initialGamificationState(STUDENT, 0);
    const tFail = applyGateSession(failed, {
      attempts: attemptInputs(12),
      passed: false,
      sessionMs: 0,
      nowMs: 1,
    });
    expect(tFail.xp).toBe(36);
    expect(tFail.coins).toBe(0);

    const passed = initialGamificationState(STUDENT, 0);
    const tPass = applyGateSession(passed, {
      attempts: attemptInputs(12),
      passed: true,
      sessionMs: 0,
      nowMs: 1,
    });
    expect(tPass.xp).toBe(36 + 25);
    expect(tPass.coins).toBe(GATE_PASS_COINS);
  });

  it("a gold upgrade earns exactly the engine's upgrade XP (no coins)", () => {
    const state = initialGamificationState(STUDENT, 0);
    const t = applyGoldUpgrade(state, { sessionMs: 0, nowMs: 1 });
    expect(t.xp).toBe(20);
    expect(t.coins).toBe(0);
  });

  it("streak: first session 1, same-day idempotent, consecutive +1, gap resets", () => {
    const state = initialGamificationState(STUDENT, Date.UTC(2026, 9, 14, 10));
    applyTopicLikeSession(state, {
      sessionType: "TOPIC_PRACTICE",
      attempts: [],
      passed: false,
      crowns: 0,
      sessionMs: Date.UTC(2026, 9, 14, 11),
      nowMs: 1,
    });
    expect(state.streakDays).toBe(1);
    applyTopicLikeSession(state, {
      sessionType: "TOPIC_PRACTICE",
      attempts: [],
      passed: false,
      crowns: 0,
      sessionMs: Date.UTC(2026, 9, 14, 20),
      nowMs: 2,
    });
    expect(state.streakDays).toBe(1);
    applyTopicLikeSession(state, {
      sessionType: "TOPIC_PRACTICE",
      attempts: [],
      passed: false,
      crowns: 0,
      sessionMs: Date.UTC(2026, 9, 15, 9),
      nowMs: 3,
    });
    expect(state.streakDays).toBe(2);
    applyTopicLikeSession(state, {
      sessionType: "TOPIC_PRACTICE",
      attempts: [],
      passed: false,
      crowns: 0,
      sessionMs: Date.UTC(2026, 9, 18, 9),
      nowMs: 4,
    });
    expect(state.streakDays).toBe(1);
  });

  it("beat-target share is monotone (never decreases)", () => {
    const state = initialGamificationState(STUDENT, 0);
    applyTopicLikeSession(state, {
      sessionType: "GAME",
      attempts: [],
      passed: false,
      crowns: 0,
      beatTargetPct: 66.7,
      sessionMs: 0,
      nowMs: 1,
    });
    expect(state.bestBeatTargetPct).toBe(66.7);
    applyTopicLikeSession(state, {
      sessionType: "GAME",
      attempts: [],
      passed: false,
      crowns: 0,
      beatTargetPct: 40,
      sessionMs: 0,
      nowMs: 2,
    });
    expect(state.bestBeatTargetPct).toBe(66.7);
    applyTopicLikeSession(state, {
      sessionType: "GAME",
      attempts: [],
      passed: false,
      crowns: 0,
      beatTargetPct: 90,
      sessionMs: 0,
      nowMs: 3,
    });
    expect(state.bestBeatTargetPct).toBe(90);
  });

  it("badge aggregates apply the earned-key rule (unit keys count only with own gate/verification attempts)", () => {
    const state = initialGamificationState(STUDENT, 0);
    const unitRows = [
      // A placement-style seed: GOLD key, but the child never played it.
      { unitId: "PK-M7", keyState: "GOLD_KEY" } as never,
      // An earned Silver: key + the child's own gate attempts.
      { unitId: UNIT, keyState: "SILVER_KEY" } as never,
    ];
    const agg = badgeAggregates({
      state,
      topicRows: [],
      unitRows,
      gateUnitIds: [UNIT],
      goldVerificationUnitIds: [],
    });
    expect(agg.silverKeys).toBe(1);
    expect(agg.goldKeys).toBe(0);
  });

  it("badge merging is forward-only and metadata comes from the catalog", () => {
    const state = initialGamificationState(STUDENT, 0);
    state.sessionsCompleted = 1;
    const added = evaluateAndMergeBadges(
      state,
      {
        sessionsCompleted: 1,
        topicsCompleted: 0,
        threeCrownTopics: 0,
        perfectTopics: 0,
        silverKeys: 0,
        goldKeys: 0,
        bestBeatTargetPct: 0,
        starCoins: 50,
        streakDays: 1,
      },
      5,
    );
    expect(added).toEqual(["first-steps"]);
    expect(state.earnedBadges).toEqual(["first-steps"]);
    // Re-evaluating adds nothing.
    expect(
      evaluateAndMergeBadges(
        state,
        {
          sessionsCompleted: 100,
          topicsCompleted: 0,
          threeCrownTopics: 0,
          perfectTopics: 0,
          silverKeys: 0,
          goldKeys: 0,
          bestBeatTargetPct: 0,
          starCoins: 50,
          streakDays: 1,
        },
        6,
      ),
    ).toEqual(["practice-fan", "marathon-learner"]);
    expect(state.earnedBadges).toEqual(["first-steps", "marathon-learner", "practice-fan"]);
    const summary = gamificationSummary(state);
    expect(summary.badges.map((b) => b.id)).toContain("first-steps");
    expect(summary.badges.find((b) => b.id === "first-steps")?.title).toBe("First Steps");
  });

  it("adoptServerLedger confirms values and clears the provisional flag", () => {
    const state = initialGamificationState(STUDENT, 0);
    state.totalXp = 41; // provisional, drifted from the server's 49
    const adopted = adoptServerLedger(
      state,
      {
        studentId: STUDENT,
        totalXp: 49,
        level: levelForXp(49),
        starCoins: 80,
        streakDays: 1,
        bestBeatTargetPct: 75,
        badges: [
          {
            id: "first-steps",
            title: "First Steps",
            description: "",
            tier: "bronze",
            scope: "global",
            awardedAt: "2026-10-23T00:00:00Z",
          },
        ],
        generatedAt: "2026-10-23T00:00:00Z",
      },
      10,
    );
    expect(adopted.totalXp).toBe(49);
    expect(adopted.provisional).toBe(false);
    expect(adopted.earnedBadges).toEqual(["first-steps"]);
  });

  it("summary level math mirrors the engine curve incl. progress percent", () => {
    const state = initialGamificationState(STUDENT, 0);
    state.totalXp = 175; // level 3: floor 150, next 300
    const summary = gamificationSummary(state);
    expect(summary.level).toBe(3);
    expect(summary.levelProgressPct).toBe(20);
    state.totalXp = levelForXp(0).level === 1 ? 0 : 0;
    const fresh = gamificationSummary(state);
    expect(fresh.level).toBe(1);
    expect(fresh.levelProgressPct).toBe(0);
  });

  it("per-attempt XP uses the engine's fluency weighting (spot check via xpForAttempt)", () => {
    expect(xpForAttempt({ isCorrect: true, fluencyGrade: 4 })).toBe(3);
    expect(xpForAttempt({ isCorrect: false, fluencyGrade: 4 })).toBe(0);
  });
});

describe("session-engine wiring (REAL SQLite, engine amounts)", () => {
  it("a passing topic session projects XP/coins and persists the ledger row", async () => {
    const engine = new PracticeSessionEngine(env.deps);
    const start = await engine.startTopicSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
      topicCode: "G",
    });
    for (const q of start.questions) {
      await engine.submitResponse(start.sessionId, {
        topicCode: "G",
        questionId: q.questionId,
        chosenAnswer: q.correctAnswer,
        isCorrect: true,
        rawTimeSec: 2,
      });
    }
    const summary = await engine.completeTopicSession(start.sessionId);
    expect(summary.passedTopic).toBe(true);
    expect(summary.crownsAwarded).toBe(3);
    // The engine amount: 8 attempts x grade-4 3 XP + 25 pass bonus.
    expect(summary.xpAwarded).toBe(49);
    expect(summary.coinsAwarded).toBe(30);

    const row = await env.gamification?.getGamificationState(STUDENT);
    expect(row).not.toBeNull();
    expect(row?.totalXp).toBe(49);
    expect(row?.starCoins).toBe(80);
    expect(row?.provisional).toBe(true);
    expect(row?.earnedBadges).toContain("first-steps");
    expect(row?.earnedBadges).toContain("crown-earner");
    expect(row?.earnedBadges).toContain("perfect-aim");
  });

  it("a game session projects per-topic groups and the beat-target input", async () => {
    setTopicGames("G", gamesBlockWithTarget(4.0));
    const engine = new PracticeSessionEngine(env.deps);
    const start = await engine.startGameSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
      topicCode: "G",
      stage: "guided",
    });
    for (const q of start.questions) {
      await engine.submitResponse(start.sessionId, {
        topicCode: "G",
        questionId: q.questionId,
        chosenAnswer: q.correctAnswer,
        isCorrect: true,
        rawTimeSec: 2,
      });
    }
    const summary = await engine.completeGameSession(start.sessionId);
    // Guided current-only composition: one topic group, 8 items.
    expect(summary.perTopic.length).toBe(1);
    expect(summary.perTopic[0]?.passedTopic).toBe(true);
    expect(summary.xpAwarded).toBe(49);
    expect(summary.coinsAwarded).toBe(30);
    const row = await env.gamification?.getGamificationState(STUDENT);
    expect(row?.totalXp).toBe(49);
    // The fixture topic's fluency target: raw 2s beats it on every item
    // (the speed badge input recorded monotonically).
    expect(row?.bestBeatTargetPct).toBe(100);
  });

  it("a passing gate session projects the gate bonus and the earned silver key badge", async () => {
    const engine = new PracticeSessionEngine(env.deps);
    const start = await engine.startGateSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
    });
    for (const q of start.questions) {
      await engine.submitResponse(start.sessionId, {
        topicCode: q.topicCode,
        questionId: q.questionId,
        chosenAnswer: q.correctAnswer,
        isCorrect: true,
        rawTimeSec: 2,
      });
    }
    const summary = await engine.completeGateSession(start.sessionId);
    expect(summary.passed).toBe(true);
    expect(summary.xpAwarded).toBeGreaterThan(25);
    expect(summary.coinsAwarded).toBe(GATE_PASS_COINS);
    const row = await env.gamification?.getGamificationState(STUDENT);
    expect(row?.earnedBadges).toContain("gate-conqueror");
  });

  it("a gold verification upgrade projects the upgrade XP", async () => {
    const engine = new PracticeSessionEngine(env.deps);
    // Silver first (pass the gate), then wait out the 14h window.
    const gate = await engine.startGateSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
    });
    for (const q of gate.questions) {
      await engine.submitResponse(gate.sessionId, {
        topicCode: q.topicCode,
        questionId: q.questionId,
        chosenAnswer: q.correctAnswer,
        isCorrect: true,
        rawTimeSec: 2,
      });
    }
    const gateSummary = await engine.completeGateSession(gate.sessionId);
    env.clock.advance(15 * 3_600_000);

    const verification = await engine.startGoldVerification({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
    });
    let answered = 0;
    for (const q of verification.questions) {
      // 4 of 5 correct passes the two-key check.
      await engine.submitResponse(verification.sessionId, {
        topicCode: q.topicCode,
        questionId: q.questionId,
        chosenAnswer: q.correctAnswer,
        isCorrect: answered < 4,
        rawTimeSec: 2,
      });
      answered += 1;
    }
    const result = await engine.completeGoldVerification(verification.sessionId);
    expect(result.upgraded).toBe(true);
    expect(result.xpAwarded).toBe(20);
    const row = await env.gamification?.getGamificationState(STUDENT);
    expect(row?.earnedBadges).toContain("gold-guardian");
    // The streak crossed two fake-clock days (start .. +15h is same day
    // at the fixture's t0 22:13Z -> the verification lands next UTC day).
    expect(row?.streakDays).toBe(2);
    // CROSS-SESSION ACCUMULATION: the ledger row carries the gate
    // session's XP + the flat upgrade bonus (verification attempts earn
    // no per-attempt XP on EITHER side — a deliberate, mirrored rule) —
    // the optimistic ledger is a running total, not a per-session value.
    expect(row?.totalXp).toBe(gateSummary.xpAwarded + 20);
  });

  it("a FAILED game session earns attempt XP only — the mobile mirror of the server's failed-session rule", async () => {
    setTopicGames("G", gamesBlockWithTarget(4.0));
    const engine = new PracticeSessionEngine(env.deps);
    const start = await engine.startGameSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
      topicCode: "G",
      stage: "guided",
    });
    let answered = 0;
    for (const q of start.questions) {
      await engine.submitResponse(start.sessionId, {
        topicCode: "G",
        questionId: q.questionId,
        chosenAnswer: q.correctAnswer,
        isCorrect: answered < 5,
        rawTimeSec: 2,
      });
      answered += 1;
    }
    const summary = await engine.completeGameSession(start.sessionId);
    expect(summary.perTopic[0]?.passedTopic).toBe(false);
    // 5 correct grade-4 attempts -> 15 XP; no bonus, no coins.
    expect(summary.xpAwarded).toBe(15);
    expect(summary.coinsAwarded).toBe(0);
    const row = await env.gamification?.getGamificationState(STUDENT);
    expect(row?.totalXp).toBe(15);
    expect(row?.starCoins).toBe(50);
    expect(row?.earnedBadges).toEqual(["first-steps"]);
  });

  it("sessions still complete (with exact reward totals) when the gamification seam is absent", async () => {
    const bare = createPracticeEnv({ gamification: false });
    try {
      const engine = new PracticeSessionEngine(bare.deps);
      const start = await engine.startTopicSession({
        studentId: STUDENT,
        gradeId: GRADE,
        unitId: UNIT,
        topicCode: "G",
      });
      for (const q of start.questions) {
        await engine.submitResponse(start.sessionId, {
          topicCode: "G",
          questionId: q.questionId,
          chosenAnswer: q.correctAnswer,
          isCorrect: true,
          rawTimeSec: 2,
        });
      }
      const summary = await engine.completeTopicSession(start.sessionId);
      expect(summary.xpAwarded).toBe(49);
      expect(bare.gamification).toBeNull();
    } finally {
      bare.dispose();
    }
  });

  it("the storage row round-trips every field", async () => {
    expect(env.gamification).not.toBeNull();
    const state = initialGamificationState(STUDENT, 42);
    state.totalXp = 120;
    state.starCoins = 77;
    state.streakDays = 3;
    state.lastActiveDayKey = "2026-10-23";
    state.bestBeatTargetPct = 81.2;
    state.sessionsCompleted = 9;
    state.earnedBadges = ["first-steps", "streak-spark"];
    await env.gamification!.upsertGamificationState(state);
    const loaded = await env.gamification!.getGamificationState(STUDENT);
    expect(loaded).toEqual(state);
  });
});

describe("no-fork source pins (D9)", () => {
  const projectorSource = readFileSync(
    `${repoRoot}/apps/mobile/src/gamification/rewardsProjector.ts`,
    "utf-8",
  );
  const engineSource = readFileSync(
    `${repoRoot}/apps/mobile/src/practice/practiceEngine.ts`,
    "utf-8",
  );
  const serverRewards = readFileSync(`${repoRoot}/services/api/rewards.mjs`, "utf-8");
  const serverSync = readFileSync(`${repoRoot}/services/api/sync.mjs`, "utf-8");
  const serverHandlers = readFileSync(`${repoRoot}/services/api/server.mjs`, "utf-8");

  it("the mobile projector computes amounts ONLY through engine imports", () => {
    expect(projectorSource).toContain('from "@balashikshana/core-engine"');
    for (const fn of [
      "awardXpForAttempts",
      "awardXpForSessionOutcome",
      "coinsForTopicPass",
      "GATE_PASS_COINS",
      "nextStreakState",
      "evaluateBadges",
      "levelForXp",
    ]) {
      expect(projectorSource).toContain(fn);
    }
    // No inline formula forks.
    expect(projectorSource).not.toContain("15 +");
    expect(projectorSource).not.toMatch(/streakDays\s*\+\s*1/);
  });

  it("the session engine consumes the projector (never its own reward math)", () => {
    expect(engineSource).toContain('from "../gamification/rewardsProjector"');
    expect(engineSource).not.toContain("15 +");
  });

  it("the server writers + replays + online handlers consume the engine (one source)", () => {
    for (const src of [serverRewards, serverSync, serverHandlers]) {
      expect(src).toMatch(/from "\.\.\/\.\.\/packages\/core-engine\/src\/index\.mjs"/);
    }
    // rewards.mjs is the single import site in the writers.
    expect(serverRewards).toMatch(/from "\.\.\/\.\.\/packages\/core-engine\/src\/index\.mjs"/);
    expect(serverSync).toContain('from "./rewards.mjs"');
    expect(serverHandlers).toContain('from "./rewards.mjs"');
    // The pre-#55 inline formulas are gone from both paths.
    expect(serverSync).not.toContain("15 + derivation.crowns");
    expect(serverHandlers).not.toContain("15 + crowns * 5");
    expect(serverHandlers).not.toContain("star_coins = star_coins + 50");
  });
});

// ---------------------------------------------------------------------------
// #57 acceptance: streak derives identically offline and after #48 sync
// replay (D9 agreement). The offline side is the projector (what the
// session engine runs at completion); the replay side is a faithful
// port of services/api rewards.mjs applyStreakForSession (the exact
// logic the server runs per replayed session, in DRAIN order = the
// attempt-log id order the sync worker uploads). Both call the SAME
// engine nextStreakState; this spec proves the two compositions
// converge on a stream with every boundary: same-day duplicates, a
// multi-day run, a gap reset, and a late out-of-order arrival.
// ---------------------------------------------------------------------------

describe("D9 streak agreement: offline projector == #48 sync replay (#57)", () => {
  interface StreamSession {
    sessionMs: number;
    /** Arrival position in the sync drain (attempt-log id order). */
    drainIndex: number;
  }

  /** Port of services/api rewards.mjs applyStreakForSession: the server's
   *  per-session streak transition over students.streak_days + the state
   *  row's last_active_day_key. */
  function serverReplayStreak(sessions: StreamSession[]): {
    streakDays: number;
    lastActiveDayKey: string;
  } {
    let streakDays = 0;
    let lastActiveDayKey = "";
    for (const session of [...sessions].sort((a, b) => a.drainIndex - b.drainIndex)) {
      const sessionDayKey = dayKeyForMs(session.sessionMs);
      if (sessionDayKey === "") continue;
      const next = nextStreakState({
        currentStreakDays: streakDays,
        lastActiveDayKey,
        sessionDayKey,
      });
      if (next.changed) {
        streakDays = next.streakDays;
        lastActiveDayKey = next.lastActiveDayKey;
      }
    }
    return { streakDays, lastActiveDayKey };
  }

  it("a boundary-heavy stream converges: same-day duplicates, a run, a gap reset, a late arrival", () => {
    const d = (day: number, hour = 10) => Date.UTC(2026, 9, day, hour);
    const stream: StreamSession[] = [
      { sessionMs: d(12, 9), drainIndex: 0 },
      { sessionMs: d(12, 16), drainIndex: 1 }, // same UTC day: idempotent
      { sessionMs: d(13, 9), drainIndex: 2 }, // consecutive: 2
      { sessionMs: d(14, 9), drainIndex: 3 }, // consecutive: 3
      { sessionMs: d(17, 9), drainIndex: 4 }, // 3-day gap: reset to 1
      { sessionMs: d(18, 9), drainIndex: 5 }, // consecutive: 2
      // A late-draining session from an EARLIER day (offline backlog
      // replayed after newer sessions): the engine never moves the
      // streak backwards — no-op on the server side.
      { sessionMs: d(16, 20), drainIndex: 6 },
    ];

    // Offline: the projector path (the session engine's completion call).
    const local = initialGamificationState(STUDENT, 0);
    for (const session of stream) {
      applyTopicLikeSession(local, {
        sessionType: "TOPIC_PRACTICE",
        attempts: [],
        passed: false,
        crowns: 0,
        sessionMs: session.sessionMs,
        nowMs: session.sessionMs,
      });
    }

    // Replay: the server port, in drain order (incl. the late arrival).
    const server = serverReplayStreak(stream);

    expect(local.streakDays).toBe(server.streakDays);
    expect(local.lastActiveDayKey).toBe(server.lastActiveDayKey);
    expect(server.streakDays).toBe(2);
    expect(server.lastActiveDayKey).toBe("2026-10-18");
  });

  it("the confirmed ledger adopts the same streak (the D8 confirm step keeps the value)", () => {
    const local = initialGamificationState(STUDENT, 0);
    applyTopicLikeSession(local, {
      sessionType: "TOPIC_PRACTICE",
      attempts: [],
      passed: false,
      crowns: 0,
      sessionMs: Date.UTC(2026, 9, 12, 9),
      nowMs: 1,
    });
    applyTopicLikeSession(local, {
      sessionType: "TOPIC_PRACTICE",
      attempts: [],
      passed: false,
      crowns: 0,
      sessionMs: Date.UTC(2026, 9, 13, 9),
      nowMs: 2,
    });
    const server = serverReplayStreak([
      { sessionMs: Date.UTC(2026, 9, 12, 9), drainIndex: 0 },
      { sessionMs: Date.UTC(2026, 9, 13, 9), drainIndex: 1 },
    ]);
    const confirmed = adoptServerLedger(
      local,
      {
        studentId: STUDENT,
        totalXp: local.totalXp,
        level: levelForXp(local.totalXp),
        starCoins: local.starCoins,
        streakDays: server.streakDays,
        bestBeatTargetPct: local.bestBeatTargetPct,
        badges: [],
        generatedAt: "2026-10-13T10:00:00.000Z",
      },
      3,
    );
    expect(confirmed.streakDays).toBe(local.streakDays);
    expect(confirmed.provisional).toBe(false);
  });

  it("#57 surfacing seam: useStreak and the journey strip surface the same summary streak", () => {
    const hook = readFileSync(`${repoRoot}/apps/mobile/src/gamification/useStreak.ts`, "utf8");
    const strip = readFileSync(
      `${repoRoot}/apps/mobile/src/gamification/GamificationHeaderStrip.tsx`,
      "utf8",
    );
    expect(hook).toContain("useGamificationSummary(studentId)");
    expect(hook).toContain("streakDays: summary.streakDays");
    expect(hook).toContain("provisional: summary.provisional");
    expect(strip).toContain('label="Day streak"');
  });
});

describe("celebration report wiring (#58 — engine integration)", () => {
  /** The canonical fast-correct topic session helper (sibling pattern). */
  async function passTopicSession(engine: PracticeSessionEngine): Promise<void> {
    const start = await engine.startTopicSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
      topicCode: "G",
    });
    for (const q of start.questions) {
      await engine.submitResponse(start.sessionId, {
        topicCode: "G",
        questionId: q.questionId,
        chosenAnswer: q.correctAnswer,
        isCorrect: true,
        rawTimeSec: 2,
      });
    }
    await engine.completeTopicSession(start.sessionId);
  }

  it("a first passing session reports the newly earned badges and the level transition", async () => {
    const engine = new PracticeSessionEngine(env.deps);
    const start = await engine.startTopicSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
      topicCode: "G",
    });
    for (const q of start.questions) {
      await engine.submitResponse(start.sessionId, {
        topicCode: "G",
        questionId: q.questionId,
        chosenAnswer: q.correctAnswer,
        isCorrect: true,
        rawTimeSec: 2,
      });
    }
    const summary = await engine.completeTopicSession(start.sessionId);
    // The report surfaces EXACTLY the badges the ledger row merged
    // (the evaluateAndMergeBadges return, wired through projectRewards).
    const row = await env.gamification?.getGamificationState(STUDENT);
    expect([...(row?.earnedBadges ?? [])].sort()).toEqual(
      [...summary.celebration.badgesAwarded].sort(),
    );
    expect(summary.celebration.badgesAwarded).toContain("first-steps");
    // Level-up is the engine curve's verdict on the before/after totals.
    expect(summary.celebration.leveledUp).toBe(
      levelForXp(row?.totalXp ?? 0).level > levelForXp(0).level,
    );
    expect(summary.celebration.level).toBe(levelForXp(row?.totalXp ?? 0).level);
    // Fresh state: streak starts at 1 with no active day key; the first
    // session CLAIMS the day but does not GROW the streak.
    expect(summary.celebration.streakIncreased).toBe(false);
    expect(summary.celebration.streakDays).toBe(row?.streakDays);
  });

  it("a second same-day session reports nothing new (badges/level/streak all quiet)", async () => {
    const engine = new PracticeSessionEngine(env.deps);
    await passTopicSession(engine);
    const rowAfterFirst = await env.gamification?.getGamificationState(STUDENT);
    const xpAfterFirst = rowAfterFirst?.totalXp ?? 0;

    const start = await engine.startTopicSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
      topicCode: "G",
    });
    for (const q of start.questions) {
      await engine.submitResponse(start.sessionId, {
        topicCode: "G",
        questionId: q.questionId,
        chosenAnswer: q.correctAnswer,
        isCorrect: true,
        rawTimeSec: 2,
      });
    }
    const second = await engine.completeTopicSession(start.sessionId);
    // Same fake-clock day (streak idempotent), no new catalog badge
    // earned at these aggregates, and the level verdict is computed over
    // the running totals — the report describes THIS session's deltas.
    expect(second.celebration.streakIncreased).toBe(false);
    expect(second.celebration.badgesAwarded).toEqual([]);
    expect(second.celebration.leveledUp).toBe(
      levelForXp(xpAfterFirst + second.xpAwarded).level > levelForXp(xpAfterFirst).level,
    );
  });

  it("without the gamification seam the report is empty but well-formed (scratch path)", async () => {
    const bare = createPracticeEnv({ prerequisiteUnit: true, gamification: false });
    try {
      const engine = new PracticeSessionEngine(bare.deps);
      const start = await engine.startTopicSession({
        studentId: STUDENT,
        gradeId: GRADE,
        unitId: UNIT,
        topicCode: "G",
      });
      for (const q of start.questions) {
        await engine.submitResponse(start.sessionId, {
          topicCode: "G",
          questionId: q.questionId,
          chosenAnswer: q.correctAnswer,
          isCorrect: true,
          rawTimeSec: 2,
        });
      }
      const summary = await engine.completeTopicSession(start.sessionId);
      expect(summary.xpAwarded).toBe(49);
      expect(summary.celebration.badgesAwarded).toEqual([]);
      expect(summary.celebration.streakDays).toBe(1);
      // The scratch transition runs on a throwaway state; the level
      // verdict mirrors the engine curve over that scratch state.
      expect(summary.celebration.leveledUp).toBe(levelForXp(49).level > levelForXp(0).level);
    } finally {
      bare.dispose();
    }
  });

  it("a gate pass reports the gate badges; a gold upgrade reports on the upgraded summary only", async () => {
    const engine = new PracticeSessionEngine(env.deps);
    const gate = await engine.startGateSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
    });
    for (const q of gate.questions) {
      await engine.submitResponse(gate.sessionId, {
        topicCode: q.topicCode,
        questionId: q.questionId,
        chosenAnswer: q.correctAnswer,
        isCorrect: true,
        rawTimeSec: 2,
      });
    }
    const gateSummary = await engine.completeGateSession(gate.sessionId);
    expect(gateSummary.celebration.badgesAwarded).toContain("gate-conqueror");

    env.clock.advance(15 * 3_600_000);
    const verification = await engine.startGoldVerification({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
    });
    let answered = 0;
    for (const q of verification.questions) {
      await engine.submitResponse(verification.sessionId, {
        topicCode: q.topicCode,
        questionId: q.questionId,
        chosenAnswer: q.correctAnswer,
        isCorrect: answered < 4,
        rawTimeSec: 2,
      });
      answered += 1;
    }
    const result = await engine.completeGoldVerification(verification.sessionId);
    expect(result.upgraded).toBe(true);
    expect(result.celebration?.badgesAwarded).toContain("gold-guardian");
    // The 15h advance crossed a UTC day: the upgrade's report carries
    // the streak growth (the Gold ceremony's streak-milestone input).
    expect(result.celebration?.streakIncreased).toBe(true);
  });
});
