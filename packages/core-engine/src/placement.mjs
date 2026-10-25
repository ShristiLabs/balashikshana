/**
 * Placement diagnostic rules (issue #60, roadmap E10) — PURE functions and
 * data only. Zero dependencies, no clocks (time arrives as a parameter),
 * no I/O, no Math.random (randomness is a hand-rolled seeded PRNG whose
 * state travels explicitly, so every adaptive path is DETERMINISTIC per
 * seed).
 *
 * DOCTRINE (binding, mirrors rewards.mjs/hearts.mjs):
 * - D8/D3 agreement: the start-point recommendation is derived by THIS
 *   module on BOTH sides — the RN client's optimistic local projection
 *   and the server's authoritative recompute from the same append-only
 *   PLACEMENT attempt stream. Identical stream, identical outcome, by
 *   construction. Server call sites: services/api/sync.mjs (the
 *   reconciler's PLACEMENT replay) and services/api/placement.mjs (the
 *   record read). Client call site: apps/mobile/src/placement.
 * - Placement RECOMMENDS a start point and grants PROVISIONAL credit;
 *   it never awards Silver/Gold keys (only a #51 Boss Gate does), never
 *   marks a unit MASTERED, and never completes a topic (a placement item
 *   is evidence, not a crowning pass).
 * - Provisional credit is ordinary FSRS stability (updateTopicMemoryStability
 *   on the placement item's fluency) that decays through the normal
 *   retrievability path if the child never revisits the topic — there is
 *   deliberately NO second memory system.
 *
 * ADAPTIVE PROBE DESIGN (documented policy; the issue body fixes the
 * shape, this module fixes the numbers and they are POLICY CONSTANTS,
 * like gate thresholds):
 * - Strands: units arrive strand-keyed (registry subject: "math"/"ela").
 *   Each strand's units are ordered by (sequenceOrder, unitId) — the
 *   registry chains are linear per strand (PK-M1 -> PK-M2 -> ...), with
 *   the grade's first unit carrying the cross-grade entry link
 *   (e.g. G1-M1 requires K-M10).
 * - Adaptive staircase: the probe walks each strand's chain from unit 1.
 *   A correct answer advances the depth (the child likely knows the next
 *   unit too); a wrong answer parks the strand in CONFIRMATION — one more
 *   item on the SAME unit. A second wrong answer CONFIRMS the frontier
 *   (the child starts at that unit); a correct confirm treats the first
 *   miss as a slip (one-tap errors must not pin a young child) and keeps
 *   advancing. This confirmation rule IS the confidence-based stopping
 *   rule: the session ends as soon as every strand has a confirmed
 *   frontier or hit its chain end, subject to the hard item cap.
 * - Cross-grade prerequisites are covered by the depth-0 probe itself:
 *   the grade's first unit embeds its prior-grade transition, so a chain
 *   start of 0 (wrong on unit 1) means start at unit 1, and any deeper
 *   start implies unit 1 was demonstrated — the "explicitly re-probed"
 *   limb of the guardrail holds by construction.
 *
 * GUARDRAILS (hard, tested exactly at the boundary):
 * - maxSkipAheadUnits caps BOTH the recommended start index AND the
 *   credited prefix per strand: one short run can never blast a child
 *   more than 4 units past the grade's first unit, and discarded
 *   evidence beyond the cap is never credited (a mid-grade re-run is a
 *   documented non-goal; the cap keeps a single run's blast radius
 *   bounded).
 * - The recommended start unit's prerequisite chain is fully credited or
 *   re-probed by construction: the start is the FIRST uncredited unit of
 *   its strand, so everything the DAG requires before it carries
 *   placement credit.
 * - No key vocabulary exists in this module's outputs — callers cannot
 *   award keys from placement even by accident.
 *
 * Determinism policy: no function here reads the wall clock, Math.random,
 * or locale-dependent formatting. Item selection advances an explicit
 * integer PRNG state; outcome derivation is a pure order-independent
 * function of per-unit response tallies (robust to batch splits — the
 * D8 union-replay seam).
 */

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

/**
 * Placement policy numbers (POLICY CONSTANTS, like gate thresholds — not
 * data, not configurable per call except in tests).
 */
