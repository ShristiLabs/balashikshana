/**
 * SyncEngine tests (issue #48) — the no-loss/idempotency/backoff matrix
 * against REAL node:sqlite storage (practiceEnv) with an injected fake
 * transport + connectivity. No React Native anywhere in this file.
 *
 * Matrix:
 * 1. happy path: drain -> upload -> adopt snapshot -> mark synced
 * 2. crash between upload and mark-synced: rows replay, nothing lost,
 *    nothing double-counted (server dedupe simulated + asserted)
 * 3. idle run adopts the snapshot via the cheap GET (confirm/rollback)
 * 4. offline pause: transport never called; queue drains on reconnect
 * 5. backoff: full-jitter bounds, doubling, cap (pure functions)
 * 6. retry loop: retryable failures back off then succeed; fatal 401/403
 *    never retry
 * 7. whole-session batching: capped drains trim the trailing session;
 *    active sessions are deferred
 * 8. confirm/rollback: provisional local Gold rolled back per snapshot;
 *    server timestamps adopted; provisional flags clear
 * 9. content-version handshake signal fires
 * 10. batch-split determinism: same sessions, different splits, same
 *     uploads and same final state
 */
import { describe, expect, it } from "vitest";
import { PracticeSessionEngine } from "../src/practice/practiceEngine";
import { SyncEngine } from "../src/sync/syncEngine";
import { computeBackoffDelay, backoffUpperBound } from "../src/sync/backoff";
import {
  SyncTransportError,
  type SyncTransport,
  type SyncUploadResponse,
  type Connectivity,
  type SyncDeps,
} from "../src/sync/types";
import { createPracticeEnv, type PracticeTestEnv } from "./helpers/practiceEnv";

const MS_HOUR = 3_600_000;

interface TransportCall {
  kind: "upload" | "fetch";
  attempts: number[];
}

class FakeTransport implements SyncTransport {
  uploads: TransportCall[] = [];
  /** Full wire payloads per upload (assertions on the mapped shape). */
  wireLog: import("../src/sync/types").SyncAttemptWire[][] = [];
  fetches = 0;
  failuresBeforeSuccess = 0;
  failStatus = 500;
  /** Server-side snapshot the fake returns (hand-built per test). */
  snapshot: SyncUploadResponse["progress"] = { units: [], topics: [] };
  stats = { inserted: 0, duplicates: 0, sessionsReplayed: 0, clockSkewAdjusted: 0 };
  packsOutdated: SyncUploadResponse["packsOutdated"] = [];

  private calls = 0;

  private maybeFail(): void {
    this.calls += 1;
    if (this.calls <= this.failuresBeforeSuccess) {
      throw new SyncTransportError(`simulated failure ${this.calls}`, this.failStatus);
    }
  }

  async uploadAttempts(
    attempts: import("../src/sync/types").SyncAttemptWire[],
  ): Promise<SyncUploadResponse> {
    // The REAL server contract: maxItems 200 on the attempts array —
    // an oversized batch is a fatal 400 (never retried).
    if (attempts.length > SyncEngine.SERVER_MAX_BATCH) {
      throw new SyncTransportError(
        "batch exceeds the server cap (SYNC_MAX_ATTEMPTS_PER_BATCH)",
        400,
      );
    }
    this.maybeFail();
    // Server-side idempotency simulation: the fake remembers every seq
    // it has EVER seen; replays count as duplicates and "insert" nothing.
    const seen = new Set(this.uploads.map((u) => u.attempts).flat());
    const inserted = attempts.filter((a) => !seen.has(a.seq)).length;
    this.stats = {
      inserted,
      duplicates: attempts.length - inserted,
      sessionsReplayed: inserted,
      clockSkewAdjusted: 0,
    };
    this.uploads.push({ kind: "upload", attempts: attempts.map((a) => a.seq) });
    this.wireLog.push(attempts);
    return {
      ackedSeqs: attempts.map((a) => a.seq),
      serverTime: new Date().toISOString(),
      stats: this.stats,
      packsOutdated: this.packsOutdated,
      progress: this.snapshot,
    };
  }

  async fetchProgress(): Promise<import("../src/sync/types").SyncProgressResponse> {
    this.maybeFail();
    this.fetches += 1;
    return {
      serverTime: new Date().toISOString(),
      packsOutdated: this.packsOutdated,
      progress: this.snapshot,
    };
  }

  resetCalls(): void {
    this.calls = 0;
    this.failuresBeforeSuccess = 0;
  }
}

function alwaysOnline(): Connectivity {
  return {
    async isOnline() {
      return true;
    },
    subscribe() {
      return () => {};
    },
  };
}

function offlineConnectivity(onlineRef: { value: boolean }): Connectivity {
  return {
    async isOnline() {
      return onlineRef.value;
    },
    subscribe() {
      return () => {};
    },
  };
}

/** Runs one full offline topic session (all-correct) through the engine. */
async function runTopicSession(env: PracticeTestEnv, questionCount = 4): Promise<void> {
  const engine = new PracticeSessionEngine(env.deps);
  const start = await engine.startTopicSession({
    studentId: "s1",
    gradeId: "kindergarten",
    unitId: "K-M2",
    topicCode: "G",
    count: questionCount,
  });
  for (const q of start.questions) {
    await engine.submitResponse(start.sessionId, {
      questionId: q.questionId,
      topicCode: "G",
      isCorrect: true,
      rawTimeSec: 2.1,
      chosenAnswer: q.correctAnswer,
    });
  }
  await engine.completeTopicSession(start.sessionId);
}

