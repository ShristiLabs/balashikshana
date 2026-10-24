/**
 * Journey-map model (issue #49) — the PURE derivation layer.
 *
 * DI doctrine (same as practice/sync): zero react-native imports, zero
 * native modules, zero I/O. Everything here is a pure function of
 * (pack unit/topic rows, progress rows, clock) — the vitest suite
 * exercises every derivation without RN, and the screen layer only
 * renders what this module computes.
 *
 * STATE-DERIVATION CONTRACT (issue #49: "unit node states driven by
 * engine UNIT_STATES"). The seven engine states map onto pack + progress
 * data as follows — precedence top to bottom:
 *
 *   LOCKED               prerequisite units (prerequisite_unit_ids_json,
 *                        resolved inside the grade) not all MASTERED
 *   MASTERED             unit_progress.status = MASTERED (sticky on both
 *                        sides; gate passed)
 *   REMEDIATION_REQUIRED unit_progress.status = REMEDIATION_REQUIRED
 *                        (last gate attempt failed)
 *   GATE_UNLOCKED        every topic completed at fluency (avg crowns
 *                        >= 2) — the boss gate is genuinely winnable
 *   FLUENCY_READY        every topic completed (basic crowns >= 1) —
 *                        fluency built, gate available to attempt
 *   GUIDED_PRACTICE      some (not all) topics completed
 *   STUDY_REQUIRED       unlocked, nothing completed yet
 *
 * The FLUENCY_READY / GATE_UNLOCKED split is the journey's documented
 * reading of the engine's ladder: completing every stone makes the child
 * "ready"; demonstrating fluency (2+ crowns average — the projector's
 * 85%-accuracy tier) "unlocks" the gate as the highlighted next action.
 * Both are computed, never stored.
 *
 * KEY STATES (two-key sleep-consolidation, #47/#48): none -> Silver ->
 * Gold straight off unit_progress.key_state; `provisional` mirrors the
 * row (sync adoption clears it); the 14-hour Gold-verification window
 * is goldEligibleAtMs - now (0 once eligible). Keys are forward-only.
 */

import { UNIT_STATES } from "@balashikshana/core-engine";
import { goldEligibleAtMs } from "../practice/goldKey";
import type { KeyState, UnitProgressRecord } from "../practice/types";

/** The engine's ladder, verbatim — the engine stays the single source. */
export type UnitState = (typeof UNIT_STATES)[keyof typeof UNIT_STATES];

/** The pack-side shape the model consumes (subset of PackUnitRow). */
export interface JourneyUnitSource {
  unitId: string;
  subject: string;
  sequenceOrder: number;
  title: string;
  prerequisiteUnitIds: string[];
}

/** Per-unit topic census straight off the pack (one topicsForGrade read). */
export interface UnitTopicCensus {
  unitId: string;
  totalTopics: number;
}

/** Completed-topic counts per unit (from allTopicProgress, keyed by unit). */
export interface UnitTopicCompletion {
  unitId: string;
  completedTopics: number;
  /** Average crowns over ALL of the unit's topics (0 for untouched). */
  averageCrowns: number;
}

export interface JourneyModelInput {
  units: JourneyUnitSource[];
  census: UnitTopicCensus[];
  completion: UnitTopicCompletion[];
  unitProgress: UnitProgressRecord[];
  nowMs: number;
}

export interface JourneyUnitNode {
  unitId: string;
  subject: string;
  sequenceOrder: number;
  title: string;
  state: UnitState;
  /** Prerequisite unit ids that are still unmastered (LOCKED reason). */
  blockedBy: string[];
  totalTopics: number;
  completedTopics: number;
  /** 0..1 completion fraction of the unit's topics. */
  topicFraction: number;
  keyState: KeyState | null;
  /** True while the key (or gate outcome) awaits server confirmation. */
  provisional: boolean;
  /** Silver award time (epoch ms, 0 when none) — drives the countdown. */
  silverAwardedAt: number;
  /** Epoch ms at which Gold verification may run (0 when no Silver). */
  goldEligibleAtMs: number;
  /** ms remaining in the 14-hour window (0 = eligible or not applicable). */
  goldCountdownMs: number;
  /** True when the Gold verification is unlocked (window elapsed). */
  goldEligible: boolean;
  /**
   * The child's next actionable unit: the first unlocked unit that is
   * not MASTERED (Duolingo's "you are here"). Exactly zero or one node
   * in a model carries this.
   */
  isCurrent: boolean;
}

export interface JourneyModel {
  gradeId: string;
  units: JourneyUnitNode[];
  garden: GardenHealth;
  derivedAtMs: number;
}

// ----------------------------------------------------------------------
// Garden health — aggregate mastery/gate-health visual, computed
// ----------------------------------------------------------------------

export type GardenBand = "sprouting" | "growing" | "thriving";

export interface GardenHealth {
  totalUnits: number;
  masteredUnits: number;
  silverKeys: number;
  goldKeys: number;
  /** Mean per-unit mastery fraction, 0..100 (locked units count 0). */
  overallPct: number;
  /** Fraction of GATE-attempted units whose best accuracy >= 80, 0..100. */
  gateHealthPct: number;
  band: GardenBand;
}

