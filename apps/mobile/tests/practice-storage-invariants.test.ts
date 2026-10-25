/**
 * Storage-layer invariant tests (issue #47, tester pass):
 *
 * 1. REOPEN PERSISTENCE — sequence ids stay strictly monotonic when the
 *    database is CLOSED and REOPENED (simulating an app restart between
 *    sessions), not just across in-memory instances.
 * 2. MUTATION SURFACE — every SQL write in both adapters (production
 *    nativePractice.ts and test practiceEnv.ts) is classified: only
 *    attempt_log INSERTs and topic_progress/unit_progress upserts
 *    exist; attempt_log never carries a conflict clause.
 * 3. CRASH BETWEEN ATTEMPT AND PROJECTION — attempts are durable the
 *    moment they are answered; a lost (never-completed) session leaves
 *    the log intact and a replayed session re-derives the identical
 *    projection (deterministic engine = D8 recovery story).
 */
import { describe, expect, it } from "vitest";
// eslint-disable-next-line import/no-unresolved
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AttemptRecorder } from "../src/practice/attemptRecorder";
import { PracticeSessionEngine } from "../src/practice/practiceEngine";
import { CONTENT_DB_NAME } from "../src/content/schema";
import type { AttemptInput } from "../src/practice/types";
import { NodePracticeStorage, runMigrations, type FakeClock } from "./helpers/practiceEnv";

function attempt(n: number, sessionId: string): AttemptInput {
  return {
    studentId: "s1",
    unitId: "K-M2",
    topicId: "K-M2-G",
    questionId: `K-M2-G-Q${n}`,
    interactionType: "multiple-choice",
    chosenAnswer: String(n),
    isCorrect: true,
    rawTimeSec: 2,
    audioDurationSec: 0,
    cognitiveTimeSec: 1.58,
    fluencyGrade: 3,
    misconceptionTags: [],
    sessionType: "TOPIC_PRACTICE",
    sessionId,
    motorBaselineSec: 0.42,
  };
}

