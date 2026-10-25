/**
 * Placement session-engine specs (issue #60) — the THIN client adapter
 * over the core-engine placement module, run against the REAL node
 * storage harness (append-only attempt log + topic-progress projection
 * + the #55 gamification seam):
 *
 * - determinism per seed across the full adapter (same pack, same seed,
 *   same policy => identical engine question sequence);
 * - every answer lands as an append-only PLACEMENT attempt carrying the
 *   #48 facts (motor baseline, raw time, session id);
 * - complete() derives the SAME outcome the server's replay will derive
 *   from the drained attempt stream (the client/server D8 seam — same
 *   facts, same engine call, agreement by construction, PINNED here);
 * - provisional credit is stability-only: completed 0, crowns 0,
 *   provisional flag set, band (0, 4]; a practice-earned stability is
 *   never regressed and practice completion state is never overwritten;
 * - NO unit-progress rows are ever written (placement recommends; it
 *   never unlocks/awards — the #51 gate/key path stays untouched);
 * - per-attempt XP projects through the shared #55 rules (> 0 with
 *   correct answers); the celebration report is present for the mascot.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { derivePlacementOutcome, PLACEMENT_RULES } from "@balashikshana/core-engine";
import { PlacementSessionEngine } from "../src/placement/session";
import type { PlacementItemView } from "../src/placement/session";
import { createPracticeEnv, type PracticeTestEnv } from "./helpers/practiceEnv";
import type { PackContentReader, PracticeDeps } from "../src/practice/types";

/** Two-strand fixture pack (math 6 units, ela 5 units; 2 topics each). */
function fixtureUnitRows() {
  const rows: {
    unit_id: string;
    grade_id: string;
    subject: string;
    sequence_order: number;
    title: string;
    prerequisite_unit_ids_json: string;
    gate_question_count: number;
    gate_min_accuracy_pct: number;
    gate_max_speed_sec: number;
    gate_streak_req: number;
  }[] = [];
  for (let i = 1; i <= 6; i += 1) {
    rows.push({
      unit_id: `K-M${i}`,
      grade_id: "kindergarten",
      subject: "math",
      sequence_order: i * 2,
      title: `Math ${i}`,
      prerequisite_unit_ids_json: i === 1 ? "[]" : JSON.stringify([`K-M${i - 1}`]),
      gate_question_count: 6,
      gate_min_accuracy_pct: 80,
      gate_max_speed_sec: 6,
      gate_streak_req: 4,
    });
  }
  for (let i = 1; i <= 5; i += 1) {
    rows.push({
      unit_id: `K-E${i}`,
      grade_id: "kindergarten",
      subject: "ela",
      sequence_order: i * 2 + 1,
      title: `ELA ${i}`,
      prerequisite_unit_ids_json: i === 1 ? "[]" : JSON.stringify([`K-E${i - 1}`]),
      gate_question_count: 6,
      gate_min_accuracy_pct: 80,
      gate_max_speed_sec: 8,
      gate_streak_req: 4,
    });
  }
  return rows;
}

function fixtureTopicRows() {
  const rows: {
    topic_id: string;
    unit_id: string;
    grade_id: string;
    subject: string;
    topic_code: string;
    topic_name: string;
    sequence_order: number;
    assets_json: string;
  }[] = [];
  for (const unit of fixtureUnitRows()) {
    for (const [n, code] of ["A", "B"].entries()) {
      rows.push({
        topic_id: `${unit.unit_id}-${code}`,
        unit_id: unit.unit_id,
        grade_id: "kindergarten",
        subject: unit.subject,
        topic_code: code,
        topic_name: `${unit.title} topic ${code}`,
        sequence_order: n + 1,
        assets_json: "{}",
      });
    }
  }
  return rows;
}

/** A deps set whose openContent serves the fixture pack (rows only). */
function placementDeps(env: PracticeTestEnv): PracticeDeps {
  const reader: PackContentReader = {
    async gradePolicy() {
      return {
        gradeId: "kindergarten",
        srGrowthFactor: 1.85,
        srMaxIntervalDays: 30,
        baseScheduleDays: [1, 2, 4, 8, 15, 30],
      };
    },
    async unit() {
      return null;
    },
    async unitsForGrade() {
      return fixtureUnitRows();
    },
    async topicsForUnit(unitId) {
      return fixtureTopicRows().filter((t) => t.unit_id === unitId);
    },
    async topicsForGrade() {
      return fixtureTopicRows();
    },
    async topic(topicId) {
      return fixtureTopicRows().find((t) => t.topic_id === topicId) ?? null;
    },
    async questionsForTopic() {
      return [];
    },
    async questionsForUnit() {
      return [];
    },
  };
  return {
    storage: env.storage,
    openContent: async () => reader,
    now: env.deps.now,
    newSessionId: env.deps.newSessionId,
    motorBaselineSec: 0.42,
    gamificationStorage: env.gamification ?? undefined,
  };
}