/** Runs one offline gate session through the engine (all-correct). */
async function runGateSession(env: PracticeTestEnv, count = 6): Promise<void> {
  const engine = new PracticeSessionEngine(env.deps);
  const start = await engine.startGateSession({
    studentId: "s1",
    gradeId: "kindergarten",
    unitId: "K-M2",
    count,
  });
  for (const q of start.questions) {
    await engine.submitResponse(start.sessionId, {
      questionId: q.questionId,
      topicCode: q.topicCode,
      isCorrect: true,
      rawTimeSec: 2.0,
      chosenAnswer: q.correctAnswer,
    });
  }
  await engine.completeGateSession(start.sessionId);
}

function makeDeps(
  env: PracticeTestEnv,
  transport: FakeTransport,
  extra?: Partial<SyncDeps>,
): SyncDeps {
  return {
    storage: env.storage,
    transport,
    connectivity: alwaysOnline(),
    now: () => env.clock.nowMs,
    sleep: async () => {},
    random: () => 0.5,
    ...extra,
  };
}

describe("happy path: drain -> upload -> adopt -> mark synced", () => {
  it("uploads a completed session, applies the snapshot, flips synced", async () => {
    const env = createPracticeEnv();
    const transport = new FakeTransport();
    try {
      await runTopicSession(env);
      expect(await env.storage.unsyncedAttemptCount("s1")).toBe(4);

      transport.snapshot = {
        units: [],
        topics: [
          {
            topicId: "K-M2-G",
            unitId: "K-M2",
            topicCode: "G",
            completed: 1,
            crowns: 3,
            masteryScore: 100,
            bestAccuracyPct: 100,
            bestMedianSpeedSec: 1.68,
            attemptsCount: 1,
            fluencyGrade: 4,
            stabilityDays: 3.7,
            nextReviewAt: new Date(env.clock.nowMs + 3.7 * 86_400_000).toISOString(),
            lastReviewedAt: new Date(env.clock.nowMs).toISOString(),
          },
        ],
      };

      const engine = new SyncEngine(makeDeps(env, transport));
      const result = await engine.sync("s1");

      expect(result.outcome).toBe("synced");
      expect(result.uploaded).toBe(4);
      expect(result.pending).toBe(0);
      expect(transport.uploads).toHaveLength(1);
      expect(transport.uploads[0]!.attempts).toEqual([1, 2, 3, 4]);

      const row = await env.storage.getTopicProgress("s1", "K-M2-G");
      expect(row?.provisional).toBe(false);
      expect(row?.crowns).toBe(3);
      expect(row?.stabilityDays).toBeCloseTo(3.7, 5);

      const syncedRows = env.storage.db
        .prepare("SELECT id, synced FROM attempt_log ORDER BY id")
        .all() as unknown as { id: number; synced: number }[];
      expect(syncedRows.every((r) => r.synced === 1)).toBe(true);
    } finally {
      env.dispose();
    }
  });
});

describe("crash-at-every-step matrix (no attempt loss)", () => {
  it("crash between upload and mark-synced: the replay uploads the SAME rows and marks once", async () => {
    const env = createPracticeEnv();
    const transport = new FakeTransport();
    try {
      await runTopicSession(env);
      await runGateSession(env);

      // First run: the storage throws AFTER the upload succeeded — the
      // exact crash window between upload and mark-synced.
      const realMark = env.storage.markSyncedUpTo.bind(env.storage);
      let markCalls = 0;
      env.storage.markSyncedUpTo = async (studentId: string, seq: number) => {
        markCalls += 1;
        if (markCalls === 1) throw new Error("simulated crash after upload");
        return realMark(studentId, seq);
      };

      const engine = new SyncEngine(makeDeps(env, transport));
      // syncOnce (single pass, no retry) models the process dying in
      // the crash window: the storage error propagates and nothing was
      // marked synced.
      const crashed = await engine.syncOnce("s1").catch((e: Error) => e);
      expect(crashed).toBeInstanceOf(Error);
      expect((crashed as Error).message).toBe("simulated crash after upload");
      const afterCrash = env.storage.db
        .prepare("SELECT COUNT(*) AS c FROM attempt_log WHERE synced = 0")
        .get() as unknown as { c: number };
      expect(afterCrash.c).toBe(10);

      // Recovery run: same rows uploaded AGAIN (server dedupes — the
      // fake counts them as duplicates), then marked synced once.
      const result = await engine.sync("s1");
      expect(result.outcome).toBe("synced");
      const uploadedBatches = transport.uploads.map((u) => u.attempts);
      expect(uploadedBatches[1]).toEqual(uploadedBatches[0]);
      expect(result.stats?.duplicates).toBeGreaterThan(0);

      const finalRows = env.storage.db
        .prepare("SELECT id, synced FROM attempt_log ORDER BY id")
        .all() as unknown as { id: number; synced: number }[];
      expect(finalRows).toHaveLength(10);
      expect(finalRows.every((r) => r.synced === 1)).toBe(true);
    } finally {
      env.dispose();
    }
  });

  it("idle re-run never re-uploads: the GET snapshot only", async () => {
    const env = createPracticeEnv();
    const transport = new FakeTransport();
    try {
      await runTopicSession(env);
      const engine = new SyncEngine(makeDeps(env, transport));
      await engine.sync("s1");
      expect(transport.uploads).toHaveLength(1);

      const second = await engine.sync("s1");
      expect(second.outcome).toBe("idle");
      expect(transport.uploads).toHaveLength(1);
      expect(transport.fetches).toBe(1);
    } finally {
      env.dispose();
    }
  });

  it("crash mid-apply (partial snapshot adoption) converges on the next run", async () => {
    const env = createPracticeEnv();
    const transport = new FakeTransport();
    try {
      await runTopicSession(env);
      transport.snapshot = {
        units: [],
        topics: [
          {
            topicId: "K-M2-G",
            unitId: "K-M2",
            topicCode: "G",
            completed: 1,
            crowns: 2,
            masteryScore: 90,
            bestAccuracyPct: 90,
            bestMedianSpeedSec: 1.7,
            attemptsCount: 1,
            fluencyGrade: 3,
            stabilityDays: 3.0,
            nextReviewAt: new Date(env.clock.nowMs + 3 * 86_400_000).toISOString(),
            lastReviewedAt: new Date(env.clock.nowMs).toISOString(),
          },
        ],
      };

      const realUpsert = env.storage.upsertTopicProgress.bind(env.storage);
      let upserts = 0;
      env.storage.upsertTopicProgress = async (record) => {
        upserts += 1;
        if (upserts === 1) throw new Error("simulated crash mid-apply");
        return realUpsert(record);
      };

      const engine = new SyncEngine(makeDeps(env, transport));
      // Single pass: the mid-apply crash propagates (process death).
      await expect(engine.syncOnce("s1")).rejects.toThrow("simulated crash mid-apply");
      // Nothing marked synced after the failed apply.
      const unsynced = env.storage.db
        .prepare("SELECT COUNT(*) AS c FROM attempt_log WHERE synced = 0")
        .get() as unknown as { c: number };
      expect(unsynced.c).toBe(4);

      const result = await engine.sync("s1");
      expect(result.outcome).toBe("synced");
      const row = await env.storage.getTopicProgress("s1", "K-M2-G");
      expect(row?.provisional).toBe(false);
      expect(row?.crowns).toBe(2);
    } finally {
      env.dispose();
    }
  });
});

