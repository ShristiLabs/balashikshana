/**
 * Hearts policy acceptance spec (issue #56, roadmap D6) — REAL SQLite
 * (node:sqlite) through the PracticeSessionEngine, the game store, and
 * the #48 sync engine, mirroring the games-session-integration harness.
 *
 * - MOUNT MATRIX (the roadmap M4 gate: "hearts UI absent in Pre-K-G1
 *   builds"): ALL five registry grades x both game stages through the
 *   real startGameSession wiring — hearts mount ONLY for grade-2 and
 *   grade-3 fluency sprints (the single core-engine predicate; the
 *   wiring never re-derives the tier).
 * - G2 lifecycle: bounded loss on first-answer misses, re-queue repeats
 *   never double-penalize, empty hearts end the session with the
 *   growth-reframe reason, effort XP still credits (kid-safety), and
 *   the session_outcomes row carries the telemetry.
 * - No-fail tiers (Pre-K-G1, guided): NO hearts state, NO outcome row —
 *   structural, not a value.
 * - #48 wire: outcomes drain/upload/ack with no-loss ordering; a
 *   pre-#56 server (no ackedOutcomeIds) leaves rows to ride the next
 *   batch; exactly-once re-upload after ack.
 * - Structural source pins: the screen mounts HeartsDisplay ONLY under
 *   the engine-set heartsRemaining !== null guard; the store mirrors
 *   the engine transition and computes nothing; the reframe copy is
 *   growth-mindset, never punitive.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HEART_COUNT } from "@balashikshana/core-engine";
import { PracticeSessionEngine } from "../src/practice/practiceEngine";
import { SyncEngine } from "../src/sync/syncEngine";
import type {
  SessionOutcomeWire,
  SyncAttemptWire,
  SyncDeps,
  SyncRunResult,
  SyncTransport,
  SyncUploadResponse,
} from "../src/sync/types";
import { createPracticeEnv, FIXTURE_UNIT, type PracticeTestEnv } from "./helpers/practiceEnv";

import { DatabaseSync } from "node:sqlite";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const STUDENT = "s1";
const UNIT = FIXTURE_UNIT.unitId; // K-M2 (fixture pack)
const PACK_ARTIFACT = "pack-kindergarten-v1.0.0.sqlite";

/** The five registry grade ids (docs/us-curriculum-registry.json). */
const ALL_GRADES = ["pre-k", "kindergarten", "grade-1", "grade-2", "grade-3"] as const;
const HEARTS_GRADES = ["grade-2", "grade-3"] as const;

let env: PracticeTestEnv;

beforeEach(() => {
  env = createPracticeEnv({ prerequisiteUnit: true });
});

afterEach(() => {
  env.dispose();
});

/**
 * Test-only pack alias (the setTopicGames precedent): registers the
 * fixture artifact under a second grade id, exactly as the #46 content
 * service would install per-grade packs. The session's gradeId drives
 * the D6 predicate; the pack serves the same unit rows.
 */
function aliasGradePack(gradeId: string): void {
  env.storage.db
    .prepare(
      "INSERT INTO pack_meta (grade_id, content_version, format_version, status, artifact, size_bytes, sha256, key_id, installed_at) VALUES (?, '1.0.0', 1, 'active', ?, 1024, ?, 'test', 2)",
    )
    .run(gradeId, PACK_ARTIFACT, "c".repeat(64));
}

/** Test-only pack editor: writes a topic's assets.games block. */
function setTopicGames(topicCode: string, games: unknown): void {
  const db = new DatabaseSync(`${env.dir}/${PACK_ARTIFACT}`);
  try {
    db.prepare("UPDATE skill_topics SET assets_json = ? WHERE topic_id = ?").run(
      JSON.stringify({ games }),
      `${UNIT}-${topicCode}`,
    );
  } finally {
    db.close();
  }
}

