/**
 * Journey screen store (issue #49) — the PURE state machine between the
 * native loaders and the view. No react-native imports; the vitest suite
 * drives every transition directly.
 *
 * State shape:
 * - grades: the fixed platform grade list (GRADE_IDS), each carrying its
 *   pack currency: "installed" (contentVersion present), "downloading"
 *   (ensurePack in flight — the switcher shows the download state),
 *   "missing" (nothing installed; offline or not yet published), or
 *   "stale" (the #48 handshake flagged a newer server version).
 * - activeGrade + model: the derived journey model for the active grade.
 *   The `model-loaded` action is GUARDED: a model whose gradeId is not
 *   the active grade is ignored (stale racer — see the reducer), which
 *   is what keeps racing loaders (mount hydration vs. grade switch)
 *   last-writer-consistent.
 * - Per-grade progress preservation is structural: unit_progress rows
 *   are keyed by unit id (globally unique across grades), so switching
 *   back re-reads the same rows — the store never clears anything on a
 *   switch, and the reducer proves it.
 */

import type { EnsureResult } from "../content/types";
import type { JourneyModel } from "./model";

export type PackCurrency = "installed" | "downloading" | "missing" | "stale";

export interface GradeSlot {
  gradeId: string;
  label: string;
  currency: PackCurrency;
  contentVersion: string | null;
}

export type JourneyStatus = "loading" | "ready" | "no-pack" | "error";

export interface JourneyState {
  status: JourneyStatus;
  /** Selected grade id (drives which pack's units render). */
  activeGrade: string;
  grades: GradeSlot[];
  model: JourneyModel | null;
  /** Bumped whenever a fresh model lands — the path-layer memo key. */
  modelVersion: number;
  /** True while the mount-time server snapshot hydration is running. */
  hydrating: boolean;
  /** Epoch ms of the last successful snapshot adoption (0 = never). */
  lastHydratedAtMs: number;
  error: string | null;
}

export type JourneyAction =
  | { type: "grades-initialized"; grades: GradeSlot[]; activeGrade: string }
  | { type: "grade-selected"; gradeId: string }
  | { type: "pack-ensure-started"; gradeId: string }
  | {
      type: "pack-ensure-resolved";
      gradeId: string;
      currency: PackCurrency;
      contentVersion: string | null;
    }
  | { type: "pack-flagged-stale"; gradeId: string }
  | { type: "model-loaded"; model: JourneyModel }
  | { type: "load-failed"; error: string }
  | { type: "no-pack" }
  | { type: "hydration-started" }
  | { type: "hydration-adopted"; atMs: number };

export function initialJourneyState(): JourneyState {
  return {
    status: "loading",
    activeGrade: "",
    grades: [],
    model: null,
    modelVersion: 0,
    hydrating: false,
    lastHydratedAtMs: 0,
    error: null,
  };
}

function updateSlot(
  grades: GradeSlot[],
  gradeId: string,
  patch: Partial<Pick<GradeSlot, "currency" | "contentVersion">>,
): GradeSlot[] {
  return grades.map((slot) => (slot.gradeId === gradeId ? { ...slot, ...patch } : slot));
}

export function journeyReducer(state: JourneyState, action: JourneyAction): JourneyState {
  switch (action.type) {
    case "grades-initialized":
      return { ...state, grades: action.grades, activeGrade: action.activeGrade };

    case "grade-selected": {
      if (action.gradeId === state.activeGrade) return state;
      // Switching grades NEVER clears model-agnostic progress state; the
      // next model-load replaces only the view model (per-grade rows are
      // preserved by construction — see the module header).
      return {
        ...state,
        activeGrade: action.gradeId,
        status: "loading",
        model: null,
        error: null,
      };
    }

    case "pack-ensure-started":
      return {
        ...state,
        grades: updateSlot(state.grades, action.gradeId, { currency: "downloading" }),
      };

    case "pack-ensure-resolved":
      return {
        ...state,
        grades: updateSlot(state.grades, action.gradeId, {
          currency: action.currency,
          contentVersion: action.contentVersion,
        }),
      };

    case "pack-flagged-stale":
      return {
        ...state,
        grades: updateSlot(state.grades, action.gradeId, { currency: "stale" }),
      };

    case "model-loaded":
      // Active-grade guard: a load resolving for a grade that is no
      // longer selected is a stale racer (e.g. the mount hydration
      // finishing after a grade switch) — ignore it so the map can
      // never render one grade's units under another grade's selection
      // (node taps route {gradeId, unitId} pairs that must match).
      if (action.model.gradeId !== state.activeGrade) return state;
      return {
        ...state,
        status: "ready",
        model: action.model,
        modelVersion: state.modelVersion + 1,
        error: null,
      };

    case "load-failed":
      return { ...state, status: "error", error: action.error };

    case "no-pack":
      return { ...state, status: "no-pack", model: null };

    case "hydration-started":
      return { ...state, hydrating: true };

    case "hydration-adopted":
      return { ...state, hydrating: false, lastHydratedAtMs: action.atMs };

    default:
      return state;
  }
}

/**
 * Map an #46 EnsureResult to the switcher's currency vocabulary.
 * "current"/"installed"/"upgraded" -> installed; "refused"/"failed"/
 * "unavailable" -> missing (the download state surfaced per grade).
 */
export function currencyForEnsureResult(
  result: EnsureResult,
  installedVersion: string | null,
): { currency: PackCurrency; contentVersion: string | null } {
  switch (result.status) {
    case "current":
    case "installed":
    case "upgraded":
      return {
        currency: "installed",
        contentVersion: result.contentVersion ?? installedVersion,
      };
    default:
      // A failed ensure over an existing install keeps serving the
      // installed pack (offline tolerance — the journey stays usable).
      return installedVersion
        ? { currency: "installed", contentVersion: installedVersion }
        : { currency: "missing", contentVersion: null };
  }
}