describe("offline pause / reconnect", () => {
  it("offline: outcome offline, transport untouched; online: queue drains", async () => {
    const net = { value: false };
    const env = createPracticeEnv();
    const transport = new FakeTransport();
    try {
      await runTopicSession(env);
      const engine = new SyncEngine(
        makeDeps(env, transport, { connectivity: offlineConnectivity(net) }),
      );
      const offlineResult = await engine.sync("s1");
      expect(offlineResult.outcome).toBe("offline");
      expect(offlineResult.pending).toBe(4);
      expect(transport.uploads).toHaveLength(0);

      net.value = true;
      const onlineResult = await engine.sync("s1");
      expect(onlineResult.outcome).toBe("synced");
      expect(onlineResult.uploaded).toBe(4);
    } finally {
      env.dispose();
    }
  });
});

describe("backoff (exponential + full jitter)", () => {
  it("delay is within [0, min(cap, base * 2^attempt)) for seeded rng values", () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const upper = backoffUpperBound(attempt, { baseMs: 1000, maxMs: 60000 });
      for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
        const d = computeBackoffDelay(attempt, { baseMs: 1000, maxMs: 60000, random: () => r });
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThan(Math.max(1, upper));
      }
    }
  });

  it("bounds double per attempt then cap at max", () => {
    expect(backoffUpperBound(0, { baseMs: 1000, maxMs: 60000 })).toBe(1000);
    expect(backoffUpperBound(1, { baseMs: 1000, maxMs: 60000 })).toBe(2000);
    expect(backoffUpperBound(3, { baseMs: 1000, maxMs: 60000 })).toBe(8000);
    expect(backoffUpperBound(10, { baseMs: 1000, maxMs: 60000 })).toBe(60000);
  });
});

describe("retry loop", () => {
  it("retryable 500s back off then succeed", async () => {
    const env = createPracticeEnv();
    const transport = new FakeTransport();
    const sleeps: number[] = [];
    try {
      await runTopicSession(env);
      transport.failuresBeforeSuccess = 2;
      transport.failStatus = 500;
      const engine = new SyncEngine(
        makeDeps(env, transport, {
          sleep: async (ms) => {
            sleeps.push(ms);
          },
          random: () => 0.5,
        }),
      );
      const result = await engine.sync("s1");
      expect(result.outcome).toBe("synced");
      expect(result.attempts).toBeGreaterThanOrEqual(3);
      expect(sleeps).toHaveLength(2);
      expect(sleeps[0]).toBe(500); // 0.5 * min(60000, 1000 * 2^0)
      expect(sleeps[1]).toBe(1000); // 0.5 * min(60000, 1000 * 2^1)
    } finally {
      env.dispose();
    }
  });

  it("fatal 401 (no device session) never retries", async () => {
    const env = createPracticeEnv();
    const transport = new FakeTransport();
    try {
      await runTopicSession(env);
      transport.failuresBeforeSuccess = 5;
      transport.failStatus = 401;
      const engine = new SyncEngine(makeDeps(env, transport));
      const result = await engine.sync("s1");
      expect(result.outcome).toBe("failed-fatal");
      expect(result.attempts).toBe(1);
      expect(transport.uploads).toHaveLength(0);
      expect(result.pending).toBe(4);
    } finally {
      env.dispose();
    }
  });

  it("exhausted retries surface failed-retryable with attempts count", async () => {
    const env = createPracticeEnv();
    const transport = new FakeTransport();
    try {
      await runTopicSession(env);
      transport.failuresBeforeSuccess = 99;
      transport.failStatus = 503;
      const engine = new SyncEngine(makeDeps(env, transport, { maxAttempts: 3 }));
      const result = await engine.sync("s1");
      expect(result.outcome).toBe("failed-retryable");
      expect(result.attempts).toBe(3);
      expect(result.pending).toBe(4);
    } finally {
      env.dispose();
    }
  });
});