function registryGamesBlock(): { guidedPracticeGame: object; fluencySprintGame: object } {
  return {
    guidedPracticeGame: {
      gameId: `game_guided_${UNIT}_G`,
      archetype: "block-builder",
      title: "Guided Explorer",
      mechanics: "Untimed explorer with hints.",
      targetMasteryScore: 80,
      minQuestionsToComplete: 8,
    },
    fluencySprintGame: {
      gameId: `game_fluency_${UNIT}_G`,
      archetype: "block-builder",
      title: "Fluency Blitz",
      mechanics: "Fast-paced sprint.",
      targetResponseSpeedSec: 5.5,
      spiralMix: { currentTopic: 0.7, contrastivePrerequisite: 0.2, spacedReview: 0.1 },
    },
  };
}

async function startSession(
  engine: PracticeSessionEngine,
  gradeId: string,
  stage: "guided" | "fluency",
) {
  return engine.startGameSession({
    studentId: STUDENT,
    gradeId,
    unitId: UNIT,
    topicCode: "G",
    stage,
    motorBaselineSec: 0.42,
  });
}

function outcomeRows(): {
  id: number;
  session_id: string;
  session_type: string;
  stage: string;
  hearts_lost: number;
  hearts_remaining: number;
  end_reason: string;
  synced: number;
}[] {
  return env.storage.db
    .prepare(
      "SELECT id, session_id, session_type, stage, hearts_lost, hearts_remaining, end_reason, synced FROM session_outcomes ORDER BY id ASC",
    )
    .all() as ReturnType<typeof outcomeRows>;
}

// ---------------------------------------------------------------------------
// D6 mount matrix — all five grades x both stages through the WIRING
// ---------------------------------------------------------------------------

describe("D6 mount matrix (startGameSession wiring, five grades x both stages)", () => {
  it("mounts hearts ONLY for grade-2/grade-3 fluency sprints", async () => {
    setTopicGames("G", registryGamesBlock());
    const engine = new PracticeSessionEngine(env.deps);
    for (const gradeId of ALL_GRADES) {
      if (gradeId !== "kindergarten") aliasGradePack(gradeId);
      const fluency = await startSession(engine, gradeId, "fluency");
      expect(fluency.heartsRemaining, `${gradeId} fluency`).toBe(
        (HEARTS_GRADES as readonly string[]).includes(gradeId) ? HEART_COUNT : null,
      );
      const guided = await startSession(engine, gradeId, "guided");
      expect(guided.heartsRemaining, `${gradeId} guided`).toBe(null);
    }
  });
});

// ---------------------------------------------------------------------------
// G2 fluency lifecycle: bounded loss, no re-queue double penalty,
// hearts-empty end + telemetry, effort XP intact
// ---------------------------------------------------------------------------

