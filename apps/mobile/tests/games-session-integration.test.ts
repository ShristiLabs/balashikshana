/**
 * Game-session integration (issue #52) — REAL SQLite (node:sqlite)
 * through the PracticeSessionEngine, mirroring the #47/#50/#51
 * harnesses:
 *
 * - spiral composition against a two-unit pack fixture whose topics
 *   carry REAL games asset blocks (test-only pack editor, the
 *   setPackPrereqs precedent): fluency composes the registry 70/20/10
 *   as 6/1/1 at count 8; guided composes current-only;
 * - attempt rows carry the GAME session type + the four local-only
 *   telemetry columns (spiral provenance per item, registry speed
 *   target, archetype, fallback marker);
 * - completion projects EVERY topic the stream served (per-topic
 *   grouping parity with the server's replayGameSession);
 * - the fallback path stamps TOPIC_PRACTICE rows with the marker;
 * - the #48 wire carries GAME session rows with the SAME facts-only
 *   shape (no telemetry keys leak into the upload);
 * - error paths free sync liveness (abandon-on-error, attempts
 *   durable) — the Proxy-over-storage fault injection.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
 
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { computeCognitiveTimeSec } from "@balashikshana/core-engine";
import { PracticeSessionEngine } from "../src/practice/practiceEngine";
import type { PracticeDeps } from "../src/practice/types";
import { SyncEngine } from "../src/sync/syncEngine";
import type { SyncDeps, SyncTransport, SyncUploadResponse } from "../src/sync/types";
import {
  createPracticeEnv,
  FIXTURE_PREREQ_UNIT,
  FIXTURE_UNIT,
  type PracticeTestEnv,
} from "./helpers/practiceEnv";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const syncSource = readFileSync(`${repoRoot}/services/api/sync.mjs`, "utf-8");

const STUDENT = "s1";
const GRADE = "kindergarten";
const UNIT = FIXTURE_UNIT.unitId; // K-M2
const PREREQ = FIXTURE_PREREQ_UNIT.unitId; // K-M1

let env: PracticeTestEnv;

beforeEach(() => {
  env = createPracticeEnv({ prerequisiteUnit: true });
});

afterEach(() => {
  env.dispose();
});

function engineFor(deps: PracticeDeps = env.deps): PracticeSessionEngine {
  return new PracticeSessionEngine(deps);
}

/** Test-only pack editor: writes a topic's assets.games block (before any reader opens). */
function setTopicGames(topicCode: string, unitId: string, games: unknown): void {
  const db = new DatabaseSync(`${env.dir}/pack-kindergarten-v1.0.0.sqlite`);
  try {
    db.prepare("UPDATE skill_topics SET assets_json = ? WHERE topic_id = ?").run(
      JSON.stringify({ games }),
      `${unitId}-${topicCode}`,
    );
  } finally {
    db.close();
  }
}

/** Real-registry-shaped games block (PK-M1 topic A data). */
function registryGamesBlock(
  overrides: {
    guidedArchetype?: string;
    fluencyArchetype?: string;
    targetResponseSpeedSec?: number;
  } = {},
): {
  guidedPracticeGame: Record<string, unknown>;
  fluencySprintGame: Record<string, unknown>;
} {
  return {
    guidedPracticeGame: {
      gameId: `game_guided_${UNIT}_X`,
      stage: "Stage 2: Guided Practice (Untimed)",
      archetype: overrides.guidedArchetype ?? "block-builder",
      title: "Guided Explorer",
      mechanics: "Untimed explorer with hints.",
      targetMasteryScore: 80,
      minQuestionsToComplete: 8,
    },
    fluencySprintGame: {
      gameId: `game_fluency_${UNIT}_X`,
      stage: "Stage 3: Fluency Zone (Timed Automaticity)",
      archetype: overrides.fluencyArchetype ?? "block-builder",
      title: "Fluency Blitz",
      mechanics: "Fast-paced sprint.",
      targetResponseSpeedSec: overrides.targetResponseSpeedSec ?? 5.5,
      spiralMix: { currentTopic: 0.7, contrastivePrerequisite: 0.2, spacedReview: 0.1 },
    },
  };
}