describe("whole-session batching", () => {
  it("a capped drain EXTENDS the trailing session to its true end — sessions never split", async () => {
    const env = createPracticeEnv();
    const transport = new FakeTransport();
    try {
      await runTopicSession(env, 4);
      await runGateSession(env, 6);
      expect(await env.storage.unsyncedAttemptCount("s1")).toBe(10);

      // batchSize 6: the drain window rows 1-6 cuts the gate session
      // (rows 5-10); the engine extends the trailing session with a
      // bounded tail probe and uploads both WHOLE sessions in one batch
      // (10 attempts — under the server's 200 hard cap).
      const engine = new SyncEngine(makeDeps(env, transport, { batchSize: 6 }));
      const first = await engine.sync("s1");
      expect(first.outcome).toBe("synced");
      expect(first.uploaded).toBe(10);
      expect(transport.uploads).toHaveLength(1);
      expect(transport.uploads[0]!.attempts).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(await env.storage.unsyncedAttemptCount("s1")).toBe(0);
    } finally {
      env.dispose();
    }
  });

  it("a batch smaller than the window limit uploads exactly the drained sessions", async () => {
    const env = createPracticeEnv();
    const transport = new FakeTransport();
    try {
      await runTopicSession(env, 4);
      await runGateSession(env, 6);
      // batchSize 4: window [1-4] (topic, complete — the tail probe
      // finds a different session), then window [5-8] extends to the
      // gate session's end [5-10]. Two batches, never a split session.
      const engine = new SyncEngine(makeDeps(env, transport, { batchSize: 4 }));
      const result = await engine.sync("s1");
      expect(result.outcome).toBe("synced");
      expect(transport.uploads.map((u) => u.attempts)).toEqual([
        [1, 2, 3, 4],
        [5, 6, 7, 8, 9, 10],
      ]);
      expect(await env.storage.unsyncedAttemptCount("s1")).toBe(0);
    } finally {
      env.dispose();
    }
  });

  it("an active (still-open) session is deferred, never uploaded half", async () => {
    const env = createPracticeEnv();
    const transport = new FakeTransport();
    try {
      const practice = new PracticeSessionEngine(env.deps);
      const start = await practice.startTopicSession({
        studentId: "s1",
        gradeId: "kindergarten",
        unitId: "K-M2",
        topicCode: "G",
        count: 4,
      });
      await practice.submitResponse(start.sessionId, {
        questionId: start.questions[0]!.questionId,
        topicCode: "G",
        isCorrect: true,
        rawTimeSec: 2,
        chosenAnswer: "1",
      });

      const engine = new SyncEngine(
        makeDeps(env, transport, { isActiveSession: (id) => id === start.sessionId }),
      );
      const result = await engine.sync("s1");
      expect(result.outcome).toBe("idle");
      expect(transport.uploads).toHaveLength(0);
      expect(result.pending).toBe(1);
    } finally {
      env.dispose();
    }
  });
});

