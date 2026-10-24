/**
 * SyncEngine (issue #48, roadmap D8) — the offline-first sync loop.
 *
 *   drain (whole sessions, id order via idx_attempt_log_drain)
 *     -> upload (facts only; server reconciles via core-engine)
 *     -> adopt the authoritative snapshot (confirm/rollback provisional)
 *     -> mark synced
 *
 * NO-LOSS ORDERING: rows are marked synced ONLY after the snapshot is
 * durably applied. A crash at ANY point leaves the rows unsynced and
 * the next run replays them — the server dedupes by (student, device,
 * seq), so a replay inserts nothing and re-returns the same snapshot.
 * Attempts are never lost and never double-counted.
 *
 * WHOLE-SESSION BATCHING (protocol contract with the server): a batch
 * carries only complete sessions. A session group is deferred when
 * (a) it is the trailing group of a FULL drain window and a beyond-
 * window cursor probe cannot prove the session ended (or proving it
 * ended would still exceed the server's batch cap), or (b) an injected
 * liveness probe reports the session still open (the child is
 * answering right now). A provably-ended trailing session that fits
 * the cap is extended to its true end and uploaded whole; a deferred
 * session uploads whole on the next pass, whose window starts at its
 * head. Practice writes are NEVER blocked — sync is strictly
 * background.
 *
 * BATTERY DOCTRINE: no polling loops here. The controller (nativeSync)
 * triggers on foreground transitions and connectivity regain; the
 * engine runs a bounded drain until the queue empties, then stops.
 */

import { computeBackoffDelay } from "./backoff";
import type {
  AttemptLogRow,
  PackVersionSignal,
  ProgressSnapshot,
  SyncAttemptWire,
  SyncDeps,
  SyncLogEvent,
  SyncRunResult,
  SyncStorage,
} from "./types";
import type { TopicProgressRecord, UnitProgressRecord } from "../practice/types";

interface SessionGroup {
  key: string;
  rows: AttemptLogRow[];
}

function sessionKeyOf(row: AttemptLogRow): string {
  return `${row.session_type}\u0000${row.session_id}`;
}

function groupSessions(rows: AttemptLogRow[]): SessionGroup[] {
  const groups: SessionGroup[] = [];
  const byKey = new Map<string, SessionGroup>();
  for (const row of rows) {
    const key = sessionKeyOf(row);
    let group = byKey.get(key);
    if (!group) {
      group = { key, rows: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    group.rows.push(row);
  }
  // Preserve first-appearance order (id order).
  return groups;
}

function rowToWire(row: AttemptLogRow): SyncAttemptWire {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.misconception_tags_json || "[]") as unknown;
    if (Array.isArray(parsed)) tags = parsed as string[];
  } catch {
    tags = [];
  }
  return {
    seq: row.id,
    unitId: row.unit_id,
    topicId: row.topic_id,
    questionId: row.question_id,
    sessionType: row.session_type as SyncAttemptWire["sessionType"],
    sessionId: row.session_id,
    chosenAnswer: row.chosen_answer,
    isCorrect: row.is_correct === 1,
    rawTimeSec: row.raw_time_sec,
    audioDurationSec: row.audio_duration_sec,
    misconceptionTags: tags,
    answeredAtMs: row.answered_at,
    motorBaselineSec: row.motor_baseline_sec,
  };
}