/**
 * Per-unit mastery fraction feeding the aggregate: MASTERED = 1,
 * Silver key held = 0.75 (gate passed, Gold pending), gate-stage units
 * (FLUENCY_READY / GATE_UNLOCKED) = 0.6 + 0.2 * topicFraction, practice
 * units = 0.5 * topicFraction, STUDY_REQUIRED/LOCKED = 0. REMEDIATION
 * keeps its topic fraction (the stones still stand; the gate retries).
 */
export function unitMasteryFraction(node: {
  state: UnitState;
  topicFraction: number;
  keyState: KeyState | null;
}): number {
  switch (node.state) {
    case "MASTERED":
      return 1;
    case "REMEDIATION_REQUIRED":
      return 0.5 * node.topicFraction;
    case "FLUENCY_READY":
    case "GATE_UNLOCKED":
      return node.keyState ? 0.75 : 0.6 + 0.2 * node.topicFraction;
    case "GUIDED_PRACTICE":
      return 0.5 * node.topicFraction;
    default:
      return 0;
  }
}

/** Band thresholds are POLICY constants (like gate thresholds), not data. */
export const GARDEN_BANDS = {
  growingMinPct: 40,
  thrivingMinPct: 75,
} as const;

export function gardenBandFor(overallPct: number): GardenBand {
  if (overallPct >= GARDEN_BANDS.thrivingMinPct) return "thriving";
  if (overallPct >= GARDEN_BANDS.growingMinPct) return "growing";
  return "sprouting";
}

// ----------------------------------------------------------------------
// Model derivation
// ----------------------------------------------------------------------