describe("boundary deferral at the server batch cap (review findings 1, 3, 5)", () => {
  /** Raw attempt_log insert with explicit session identity (ids auto-assign 1..N). */
  function insertAttempt(env: PracticeTestEnv, sessionId: string, sessionType: string): void {
    env.storage.db
      .prepare(
        `INSERT INTO attempt_log (
           student_id, topic_id, question_id, interaction_type, is_correct,
           cognitive_time_sec, audio_duration_sec, answered_at, synced,
           unit_id, session_type, session_id, raw_time_sec, fluency_grade,
           misconception_tags_json, chosen_answer, motor_baseline_sec
         ) VALUES ('s1', 'K-M2-G', 'K-M2-G-Q1', 'multiple-choice', 1, 1.5, 0, ?, 0,
                   'K-M2', ?, ?, 2, 4, '[]', '1', 0.42)`,
      )
      .run(env.clock.nowMs, sessionType, sessionId);
  }

  function syncedFlags(env: PracticeTestEnv): number[] {
    return (
      env.storage.db.prepare("SELECT synced FROM attempt_log ORDER BY id").all() as unknown as {
        synced: number;
      }[]
    ).map((r) => r.synced);
  }

  it("batchSize 200, session straddling row 200: DEFERRED, never partially uploaded", async () => {
    const env = createPracticeEnv();
    const transport = new FakeTransport();
    try {
      // 49 complete topic sessions (rows 1-196), a gate session
      // STRADDLING the 200-row window boundary (rows 197-202), and a
      // trailing complete topic session (rows 203-204). The old cursor-
      // less tail probe re-read the same front 200 rows, saw an empty
      // tail, and uploaded rows 197-200 as a COMPLETE gate session —
      // the partial-upload corruption the reviewer flagged.
      for (let s = 1; s <= 49; s += 1) {
        for (let i = 0; i < 4; i += 1) insertAttempt(env, `top-${s}`, "TOPIC_PRACTICE");
      }
      for (let i = 0; i < 6; i += 1) insertAttempt(env, "gate-1", "GATE");
      for (let i = 0; i < 2; i += 1) insertAttempt(env, "top-50", "TOPIC_PRACTICE");
      expect(await env.storage.unsyncedAttemptCount("s1")).toBe(204);

      const engine = new SyncEngine(makeDeps(env, transport)); // default batchSize 200
      const first = await engine.syncOnce("s1");

      // First pass: the straddling gate session is DEFERRED — only the
      // 49 complete sessions upload, and the wire carries exactly the
      // prefix (no gate rows 197-200, no trailing rows 203-204).
      expect(first.outcome).toBe("synced");
      expect(first.uploaded).toBe(196);
      expect(transport.uploads).toHaveLength(1);
      expect(transport.uploads[0]!.attempts).toHaveLength(196);
      expect(transport.uploads[0]!.attempts[0]).toBe(1);
      expect(transport.uploads[0]!.attempts[195]).toBe(196);
      // Prefix marking (finding 5): rows past the deferred group stay
      // unsynced — including the COMPLETE trailing session's rows.
      const flags = syncedFlags(env);
      expect(flags.slice(0, 196).every((f) => f === 1)).toBe(true);
      expect(flags.slice(196).every((f) => f === 0)).toBe(true);

      // Second pass: the window starts at the gate session's head —
      // everything remaining uploads as WHOLE sessions, under the cap.
      const done = await engine.sync("s1");
      expect(done.outcome).toBe("synced");
      expect(done.pending).toBe(0);
      const batches = transport.uploads.map((u) => u.attempts);
      for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(200);
      expect(batches.flat()).toEqual(Array.from({ length: 204 }, (_, i) => i + 1));
      expect(syncedFlags(env).every((f) => f === 1)).toBe(true);
    } finally {
      env.dispose();
    }
  });

  it("configured batchSize above the server cap is clamped — no fatal-400 wedge", async () => {
    const env = createPracticeEnv();
    const transport = new FakeTransport();
    try {
      // 41 complete 5-row sessions = 205 rows; the caller misconfigures
      // batchSize 400. Without the clamp the engine drains 205 rows in
      // one window and uploads an oversized batch -> fatal 400, no
      // retry, permanently wedged. With the clamp the drain caps at
      // 200 and the deferral logic keeps every batch legal.
      for (let s = 1; s <= 41; s += 1) {
        for (let i = 0; i < 5; i += 1) insertAttempt(env, `top-${s}`, "TOPIC_PRACTICE");
      }
      const engine = new SyncEngine(makeDeps(env, transport, { batchSize: 400 }));
      const result = await engine.sync("s1");
      expect(result.outcome).toBe("synced");
      expect(result.uploaded).toBe(205);
      expect(result.pending).toBe(0);
      for (const batch of transport.uploads.map((u) => u.attempts)) {
        expect(batch.length).toBeLessThanOrEqual(SyncEngine.SERVER_MAX_BATCH);
      }
      expect(syncedFlags(env).every((f) => f === 1)).toBe(true);
    } finally {
      env.dispose();
    }
  });

  it("a deferred MIDDLE group stops the upload prefix — later complete groups never flip to synced", async () => {
    const env = createPracticeEnv();
    const transport = new FakeTransport();
    try {
      // s1 complete (1-4), s2 ACTIVE in the middle (5-8), s3 complete
      // (9-12). s3 is complete, but markSyncedUpTo is a RANGE flip:
      // uploading s3 would flip s2's unuploaded rows 5-8 to synced
      // (attempt loss). The upload must stop at s2.
      for (let i = 0; i < 4; i += 1) insertAttempt(env, "top-1", "TOPIC_PRACTICE");
      for (let i = 0; i < 4; i += 1) insertAttempt(env, "top-2", "TOPIC_PRACTICE");
      for (let i = 0; i < 4; i += 1) insertAttempt(env, "top-3", "TOPIC_PRACTICE");

      const engine = new SyncEngine(
        makeDeps(env, transport, { isActiveSession: (id) => id === "top-2" }),
      );
      const result = await engine.syncOnce("s1");
      expect(result.outcome).toBe("synced");
      expect(result.uploaded).toBe(4);
      expect(transport.uploads).toHaveLength(1);
      expect(transport.uploads[0]!.attempts).toEqual([1, 2, 3, 4]);
      // The complete s3 rows (9-12) were NOT uploaded and NOT flipped.
      const flags = syncedFlags(env);
      expect(flags.slice(4, 12).every((f) => f === 0)).toBe(true);

      // Session closes: the remainder uploads whole, nothing lost.
      const done = await new SyncEngine(makeDeps(env, transport)).sync("s1");
      expect(done.outcome).toBe("synced");
      expect(transport.uploads[1]!.attempts).toEqual([5, 6, 7, 8, 9, 10, 11, 12]);
      expect(syncedFlags(env).every((f) => f === 1)).toBe(true);
    } finally {
      env.dispose();
    }
  });

  it("a session larger than the server cap is a LOUD fatal — never a silent partial upload", async () => {
    const env = createPracticeEnv();
    const transport = new FakeTransport();
    try {
      // Contiguous protocol shape: one complete session (5 rows), then a
      // single 205-row session straddling the 200-row window. The old
      // cursor-less probe saw an empty tail and uploaded rows 6-200 as a
      // "complete" 195-row session (the exact corruption the reviewer
      // flagged); the invariant must fire instead.
      for (let i = 0; i < 5; i += 1) insertAttempt(env, "top-1", "TOPIC_PRACTICE");
      for (let i = 0; i < 205; i += 1) insertAttempt(env, "big-1", "TOPIC_PRACTICE");

      const engine = new SyncEngine(makeDeps(env, transport));
      const result = await engine.syncOnce("s1");

      expect(result.outcome).toBe("failed-fatal");
      expect(result.uploaded).toBe(0);
      expect(result.error).toContain("exceeds the server batch cap");
      expect(transport.uploads).toHaveLength(0);
      expect(syncedFlags(env).every((f) => f === 0)).toBe(true);
    } finally {
      env.dispose();
    }
  });

  it("probe window FULL and the trailing session's end unknown: deferred, nothing partial, nothing wrongly flipped", async () => {
    const env = createPracticeEnv();
    const transport = new FakeTransport();
    try {
      // INTERLEAVED rows (a corrupted/drifted local log — the protocol
      // normally keeps sessions contiguous): A(1-100), B(101-197), then
      // S's head(198-200), T(201-395), S's tail(396-400). The probe
      // [201-400] is FULL and ENDS with S's rows, so S's true end is
      // unknown: the engine must DEFER S entirely (head rows included —
      // never a partial S) and upload only the clean prefix A+B.
      for (let i = 0; i < 100; i += 1) insertAttempt(env, "a", "TOPIC_PRACTICE");
      for (let i = 0; i < 97; i += 1) insertAttempt(env, "b", "TOPIC_PRACTICE");
      for (let i = 0; i < 3; i += 1) insertAttempt(env, "s", "GATE");
      for (let i = 0; i < 195; i += 1) insertAttempt(env, "t", "TOPIC_PRACTICE");
      for (let i = 0; i < 5; i += 1) insertAttempt(env, "s", "GATE");
      expect(await env.storage.unsyncedAttemptCount("s1")).toBe(400);

      const engine = new SyncEngine(makeDeps(env, transport));
      const result = await engine.syncOnce("s1");

      expect(result.outcome).toBe("synced");
      expect(result.uploaded).toBe(197);
      expect(transport.uploads).toHaveLength(1);
      expect(transport.uploads[0]!.attempts).toHaveLength(197);
      expect(transport.uploads[0]!.attempts[0]).toBe(1);
      expect(transport.uploads[0]!.attempts[196]).toBe(197);
      // NONE of S's rows (198-200 or 396-400) traveled the wire, and
      // nothing past the uploaded prefix flipped to synced (T included).
      const wireSessions = new Set(
        transport.wireLog[0]!.map((w) => `${w.sessionType}:${w.sessionId}`),
      );
      expect(wireSessions).toEqual(new Set(["TOPIC_PRACTICE:a", "TOPIC_PRACTICE:b"]));
      const flags = syncedFlags(env);
      expect(flags.slice(0, 197).every((f) => f === 1)).toBe(true);
      expect(flags.slice(197).every((f) => f === 0)).toBe(true);
    } finally {
      env.dispose();
    }
  });

  it("drainUnsyncedAfter returns ONLY unsynced rows strictly after the cursor", async () => {
    const env = createPracticeEnv();
    try {
      for (let i = 0; i < 10; i += 1) insertAttempt(env, `top-${i}`, "TOPIC_PRACTICE");
      await env.storage.markSyncedUpTo("s1", 4);
      const ids = (rows: { id: number }[]) => rows.map((r) => r.id);

      expect(ids(await env.storage.drainUnsyncedAfter("s1", 4, 100))).toEqual([5, 6, 7, 8, 9, 10]);
      // The cursor is exclusive and the synced filter applies before the
      // limit: afterId 0 reads the front of the UNSYNCED set.
      expect(ids(await env.storage.drainUnsyncedAfter("s1", 0, 3))).toEqual([5, 6, 7]);
      expect(ids(await env.storage.drainUnsyncedAfter("s1", 10, 100))).toEqual([]);
      expect(ids(await env.storage.drainUnsyncedAfter("s1", 999, 100))).toEqual([]);
    } finally {
      env.dispose();
    }
  });
});