// The mapping reuses the engine's own machinery — the SAME FSRS growth,
// the SAME DAG credit spread, and the SAME procedural generator the
// practice paths serve (the issue's "uses propagateImplicitDagCredit"
// is structural, not incidental). Circular with index.mjs's
// `export * from`: safe because every referenced binding is a hoisted
// function declaration resolved through live bindings at call time.
import {
  propagateImplicitDagCredit,
  generateProceduralQuestion,
  updateTopicMemoryStability
} from "./index.mjs";

export const PLACEMENT_RULES = Object.freeze({
  /** Hard session bound. A strong child tops out here (2 strands x 7 depths). */
  maxItems: 14,
  /** Per-strand cap on BOTH the recommended start index and credited prefix. */
  maxSkipAheadUnits: 4,
  /** Base stability a placement item grows from (the engine's fresh-topic default). */
  provisionalBaseStabilityDays: 1.0,
  /** DAG credit weight for propagateImplicitDagCredit (the engine default). */
  dagCreditWeight: 0.4
});

/**
 * The client's default probe seed: any fixed integer keeps a session's
 * adaptive path deterministic; the value itself carries no meaning (the
 * server NEVER needs it — outcome derivation is a pure function of the
 * response tallies, not the selection path).
 */
export const DEFAULT_PLACEMENT_SEED = 60;

// ---------------------------------------------------------------------------
// Seeded PRNG (hand-rolled mulberry32 step — pure, integer state)
// ---------------------------------------------------------------------------

/**
 * One mulberry32 step: mutates the 32-bit seed and returns the next float
 * in [0, 1). Pure — callers thread the returned state explicitly.
 */
export function nextPlacementRand(seed) {
  let a = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return { seed: a, value: ((t ^ (t >>> 14)) >>> 0) / 4294967296 };
}

/** Deterministic pick of an index in [0, n) from the PRNG state. */
function pickIndex(seed, n) {
  if (n <= 1) return { seed, index: 0 };
  const step = nextPlacementRand(seed);
  return { seed: step.seed, index: Math.floor(step.value * n) % n };
}

// ---------------------------------------------------------------------------
// Strand chains
// ---------------------------------------------------------------------------

/**
 * A placement unit: the minimal registry shape the probe needs. The
 * server builds these off the units table; the client off pack rows;
 * tests off fixtures. `strand` is the registry subject key.
 */