async function seedDueReview(
  topicId: string,
  stabilityDays = 2,
  unitId: string = PREREQ,
): Promise<void> {
  await env.storage.upsertTopicProgress({
    studentId: STUDENT,
    topicId,
    unitId,
    topicCode: topicId.slice(unitId.length + 1),
    completed: 1,
    crowns: 1,
    masteryScore: 80,
    bestAccuracyPct: 80,
    bestMedianSpeedSec: 3,
    attemptsCount: 1,
    fluencyGrade: 3,
    stabilityDays,
    nextReviewAt: env.clock.nowMs - 1,
    lastReviewedAt: env.clock.nowMs - 5 * 86_400_000,
    provisional: true,
    updatedAt: env.clock.nowMs,
  });
}

function attemptRows(): {
  session_type: string;
  topic_id: string;
  game_spiral_provenance: string;
  game_target_speed_sec: number;
  game_archetype: string;
  game_fallback: number;
}[] {
  return env.storage.db
    .prepare(
      "SELECT session_type, topic_id, game_spiral_provenance, game_target_speed_sec, game_archetype, game_fallback FROM attempt_log ORDER BY id ASC",
    )
    .all() as ReturnType<typeof attemptRows>;
}

function withFailingStorage(env: PracticeTestEnv, method: "insertAttempt" | "upsertTopicProgress") {
  let armed = false;
  const storage = new Proxy(env.deps.storage, {
    get(target, prop, receiver) {
      if (prop === method && armed) {
        return async () => {
          throw new Error(`sqlite: ${method} failed (simulated disk fault)`);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return {
    deps: { ...env.deps, storage } as PracticeDeps,
    arm() {
      armed = true;
    },
  };
}

describe("game-session composition (registry 70/20/10 over the two-unit pack)", () => {
  it("fluency composes 6 current / 1 contrastive / 1 spaced-review with per-item provenance", async () => {
    setTopicGames("G", UNIT, registryGamesBlock());
    await seedDueReview(`${PREREQ}-D`);
    const engine = engineFor();
    const start = await engine.startGameSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
      topicCode: "G",
      stage: "fluency",
      motorBaselineSec: 0.42,
    });

    expect(start.stage).toBe("fluency");
    expect(start.archetype).toBe("block-builder");
    expect(start.gameTitle).toBe("Fluency Blitz");
    expect(start.targetResponseSpeedSec).toBe(5.5);
    // Derivation parity: the UNIT gate speed, never the game target.
    expect(start.targetSpeedSec).toBe(FIXTURE_UNIT.gateMaxSpeedSec);
    expect(start.questions).toHaveLength(8);
    expect(start.questions.filter((q) => q.unitId === UNIT)).toHaveLength(6);
    expect(start.questions.filter((q) => q.unitId === PREREQ)).toHaveLength(2);
    // Provenance: prereq-unit items split contrastive vs spaced-review.
    const provenances = start.questions.map((q) => start.provenanceByQuestionId[q.questionId]);
    expect(provenances.filter((p) => p === "current")).toHaveLength(6);
    expect(provenances.filter((p) => p === "contrastive")).toHaveLength(1);
    expect(provenances.filter((p) => p === "spaced-review")).toHaveLength(1);
    // The spaced-review item is the seeded due topic (most-forgotten).
    const reviewQuestion = start.questions.find(
      (q) => start.provenanceByQuestionId[q.questionId] === "spaced-review",
    );
    expect(reviewQuestion?.topicId).toBe(`${PREREQ}-D`);
  });

  it("guided composes current-only and carries no speed target (untimed)", async () => {
    setTopicGames("G", UNIT, registryGamesBlock());
    await seedDueReview(`${PREREQ}-D`);
    const engine = engineFor();
    const start = await engine.startGameSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
      topicCode: "G",
      stage: "guided",
    });
    expect(start.questions).toHaveLength(8);
    expect(start.questions.every((q) => q.unitId === UNIT)).toBe(true);
    expect(start.targetResponseSpeedSec).toBe(0);
    expect(Object.values(start.provenanceByQuestionId).every((p) => p === "current")).toBe(true);
  });

  it("a topic without a games config rejects the GAME start (host falls back before this)", async () => {
    const engine = engineFor();
    await expect(
      engine.startGameSession({
        studentId: STUDENT,
        gradeId: GRADE,
        unitId: UNIT,
        topicCode: "G",
        stage: "fluency",
      }),
    ).rejects.toThrow("no fluency game config");
  });
});

describe("game-session telemetry + completion (per-topic projection parity)", () => {
  it("records GAME rows with per-item telemetry, then projects EVERY topic served", async () => {
    setTopicGames("G", UNIT, registryGamesBlock());
    await seedDueReview(`${PREREQ}-D`);
    const engine = engineFor();
    const start = await engine.startGameSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
      topicCode: "G",
      stage: "fluency",
      motorBaselineSec: 0.42,
    });

    for (const question of start.questions) {
      await engine.submitResponse(start.sessionId, {
        topicCode: question.topicCode,
        questionId: question.questionId,
        chosenAnswer: question.correctAnswer,
        isCorrect: true,
        rawTimeSec: 2,
        audioDurationSec: 0,
      });
    }

    // Every row: GAME type, archetype, target, no fallback, and the
    // item's OWN provenance bucket (foreign items are never tagged
    // "current").
    const rows = attemptRows();
    expect(rows).toHaveLength(8);
    for (const row of rows) {
      expect(row.session_type).toBe("GAME");
      expect(row.game_archetype).toBe("block-builder");
      expect(row.game_target_speed_sec).toBe(5.5);
      expect(row.game_fallback).toBe(0);
    }
    const foreignRows = rows.filter((r) => r.topic_id !== `${UNIT}-G`);
    expect(foreignRows).toHaveLength(2);
    for (const row of foreignRows) {
      expect(["contrastive", "spaced-review"]).toContain(row.game_spiral_provenance);
    }
    expect(
      rows
        .filter((r) => r.topic_id === `${UNIT}-G`)
        .every((r) => r.game_spiral_provenance === "current"),
    ).toBe(true);

    const summary = await engine.completeGameSession(start.sessionId);
    expect(summary.metGoal).toBe(true); // 100% accuracy, raw 2s <= 5.5s
    expect(summary.accuracyPct).toBe(100);
    expect(summary.speed.medianRawSec).toBe(2);
    expect(summary.speed.beatTargetPct).toBe(100);
    expect(summary.provenanceCounts).toEqual({ current: 6, contrastive: 1, "spaced-review": 1 });
    // Per-topic projection: all three topics the stream served.
    expect(summary.perTopic).toHaveLength(3);
    const currentRow = await env.storage.getTopicProgress(STUDENT, `${UNIT}-G`);
    const prereqRow = await env.storage.getTopicProgress(STUDENT, `${PREREQ}-E`);
    const reviewRow = await env.storage.getTopicProgress(STUDENT, `${PREREQ}-D`);
    expect(currentRow?.completed).toBe(1);
    expect(currentRow?.unitId).toBe(UNIT);
    expect(currentRow?.topicCode).toBe("G");
    expect(currentRow?.attemptsCount).toBe(1);
    // Foreign topics: unit attribution is their own; topicCode is the
    // full namespaced id (the server replay rule for foreign topics).
    expect(prereqRow?.unitId).toBe(PREREQ);
    expect(prereqRow?.topicCode).toBe(`${PREREQ}-E`);
    expect(reviewRow?.unitId).toBe(PREREQ);
    expect(reviewRow?.topicCode).toBe(`${PREREQ}-D`);
    expect(prereqRow?.completed).toBe(1);
    // Session closed.
    expect(engine.activeSessionIds()).toEqual([]);
  });

  it("a missing topic group stays missing: per-topic derivation only from that topic's items", async () => {
    setTopicGames("G", UNIT, registryGamesBlock());
    const engine = engineFor();
    const start = await engine.startGameSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
      topicCode: "G",
      stage: "guided",
    });
    // 2 correct, 6 wrong on the current topic: 25% - not completed.
    for (const [i, question] of start.questions.entries()) {
      const correct = i < 2;
      await engine.submitResponse(start.sessionId, {
        topicCode: question.topicCode,
        questionId: question.questionId,
        chosenAnswer: correct ? question.correctAnswer : "definitely-wrong",
        isCorrect: correct,
        rawTimeSec: 2,
      });
    }
    const summary = await engine.completeGameSession(start.sessionId);
    expect(summary.metGoal).toBe(false);
    expect(summary.accuracyPct).toBe(25);
    const row = await env.storage.getTopicProgress(STUDENT, `${UNIT}-G`);
    expect(row?.completed).toBe(0);
    expect(row?.bestAccuracyPct).toBe(25);
  });
});