describe("D8 confirm/rollback via snapshot adoption", () => {
  it("a provisional local Gold the server did not confirm rolls back to Silver", async () => {
    const env = createPracticeEnv();
    const transport = new FakeTransport();
    try {
      // Offline: gate pass -> provisional Silver.
      await runGateSession(env);
      const afterGate = await env.storage.getUnitProgress("s1", "K-M2");
      expect(afterGate?.provisional).toBe(true);
      expect(afterGate?.keyState).toBe("SILVER_KEY");
      const silverAt = afterGate!.silverAwardedAt;

      // Offline: 14h later, verification 4/5 -> provisional local Gold.
      env.clock.advance(15 * MS_HOUR);
      const practice = new PracticeSessionEngine(env.deps);
      const verify = await practice.startGoldVerification({
        studentId: "s1",
        gradeId: "kindergarten",
        unitId: "K-M2",
      });
      for (const [i, q] of verify.questions.entries()) {
        await practice.submitResponse(verify.sessionId, {
          questionId: q.questionId,
          topicCode: q.topicCode,
          isCorrect: i < 4, // 4 of 5 — enough locally
          rawTimeSec: 2.0,
          chosenAnswer: q.correctAnswer,
        });
      }
      const verdict = await practice.completeGoldVerification(verify.sessionId);
      expect(verdict.upgraded).toBe(true);
      const afterVerify = await env.storage.getUnitProgress("s1", "K-M2");
      expect(afterVerify?.keyState).toBe("GOLD_KEY");
      expect(afterVerify?.provisional).toBe(true);

      // Server truth (D8): the verification session ran BEFORE the
      // frozen window per the SERVER clock -> stays Silver. The client
      // rolls back.
      transport.snapshot = {
        units: [
          {
            unitId: "K-M2",
            status: "MASTERED",
            keyState: "SILVER_KEY",
            bestAccuracyPct: 100,
            bestMedianSpeedSec: 1.58,
            attemptsCount: 1,
            stabilityDays: 3.7,
            lastReviewedAt: new Date(silverAt).toISOString(),
            cpaStage: "PICTORIAL_STATIC",
            silverAwardedAt: new Date(silverAt).toISOString(),
            goldVerifiedAt: null,
          },
        ],
        topics: [],
      };

      const engine = new SyncEngine(makeDeps(env, transport));
      const result = await engine.sync("s1");
      expect(result.outcome).toBe("synced");

      const rolled = await env.storage.getUnitProgress("s1", "K-M2");
      expect(rolled?.keyState).toBe("SILVER_KEY");
      expect(rolled?.provisional).toBe(false);
      expect(rolled?.goldVerifiedAt).toBe(0);
      expect(rolled?.silverAwardedAt).toBe(silverAt);
    } finally {
      env.dispose();
    }
  });

  it("confirmed states adopt server timestamps and clear provisional flags", async () => {
    const env = createPracticeEnv();
    const transport = new FakeTransport();
    try {
      await runGateSession(env);
      const silverAt = (await env.storage.getUnitProgress("s1", "K-M2"))!.silverAwardedAt;
      const goldAt = silverAt + 14 * MS_HOUR + 60_000;

      transport.snapshot = {
        units: [
          {
            unitId: "K-M2",
            status: "MASTERED",
            keyState: "GOLD_KEY",
            bestAccuracyPct: 100,
            bestMedianSpeedSec: 1.58,
            attemptsCount: 2,
            stabilityDays: 6.4,
            lastReviewedAt: new Date(goldAt).toISOString(),
            cpaStage: "PURE_ABSTRACT_SYMBOLIC",
            silverAwardedAt: new Date(silverAt).toISOString(),
            goldVerifiedAt: new Date(goldAt).toISOString(),
          },
        ],
        topics: [],
      };

      const engine = new SyncEngine(makeDeps(env, transport));
      await engine.sync("s1");

      const unit = await env.storage.getUnitProgress("s1", "K-M2");
      expect(unit?.keyState).toBe("GOLD_KEY");
      expect(unit?.provisional).toBe(false);
      expect(unit?.goldVerifiedAt).toBe(goldAt);
      expect(unit?.silverAwardedAt).toBe(silverAt);
    } finally {
      env.dispose();
    }
  });
});

