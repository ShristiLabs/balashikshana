/**
 * Storage-budget + pruning policy (issue #46) — pure, node-testable.
 *
 * Doctrine (issue body): one ACTIVE grade pack at a time. On grade switch
 * the previous grade's pack is pruned after the new pack installs; on
 * upgrade the superseded version of the same grade is pruned after the new
 * version installs. Everything else (leftovers from crashes, older
 * versions) is a candidate for deletion BEFORE a new install if the
 * storage budget demands it.
 *
 * Budget: CONTENT_STORAGE_BUDGET_BYTES caps total pack storage. Measured
 * pack sizes (registry v1.0.0): 0.86-2.33 MB per grade, 9.07 MB for all
 * five — 64 MB leaves >27x headroom for the largest pack while staying
 * trivially inside low-end-Android app-data norms (roadmap Risk 4).
 */
import type { PackMetaRow } from "./types";

export const CONTENT_STORAGE_BUDGET_BYTES = 64 * 1024 * 1024;

export interface PruneDecision {
  /** False when the budget cannot be met even after pruning everything allowed. */
  allowed: boolean;
  /** Artifact names to delete BEFORE/AROUND the install (superseded content). */
  deleteFiles: string[];
  /** Meta rows to drop alongside deleteFiles. */
  deleteMeta: { gradeId: string; contentVersion: string }[];
  reason: string | null;
}

export interface PruneInput {
  rows: PackMetaRow[];
  /** Grade the incoming pack belongs to (becomes the only kept grade). */
  incomingGradeId: string;
  /** Version of the incoming pack — supersedes same-grade rows. */
  incomingContentVersion: string;
  incomingBytes: number;
  budgetBytes?: number;
}

/**
 * Decide pruning for an install that is verified and ready to move into
 * place. The incoming pack is NOT yet in `rows` (the caller records it
 * after the move). Kept after this decision: the incoming pack only.
 */
export function decidePrune(input: PruneInput): PruneDecision {
  const budget = input.budgetBytes ?? CONTENT_STORAGE_BUDGET_BYTES;
  const deleteMeta: PruneDecision["deleteMeta"] = [];
  const deleteFiles: string[] = [];

  for (const row of input.rows) {
    const supersededSameGrade =
      row.gradeId === input.incomingGradeId && row.contentVersion !== input.incomingContentVersion;
    const otherGrade = row.gradeId !== input.incomingGradeId;
    if (supersededSameGrade || otherGrade) {
      deleteMeta.push({ gradeId: row.gradeId, contentVersion: row.contentVersion });
      deleteFiles.push(row.artifact);
    }
  }

  const keptBytes = input.rows
    .filter((row) => !deleteFiles.includes(row.artifact))
    .reduce((n, row) => n + row.sizeBytes, 0);

  if (keptBytes + input.incomingBytes > budget) {
    return {
      allowed: false,
      deleteFiles: [],
      deleteMeta: [],
      reason: "storage-budget-exceeded",
    };
  }
  return { allowed: true, deleteFiles, deleteMeta, reason: null };
}