describe("fallback path (unsupported archetype -> #50 practice runner)", () => {
  it("stamps TOPIC_PRACTICE rows with the intended archetype + fallback marker", async () => {
    // No games block needed for the fallback: the HOST resolves the
    // route before any session; the engine seam is the telemetry stamp.
    const engine = engineFor();
    const start = await engine.startTopicSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
      topicCode: "G",
      motorBaselineSec: 0.42,
      gameTelemetry: {
        spiralProvenance: "",
        targetResponseSpeedSec: 5.5,
        archetype: "bubble-pop-blitz",
        fallback: true,
      },
    });
    expect(start.sessionId).toBeTruthy();
    for (const question of start.questions.slice(0, 3)) {
      await engine.submitResponse(start.sessionId, {
        topicCode: question.topicCode,
        questionId: question.questionId,
        chosenAnswer: question.correctAnswer,
        isCorrect: true,
        rawTimeSec: 2,
      });
    }
    const rows = attemptRows();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.session_type).toBe("TOPIC_PRACTICE");
      expect(row.game_archetype).toBe("bubble-pop-blitz");
      expect(row.game_fallback).toBe(1);
      expect(row.game_spiral_provenance).toBe(""); // not spiral-composed
      expect(row.game_target_speed_sec).toBe(5.5);
    }
    // Plain practice sessions leave the telemetry columns at defaults.
    const plain = await engine.startTopicSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
      topicCode: "H",
    });
    await engine.submitResponse(plain.sessionId, {
      topicCode: "H",
      questionId: plain.questions[0]!.questionId,
      chosenAnswer: plain.questions[0]!.correctAnswer,
      isCorrect: true,
      rawTimeSec: 2,
    });
    const lastRow = attemptRows().at(-1)!;
    expect(lastRow.game_archetype).toBe("");
    expect(lastRow.game_fallback).toBe(0);
  });
});