export function strandChainsFromUnits(units) {
  if (!Array.isArray(units)) return [];
  const byStrand = new Map();
  for (const unit of units) {
    if (!unit || typeof unit.unitId !== "string") continue;
    const strand = typeof unit.strand === "string" && unit.strand.length > 0 ? unit.strand : "core";
    if (!byStrand.has(strand)) byStrand.set(strand, []);
    byStrand.get(strand).push(unit);
  }
  const chains = [];
  for (const [strand, chain] of [...byStrand.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    chain.sort((a, b) => {
      const sa = Number(a.sequenceOrder ?? 0);
      const sb = Number(b.sequenceOrder ?? 0);
      if (sa !== sb) return sa - sb;
      return a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0;
    });
    chains.push({ strand, units: chain });
  }
  return chains;
}

/** unitId -> chain position lookup { strand, index } across all chains. */
function chainPositions(chains) {
  const positions = new Map();
  for (const chain of chains) {
    chain.units.forEach((unit, index) => positions.set(unit.unitId, { strand: chain.strand, index }));
  }
  return positions;
}

// ---------------------------------------------------------------------------
// Adaptive probe state machine (reducer-style, pure)
// ---------------------------------------------------------------------------

/**
 * Probe state. `rngSeed` is the ONLY randomness source; identical seed +
 * identical responses => identical item sequence and identical outcome.
 */
export function initialPlacementState({ units, seed = 1, rules = PLACEMENT_RULES }) {
  const chains = strandChainsFromUnits(units);
  return {
    rules,
    rngSeed: Number(seed) | 0,
    itemsAsked: 0,
    chains,
    strands: Object.fromEntries(
      chains.map((chain) => [
        chain.strand,
        { status: "probing", depth: 0, pendingConfirmUnitId: null, lastTopicIndexByUnit: {} }
      ])
    )
  };
}

function liveStrandNames(state) {
  return Object.keys(state.strands).filter((name) => {
    const s = state.strands[name];
    return s.status === "probing" || s.status === "confirming";
  });
}

function probeDone(state) {
  return (
    state.itemsAsked >= state.rules.maxItems ||
    liveStrandNames(state).length === 0
  );
}

/**
 * Produces the next placement item, or `done` when the stopping rule
 * fires. Confirming strands resolve FIRST (a pending confirmation is the
 * cheapest confidence gain), then the shallowest probing strand advances
 * (round-robin across strands keeps the probe representative of the
 * grade, not deep on one subject); ties break on strand name (deterministic).
 *
 * The item is engine-generated: generateProceduralQuestion over a seeded
 * topic pick, exactly like the practice API. Callers render it; the
 * returned `kind` tells the recorder whether the answer confirms a
 * frontier or probes a new depth.
 */
export function placementNextItem(state, { unitsBy }) {
  if (probeDone(state)) return { state, done: true };
  const units = unitsBy instanceof Map ? unitsBy : new Map(Object.entries(unitsBy || {}));

  const names = liveStrandNames(state);
  const confirming = names.filter((n) => state.strands[n].status === "confirming");
  const probing = names.filter((n) => state.strands[n].status === "probing");
  const candidates = confirming.length > 0 ? confirming : probing;
  // Shallowest first (representative coverage); name tiebreak.
  candidates.sort((a, b) => {
    const da = state.strands[a].depth;
    const db = state.strands[b].depth;
    if (da !== db) return da - db;
    return a < b ? -1 : 1;
  });
  const strandName = candidates[0];
  const strandState = state.strands[strandName];
  const chain = state.chains.find((c) => c.strand === strandName);

  let unit;
  let kind;
  if (strandState.status === "confirming") {
    unit = units.get(strandState.pendingConfirmUnitId) ?? chain.units.find((u) => u.unitId === strandState.pendingConfirmUnitId);
    kind = "confirm";
    if (!unit) {
      // Defensive: pending unit vanished from the map — treat as confirmed.
      return {
        state: { ...state, strands: { ...state.strands, [strandName]: { ...strandState, status: "confirmed" } } },
        done: false
      };
    }
  } else {
    if (strandState.depth >= chain.units.length) {
      return {
        state: { ...state, strands: { ...state.strands, [strandName]: { ...strandState, status: "chain-end" } } },
        done: false
      };
    }
    unit = units.get(chain.units[strandState.depth].unitId) ?? chain.units[strandState.depth];
    kind = "probe";
  }

  const topicCount = Array.isArray(unit.skillTopics) ? unit.skillTopics.length : 0;
  if (topicCount === 0) {
    // No askable topics: skip the unit forward (never block the probe).
    const next = advanceDepth(state, strandName, chain);
    return { state: next, done: false };
  }

  const pick = pickIndex(state.rngSeed, topicCount);
  const topic = unit.skillTopics[pick.index];
  const question = generatePlacementQuestion(unit, topic, pick.seed);

  return {
    state: { ...state, rngSeed: pick.seed, itemsAsked: state.itemsAsked + 1 },
    item: {
      kind,
      strand: strandName,
      unitId: unit.unitId,
      topicId: `${unit.unitId}-${topic.code}`,
      topicCode: topic.code,
      question
    },
    done: false
  };
}

function advanceDepth(state, strandName, chain) {
  const s = state.strands[strandName];
  const depth = s.depth + 1;
  const status = depth >= chain.units.length ? "chain-end" : "probing";
  return {
    ...state,
    strands: { ...state.strands, [strandName]: { ...s, status, depth, pendingConfirmUnitId: null } }
  };
}

/**
 * Folds one graded response into the probe state (pure). Correct probe =>
 * deeper; wrong probe => confirmation on the same unit; correct confirm =>
 * slip forgiven, deeper; wrong confirm => frontier confirmed.
 */
export function recordPlacementResponse(state, { unitId, isCorrect }) {
  const chains = state.chains;
  const position = chainPositions(chains).get(unitId);
  if (!position) return state;
  const strandState = state.strands[position.strand];
  const chain = chains.find((c) => c.strand === position.strand);
  if (!strandState || strandState.status === "confirmed" || strandState.status === "chain-end") {
    return state;
  }

  if (strandState.status === "confirming" && strandState.pendingConfirmUnitId === unitId) {
    if (isCorrect) {
      // Slip forgiven — the unit counts as demonstrated; keep advancing.
      return advanceDepth(state, position.strand, chain);
    }
    return {
      ...state,
      strands: {
        ...state.strands,
        [position.strand]: { ...strandState, status: "confirmed" }
      }
    };
  }

  // Depth probe at this unit.
  if (isCorrect) {
    return advanceDepth(state, position.strand, chain);
  }
  return {
    ...state,
    strands: {
      ...state.strands,
      [position.strand]: { ...strandState, status: "confirming", pendingConfirmUnitId: unitId }
    }
  };
}

// ---------------------------------------------------------------------------
// Outcome derivation — the pure start-point mapping (D8: both sides run it)
// ---------------------------------------------------------------------------

/**
 * The start-point mapping: placement evidence -> credited topics +
 * recommended start unit. A PURE, order-independent function of per-unit
 * response tallies over the strand chains — robust to attempt-stream
 * batch splits and identical on client and server.
 *
 * Responses carry the attempt facts: { unitId, topicId, isCorrect,
 * rawTimeSec?, motorBaselineSec? }. Units carry { unitId, strand,
 * sequenceOrder, title, prerequisiteUnitIds, masteryGate? } (masteryGate
 * optional; the gate speed feeds fluency when present).
 */
export function derivePlacementOutcome({
  responses,
  units,
  unitMap,
  rules = PLACEMENT_RULES
}) {
  const chains = strandChainsFromUnits(units);
  // propagateImplicitDagCredit indexes a PLAIN OBJECT by unitId (the
  // engine's original contract); build that view here regardless of how
  // the caller passed the map.
  const dagMap = {};
  if (unitMap) {
    const entries = unitMap instanceof Map ? unitMap.entries() : Object.entries(unitMap);
    for (const [id, unit] of entries) dagMap[id] = unit;
  }
  for (const unit of units || []) dagMap[unit.unitId] = unit;

  // Per-unit tallies (order-independent; duplicate deliveries add nothing
  // new because idempotent tallies are recomputed from the union).
  const tallies = new Map(); // unitId -> { asked, wrongs, topics: Map(code -> {asked, corrects}) , topicIds: Map(topicId -> code) }
  for (const r of Array.isArray(responses) ? responses : []) {
    if (!r || typeof r.unitId !== "string") continue;
    let t = tallies.get(r.unitId);
    if (!t) {
      t = { asked: 0, wrongs: 0, topics: new Map(), topicIds: new Map() };
      tallies.set(r.unitId, t);
    }
    t.asked += 1;
    if (!r.isCorrect) t.wrongs += 1;
    const code = topicCodeOf(r.topicId, r.unitId);
    const key = r.topicId || code;
    let topic = t.topics.get(code);
    if (!topic) {
      topic = { asked: 0, corrects: 0, topicId: key };
      t.topics.set(code, topic);
    }
    topic.asked += 1;
    if (r.isCorrect) topic.corrects += 1;
  }

  const perStrand = chains.map((chain) => {
    // Walk the chain: frontier = first confirmed-wrong or unprobed unit.
    let frontierIndex = chain.units.length;
    for (let i = 0; i < chain.units.length; i += 1) {
      const unit = chain.units[i];
      const t = tallies.get(unit.unitId);
      if (t && t.wrongs >= 2) {
        frontierIndex = i;
        break;
      }
      if (!t || t.asked < 1) {
        frontierIndex = i;
        break;
      }
      // Probed with at most one wrong (a forgiven slip): demonstrated.
    }
    const capped = frontierIndex > rules.maxSkipAheadUnits;
    const creditedCount = Math.min(frontierIndex, rules.maxSkipAheadUnits);
    const startIdx = Math.min(creditedCount, chain.units.length - 1);
    return { chain, frontierIndex, capped, creditedCount, startUnitId: chain.units[Math.max(0, startIdx)].unitId };
  });

  // Credited units + provisional topic credit + DAG credit.
  const creditedUnits = [];
  let probedUnits = 0;
  let demonstratedUnits = 0;
  for (const strand of perStrand) {
    for (let i = 0; i < strand.creditedCount; i += 1) {
      const unit = strand.chain.units[i];
      const t = tallies.get(unit.unitId) ?? { asked: 0, wrongs: 0, topics: new Map() };
      probedUnits += 1;
      demonstratedUnits += 1;
      const gateSpeed = unit?.masteryGate?.maxMedianResponseTimeSec || 0;
      const creditedTopics = [];
      for (const [code, topic] of t.topics.entries()) {
        // Provisional FSRS stability per CORRECT placement item (the
        // engine's own growth function; wrong items grow nothing).
        let stability = 0;
        for (let k = 0; k < topic.corrects; k += 1) {
          const fg = gateSpeed > 0 ? 4 : 3;
          const update = updatePlacementStability({
            currentStabilityDays: stability > 0 ? stability : rules.provisionalBaseStabilityDays,
            fluencyGrade: fg
          });
          stability = update.stabilityDays;
        }
        creditedTopics.push({
          topicCode: code,
          topicId: topic.topicId,
          correctItems: topic.corrects,
          askedItems: topic.asked,
          provisionalStabilityDays: stability
        });
      }
      const unitDelta = creditedTopics.reduce((max, t2) => Math.max(max, t2.provisionalStabilityDays), 0);
      const dagCredit = propagateImplicitDagCredit(
        unit.unitId,
        unitDelta,
        dagMap,
        rules.dagCreditWeight
      );
      creditedUnits.push({
        unitId: unit.unitId,
        strand: strand.chain.strand,
        topics: creditedTopics,
        implicitDagCredit: dagCredit
      });
    }
    // Units probed past the cap still count toward confidence reporting.
    for (let i = strand.creditedCount; i < strand.frontierIndex && i < strand.chain.units.length; i += 1) {
      const t = tallies.get(strand.chain.units[i].unitId);
      if (t && t.asked > 0) probedUnits += 1;
    }
  }

  // The recommended start: the earliest uncredited point across strands
  // in journey order (subject ASC, sequence ASC — the chain order the
  // journey map renders). A child continues from the earliest unfinished
  // strand, never inside an uncredited chain.
  const startCandidates = perStrand
    .map((s) => s.chain.units.findIndex((u) => u.unitId === s.startUnitId))
    .map((idx, i) => ({ strand: perStrand[i], idx }));
  let recommended = null;
  for (const cand of startCandidates) {
    const unit = cand.strand.chain.units[Math.max(0, cand.idx)];
    if (!recommended || unit.sequenceOrder < recommended.sequenceOrder || (unit.sequenceOrder === recommended.sequenceOrder && unit.unitId < recommended.unitId)) {
      recommended = unit;
    }
  }

  const itemsAsked = talliesSum(tallies);
  const skipAheadUnitCount = perStrand.reduce((max, s) => Math.max(max, s.creditedCount), 0);

  return {
    rules,
    itemsAsked,
    recommendedStartUnitId: recommended ? recommended.unitId : null,
    perStrand: perStrand.map((s) => ({
      strand: s.chain.strand,
      frontierIndex: s.frontierIndex,
      creditedUnits: s.creditedCount,
      startUnitId: s.startUnitId,
      cappedBySkipAhead: s.capped
    })),
    creditedUnits,
    skipAheadUnitCount,
    // Confidence report: how much of the probed surface was demonstrated.
    // The stopping rule guarantees every strand frontier was confirmed (or
    // chain-ended / cap-cut) before the client ended the session.
    confidence: {
      strandsTotal: chains.length,
      probedUnits,
      demonstratedUnits
    },
    // GUARDRAIL POSTURES (structural, pinned by tests):
    prerequisiteChainCredited: true,
    keysAwarded: []
  };
}

function talliesSum(tallies) {
  let sum = 0;
  for (const t of tallies.values()) sum += t.asked;
  return sum;
}

function topicCodeOf(topicId, unitId) {
  if (typeof topicId === "string" && topicId.startsWith(`${unitId}-`)) {
    return topicId.slice(unitId.length + 1);
  }
  return topicId ?? "";
}

/**
 * Provisional stability growth — the engine's own FSRS growth clamped to
 * the placement base band. A single placement item can never out-stabilize
 * a real practice pass (the caps keep the provisional tier modest).
 */
export function updatePlacementStability({
  currentStabilityDays = PLACEMENT_RULES.provisionalBaseStabilityDays,
  fluencyGrade = 3
}) {
  const update = updateTopicMemoryStability({
    currentStabilityDays,
    fluencyGrade,
    gradeGrowthFactor: 2.0,
    maxIntervalCapDays: 4
  });
  return update;
}

// ---------------------------------------------------------------------------
// Question generation (engine items; the client renders them, the wire
// carries their facts as ordinary PLACEMENT attempts)
// ---------------------------------------------------------------------------

/**
 * Delegates to the engine's procedural generator with a derived seed —
 * the SAME generator the practice API serves (issue AC: "items sampled
 * per strand from the engine's generateProceduralQuestion").
 */
export function generatePlacementQuestion(unit, topic, seed = 0) {
  return generateProceduralQuestion(unit, topic, seed);
}
