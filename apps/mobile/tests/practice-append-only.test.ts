/**
 * Append-only attempt-log proofs (issue #47).
 *
 * Two invariants, both enforced:
 * 1. RUNTIME: the recorder's writes are INSERT-only; sequence ids are
 *    strictly monotonic across recorder instances and sessions; the
 *    synced flag stays 0 (only #48 flips it).
 * 2. SOURCE: no mobile source file contains an UPDATE or DELETE
 *    statement targeting attempt_log — the append-only contract holds
 *    across the whole tree, not just this module.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { AttemptRecorder } from "../src/practice/attemptRecorder";
import type { AttemptInput } from "../src/practice/types";
import { createPracticeEnv, type PracticeTestEnv } from "./helpers/practiceEnv";

let env: PracticeTestEnv | null = null;

function recorder(): { recorder: AttemptRecorder; env: PracticeTestEnv } {
  env = env ?? createPracticeEnv();
  return { recorder: new AttemptRecorder({ storage: env.storage, now: env.deps.now }), env };
}

function attempt(sessionId: string, n: number): AttemptInput {
  return {
    studentId: "s1",
    unitId: "K-M2",
    topicId: `K-M2-G`,
    questionId: `K-M2-G-Q${n}`,
    interactionType: "multiple-choice",
    chosenAnswer: String(n),
    isCorrect: n % 2 === 0,
    rawTimeSec: 2 + n * 0.1,
    audioDurationSec: 0.5,
    cognitiveTimeSec: 1.2,
    fluencyGrade: 3,
    misconceptionTags: [],
    sessionType: "TOPIC_PRACTICE",
    sessionId,
    motorBaselineSec: 0.42,
  };
}

describe("AttemptRecorder runtime invariants", () => {
  it("returns strictly monotonic sequence ids within a session", async () => {
    const { recorder: rec, env: e } = recorder();
    const a = await rec.record(attempt("sess-1", 1));
    const b = await rec.record(attempt("sess-1", 2));
    const c = await rec.record(attempt("sess-1", 3));
    expect(b.seq).toBeGreaterThan(a.seq);
    expect(c.seq).toBeGreaterThan(b.seq);
    expect(a.answeredAt).toBe(e.clock.nowMs);
    e.dispose();
    env = null;
  });

  it("sequence ids stay monotonic across sessions and recorder instances", async () => {
    const { recorder: rec1, env: e } = recorder();
    const first = await rec1.record(attempt("sess-1", 1));
    const second = await rec1.record(attempt("sess-2", 2));
    const rec2 = new AttemptRecorder({ storage: e.storage, now: e.deps.now });
    const third = await rec2.record(attempt("sess-3", 3));
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(third.seq).toBeGreaterThan(second.seq);
    e.dispose();
    env = null;
  });

  it("synced stays 0 for every appended row; unsyncedCount counts all", async () => {
    const { recorder: rec, env: e } = recorder();
    await rec.record(attempt("sess-1", 1));
    await rec.record(attempt("sess-1", 2));
    const rows = e.storage.db
      .prepare("SELECT synced FROM attempt_log ORDER BY id")
      .all() as unknown as { synced: number }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.synced === 0)).toBe(true);
    expect(await rec.unsyncedCount("s1")).toBe(2);
    e.dispose();
    env = null;
  });

  it("rows persist with the full v2 column set", async () => {
    const { recorder: rec, env: e } = recorder();
    const { seq } = await rec.record(attempt("sess-9", 4));
    const row = e.storage.db
      .prepare("SELECT * FROM attempt_log WHERE id = ?")
      .get(seq) as unknown as Record<string, unknown>;
    expect(row.session_id).toBe("sess-9");
    expect(row.session_type).toBe("TOPIC_PRACTICE");
    expect(row.unit_id).toBe("K-M2");
    expect(row.raw_time_sec).toBeCloseTo(2.4, 5);
    expect(row.fluency_grade).toBe(3);
    expect(row.misconception_tags_json).toBe("[]");
    expect(row.chosen_answer).toBe("4");
    e.dispose();
    env = null;
  });
});

describe("append-only source scan (no UPDATE/DELETE on attempt_log anywhere)", () => {
  const roots = [path.join(__dirname, "..", "src")];

  function tsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...tsFiles(full));
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  it("contains zero mutation statements targeting attempt_log beyond the sync worker's synced flip", () => {
    // The append-only contract holds with ONE documented exception
    // (#48): the sync worker's synced-flag flip, which must be EXACTLY
    // the whitelisted statement below — never another column, never a
    // DELETE, never an UPDATE without the synced = 0 guard.
    const whitelist =
      "UPDATE attempt_log SET synced = 1 WHERE student_id = ? AND id <= ? AND synced = 0";
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of tsFiles(root)) {
        const source = fs.readFileSync(file, "utf8");
        const normalized = source.replace(/\s+/g, " ");
        const mutations = [
          ...normalized.matchAll(
            /UPDATE\s+attempt_log[^;"]*;?|DELETE\s+FROM\s+attempt_log[^;"]*;?/gi,
          ),
        ]
          .map((m) => m[0].trim())
          .filter((stmt) => stmt !== whitelist && !whitelist.startsWith(stmt));
        if (mutations.length > 0) offenders.push(`${file}: ${mutations[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
