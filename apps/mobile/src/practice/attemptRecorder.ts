/**
 * Append-only attempt recorder (issue #47).
 *
 * The attempt log is the client-authoritative record of everything a
 * child answered (D8). This module exposes INSERT-only semantics: the
 * PracticeStorage.insertAttempt seam is the single writer, there is NO
 * update or delete path on attempt_log anywhere in the mobile tree, and
 * a source-scan test (practice-append-only.test.ts) enforces that
 * invariant. `synced` stays 0 — only #48's sync worker flips it after
 * the server acknowledges an upload.
 *
 * Determinism policy (documented per the quality bar):
 * - answered_at: injected device clock (epoch ms). The device clock is
 *   the only clock offline; #48 reconciles skew server-side.
 * - seq: the AUTOINCREMENT id — strictly monotonic across sessions and
 *   app restarts; #48 drains unsynced rows ORDER BY id.
 */
import type { AttemptInput, PracticeDeps, PracticeStorage } from "./types";

export interface RecordedAttempt {
  seq: number;
  answeredAt: number;
}

export class AttemptRecorder {
  private readonly storage: PracticeStorage;
  private readonly now: () => number;

  constructor(deps: Pick<PracticeDeps, "storage" | "now">) {
    this.storage = deps.storage;
    this.now = deps.now;
  }

  /** Append one fully-derived attempt; returns its monotonic sequence id. */
  async record(input: AttemptInput): Promise<RecordedAttempt> {
    const answeredAt = this.now();
    const seq = await this.storage.insertAttempt(input, answeredAt);
    return { seq, answeredAt };
  }

  /** #48 seam (read-only): pending upload count. */
  async unsyncedCount(studentId: string): Promise<number> {
    return this.storage.unsyncedAttemptCount(studentId);
  }
}