describe("grade-2 fluency sprint hearts lifecycle (real SQLite)", () => {
  beforeEach(() => {
    setTopicGames("G", registryGamesBlock());
    aliasGradePack("grade-2");
  });

  it("loses one heart per first-answer miss; correct answers cost nothing", async () => {
    const engine = new PracticeSessionEngine(env.deps);
    const start = await startSession(engine, "grade-2", "fluency");
    expect(start.heartsRemaining).toBe(HEART_COUNT);

    const wrong = await engine.submitResponse(start.sessionId, {
      topicCode: "G",
      questionId: start.questions[1]!.questionId,
      chosenAnswer: "not-the-answer",
      isCorrect: false,
      rawTimeSec: 4,
    });
    expect(wrong.hearts).toEqual({ remaining: HEART_COUNT - 1, lost: true });

    const right = await engine.submitResponse(start.sessionId, {
      topicCode: "G",
      questionId: start.questions[2]!.questionId,
      chosenAnswer: start.questions[2]!.correctAnswer,
      isCorrect: true,
      rawTimeSec: 2,
    });
    expect(right.hearts).toEqual({ remaining: HEART_COUNT - 1, lost: false });
  });

  it("a re-queued repeat never costs a second heart (the miss already paid)", async () => {
    const engine = new PracticeSessionEngine(env.deps);
    const start = await startSession(engine, "grade-2", "fluency");
    const question = start.questions[1]!;

    const firstMiss = await engine.submitResponse(start.sessionId, {
      topicCode: "G",
      questionId: question.questionId,
      chosenAnswer: "nope",
      isCorrect: false,
      rawTimeSec: 4,
    });
    expect(firstMiss.hearts).toEqual({ remaining: HEART_COUNT - 1, lost: true });

    const requeueMiss = await engine.submitResponse(start.sessionId, {
      topicCode: "G",
      questionId: question.questionId,
      chosenAnswer: "still-nope",
      isCorrect: false,
      rawTimeSec: 5,
      isRequeue: true,
    });
    expect(requeueMiss.hearts).toEqual({ remaining: HEART_COUNT - 1, lost: false });
  });

  it("empty hearts end the session early: reframe reason, telemetry row, effort XP intact", async () => {
    const engine = new PracticeSessionEngine(env.deps);
    const start = await startSession(engine, "grade-2", "fluency");

    // One correct answer (effort), then five distinct first-answer
    // misses — the exact moment the row empties, the screen completes.
    await engine.submitResponse(start.sessionId, {
      topicCode: "G",
      questionId: start.questions[0]!.questionId,
      chosenAnswer: start.questions[0]!.correctAnswer,
      isCorrect: true,
      rawTimeSec: 2,
    });
    let remaining = HEART_COUNT;
    for (const question of start.questions.slice(1, 6)) {
      const result = await engine.submitResponse(start.sessionId, {
        topicCode: "G",
        questionId: question.questionId,
        chosenAnswer: "miss",
        isCorrect: false,
        rawTimeSec: 4,
      });
      remaining -= 1;
      expect(result.hearts).toEqual({ remaining, lost: true });
    }
    expect(remaining).toBe(0);

    const summary = await engine.completeGameSession(start.sessionId);
    expect(summary.hearts).toMatchObject({
      heartsLost: HEART_COUNT,
      heartsRemaining: 0,
      endReason: "hearts-empty",
    });
    // Kid-safety: the correct attempt's effort XP still credits — a
    // hearts end is a pause-and-reframe, never a reward wipe.
    expect(summary.xpAwarded).toBeGreaterThan(0);

    // Telemetry: exactly one append-only outcome row, hearts-empty.
    expect(outcomeRows()).toEqual([
      {
        id: 1,
        session_id: start.sessionId,
        session_type: "GAME",
        stage: "fluency",
        hearts_lost: HEART_COUNT,
        hearts_remaining: 0,
        end_reason: "hearts-empty",
        synced: 0,
      },
    ]);
  });

  it("next-session refill: a fresh sprint starts at FULL hearts right after hearts-empty (no gate, no cooldown)", async () => {
    // Session 1 runs its heart row to empty (five distinct first-answer
    // misses on the SAME engine instance that owns the session).
    const engine = new PracticeSessionEngine(env.deps);
    const first = await startSession(engine, "grade-2", "fluency");
    for (const question of first.questions.slice(0, 5)) {
      const result = await engine.submitResponse(first.sessionId, {
        topicCode: "G",
        questionId: question.questionId,
        chosenAnswer: "miss",
        isCorrect: false,
        rawTimeSec: 4,
      });
      expect(result.hearts?.lost).toBe(true);
    }
    const firstSummary = await engine.completeGameSession(first.sessionId);
    expect(firstSummary.hearts?.endReason).toBe("hearts-empty");

    // Session 2 — started IMMEDIATELY, zero rest required — opens at
    // the full count (D6: hearts are session-scoped, never a cross-
    // session counter, never a content block). This is the structural
    // "hearts never block content permanently" proof.
    const second = await startSession(engine, "grade-2", "fluency");
    expect(second.heartsRemaining).toBe(HEART_COUNT);
    const miss = await engine.submitResponse(second.sessionId, {
      topicCode: "G",
      questionId: second.questions[0]!.questionId,
      chosenAnswer: "miss",
      isCorrect: false,
      rawTimeSec: 4,
    });
    expect(miss.hearts).toEqual({ remaining: HEART_COUNT - 1, lost: true });
    const summary = await engine.completeGameSession(second.sessionId);
    expect(summary.hearts?.endReason).toBe("completed");

    // Two append-only outcome rows — one per closed hearts session.
    expect(outcomeRows()).toHaveLength(2);
    expect(outcomeRows().map((row) => row.end_reason)).toEqual(["hearts-empty", "completed"]);
  });

  it("a completed sprint records the completed outcome (0 lost, full row)", async () => {
    const engine = new PracticeSessionEngine(env.deps);
    const start = await startSession(engine, "grade-2", "fluency");
    for (const question of start.questions) {
      await engine.submitResponse(start.sessionId, {
        topicCode: "G",
        questionId: question.questionId,
        chosenAnswer: question.correctAnswer,
        isCorrect: true,
        rawTimeSec: 2,
      });
    }
    const summary = await engine.completeGameSession(start.sessionId);
    expect(summary.hearts).toMatchObject({
      heartsLost: 0,
      heartsRemaining: HEART_COUNT,
      endReason: "completed",
    });
    expect(outcomeRows()).toHaveLength(1);
    expect(outcomeRows()[0]!.end_reason).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// No-fail tiers: structural absence (Pre-K-G1 + every guided session)
// ---------------------------------------------------------------------------

describe("Pre-K-G1 no-fail mode is structural (no hearts, no outcome rows)", () => {
  it("pre-k and grade-1 fluency sprints: misses never produce hearts state or telemetry", async () => {
    setTopicGames("G", registryGamesBlock());
    for (const gradeId of ["pre-k", "grade-1", "kindergarten"] as const) {
      const engine = new PracticeSessionEngine(env.deps);
      if (gradeId !== "kindergarten") aliasGradePack(gradeId);
      const start = await startSession(engine, gradeId, "fluency");
      expect(start.heartsRemaining).toBe(null);

      const miss = await engine.submitResponse(start.sessionId, {
        topicCode: "G",
        questionId: start.questions[0]!.questionId,
        chosenAnswer: "miss",
        isCorrect: false,
        rawTimeSec: 4,
      });
      // Gentle-retry doctrine: the miss records like any other attempt
      // (the re-queue ladder lives in the store) — no hearts transition
      // exists for this session.
      expect(miss.hearts).toBeUndefined();

      const summary = await engine.completeGameSession(start.sessionId);
      expect(summary.hearts).toBeUndefined();
    }
    expect(outcomeRows()).toEqual([]);
  });

  it("a grade-2 GUIDED session is hearts-free too (predicate gates on stage)", async () => {
    setTopicGames("G", registryGamesBlock());
    aliasGradePack("grade-2");
    const engine = new PracticeSessionEngine(env.deps);
    const start = await startSession(engine, "grade-2", "guided");
    expect(start.heartsRemaining).toBe(null);
    await engine.submitResponse(start.sessionId, {
      topicCode: "G",
      questionId: start.questions[0]!.questionId,
      chosenAnswer: "miss",
      isCorrect: false,
      rawTimeSec: 4,
    });
    const summary = await engine.completeGameSession(start.sessionId);
    expect(summary.hearts).toBeUndefined();
    expect(outcomeRows()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #48 wire: session outcomes drain, upload, ack — no-loss ordering
// ---------------------------------------------------------------------------

describe("#48 wire: hearts session outcomes ride the sync batch (additive)", () => {
  class OutcomeTransport implements SyncTransport {
    attempts: SyncAttemptWire[] = [];
    outcomes: SessionOutcomeWire[] = [];
    ackOutcomes = true;

    async uploadAttempts(
      attempts: SyncAttemptWire[],
      outcomes?: SessionOutcomeWire[],
    ): Promise<SyncUploadResponse> {
      this.attempts = attempts;
      this.outcomes = outcomes ?? [];
      return {
        ackedSeqs: attempts.map((a) => a.seq),
        ...(this.ackOutcomes && this.outcomes.length > 0
          ? { ackedOutcomeIds: this.outcomes.map((o) => o.seq) }
          : {}),
        serverTime: new Date(0).toISOString(),
        stats: {
          inserted: attempts.length,
          duplicates: 0,
          sessionsReplayed: 1,
          clockSkewAdjusted: 0,
        },
        packsOutdated: [],
        progress: { units: [], topics: [] },
      };
    }

    async fetchProgress(): Promise<import("../src/sync/types").SyncProgressResponse> {
      return {
        serverTime: new Date(0).toISOString(),
        packsOutdated: [],
        progress: { units: [], topics: [] },
      };
    }
  }

  async function completeAHeartsSession(): Promise<void> {
    setTopicGames("G", registryGamesBlock());
    aliasGradePack("grade-2");
    const engine = new PracticeSessionEngine(env.deps);
    const start = await startSession(engine, "grade-2", "fluency");
    for (const question of start.questions.slice(0, 3)) {
      await engine.submitResponse(start.sessionId, {
        topicCode: "G",
        questionId: question.questionId,
        chosenAnswer: question.correctAnswer,
        isCorrect: true,
        rawTimeSec: 2,
      });
    }
    await engine.completeGameSession(start.sessionId);
  }

  function syncWith(transport: OutcomeTransport): Promise<SyncRunResult> {
    const sync = new SyncEngine({
      storage: env.storage,
      transport,
      connectivity: { isOnline: async () => true },
    } as unknown as SyncDeps);
    return sync.sync(STUDENT);
  }

  it("uploads outcomes alongside the attempts batch and marks them synced on ack", async () => {
    await completeAHeartsSession();
    const transport = new OutcomeTransport();
    const result = await syncWith(transport);
    expect(result.outcome).toBe("synced");

    expect(transport.attempts.length).toBe(3);
    expect(transport.outcomes).toHaveLength(1);
    expect(transport.outcomes[0]).toMatchObject({
      sessionId: expect.any(String),
      sessionType: "GAME",
      stage: "fluency",
      heartsLost: 0,
      heartsRemaining: HEART_COUNT,
      endReason: "completed",
    });

    // No-loss ordering: the ack flipped exactly the acked row.
    expect(outcomeRows()[0]!.synced).toBe(1);

    // A second run re-sends nothing (exactly-once client-side too).
    const second = new OutcomeTransport();
    await syncWith(second);
    expect(second.outcomes).toHaveLength(0);
    expect(second.attempts).toHaveLength(0);
  });

  it("a pre-#56 server (no ackedOutcomeIds) leaves outcome rows to ride the next attempts batch", async () => {
    await completeAHeartsSession();
    const legacy = new OutcomeTransport();
    legacy.ackOutcomes = false;
    await syncWith(legacy);
    expect(legacy.outcomes).toHaveLength(1);
    // Nothing marked synced without an explicit ack — no data loss.
    expect(outcomeRows()[0]!.synced).toBe(0);

    // Outcomes ride ONLY alongside an attempts batch (the server keeps
    // attempts minItems 1 — the additive-wire rule), so with nothing
    // else pending an idle sync carries nothing and the row waits.
    const idle = new OutcomeTransport();
    const idleResult = await syncWith(idle);
    expect(idleResult.outcome).toBe("idle");
    expect(idle.outcomes).toHaveLength(0);
    expect(outcomeRows()[0]!.synced).toBe(0);

    // The child's next session produces attempts; the upgraded server
    // acks and the stranded outcome rides that batch — nothing is lost.
    const engine = new PracticeSessionEngine(env.deps);
    const start = await engine.startTopicSession({
      studentId: STUDENT,
      gradeId: "kindergarten",
      unitId: UNIT,
      topicCode: "G",
      count: 2,
    });
    for (const question of start.questions.slice(0, 2)) {
      await engine.submitResponse(start.sessionId, {
        topicCode: "G",
        questionId: question.questionId,
        chosenAnswer: question.correctAnswer,
        isCorrect: true,
        rawTimeSec: 2,
      });
    }
    await engine.completeTopicSession(start.sessionId);

    const upgraded = new OutcomeTransport();
    await syncWith(upgraded);
    expect(upgraded.attempts.length).toBeGreaterThanOrEqual(2);
    expect(upgraded.outcomes).toHaveLength(1);
    expect(outcomeRows()[0]!.synced).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Structural source pins: the UI cannot mount hearts on its own
// ---------------------------------------------------------------------------

describe("structural no-fail source pins (roadmap M4 gate)", () => {
  const screen = readFileSync(`${repoRoot}/apps/mobile/src/games/GameSessionScreen.tsx`, "utf8");
  const store = readFileSync(`${repoRoot}/apps/mobile/src/games/gameStore.ts`, "utf8");
  const engineSource = readFileSync(
    `${repoRoot}/apps/mobile/src/practice/practiceEngine.ts`,
    "utf8",
  );

  it("the screen mounts HeartsDisplay ONLY under the engine-set heartsRemaining guard", () => {
    // Exactly one mount site, inside the null-guard ternary — the
    // screen holds no grade/stage hearts logic of its own.
    const mounts = screen.match(/<HeartsDisplay/g) ?? [];
    expect(mounts.length).toBeGreaterThanOrEqual(1);
    expect(screen).toContain("state.heartsRemaining !== null ?");
    expect(screen).not.toMatch(/shouldMountHearts/);
    // The engine symbols stay engine-imported (#58 added badgeById to
    // the same import line for the ceremony blooms).
    expect(screen).toMatch(
      /import \{[^}]*HEART_COUNT[^}]*heartsRegrowProgress[^}]*\} from "@balashikshana\/core-engine"/,
    );
  });

  it("the reframe screen is growth-mindset copy, never punitive", () => {
    expect(screen).toContain("Mistakes grow your brain!");
    expect(screen).toContain("Your next game starts with a full heart row!");
    // No fail-state vocabulary anywhere in the screen.
    expect(screen).not.toMatch(/you failed|you lost|game over/i);
  });

  it("the store mirrors the engine transition and computes nothing", () => {
    // Hearts state enters the store ONLY from the engine's start
    // payload; the response mirror requires BOTH a hearts session AND
    // the engine's transition (a non-hearts session can never gain
    // hearts through the reducer).
    expect(store).toContain("heartsRemaining: action.start.heartsRemaining");
    expect(store).toContain("state.heartsRemaining !== null && action.hearts");
    // No hearts MATH in the store: the count constant and the predicate
    // are engine-only (comments mention them; code must not).
    const storeCode = store.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(storeCode).not.toContain("HEART_COUNT");
    expect(storeCode).not.toContain("shouldMountHearts");
  });

  it("the engine mounts hearts ONLY through the core-engine D6 predicate", () => {
    expect(engineSource).toContain("shouldMountHearts(params.gradeId, params.stage)");
    expect(engineSource).toContain("heartStateAfterResponse(session.heartsRemaining");
    expect(engineSource).toContain("heartsSessionEndReason(remaining)");
  });

  it("HeartsDisplay is shape+color redundant, exact-count for screen readers, and static", () => {
    const display = readFileSync(`${repoRoot}/apps/mobile/src/games/HeartsDisplay.tsx`, "utf8");
    // Shape redundancy: FILLED vs OUTLINE glyphs carry the state, so
    // color is never the only channel (D6 kid-facing doctrine).
    expect(display).toContain("\\u2665");
    expect(display).toContain("\\u2661");
    // A11y: the exact remaining count rides the label, not just glyphs.
    expect(display).toContain("hearts left");
    expect(display).toContain("accessibilityLabel={label}");
    // Static + display-only: no animation primitives, timers, or
    // pressables (reduced-motion safe by construction, nothing tappable).
    expect(display).not.toMatch(/Animated|setTimeout|setInterval|Pressable|onPress/);
  });
});