describe("reopen persistence: monotonic ids across app restarts", () => {
  it("seq continues strictly upward after close + reopen of the same file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "practice-reopen-"));
    const file = path.join(dir, CONTENT_DB_NAME);
    try {
      const db1 = new DatabaseSync(file);
      runMigrations(db1);
      const storage1 = new NodePracticeStorage(db1);
      const clock: FakeClock = {
        nowMs: 1000,
        advance() {
          throw new Error("unused");
        },
      };
      const rec1 = new AttemptRecorder({ storage: storage1, now: () => clock.nowMs });
      const first = await rec1.record(attempt(1, "sess-1"));
      const second = await rec1.record(attempt(2, "sess-1"));
      db1.close(); // app restart

      const db2 = new DatabaseSync(file);
      const storage2 = new NodePracticeStorage(db2);
      const rec2 = new AttemptRecorder({ storage: storage2, now: () => clock.nowMs });
      const third = await rec2.record(attempt(3, "sess-2"));
      const fourth = await rec2.record(attempt(4, "sess-3"));
      expect(third.seq).toBeGreaterThan(second.seq);
      expect(fourth.seq).toBeGreaterThan(third.seq);
      expect(second.seq).toBeGreaterThan(first.seq);
      // No gaps introduced by the restart: ids are contiguous.
      const ids = db2.prepare("SELECT id FROM attempt_log ORDER BY id").all() as unknown as {
        id: number;
      }[];
      expect(ids.map((r) => r.id)).toEqual([first.seq, second.seq, third.seq, fourth.seq]);
      db2.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SQL mutation surface of both adapters", () => {
  const files = {
    "src/practice/nativePractice.ts": path.join(
      __dirname,
      "..",
      "src",
      "practice",
      "nativePractice.ts",
    ),
    "tests/helpers/practiceEnv.ts": path.join(__dirname, "helpers", "practiceEnv.ts"),
  };

  for (const [label, file] of Object.entries(files)) {
    it(`${label}: writes only attempt_log (plain INSERT), topic_progress and unit_progress (upsert)`, () => {
      const source = fs.readFileSync(file, "utf8").replace(/\s+/g, " ");
      const insertTables = [...source.matchAll(/INSERT INTO (\w+)/g)].map((m) => m[1]);
      expect(insertTables.length).toBeGreaterThan(0);
      // The pack-fixture builder in the helper also inserts pack rows —
      // allowed only in the helper, never in production code.
      // #55: gamification_state is the optimistic reward projection's
      // upsert target — the same projector-owned full-row write doctrine
      // as the two progress tables.
      // #57: reminder_settings is the device-local parent settings
      // singleton (schema v7) — upserted only by the parent surface's
      // adapter with an engine-rule validation gate.
      const allowed = label.startsWith("tests/")
        ? [
            "attempt_log",
            "topic_progress",
            "unit_progress",
            "gamification_state",
            "session_outcomes",
            "reminder_settings",
            "pack_meta",
            "pack_info",
            "grades",
            "units",
            "skill_topics",
            "practice_questions",
          ]
        : [
            "attempt_log",
            "topic_progress",
            "unit_progress",
            "gamification_state",
            "session_outcomes",
            "reminder_settings",
          ];
      for (const table of insertTables) expect(allowed).toContain(table);
      // attempt_log is INSERT ... VALUES with NO conflict clause.
      const attemptSegment = source.split("INSERT INTO attempt_log")[1] ?? "";
      expect(attemptSegment.slice(0, 700)).not.toMatch(/ON CONFLICT/);
      expect(attemptSegment.slice(0, 700)).not.toMatch(/DO UPDATE/);
      // No UPDATE/DELETE statements at all beyond upsert DO UPDATE SET
      // clauses scoped to the two progress tables — with ONE documented
      // #48 exception: the sync worker's synced-flag flip, which must
      // be EXACTLY this statement (never another column, never without
      // the synced = 0 guard).
      const attemptUpdates = [...source.matchAll(/UPDATE attempt_log\s+SET[^"']*/gi)].map((m) =>
        m[0].replace(/\s+/g, " ").trim(),
      );
      const allowedFlip =
        "UPDATE attempt_log SET synced = 1 WHERE student_id = ? AND id <= ? AND synced = 0";
      expect(attemptUpdates.length).toBe(1);
      expect(attemptUpdates[0]).toBe(allowedFlip);
      // #56: session_outcomes follows the SAME append-only doctrine with
      // ONE whitelisted mutation — the sync worker's acked-ids synced
      // flip (never another column, never without the synced = 0 guard).
      const outcomeSegments = source.split("UPDATE session_outcomes SET synced = 1");
      expect(outcomeSegments.length).toBe(2);
      expect(outcomeSegments[1]!.slice(0, 80)).toMatch(/^ WHERE student_id = \? AND id IN \(/);
      expect(outcomeSegments[1]!.slice(0, 220)).toContain(") AND synced = 0");
      expect(source).not.toMatch(/DELETE FROM session_outcomes/i);
      expect(source).not.toMatch(/UPDATE session_outcomes SET (?!synced)/i);
      expect(source).not.toMatch(/DELETE FROM attempt_log/i);
      expect(source).not.toMatch(/DELETE FROM (topic|unit)_progress/i);
      expect(source).not.toMatch(/UPDATE (topic|unit)_progress SET/i);
      // Exactly the progress tables + the gamification projection row
      // carry conflict clauses (projector-owned upserts).
      const conflicts = [
        ...source.matchAll(/ON CONFLICT\(student_id, (topic_id|unit_id)\)/g),
        ...source.matchAll(/ON CONFLICT\(student_id\) DO UPDATE/g),
      ];
      expect(conflicts.length).toBeGreaterThanOrEqual(3);
    });
  }

  it("PracticeStorage interface exposes no mutation of attempts (contract)", () => {
    const source = fs
      .readFileSync(path.join(__dirname, "..", "src", "practice", "types.ts"), "utf8")
      .replace(/\s+/g, " ");
    const storageIface = source.split("export interface PracticeStorage")[1] ?? "";
    expect(storageIface).toContain("insertAttempt");
    expect(storageIface).toContain("unsyncedAttemptCount");
    expect(storageIface).not.toMatch(/updateAttempt|deleteAttempt|markSynced|setSynced/);
  });
});

describe("crash between attempt and projection", () => {
  it("attempts survive a lost session; a replay re-derives the identical projection", async () => {
    const { createPracticeEnv } = await import("./helpers/practiceEnv");
    const env = createPracticeEnv();
    try {
      const answers = [
        { correct: true, rawSec: 2.2 },
        { correct: true, rawSec: 2.4 },
        { correct: true, rawSec: 2.1 },
        { correct: false, rawSec: 5.0 },
        { correct: true, rawSec: 2.3 },
      ];

      // Session 1 "crashes": responses submitted (durable) but never completed.
      const crashed = new PracticeSessionEngine(env.deps);
      const s1 = await crashed.startTopicSession({
        studentId: "s1",
        gradeId: "kindergarten",
        unitId: "K-M2",
        topicCode: "G",
        count: answers.length,
      });
      for (const [i, a] of answers.entries()) {
        await crashed.submitResponse(s1.sessionId, {
          topicCode: "G",
          questionId: s1.questions[i]!.questionId,
          chosenAnswer: a.correct ? s1.questions[i]!.correctAnswer : "x",
          isCorrect: a.correct,
          rawTimeSec: a.rawSec,
        });
      }
      // No completeTopicSession: the engine instance is dropped.
      const durableCount = (
        env.storage.db.prepare("SELECT COUNT(*) n FROM attempt_log").get() as unknown as {
          n: number;
        }
      ).n;
      expect(durableCount).toBe(answers.length);
      expect(await env.deps.storage.unsyncedAttemptCount("s1")).toBe(answers.length);

      // Session 2: the child replays the same session and completes it.
      const replay = new PracticeSessionEngine(env.deps);
      const s2 = await replay.startTopicSession({
        studentId: "s1",
        gradeId: "kindergarten",
        unitId: "K-M2",
        topicCode: "G",
        count: answers.length,
      });
      for (const [i, a] of answers.entries()) {
        await replay.submitResponse(s2.sessionId, {
          topicCode: "G",
          questionId: s2.questions[i]!.questionId,
          chosenAnswer: a.correct ? s2.questions[i]!.correctAnswer : "x",
          isCorrect: a.correct,
          rawTimeSec: a.rawSec,
        });
      }
      const summary = await replay.completeTopicSession(s2.sessionId);

      // Deterministic derivation: same inputs -> the projection a
      // completed session 1 would have produced (accuracy/speed/crowns).
      expect(summary.accuracyPct).toBe(80);
      expect(summary.crownsAwarded).toBe(1);
      expect(summary.topicProgress.attemptsCount).toBe(1); // first COMPLETED session
      // The log kept BOTH batches — append-only truth, no dedup, no loss.
      expect(await env.deps.storage.unsyncedAttemptCount("s1")).toBe(answers.length * 2);
    } finally {
      env.dispose();
    }
  });
});

describe("session edge behavior", () => {
  it("submitResponse rejects a question id that is not part of the session", async () => {
    const { createPracticeEnv } = await import("./helpers/practiceEnv");
    const env = createPracticeEnv();
    try {
      const engine = new PracticeSessionEngine(env.deps);
      const start = await engine.startTopicSession({
        studentId: "s1",
        gradeId: "kindergarten",
        unitId: "K-M2",
        topicCode: "G",
        count: 3,
      });
      await expect(
        engine.submitResponse(start.sessionId, {
          topicCode: "G",
          questionId: "K-M2-G-Q99",
          chosenAnswer: "1",
          isCorrect: true,
          rawTimeSec: 2,
        }),
      ).rejects.toThrow(/not in session/);
    } finally {
      env.dispose();
    }
  });

  it("Gold verification before any gate is refused gracefully", async () => {
    const { createPracticeEnv } = await import("./helpers/practiceEnv");
    const env = createPracticeEnv();
    try {
      const engine = new PracticeSessionEngine(env.deps);
      const status = await engine.goldStatus("s1", "K-M2");
      expect(status.keyState).toBeNull();
      expect(status.eligible).toBe(false);
      expect(status.goldEligibleAtMs).toBe(14 * 3_600_000); // silver 0 -> base window

      const v = await engine.startGoldVerification({
        studentId: "s1",
        gradeId: "kindergarten",
        unitId: "K-M2",
      });
      for (const q of v.questions) {
        await engine.submitResponse(v.sessionId, {
          topicCode: q.topicCode,
          questionId: q.questionId,
          chosenAnswer: q.correctAnswer,
          isCorrect: true,
          rawTimeSec: 2,
        });
      }
      const result = await engine.completeGoldVerification(v.sessionId);
      expect(result.upgraded).toBe(false);
      expect(result.reason).toBe("no unit progress yet");
      // But the 5 answered items were still logged (append-only truth).
      expect(await engine.unsyncedAttemptCount("s1")).toBe(5);
    } finally {
      env.dispose();
    }
  });
});