describe("#48 wire: GAME rows ride the existing facts-only pipeline", () => {
  class FakeTransport implements SyncTransport {
    wire: import("../src/sync/types").SyncAttemptWire[] = [];
    async uploadAttempts(
      attempts: import("../src/sync/types").SyncAttemptWire[],
    ): Promise<SyncUploadResponse> {
      this.wire = attempts;
      return {
        ackedSeqs: attempts.map((a) => a.seq),
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

  it("drains GAME rows whole-session and maps them to the wire WITHOUT telemetry keys", async () => {
    setTopicGames("G", UNIT, registryGamesBlock());
    const engine = engineFor();
    const start = await engine.startGameSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
      topicCode: "G",
      stage: "guided",
    });
    for (const question of start.questions.slice(0, 4)) {
      await engine.submitResponse(start.sessionId, {
        topicCode: question.topicCode,
        questionId: question.questionId,
        chosenAnswer: question.correctAnswer,
        isCorrect: true,
        rawTimeSec: 2,
      });
    }
    await engine.completeGameSession(start.sessionId);

    const transport = new FakeTransport();
    const sync = new SyncEngine({
      storage: env.storage,
      transport,
      connectivity: { isOnline: async () => true },
      isActiveSession: (id: string) => engine.activeSessionIds().includes(id),
    } as unknown as SyncDeps);
    const result = await sync.sync(STUDENT);
    expect(result.outcome).toBe("synced");
    expect(transport.wire).toHaveLength(4);
    for (const wire of transport.wire) {
      expect(wire.sessionType).toBe("GAME");
      // The wire is FACTS ONLY: no game telemetry keys ever travel.
      expect(Object.keys(wire).sort()).toEqual([
        "answeredAtMs",
        "audioDurationSec",
        "chosenAnswer",
        "isCorrect",
        "misconceptionTags",
        "motorBaselineSec",
        "questionId",
        "rawTimeSec",
        "seq",
        "sessionId",
        "sessionType",
        "topicId",
        "unitId",
      ]);
    }
  });
});

describe("error paths free sync liveness (#50/#51 doctrine)", () => {
  it("a throwing submitResponse strands liveness until the game screen abandons", async () => {
    setTopicGames("G", UNIT, registryGamesBlock());
    const failing = withFailingStorage(env, "insertAttempt");
    const engine = new PracticeSessionEngine(failing.deps);
    const start = await engine.startGameSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
      topicCode: "G",
      stage: "fluency",
    });
    const first = start.questions[0]!;
    await engine.submitResponse(start.sessionId, {
      topicCode: first.topicCode,
      questionId: first.questionId,
      chosenAnswer: first.correctAnswer,
      isCorrect: true,
      rawTimeSec: 2,
    });
    failing.arm();
    const second = start.questions[1]!;
    await expect(
      engine.submitResponse(start.sessionId, {
        topicCode: second.topicCode,
        questionId: second.questionId,
        chosenAnswer: second.correctAnswer,
        isCorrect: true,
        rawTimeSec: 2,
      }),
    ).rejects.toThrow("insertAttempt failed");
    expect(engine.activeSessionIds()).toContain(start.sessionId);
    expect(engine.abandonSession(start.sessionId)).toBe(true);
    expect(engine.activeSessionIds()).toEqual([]);
    expect(await env.deps.storage.unsyncedAttemptCount(STUDENT)).toBe(1);
  });

  it("a throwing completeGameSession strands liveness until abandon; attempts durable", async () => {
    setTopicGames("G", UNIT, registryGamesBlock());
    const failing = withFailingStorage(env, "upsertTopicProgress");
    const engine = new PracticeSessionEngine(failing.deps);
    const start = await engine.startGameSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
      topicCode: "G",
      stage: "guided",
    });
    for (const question of start.questions) {
      await engine.submitResponse(start.sessionId, {
        topicCode: question.topicCode,
        questionId: question.questionId,
        chosenAnswer: question.correctAnswer,
        isCorrect: true,
        rawTimeSec: 2,
      });
    }
    failing.arm();
    await expect(engine.completeGameSession(start.sessionId)).rejects.toThrow(
      "upsertTopicProgress failed",
    );
    expect(engine.activeSessionIds()).toContain(start.sessionId);
    expect(engine.abandonSession(start.sessionId)).toBe(true);
    expect(await env.deps.storage.unsyncedAttemptCount(STUDENT)).toBe(8);
  });
});