function parsePrerequisites(json: string): string[] {
  try {
    const parsed = JSON.parse(json || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

/** Pack row -> model source (the only place the pack's JSON is parsed). */
export function unitSourceFromPackRow(row: {
  unit_id: string;
  subject: string;
  sequence_order: number;
  title: string;
  prerequisite_unit_ids_json: string;
}): JourneyUnitSource {
  return {
    unitId: row.unit_id,
    subject: row.subject,
    sequenceOrder: row.sequence_order,
    title: row.title,
    prerequisiteUnitIds: parsePrerequisites(row.prerequisite_unit_ids_json),
  };
}

export function deriveJourneyModel(input: JourneyModelInput & { gradeId: string }): JourneyModel {
  const progressByUnit = new Map(input.unitProgress.map((row) => [row.unitId, row]));
  const censusByUnit = new Map(input.census.map((row) => [row.unitId, row.totalTopics]));
  const completionByUnit = new Map(input.completion.map((row) => [row.unitId, row]));

  // First pass: MASTERED set drives the LOCKED derivation.
  const mastered = new Set(
    input.unitProgress.filter((row) => row.status === "MASTERED").map((row) => row.unitId),
  );

  const nodes: JourneyUnitNode[] = input.units.map((unit) => {
    const totalTopics = censusByUnit.get(unit.unitId) ?? 0;
    const completion = completionByUnit.get(unit.unitId);
    const completedTopics = Math.min(completion?.completedTopics ?? 0, totalTopics);
    const averageCrowns = completion?.averageCrowns ?? 0;
    const topicFraction = totalTopics > 0 ? completedTopics / totalTopics : 0;
    const row = progressByUnit.get(unit.unitId) ?? null;

    const blockedBy =
      unit.prerequisiteUnitIds.length > 0
        ? unit.prerequisiteUnitIds.filter((prereq) => !mastered.has(prereq))
        : [];
    const allTopicsDone = totalTopics > 0 && completedTopics >= totalTopics;

    let state: UnitState;
    if (blockedBy.length > 0) {
      state = "LOCKED";
    } else if (row?.status === "MASTERED") {
      state = "MASTERED";
    } else if (row?.status === "REMEDIATION_REQUIRED") {
      state = "REMEDIATION_REQUIRED";
    } else if (allTopicsDone && averageCrowns >= 2) {
      state = "GATE_UNLOCKED";
    } else if (allTopicsDone) {
      state = "FLUENCY_READY";
    } else if (completedTopics > 0) {
      state = "GUIDED_PRACTICE";
    } else {
      state = "STUDY_REQUIRED";
    }

    // A held key outranks the derived ladder (keys are forward-only and
    // only MASTERED units hold keys in practice; the ordering keeps the
    // derivation total regardless of row history).
    if ((row?.keyState === "SILVER_KEY" || row?.keyState === "GOLD_KEY") && state !== "MASTERED") {
      state = "MASTERED";
    }

    const silverAwardedAt = row?.silverAwardedAt ?? 0;
    const silverHeld = row?.keyState === "SILVER_KEY" || row?.keyState === "GOLD_KEY";
    const eligibleAt = silverHeld && silverAwardedAt > 0 ? goldEligibleAtMs(silverAwardedAt) : 0;
    const goldEligible =
      row?.keyState === "SILVER_KEY" && eligibleAt > 0 && input.nowMs >= eligibleAt;
    const countdown =
      row?.keyState === "SILVER_KEY" && eligibleAt > 0 ? Math.max(0, eligibleAt - input.nowMs) : 0;

    return {
      unitId: unit.unitId,
      subject: unit.subject,
      sequenceOrder: unit.sequenceOrder,
      title: unit.title,
      state,
      blockedBy,
      totalTopics,
      completedTopics,
      topicFraction,
      keyState: row?.keyState ?? null,
      provisional: row?.provisional ?? false,
      silverAwardedAt,
      goldEligibleAtMs: eligibleAt,
      goldCountdownMs: countdown,
      goldEligible,
      isCurrent: false,
    };
  });

  // The current node: first unlocked unit that is not MASTERED. If every
  // unit is mastered the journey has no current node (celebration is #58).
  const current = nodes.find((node) => node.state !== "LOCKED" && node.state !== "MASTERED");
  if (current) current.isCurrent = true;

  return {
    gradeId: input.gradeId,
    units: nodes,
    garden: computeGardenHealth(nodes, input.unitProgress),
    derivedAtMs: input.nowMs,
  };
}

export function computeGardenHealth(
  nodes: JourneyUnitNode[],
  unitProgress: UnitProgressRecord[],
): GardenHealth {
  // Gate health: of the units whose gate was actually attempted
  // (attemptsCount > 0 on the unit row), the share meeting the registry's
  // 80% gate accuracy bar. No attempts yet -> 0 (an empty garden is
  // sprouting, not healthy — never a hardcoded value).
  const attempted = unitProgress.filter((row) => row.attemptsCount > 0);
  const gateHealthy = attempted.filter((row) => row.bestAccuracyPct >= 80).length;
  const gateHealthPct = attempted.length > 0 ? (gateHealthy / attempted.length) * 100 : 0;

  const totalUnits = nodes.length;
  if (totalUnits === 0) {
    return {
      totalUnits: 0,
      masteredUnits: 0,
      silverKeys: 0,
      goldKeys: 0,
      overallPct: 0,
      gateHealthPct: Math.round(gateHealthPct * 10) / 10,
      band: "sprouting",
    };
  }

  let fractionsSum = 0;
  let masteredUnits = 0;
  let silverKeys = 0;
  let goldKeys = 0;
  for (const node of nodes) {
    fractionsSum += unitMasteryFraction(node);
    if (node.state === "MASTERED") masteredUnits += 1;
    if (node.keyState === "SILVER_KEY") silverKeys += 1;
    if (node.keyState === "GOLD_KEY") goldKeys += 1;
  }

  const overallPct = (fractionsSum / totalUnits) * 100;
  return {
    totalUnits,
    masteredUnits,
    silverKeys,
    goldKeys,
    overallPct: Math.round(overallPct * 10) / 10,
    gateHealthPct: Math.round(gateHealthPct * 10) / 10,
    band: gardenBandFor(overallPct),
  };
}

// ----------------------------------------------------------------------
// Winding-path layout — deterministic, pure, memoizable
// ----------------------------------------------------------------------

export interface PathGeometry {
  /** Drawable width (screen width minus horizontal padding). */
  width: number;
  /** Vertical distance between consecutive node centers. */
  verticalStep: number;
  /** Horizontal winding amplitude around the center line. */
  amplitude: number;
}

export interface PathLayout {
  /** Node centers in journey order (top to bottom). */
  positions: { x: number; y: number }[];
  /** Single SVG path `d` string threading the node centers (cubic). */
  pathD: string;
  /** Total drawable height (scroll content height for the path layer). */
  height: number;
}

/**
 * Deterministic S-curve layout: node centers ride a sine wave down the
 * drawable area. The same (unitCount, geometry) ALWAYS yields the same
 * positions and path string — the screen memoizes on those two inputs
 * only, so a re-render with an unchanged grade layout allocates nothing.
 */
export function layoutWindingPath(unitCount: number, geometry: PathGeometry): PathLayout {
  const centerX = geometry.width / 2;
  const positions: { x: number; y: number }[] = [];
  for (let i = 0; i < unitCount; i += 1) {
    // Quarter-period sine: center, right, center, left, center... —
    // the classic winding cadence (two nodes per full period).
    const phase = (i * Math.PI) / 2;
    const x = centerX + Math.sin(phase) * geometry.amplitude;
    const y = geometry.verticalStep * (i + 1);
    positions.push({ x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 });
  }

  let pathD = "";
  if (positions.length === 1) {
    const p = positions[0]!;
    pathD = `M ${p.x} ${p.y}`;
  } else if (positions.length > 1) {
    pathD = positions.reduce((d, point, i) => {
      if (i === 0) return `M ${point.x} ${point.y}`;
      const prev = positions[i - 1]!;
      // Vertical-tangent cubic: control points pull straight down the
      // center line, giving the rounded S-bend the harness validated.
      const midY = (prev.y + point.y) / 2;
      return `${d} C ${prev.x} ${midY}, ${point.x} ${midY}, ${point.x} ${point.y}`;
    }, "");
  }

  return {
    positions,
    pathD,
    height: geometry.verticalStep * (unitCount + 1),
  };
}