function isoToMs(iso: string | null | undefined): number {
  if (!iso) return 0;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

export class SyncEngine {
  /** The server's documented hard cap on attempts per batch
   *  (SYNC_MAX_ATTEMPTS_PER_BATCH default; OpenAPI maxItems). */
  static readonly SERVER_MAX_BATCH = 200;

  private readonly deps: SyncStorage;
  private readonly depsFull: SyncDeps;

  constructor(deps: SyncDeps) {
    this.deps = deps.storage;
    this.depsFull = deps;
  }

  /** Pending unsynced attempts (read-only seam for UI/battery hints). */
  async pendingCount(studentId: string): Promise<number> {
    return this.deps.unsyncedAttemptCount(studentId);
  }

  /**
   * One full sync run with bounded retry (exponential backoff + full
   * jitter). Returns when the queue is drained, the device is offline,
   * a fatal (non-retryable) problem arrives, or attempts are exhausted.
   */
  async sync(studentId: string): Promise<SyncRunResult> {
    const maxAttempts = this.depsFull.maxAttempts ?? 5;
    const startedAt = this.depsFull.now?.() ?? Date.now();
    let lastError = "";
    let attemptsMade = 0;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      attemptsMade = attempt + 1;
      try {
        const result = await this.syncOnce(studentId);
        if (result.outcome === "synced" && result.pending > 0) {
          // More batches remain — drain immediately (bounded by the
          // overall attempt budget). A final idle (only deferred
          // sessions remain) still counts as a synced run.
          const next = await this.sync(studentId);
          return {
            ...next,
            outcome: next.outcome === "idle" ? "synced" : next.outcome,
            uploaded: next.uploaded + result.uploaded,
            attempts: next.attempts + attemptsMade,
          };
        }
        this.log({
          kind: "sync-run",
          outcome: result.outcome,
          uploaded: result.uploaded,
          pending: result.pending,
          latencyMs: (this.depsFull.now?.() ?? Date.now()) - startedAt,
        });
        return { ...result, attempts: attemptsMade };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        const retryable = this.isRetryable(err);
        if (!retryable || attempt === maxAttempts - 1) {
          const pending = await this.deps.unsyncedAttemptCount(studentId).catch(() => -1);
          const outcome = retryable ? "failed-retryable" : "failed-fatal";
          this.log({
            kind: "sync-run",
            outcome,
            uploaded: 0,
            pending,
            latencyMs: (this.depsFull.now?.() ?? Date.now()) - startedAt,
          });
          return { outcome, uploaded: 0, pending, attempts: attemptsMade, error: lastError };
        }
        const delayMs = computeBackoffDelay(attempt, {
          baseMs: this.depsFull.backoffBaseMs,
          maxMs: this.depsFull.backoffMaxMs,
          random: this.depsFull.random,
        });
        this.log({ kind: "sync-retry", attempt: attempt + 1, delayMs, error: lastError });
        if (this.depsFull.sleep) await this.depsFull.sleep(delayMs);
      }
    }
    return {
      outcome: "failed-retryable",
      uploaded: 0,
      pending: -1,
      attempts: attemptsMade,
      error: lastError,
    };
  }

  /**
   * Single pass: drain -> upload -> adopt -> mark. Transport errors
   * propagate to the retry loop; storage errors are local bugs and
   * crash loudly by design.
   */
  async syncOnce(studentId: string): Promise<SyncRunResult> {
    if (!(await this.depsFull.connectivity.isOnline())) {
      this.log({ kind: "sync-connectivity", online: false });
      return {
        outcome: "offline",
        uploaded: 0,
        pending: await this.deps.unsyncedAttemptCount(studentId),
        attempts: 1,
      };
    }

    // Client-side clamp to the server's hard cap (review finding 3): a
    // configured batchSize above the cap would build batches the server
    // answers with a fatal 400 — permanently, since 400 is not
    // retryable. Misconfiguration degrades to the cap instead of wedging.
    const batchSize = Math.min(
      this.depsFull.batchSize ?? SyncEngine.SERVER_MAX_BATCH,
      SyncEngine.SERVER_MAX_BATCH,
    );
    const rows = await this.deps.drainUnsynced(studentId, batchSize);
    const totalUnsynced = await this.deps.unsyncedAttemptCount(studentId);

    // Whole-session guarantee (review finding 1). When the drain window
    // is FULL, the trailing session may continue beyond it. A cursor
    // probe reads the unsynced rows strictly AFTER the window's last id
    // (never a re-read of the window — a cursor-less re-drain returns
    // the same front rows, an always-empty tail, and a partial session
    // the server would replay as complete). Outcomes:
    //   - session provably ended AND window+tail fits the cap ->
    //     extend to the session's true end and upload it whole;
    //   - session continues beyond the window (or the extension would
    //     exceed the cap) -> DEFER the trailing group: upload only the
    //     complete prefix. The next pass's window starts at the
    //     deferred session's head, so a session that fits the cap in
    //     one window always uploads whole — progress is guaranteed;
    //   - the session alone exceeds the server's hard batch cap ->
    //     loud fatal (invariant violation, never a silent split).
    let uploadRows = rows;
    let deferredTrailingKey: string | null = null;
    if (rows.length >= batchSize && rows.length > 0) {
      const last = rows[rows.length - 1]!;
      const trailingKey = sessionKeyOf(last);
      let inWindow = 0;
      for (const r of rows) if (sessionKeyOf(r) === trailingKey) inWindow += 1;
      const probe = await this.deps.drainUnsyncedAfter(
        studentId,
        last.id,
        SyncEngine.SERVER_MAX_BATCH,
      );
      const tail = probe.filter((r) => sessionKeyOf(r) === trailingKey);
      if (inWindow + tail.length > SyncEngine.SERVER_MAX_BATCH) {
        return {
          outcome: "failed-fatal",
          uploaded: 0,
          pending: totalUnsynced,
          attempts: 1,
          error: `session ${last.session_id} exceeds the server batch cap (${SyncEngine.SERVER_MAX_BATCH} attempts)`,
        };
      }
      const sessionEnded = this.trailingSessionEnded(probe, tail, trailingKey, last.id);
      if (sessionEnded && rows.length + tail.length <= SyncEngine.SERVER_MAX_BATCH) {
        uploadRows = [...rows, ...tail];
      } else {
        deferredTrailingKey = trailingKey;
      }
    }

    // Uploadable groups are a PREFIX of the drained groups (review
    // finding 5): the walk STOPS at the first deferred group — a
    // capped-tail trailing session or a still-open (active) session.
    // Rows after a deferred group stay unsynced: markSyncedUpTo is a
    // range flip, so uploading them would flip the deferred group's
    // UNUPLOADED rows to synced (attempt loss). They upload on the
    // next pass instead — practice writes are never blocked.
    const groups = groupSessions(uploadRows);
    const uploadable: SessionGroup[] = [];
    for (const group of groups) {
      if (deferredTrailingKey !== null && group.key === deferredTrailingKey) break;
      const active = this.depsFull.isActiveSession?.(group.rows[0]!.session_id) ?? false;
      if (active) break;
      uploadable.push(group);
    }

    if (uploadable.length === 0) {
      if (rows.length === 0) {
        // Nothing pending: adopt the authoritative snapshot (confirm/
        // rollback of provisional state + content handshake) — a cheap
        // GET, never a write.
        const snap = await this.depsFull.transport.fetchProgress();
        await this.applySnapshot(studentId, snap.progress);
        this.signalContent(snap.packsOutdated);
        return {
          outcome: "idle",
          uploaded: 0,
          pending: 0,
          attempts: 1,
          packsOutdated: snap.packsOutdated,
        };
      }
      // Only deferred (open/capped-tail) sessions — nothing to upload.
      return { outcome: "idle", uploaded: 0, pending: totalUnsynced, attempts: 1 };
    }

    const wire = uploadable.flatMap((g) => g.rows.map(rowToWire));
    const response = await this.depsFull.transport.uploadAttempts(wire);
    await this.applySnapshot(studentId, response.progress);
    // End of the UPLOADED PREFIX, not the global max (review finding
    // 5): `uploadable` stops at the first deferred group, so this is
    // the last seq actually uploaded — rows of any deferred (and later)
    // groups can never flip to synced here.
    const maxSeq = wire[wire.length - 1]!.seq;
    await this.deps.markSyncedUpTo(studentId, maxSeq);
    this.signalContent(response.packsOutdated);

    return {
      outcome: "synced",
      uploaded: wire.length,
      pending: Math.max(0, totalUnsynced - wire.length),
      stats: response.stats,
      packsOutdated: response.packsOutdated,
      attempts: 1,
    };
  }

  /**
   * D8 confirm/rollback: adopt the server-authoritative rows wholesale.
   * Provisional flags clear; a local provisional Gold the server did
   * not confirm is rolled back to the server's key state. Values adopt
   * SERVER timestamps (converted to epoch ms); updatedAt stamps the
   * local write time (cosmetic ordering only).
   */
  async applySnapshot(studentId: string, snapshot: ProgressSnapshot): Promise<void> {
    const nowMs = this.depsFull.now?.() ?? Date.now();

    for (const unit of snapshot.units) {
      const record: UnitProgressRecord = {
        studentId,
        unitId: unit.unitId,
        status: unit.status,
        keyState:
          unit.keyState === "SILVER_KEY" || unit.keyState === "GOLD_KEY" ? unit.keyState : null,
        bestAccuracyPct: unit.bestAccuracyPct,
        bestMedianSpeedSec: unit.bestMedianSpeedSec,
        attemptsCount: unit.attemptsCount,
        stabilityDays: unit.stabilityDays,
        lastReviewedAt: isoToMs(unit.lastReviewedAt),
        cpaStage: unit.cpaStage,
        provisional: false,
        silverAwardedAt: isoToMs(unit.silverAwardedAt),
        goldVerifiedAt: isoToMs(unit.goldVerifiedAt),
        updatedAt: nowMs,
      };
      await this.deps.upsertUnitProgress(record);
    }

    for (const topic of snapshot.topics) {
      const record: TopicProgressRecord = {
        studentId,
        topicId: topic.topicId,
        unitId: topic.unitId,
        topicCode: topic.topicCode,
        completed: topic.completed,
        crowns: topic.crowns,
        masteryScore: topic.masteryScore,
        bestAccuracyPct: topic.bestAccuracyPct,
        bestMedianSpeedSec: topic.bestMedianSpeedSec,
        attemptsCount: topic.attemptsCount,
        fluencyGrade: topic.fluencyGrade,
        stabilityDays: topic.stabilityDays,
        nextReviewAt: isoToMs(topic.nextReviewAt),
        lastReviewedAt: isoToMs(topic.lastReviewedAt),
        provisional: false,
        updatedAt: nowMs,
      };
      await this.deps.upsertTopicProgress(record);
    }
  }

  /**
   * Does the beyond-window probe PROVE the trailing session ended?
   * True when the probe read the entire unsynced remainder (fewer rows
   * than asked — nothing exists past it), or when a row of a DIFFERENT
   * session follows the trailing session's last seen row (the child
   * moved on). False when the probe window itself filled with the
   * trailing session's rows: its true end is still unknown, so the
   * session is deferred rather than risked.
   */
  private trailingSessionEnded(
    probe: AttemptLogRow[],
    tail: AttemptLogRow[],
    trailingKey: string,
    windowLastId: number,
  ): boolean {
    if (probe.length < SyncEngine.SERVER_MAX_BATCH) return true;
    const lastSeenId = tail.length > 0 ? tail[tail.length - 1]!.id : windowLastId;
    return probe.some((r) => r.id > lastSeenId && sessionKeyOf(r) !== trailingKey);
  }

  private isRetryable(err: unknown): boolean {
    if (err && typeof err === "object" && "retryable" in err) {
      return Boolean((err as { retryable: unknown }).retryable);
    }
    // Network-level failures (fetch rejects) are retryable by default.
    return true;
  }

  private signalContent(packs: PackVersionSignal[] | undefined): void {
    if (packs && packs.length > 0) {
      this.depsFull.onContentOutdated?.(packs);
      this.log({ kind: "sync-content-outdated", packs: packs.length });
    }
  }

  private log(event: SyncLogEvent): void {
    this.depsFull.logger?.log(event);
  }
}