describe("GAME attempts are audio-aware; topic practice stays audio-0 (both-sides rule)", () => {
  it("GAME rows derive cognitive time WITH audio; TOPIC_PRACTICE rows ignore it", async () => {
    setTopicGames("G", UNIT, registryGamesBlock());
    const engine = engineFor();
    const game = await engine.startGameSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
      topicCode: "G",
      stage: "guided",
      motorBaselineSec: 0.42,
    });
    // A long narration on the game item: the GAME rule (audio-aware,
    // mirroring the server's isTopic === TOPIC_PRACTICE branch) must
    // subtract it from cognitive time.
    const q = game.questions[0]!;
    await engine.submitResponse(game.sessionId, {
      topicCode: q.topicCode,
      questionId: q.questionId,
      chosenAnswer: q.correctAnswer,
      isCorrect: true,
      rawTimeSec: 9,
      audioDurationSec: 6,
    });
    const topic = await engine.startTopicSession({
      studentId: STUDENT,
      gradeId: GRADE,
      unitId: UNIT,
      topicCode: "H",
      motorBaselineSec: 0.42,
    });
    const tq = topic.questions[0]!;
    await engine.submitResponse(topic.sessionId, {
      topicCode: tq.topicCode,
      questionId: tq.questionId,
      chosenAnswer: tq.correctAnswer,
      isCorrect: true,
      rawTimeSec: 9,
      audioDurationSec: 6,
    });
    const rows = env.storage.db
      .prepare(
        "SELECT session_type, raw_time_sec, audio_duration_sec, cognitive_time_sec FROM attempt_log ORDER BY id ASC",
      )
      .all() as {
      session_type: string;
      raw_time_sec: number;
      audio_duration_sec: number;
      cognitive_time_sec: number;
    }[];
    expect(rows).toHaveLength(2);
    const [gameRow, topicRow] = rows;
    // The engine's cognitive-time formula (core-engine, both sides):
    // max(0.5, raw - motorBaseline - audio) with a 0.5s floor.
    expect(gameRow!.session_type).toBe("GAME");
    expect(gameRow!.cognitive_time_sec).toBe(computeCognitiveTimeSec(9, 0.42, 6));
    // The topic row uses audio 0 (the online topic path's rule).
    expect(topicRow!.session_type).toBe("TOPIC_PRACTICE");
    expect(topicRow!.cognitive_time_sec).toBe(computeCognitiveTimeSec(9, 0.42, 0));
  });
});