type Policy = (unitId: string, kind: "probe" | "confirm") => boolean;

/** Drives the adapter like the screen does (grading by correctAnswer). */
async function runPlacement(
  env: PracticeTestEnv,
  policy: Policy,
  seed?: number,
): Promise<{
  summary: ReturnType<PlacementSessionEngine["complete"]> extends Promise<infer T> ? T : never;
  items: PlacementItemView[];
}> {
  const engine = new PlacementSessionEngine(placementDeps(env));
  const start = await engine.start({
    studentId: "stu-place",
    gradeId: "kindergarten",
    ...(seed !== undefined ? { seed } : {}),
  });
  const items: PlacementItemView[] = [];
  if (start.firstItem) items.push(start.firstItem);
  let current = start.firstItem;
  let guard = 0;
  while (current && guard < 40) {
    guard += 1;
    const isCorrect =
      current.question.correctAnswer !== "" ? policy(current.unitId, current.kind) : true;
    const next = await engine.submit(start.sessionId, {
      questionId: current.question.questionId,
      chosenAnswer: isCorrect ? String(current.question.correctAnswer) : "__wrong__",
      isCorrect,
      rawTimeSec: 3.0,
      audioDurationSec: 0,
    });
    current = next;
    if (next) items.push(next);
  }
  const summary = await engine.complete(start.sessionId);
  return { summary, items };
}

