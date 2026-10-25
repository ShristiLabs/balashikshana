/**
 * Placement offer + decision-record specs (issue #60) — the PURE policy
 * layer: when the journey offers the diagnostic (first grade entry per
 * (student, grade), resumability through record absence), what a decline
 * writes, and what an accepted recommendation writes (default
 * recommended vs the explicit gentler unit-1 path).
 */
import { describe, expect, it } from "vitest";
import {
  acceptDecision,
  declineDecision,
  gentleStartUnitId,
  shouldOfferPlacement,
} from "../src/placement/offer";
import { normalizeCreditedUnitIds } from "../src/placement/record";
import type { PlacementDecisionRecord } from "../src/placement/record";

function declinedRecord(): PlacementDecisionRecord {
  return declineDecision({
    studentId: "stu-1",
    gradeId: "kindergarten",
    firstUnitId: "K-M1",
    nowMs: 1_700_000_000_000,
  });
}

describe("shouldOfferPlacement (first-grade-entry guard)", () => {
  it("offers when no decision record exists (fresh onboarding landing)", () => {
    expect(shouldOfferPlacement(null)).toBe(true);
  });

  it("never re-offers after a decline", () => {
    expect(shouldOfferPlacement(declinedRecord())).toBe(false);
  });

  it("never re-offers after a completed placement", () => {
    const record = acceptDecision({
      studentId: "stu-1",
      gradeId: "kindergarten",
      summary: {
        sessionId: "place-1",
        itemsAsked: 6,
        outcome: {
          recommendedStartUnitId: "K-M3",
          creditedUnits: [{ unitId: "K-M1" }, { unitId: "K-M2" }],
        },
      },
      acceptedUnitId: "K-M3",
      nowMs: 1_700_000_000_000,
    });
    expect(shouldOfferPlacement(record)).toBe(false);
  });
});

describe("declineDecision", () => {
  it("writes the gentler start (journey first unit), zero credit, no session", () => {
    const record = declinedRecord();
    expect(record.status).toBe("declined");
    expect(record.startUnitId).toBe("K-M1");
    expect(record.recommendedStartUnitId).toBeNull();
    expect(record.creditedUnitIds).toEqual([]);
    expect(record.itemsAsked).toBe(0);
    expect(record.sessionId).toBeNull();
  });
});

describe("acceptDecision", () => {
  const summary = {
    sessionId: "place-9",
    itemsAsked: 8,
    outcome: {
      recommendedStartUnitId: "K-M3",
      creditedUnits: [{ unitId: "K-M2" }, { unitId: "K-M1" }, { unitId: "K-M2" }],
    },
  };

  it("default path: the accepted unit IS the recommendation", () => {
    const record = acceptDecision({
      studentId: "stu-1",
      gradeId: "kindergarten",
      summary,
      acceptedUnitId: "K-M3",
      nowMs: 5,
    });
    expect(record.status).toBe("completed");
    expect(record.startUnitId).toBe("K-M3");
    expect(record.recommendedStartUnitId).toBe("K-M3");
    expect(record.itemsAsked).toBe(8);
    expect(record.sessionId).toBe("place-9");
  });

  it("gentle path: the explicit unit-1 start keeps the recommendation on record", () => {
    const record = acceptDecision({
      studentId: "stu-1",
      gradeId: "kindergarten",
      summary,
      acceptedUnitId: "K-M1",
      nowMs: 5,
    });
    expect(record.startUnitId).toBe("K-M1");
    expect(record.recommendedStartUnitId).toBe("K-M3");
  });

  it("credited units are deduped and sorted (deterministic wire shape)", () => {
    const record = acceptDecision({
      studentId: "stu-1",
      gradeId: "kindergarten",
      summary,
      acceptedUnitId: "K-M3",
      nowMs: 5,
    });
    expect(record.creditedUnitIds).toEqual(["K-M1", "K-M2"]);
    expect(normalizeCreditedUnitIds(["b", "a", "b"])).toEqual(["a", "b"]);
    expect(normalizeCreditedUnitIds([])).toEqual([]);
  });

  it("a degenerate outcome without a recommendation falls back to the accepted unit", () => {
    const record = acceptDecision({
      studentId: "stu-1",
      gradeId: "kindergarten",
      summary: {
        sessionId: "place-x",
        itemsAsked: 0,
        outcome: { recommendedStartUnitId: null, creditedUnits: [] },
      },
      acceptedUnitId: "K-M1",
      nowMs: 5,
    });
    expect(record.recommendedStartUnitId).toBe("K-M1");
    expect(record.creditedUnitIds).toEqual([]);
  });
});

describe("gentleStartUnitId (journey order)", () => {
  it("is the journey's first unit (subject ASC, sequence ASC — unitsForGrade order)", () => {
    expect(gentleStartUnitId(["K-E1", "K-M1", "K-M2"])).toBe("K-E1");
  });

  it("degenerates to empty for an empty grade (caller routes to unit 1 anyway)", () => {
    expect(gentleStartUnitId([])).toBe("");
  });
});
