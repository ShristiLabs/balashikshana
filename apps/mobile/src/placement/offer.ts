/**
 * Placement offer guard (issue #60) — PURE decision policy for WHEN the
 * journey surface offers the placement diagnostic and WHAT the family's
 * choice writes. Node-testable; no React, no I/O, no clock (nowMs and
 * unit facts arrive as parameters).
 *
 * Policy (binding, from the issue body + #44 resumability):
 * - The offer is per (student, grade): it appears on FIRST grade entry —
 *   a fresh onboarding landing OR a first switch into a grade the child
 *   has never been offered placement for.
 * - ONE decision per (student, grade), ever: `declined` (the offer was
 *   skipped — never re-asked for that grade; the journey starts at unit
 *   1) or `completed` (the probe ran; `startUnitId` records the ACCEPTED
 *   start point — the recommendation, or the gentler unit-1 option).
 * - The offer NEVER blocks: absence of a record only ever SHOWS the
 *   gentle card; every journey interaction stays live underneath it.
 * - Resumed-onboarding re-show (#44 AC): a kill anywhere before the
 *   decision write leaves no record, so the next journey mount offers
 *   again — the record's absence IS the resume state.
 */
import type { PlacementDecisionRecord } from "./record";
import { normalizeCreditedUnitIds } from "./record";

/** True when the journey should show the placement offer card. */
export function shouldOfferPlacement(record: PlacementDecisionRecord | null): boolean {
  return record === null;
}

/**
 * The decline decision: the family skipped the exploration. The journey
 * start is the grade's FIRST unit in journey order (subject ASC,
 * sequence ASC — the order unitsForGrade returns); no credit exists.
 */
export function declineDecision(params: {
  studentId: string;
  gradeId: string;
  firstUnitId: string;
  nowMs: number;
}): PlacementDecisionRecord {
  return {
    studentId: params.studentId,
    gradeId: params.gradeId,
    status: "declined",
    startUnitId: params.firstUnitId,
    recommendedStartUnitId: null,
    creditedUnitIds: [],
    itemsAsked: 0,
    sessionId: null,
    updatedAt: params.nowMs,
  };
}

/**
 * The completion decision: the probe ran and the family chose where to
 * start. `acceptedUnitId` is the recommendation (default path) or the
 * gentler unit-1 start (explicit path) — both are always available on
 * the recommendation screen per the issue body.
 */
export function acceptDecision(params: {
  studentId: string;
  gradeId: string;
  summary: {
    sessionId: string;
    itemsAsked: number;
    outcome: {
      recommendedStartUnitId: string | null;
      creditedUnits: { unitId: string }[];
    };
  };
  acceptedUnitId: string;
  nowMs: number;
}): PlacementDecisionRecord {
  const { summary } = params;
  const recommended = summary.outcome.recommendedStartUnitId ?? params.acceptedUnitId;
  return {
    studentId: params.studentId,
    gradeId: params.gradeId,
    status: "completed",
    startUnitId: params.acceptedUnitId,
    recommendedStartUnitId: recommended,
    creditedUnitIds: normalizeCreditedUnitIds(
      summary.outcome.creditedUnits.map((unit) => unit.unitId),
    ),
    itemsAsked: summary.itemsAsked,
    sessionId: summary.sessionId,
    updatedAt: params.nowMs,
  };
}

/**
 * Derives the gentler-option unit (journey order's first unit) for the
 * recommendation screen's explicit "start from the beginning" path.
 * Journey order is unitsForGrade's contract (subject ASC, sequence ASC,
 * unit id ASC) — the journey map's node order.
 */
export function gentleStartUnitId(unitIdsInJourneyOrder: string[]): string {
  return unitIdsInJourneyOrder[0] ?? "";
}