describe("PlacementSessionEngine (thin adapter over the engine module)", () => {
  let env: PracticeTestEnv;

  beforeEach(() => {
    env = createPracticeEnv();
  });

  afterEach(() => {
    env.dispose();
  });

  it("deterministic per seed: identical policy + seed => identical question sequence", async () => {
    const policy: Policy = (unitId) => unitId.endsWith("1") || unitId.endsWith("2");
    const a = await runPlacement(env, policy, 99);
    const b = await runPlacement(env, policy, 99);
    expect(a.items.map((i) => i.question.questionId)).toEqual(
      b.items.map((i) => i.question.questionId),
    );
    expect(a.items.length).toBe(b.items.length);
  });

  it("bounds the session: all-correct stops at chain ends (under the cap), mixed stops on confirmed frontiers", async () => {
    const strong = await runPlacement(env, () => true, 5);
    // The fixture's strands are 6 (math) + 5 (ela) units: an all-correct
    // child walks both to CHAIN END in 11 items — under the 14-item hard
    // cap (the cap binds only on longer chains; the engine suite pins
    // the exactly-at-14 boundary there).
    expect(strong.items.length).toBe(11);
    expect(strong.items.length).toBeLessThanOrEqual(PLACEMENT_RULES.maxItems);
    const weak = await runPlacement(env, () => false, 5);
    // 2 strands x (probe + confirm) = 4 items — the confidence rule.
    expect(weak.items.length).toBe(4);
  });

  it("records every answer as an append-only PLACEMENT attempt with the #48 facts", async () => {
    const { summary } = await runPlacement(env, (unitId) => unitId.endsWith("1"), 7);
    const drained = await env.storage.drainUnsynced("stu-place", 100);
    expect(drained.length).toBe(summary.itemsAsked);
    for (const row of drained) {
      expect(row.session_type).toBe("PLACEMENT");
      expect(row.motor_baseline_sec).toBe(0.42);
      expect(row.session_id).toBeTruthy();
      expect(row.synced).toBe(0);
    }
  });

  it("D8 seam: complete()'s outcome equals derivePlacementOutcome over the drained stream", async () => {
    const { summary } = await runPlacement(
      env,
      (unitId, kind) => kind === "confirm" || unitId.endsWith("1"),
      11,
    );
    const drained = await env.storage.drainUnsynced("stu-place", 100);
    const responses = drained.map((row) => ({
      unitId: row.unit_id,
      topicId: row.topic_id,
      isCorrect: row.is_correct === 1,
    }));
    const replayed = derivePlacementOutcome({
      responses,
      units: fixtureUnitRows().map((u) => ({
        unitId: u.unit_id,
        strand: u.subject,
        sequenceOrder: u.sequence_order,
        title: u.title,
        prerequisiteUnitIds: JSON.parse(u.prerequisite_unit_ids_json) as string[],
        masteryGate: { maxMedianResponseTimeSec: u.gate_max_speed_sec },
      })),
    });
    // The server replays the SAME facts through the SAME engine call:
    // identical recommendation, credit, and cap posture, by construction.
    expect(replayed.recommendedStartUnitId).toBe(summary.outcome.recommendedStartUnitId);
    expect(replayed.creditedUnits.map((u) => u.unitId).sort()).toEqual(
      summary.outcome.creditedUnits.map((u) => u.unitId).sort(),
    );
    expect(replayed.skipAheadUnitCount).toBe(summary.outcome.skipAheadUnitCount);
    expect(replayed.keysAwarded).toEqual([]);
  });

  it("provisional credit is stability-only: never completes, crowns, or writes unit rows", async () => {
    const { summary } = await runPlacement(env, (unitId) => unitId.endsWith("1"), 13);
    expect(summary.creditedTopics.length).toBeGreaterThan(0);
    for (const credited of summary.creditedTopics) {
      const row = await env.storage.getTopicProgress("stu-place", credited.topicId);
      expect(row).not.toBeNull();
      expect(row?.completed).toBe(0);
      expect(row?.crowns).toBe(0);
      expect(row?.masteryScore).toBe(0);
      expect(row?.provisional).toBe(true);
      expect(row?.stabilityDays).toBeGreaterThan(0);
      expect(row?.stabilityDays).toBeLessThanOrEqual(4);
    }
    // Placement NEVER touches unit progress (no unlock, no key path).
    expect(await env.storage.allUnitProgress("stu-place")).toEqual([]);
  });

  it("never regresses a practice-earned stability or completion state", async () => {
    const topicId = "K-M1-A";
    await env.storage.upsertTopicProgress({
      studentId: "stu-place",
      topicId,
      unitId: "K-M1",
      topicCode: "A",
      completed: 1,
      crowns: 2,
      masteryScore: 80,
      bestAccuracyPct: 100,
      bestMedianSpeedSec: 2,
      attemptsCount: 5,
      fluencyGrade: 4,
      stabilityDays: 21,
      nextReviewAt: 9,
      lastReviewedAt: 1,
      provisional: false,
      updatedAt: 1,
    });
    const { summary } = await runPlacement(env, () => true, 21);
    const row = await env.storage.getTopicProgress("stu-place", topicId);
    expect(row).not.toBeNull();
    expect(row?.completed).toBe(1);
    expect(row?.crowns).toBe(2);
    expect(row?.stabilityDays).toBe(21);
    expect(summary.creditedTopics.find((t) => t.topicId === topicId)?.stabilityDays ?? 0).toBe(21);
  });

  it("projects per-attempt XP through the shared #55 rules and builds the celebration report", async () => {
    const { summary } = await runPlacement(env, () => true, 31);
    expect(summary.xpAwarded).toBeGreaterThan(0);
    expect(summary.celebration).toBeTruthy();
    expect(typeof summary.celebration.leveledUp).toBe("boolean");
  });

  it("an all-wrong run credits nothing and still completes gently", async () => {
    const { summary } = await runPlacement(env, () => false, 41);
    expect(summary.creditedTopics).toEqual([]);
    expect(summary.outcome.creditedUnits).toEqual([]);
    expect(summary.itemsAsked).toBe(4);
    expect(summary.celebration).toBeTruthy();
  });

  it("complete() forgets the session (double complete is an error, not a second write)", async () => {
    const engine = new PlacementSessionEngine(placementDeps(env));
    const start = await engine.start({ studentId: "stu-place", gradeId: "kindergarten", seed: 3 });
    await engine.complete(start.sessionId);
    await expect(engine.complete(start.sessionId)).rejects.toThrow(/Unknown placement session/);
  });

  it("no installed pack: start throws the no-pack error the screen maps to its retry surface", async () => {
    const engine = new PlacementSessionEngine({
      storage: env.storage,
      openContent: async () => null,
      now: env.deps.now,
      newSessionId: env.deps.newSessionId,
    });
    await expect(engine.start({ studentId: "stu-place", gradeId: "grade-3" })).rejects.toThrow(
      /No content pack installed/,
    );
  });
});
