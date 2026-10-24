/**
 * Version-comparison and pruning-policy tests (issue #46).
 */
import { describe, expect, it } from "vitest";
import { compareContentVersion, needsUpdate } from "../src/content/versioning";
import { CONTENT_STORAGE_BUDGET_BYTES, decidePrune } from "../src/content/prunePolicy";
import type { PackMetaRow } from "../src/content/types";

function metaRow(
  gradeId: string,
  contentVersion: string,
  sizeBytes: number,
  artifact?: string,
): PackMetaRow {
  return {
    gradeId,
    contentVersion,
    formatVersion: 1,
    status: "active",
    artifact: artifact ?? `pack-${gradeId}-v${contentVersion}.sqlite`,
    sizeBytes,
    sha256: "a".repeat(64),
    keyId: "dev-local",
    installedAt: 1_000,
  };
}

describe("compareContentVersion", () => {
  it("orders triples numerically, not lexically", () => {
    expect(compareContentVersion("1.0.0", "1.0.0")).toBe(0);
    expect(compareContentVersion("1.2.0", "1.10.0")).toBeLessThan(0);
    expect(compareContentVersion("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareContentVersion("1.0", "1.0.0")).toBe(0);
  });

  it("needsUpdate is strict newer only", () => {
    expect(needsUpdate("1.0.0", "1.0.1")).toBe(true);
    expect(needsUpdate("1.1.0", "1.0.9")).toBe(false);
    expect(needsUpdate("1.0.0", "1.0.0")).toBe(false);
  });
});

describe("decidePrune", () => {
  it("prunes the previous grade's pack on a grade switch", () => {
    const decision = decidePrune({
      rows: [metaRow("grade-1", "1.0.0", 2_000_000)],
      incomingGradeId: "pre-k",
      incomingContentVersion: "1.0.0",
      incomingBytes: 900_000,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.deleteMeta).toEqual([{ gradeId: "grade-1", contentVersion: "1.0.0" }]);
    expect(decision.deleteFiles).toEqual(["pack-grade-1-v1.0.0.sqlite"]);
  });

  it("prunes superseded versions of the same grade on upgrade", () => {
    const decision = decidePrune({
      rows: [metaRow("pre-k", "1.0.0", 900_000)],
      incomingGradeId: "pre-k",
      incomingContentVersion: "1.1.0",
      incomingBytes: 950_000,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.deleteMeta).toEqual([{ gradeId: "pre-k", contentVersion: "1.0.0" }]);
  });

  it("keeps the current same-grade row untouched (no-op decision)", () => {
    const decision = decidePrune({
      rows: [metaRow("pre-k", "1.0.0", 900_000)],
      incomingGradeId: "pre-k",
      incomingContentVersion: "1.0.0",
      incomingBytes: 900_000,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.deleteMeta).toEqual([]);
  });

  it("refuses installs that would exceed the storage budget", () => {
    const decision = decidePrune({
      rows: [metaRow("pre-k", "1.0.0", 30_000_000), metaRow("grade-3", "1.0.0", 30_000_000)],
      incomingGradeId: "grade-1",
      incomingContentVersion: "1.0.0",
      incomingBytes: 10_000_000,
      // Even pruning both old packs: 30+30 pruned, incoming 10MB fits.
      budgetBytes: 64 * 1024 * 1024,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.deleteMeta).toHaveLength(2);

    const refused = decidePrune({
      rows: [],
      incomingGradeId: "grade-1",
      incomingContentVersion: "1.0.0",
      incomingBytes: 5_000_000,
      budgetBytes: 4_000_000,
    });
    expect(refused.allowed).toBe(false);
    expect(refused.reason).toBe("storage-budget-exceeded");
  });

  it("budget accounts for kept bytes, not just the incoming pack", () => {
    // A row that must be KEPT (same grade+version) plus an incoming pack
    // that together exceed the budget -> refused (kept bytes counted).
    const decision = decidePrune({
      rows: [metaRow("pre-k", "1.0.0", 6_000_000)],
      incomingGradeId: "pre-k",
      incomingContentVersion: "1.0.0",
      incomingBytes: 6_000_000,
      budgetBytes: 10_000_000,
    });
    expect(decision.allowed).toBe(false);
  });

  it("default budget is generous vs measured pack sizes", () => {
    expect(CONTENT_STORAGE_BUDGET_BYTES).toBe(64 * 1024 * 1024);
  });

  it("prunes EVERY superseded and other-grade row, deterministically in row order", () => {
    const rows = [
      metaRow("grade-1", "1.0.0", 900_000),
      metaRow("pre-k", "1.0.0", 800_000),
      metaRow("grade-1", "1.5.0", 950_000),
      // The only row that survives: same grade, same version as incoming.
      metaRow("grade-1", "2.0.0", 1_000_000),
    ];
    const decision = decidePrune({
      rows,
      incomingGradeId: "grade-1",
      incomingContentVersion: "2.0.0",
      incomingBytes: 1_000_000,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.deleteMeta).toEqual([
      { gradeId: "grade-1", contentVersion: "1.0.0" },
      { gradeId: "pre-k", contentVersion: "1.0.0" },
      { gradeId: "grade-1", contentVersion: "1.5.0" },
    ]);
    expect(decision.deleteFiles).toEqual([
      "pack-grade-1-v1.0.0.sqlite",
      "pack-pre-k-v1.0.0.sqlite",
      "pack-grade-1-v1.5.0.sqlite",
    ]);
  });

  it("budget boundary is inclusive: exact fit allowed, one byte over refused", () => {
    const input = (budgetBytes: number) => ({
      rows: [metaRow("pre-k", "1.0.0", 6_000_000)],
      incomingGradeId: "pre-k",
      incomingContentVersion: "1.0.0",
      incomingBytes: 4_000_000,
      budgetBytes,
    });
    expect(decidePrune(input(10_000_000)).allowed).toBe(true);
    const oneOver = decidePrune(input(9_999_999));
    expect(oneOver.allowed).toBe(false);
    expect(oneOver.reason).toBe("storage-budget-exceeded");
  });

  it("pruning stale rows is what makes an otherwise-over-budget install fit", () => {
    const decision = decidePrune({
      // 30MB of stale other-grade content would blow a 34MB budget if kept,
      // but it is prunable, so a 5MB incoming pack fits.
      rows: [metaRow("grade-3", "1.0.0", 30_000_000)],
      incomingGradeId: "grade-1",
      incomingContentVersion: "1.0.0",
      incomingBytes: 5_000_000,
      budgetBytes: 34_000_000,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.deleteMeta).toEqual([{ gradeId: "grade-3", contentVersion: "1.0.0" }]);
  });
});
