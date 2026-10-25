/**
 * Placement decision record (issue #60) — the DEVICE-LOCAL store seam.
 *
 * Division of ownership (mirrors the server ledger row's note): the
 * server owns the placement OUTCOME (re-derived from the attempt
 * stream); this row owns the family's DECISION — declined offers are
 * never re-asked for the grade, and the accepted start point (the
 * recommendation, or the gentler unit-1 option) drives the journey.
 * Offline-first: the local row is written the moment the family
 * chooses and stands on resumed onboarding (#44 resumability) even
 * with no network; nothing here ever leaves the device except through
 * the ordinary PLACEMENT attempt stream.
 */
export type PlacementDecisionStatus = "declined" | "completed";

export interface PlacementDecisionRecord {
  studentId: string;
  gradeId: string;
  status: PlacementDecisionStatus;
  /** The ACCEPTED start unit (the recommendation, or unit 1 on the gentler path / decline). */
  startUnitId: string;
  /** The engine's recommendation at decision time (null when declined). */
  recommendedStartUnitId: string | null;
  /** Placement-credited units (guardrails applied) — the journey unlock set. */
  creditedUnitIds: string[];
  itemsAsked: number;
  sessionId: string | null;
  updatedAt: number;
}

/** Storage seam (nativePractice provides the SQLite implementation; tests fake it). */
export interface PlacementRecordStore {
  get(studentId: string, gradeId: string): Promise<PlacementDecisionRecord | null>;
  upsert(record: PlacementDecisionRecord): Promise<void>;
}

/** The deterministic wire shape of credited_unit_ids_json (sorted, deduped). */
export function normalizeCreditedUnitIds(unitIds: string[]): string[] {
  return [...new Set(unitIds)].sort();
}