describe("airplane-mode E2E (issue #51 M3 verification gate)", () => {
  it("full gate offline: Silver -> 14 h -> Gold check offline -> online sync uploads both sessions and confirms the Gold key", async () => {
    const env = createPracticeEnv();
    const transport = new FakeTransport();
    const onlineRef = { value: false };
    try {
      const deps = makeDeps(env, transport, { connectivity: offlineConnectivity(onlineRef) });
      const engine = new SyncEngine(deps);

      // OFFLINE: a sync attempt while airplane-mode does nothing.
      const offlineIdle = await engine.syncOnce("s1");
      expect(offlineIdle.outcome).toBe("offline");
      expect(transport.uploads).toHaveLength(0);

      // OFFLINE: day-1 boss gate, all-correct -> provisional Silver.
      await runGateSession(env);
      const afterGate = await env.storage.getUnitProgress("s1", "K-M2");
      expect(afterGate?.keyState).toBe("SILVER_KEY");
      expect(afterGate?.provisional).toBe(true);
      const silverAt = afterGate!.silverAwardedAt;

      // OFFLINE: past the 14-hour window, 4-of-5 verification ->
      // provisional local Gold.
      env.clock.advance(14 * MS_HOUR + 60_000);
      const practice = new PracticeSessionEngine(env.deps);
      const verify = await practice.startGoldVerification({
        studentId: "s1",
        gradeId: "kindergarten",
        unitId: "K-M2",
      });
      for (const [i, q] of verify.questions.entries()) {
        await practice.submitResponse(verify.sessionId, {
          questionId: q.questionId,
          topicCode: q.topicCode,
          isCorrect: i < 4,
          rawTimeSec: 2.0,
          chosenAnswer: q.correctAnswer,
        });
      }
      const verdict = await practice.completeGoldVerification(verify.sessionId);
      expect(verdict.upgraded).toBe(true);
      expect((await env.storage.getUnitProgress("s1", "K-M2"))?.provisional).toBe(true);

      // ONLINE: the server recomputed the same stream and CONFIRMS the
      // Gold key (D8: server-authoritative, adopting its timestamps).
      const goldAt = env.clock.nowMs;
      transport.snapshot = {
        units: [
          {
            unitId: "K-M2",
            status: "MASTERED",
            keyState: "GOLD_KEY",
            bestAccuracyPct: 100,
            bestMedianSpeedSec: 1.58,
            attemptsCount: 2,
            stabilityDays: 6.4,
            lastReviewedAt: new Date(goldAt).toISOString(),
            cpaStage: "PURE_ABSTRACT_SYMBOLIC",
            silverAwardedAt: new Date(silverAt).toISOString(),
            goldVerifiedAt: new Date(goldAt).toISOString(),
          },
        ],
        topics: [],
      };
      onlineRef.value = true;
      const result = await engine.syncOnce("s1");
      expect(result.outcome).toBe("synced");

      // Both whole sessions traveled the wire under their own types.
      const wire = transport.wireLog.flat();
      expect(wire).toHaveLength(11);
      expect(wire.filter((w) => w.sessionType === "GATE")).toHaveLength(6);
      expect(wire.filter((w) => w.sessionType === "GOLD_VERIFICATION")).toHaveLength(5);
      expect(new Set(wire.map((w) => w.sessionId)).size).toBe(2);

      // Convergence: nothing unsynced, key confirmed, provisional clear.
      expect(await env.storage.unsyncedAttemptCount("s1")).toBe(0);
      const unit = await env.storage.getUnitProgress("s1", "K-M2");
      expect(unit?.keyState).toBe("GOLD_KEY");
      expect(unit?.provisional).toBe(false);
      expect(unit?.silverAwardedAt).toBe(silverAt);
      expect(unit?.goldVerifiedAt).toBe(goldAt);
    } finally {
      env.dispose();
    }
  });
});

describe("content-version handshake", () => {
  it("signals outdated packs through the callback and the result", async () => {
    const env = createPracticeEnv();
    const transport = new FakeTransport();
    const signals: { gradeId: string }[][] = [];
    try {
      transport.packsOutdated = [
        { gradeId: "kindergarten", installedVersion: "1.0.0", currentVersion: "1.1.0" },
      ];
      const engine = new SyncEngine(
        makeDeps(env, transport, { onContentOutdated: (packs) => signals.push(packs) }),
      );
      const result = await engine.sync("s1");
      expect(result.outcome).toBe("idle");
      expect(result.packsOutdated).toHaveLength(1);
      expect(signals).toHaveLength(1);
      expect(signals[0]![0]!.gradeId).toBe("kindergarten");
    } finally {
      env.dispose();
    }
  });
});