describe("server parity tripwires (source scans)", () => {
  it("the server accepts GAME sessions and replays them per-topic (never gold-verification)", () => {
    expect(syncSource).toContain('"TOPIC_PRACTICE", "GATE", "GOLD_VERIFICATION", "GAME"');
    expect(syncSource).toContain('sessionType === "GAME"');
    expect(syncSource).toContain("await replayGameSession(");
    // The per-topic grouping rule this file's completion mirrors.
    expect(syncSource).toContain("groupOf(item.a.topicId).items.push(item)");
  });

  it("the OpenAPI baseline carries the additive GAME + PLACEMENT enum values", () => {
    const baseline = readFileSync(`${repoRoot}/docs/openapi/baseline.yaml`, "utf-8");
    // (?<!-) excludes the tail of "x-extensible-enum:" lines, which
    // would otherwise also match the bare "enum: [" prefix.
    // #52 grew the closed AttemptInput enum by GAME; #60 grew it again
    // by PLACEMENT (the same additive precedent, pinned here).
    expect(
      baseline.match(/(?<!-)enum: \[TOPIC_PRACTICE, GATE, GOLD_VERIFICATION, GAME, PLACEMENT\]/g),
    ).toHaveLength(1);
    // The ledger's response enum cannot grow without breaking the
    // oasdiff additive-only gate, so #60 keeps the legacy closed enum
    // byte-identical and declares the PLACEMENT growth via the
    // x-extensible-enum extension (non-breaking by oasdiff doctrine).
    expect(
      baseline.match(/(?<!-)enum: \[TOPIC_PRACTICE, GATE, GOLD_VERIFICATION, GAME\]/g),
    ).toHaveLength(1);
    expect(baseline).toContain(
      "x-extensible-enum: [TOPIC_PRACTICE, GATE, GOLD_VERIFICATION, GAME, PLACEMENT]",
    );
    // #60 also added the placement record read.
    expect(baseline).toContain("/api/placement/record:");
  });
});