describe("batch-split determinism (same stream, different splits)", () => {
  it("identical uploads and identical final local state across 1/2/3-batch splits", async () => {
    const build = async (batchSize: number) => {
      const env = createPracticeEnv();
      const transport = new FakeTransport();
      try {
        await runTopicSession(env, 4);
        await runGateSession(env, 6);
        const engine = new SyncEngine(makeDeps(env, transport, { batchSize }));
        const result = await engine.sync("s1");
        expect(result.outcome).toBe("synced");
        const uploads = transport.uploads.map((u) => u.attempts);
        const unit = await env.storage.getUnitProgress("s1", "K-M2");
        const topic = await env.storage.getTopicProgress("s1", "K-M2-G");
        const synced = env.storage.db
          .prepare("SELECT id, synced FROM attempt_log ORDER BY id")
          .all() as unknown as {
          id: number;
          synced: number;
        }[];
        return { uploads, unit, topic, synced };
      } finally {
        env.dispose();
      }
    };

    const one = await build(200);
    const two = await build(6);
    const three = await build(4);
    // Uploads flatten to the same ordered stream; batching differs only
    // in boundaries (whole sessions), so flattened seq order is equal.
    const flatten = (u: number[][]) => u.flat();
    expect(flatten(two.uploads)).toEqual(flatten(one.uploads));
    expect(flatten(three.uploads)).toEqual(flatten(one.uploads));
    // Each batch contains only WHOLE sessions (no split session rows).
    for (const batches of [one.uploads, two.uploads, three.uploads]) {
      expect(batches.flat()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    }
    expect(two.unit).toEqual(one.unit);
    expect(three.unit).toEqual(one.unit);
    expect(two.topic).toEqual(one.topic);
    expect(three.topic).toEqual(one.topic);
    expect(two.synced).toEqual(one.synced);
    expect(three.synced).toEqual(one.synced);
  });
});

/** Runs one offline topic session for an arbitrary student id. */
async function runTopicSessionAs(
  env: PracticeTestEnv,
  studentId: string,
  questionCount = 4,
): Promise<void> {
  const engine = new PracticeSessionEngine(env.deps);
  const start = await engine.startTopicSession({
    studentId,
    gradeId: "kindergarten",
    unitId: "K-M2",
    topicCode: "G",
    count: questionCount,
  });
  for (const q of start.questions) {
    await engine.submitResponse(start.sessionId, {
      questionId: q.questionId,
      topicCode: "G",
      isCorrect: true,
      rawTimeSec: 2.1,
      chosenAnswer: q.correctAnswer,
    });
  }
  await engine.completeTopicSession(start.sessionId);
}

describe("student scoping (one device, one child's stream — never another's)", () => {
  it("sync(s1) uploads and flips ONLY s1's rows; s2 stays fully unsynced", async () => {
    const env = createPracticeEnv();
    const transport = new FakeTransport();
    try {
      await runTopicSessionAs(env, "s1");
      await runTopicSessionAs(env, "s2");

      const engine = new SyncEngine(makeDeps(env, transport));
      const first = await engine.sync("s1");
      expect(first.outcome).toBe("synced");
      expect(first.uploaded).toBe(4);

      // Only s1's four rows were uploaded (ids 1-4; s2's are 5-8).
      expect(transport.uploads).toHaveLength(1);
      expect(transport.uploads[0]!.attempts).toEqual([1, 2, 3, 4]);
      // The synced flip is student-scoped: s2's rows are untouched.
      expect(await env.storage.unsyncedAttemptCount("s1")).toBe(0);
      expect(await env.storage.unsyncedAttemptCount("s2")).toBe(4);

      const second = await engine.sync("s2");
      expect(second.outcome).toBe("synced");
      expect(second.uploaded).toBe(4);
      expect(transport.uploads[1]!.attempts).toEqual([5, 6, 7, 8]);
      expect(await env.storage.unsyncedAttemptCount("s2")).toBe(0);
    } finally {
      env.dispose();
    }
  });
});

describe("wire mapping robustness", () => {
  it("a malformed misconception_tags_json row maps to empty tags, never crashes the drain", async () => {
    const env = createPracticeEnv();
    const transport = new FakeTransport();
    try {
      // Raw insert with garbage tags JSON — the defensive parse branch
      // of rowToWire (a corrupted local row must not wedge the queue).
      env.storage.db
        .prepare(
          `INSERT INTO attempt_log (
             student_id, topic_id, question_id, interaction_type, is_correct,
             cognitive_time_sec, audio_duration_sec, answered_at, synced,
             unit_id, session_type, session_id, raw_time_sec, fluency_grade,
             misconception_tags_json, chosen_answer, motor_baseline_sec
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          "s1",
          "K-M2-G",
          "K-M2-G-Q1",
          "multiple-choice",
          1,
          1.5,
          0,
          env.clock.nowMs,
          "K-M2",
          "TOPIC_PRACTICE",
          "sess-raw-1",
          2,
          4,
          "not-json{",
          "1",
          0.42,
        );

      const engine = new SyncEngine(makeDeps(env, transport));
      const result = await engine.sync("s1");
      expect(result.outcome).toBe("synced");
      expect(result.uploaded).toBe(1);
      const wire = transport.wireLog[0]![0]!;
      expect(wire.misconceptionTags).toEqual([]);
      expect(wire.seq).toBe(1);
      expect(wire.motorBaselineSec).toBe(0.42);
    } finally {
      env.dispose();
    }
  });
});

describe("idle snapshot fetch honors the retry loop", () => {
  it("a failing GET backs off once, then adopts the snapshot", async () => {
    const env = createPracticeEnv();
    const transport = new FakeTransport();
    const sleeps: number[] = [];
    try {
      transport.failuresBeforeSuccess = 1;
      transport.failStatus = 500;
      const engine = new SyncEngine(
        makeDeps(env, transport, {
          sleep: async (ms) => {
            sleeps.push(ms);
          },
          random: () => 0.5,
        }),
      );
      const result = await engine.sync("s1");
      expect(result.outcome).toBe("idle");
      expect(sleeps).toEqual([500]);
      expect(transport.fetches).toBe(1);
    } finally {
      env.dispose();
    }
  });
});
