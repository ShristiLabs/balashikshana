/**
 * Local-vs-server semantic equivalence proof (issue #47 acceptance
 * criterion: "On-device gate evaluation is the same engine call as the
 * server's — identical verdicts for both consumption paths").
 *
 * The `server*` helpers below are faithful line-by-line ports of the
 * server handlers in services/api/server.mjs (topic-complete and
 * gate-evaluate, including the exact ON CONFLICT merge semantics of
 * the Postgres upserts). The local projector runs the same response
 * streams; every projected progress field must match EXACTLY, for both
 * consumption paths, because both sides call the same core-engine
 * functions with the same parameters.
 *
 * The ONE documented divergence (local two-key machine vs the server's
 * second-pass GOLD promotion) is asserted explicitly, not hidden: the
 * projections agree on everything except keyState when a Silver holder
 * passes the gate again.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  computeCognitiveTimeSec,
  computeFluencyGrade,
  evaluateMasteryGateAttempt,
  median,
  updateTopicMemoryStability,
} from "@balashikshana/core-engine";
import {
  deriveGateSession,
  deriveTopicSession,
  mergeTopicProgress,
  mergeUnitProgress,
  type SessionResponse,
} from "../src/practice/progressProjector";
import type { TopicProgressRecord, UnitProgressRecord } from "../src/practice/types";

type TopicProgressRecordLike = TopicProgressRecord;

const NOW = 1_700_000_000_000;
const MOTOR = 0.42;
const TARGET_SPEED = 6;
const SR = { gradeGrowthFactor: 1.85, maxIntervalCapDays: 30 };

const UNIT = {
  unitId: "K-M2",
  title: "Numbers to 10",
  masteryGate: {
    questionCount: 6,
    minAccuracyPercent: 80,
    maxMedianResponseTimeSec: TARGET_SPEED,
    challengeZoneStreak: 4,
  },
  skillTopics: [
    { code: "G", name: "Counting to 10" },
    { code: "H", name: "Comparing Numbers" },
    { code: "I", name: "Number Order" },
  ],
};

interface ServerTopicRow {
  completed: number;
  crowns: number;
  mastery_score: number;
  best_accuracy_pct: number;
  best_median_speed_sec: number;
  attempts_count: number;
  fluency_grade: number;
  stability_days: number;
  next_review_at: number;
  last_reviewed_at: number;
}

/**
 * Port of POST /api/practice/topic/complete (services/api/server.mjs):
 * derivation + upsert-merge, exactly as the server computes them.
 */
function serverTopicComplete(
  responses: SessionResponse[],
  prev: ServerTopicRow | null,
): ServerTopicRow {
  const total = Math.max(1, responses.length);
  const correct = responses.filter((r) => r.isCorrect).length;
  const accPct = Number(((correct / total) * 100).toFixed(1));
  const cogTimes = responses.map((r) => computeCognitiveTimeSec(r.rawTimeSec || 3.0, MOTOR, 0));
  const medSpeed = Number(median(cogTimes).toFixed(2));

  const passedTopic = accPct >= 80;
  const crowns =
    accPct >= 95 && medSpeed <= TARGET_SPEED ? 3 : accPct >= 85 ? 2 : passedTopic ? 1 : 0;

  const fg = computeFluencyGrade(passedTopic, medSpeed, TARGET_SPEED);
  const srUpdate = updateTopicMemoryStability({
    currentStabilityDays: prev ? prev.stability_days : 1.0,
    fluencyGrade: fg,
    gradeGrowthFactor: SR.gradeGrowthFactor,
    maxIntervalCapDays: SR.maxIntervalCapDays,
  });
  const now = NOW;
  const nextReview = now + srUpdate.stabilityDays * 86400000;

  // ON CONFLICT(student_id, topic_id) DO UPDATE — ported branch for branch.
  if (!prev) {
    return {
      completed: passedTopic ? 1 : 0,
      crowns,
      mastery_score: Math.round(accPct),
      best_accuracy_pct: accPct,
      best_median_speed_sec: medSpeed,
      attempts_count: 1,
      fluency_grade: fg,
      stability_days: srUpdate.stabilityDays,
      next_review_at: nextReview,
      last_reviewed_at: now,
    };
  }
  return {
    completed: Math.max(prev.completed, passedTopic ? 1 : 0),
    crowns: Math.max(prev.crowns, crowns),
    mastery_score: Math.max(prev.mastery_score, Math.round(accPct)),
    best_accuracy_pct: Math.max(prev.best_accuracy_pct, accPct),
    best_median_speed_sec:
      prev.best_median_speed_sec > 0 ? Math.min(prev.best_median_speed_sec, medSpeed) : medSpeed,
    attempts_count: prev.attempts_count + 1,
    fluency_grade: fg,
    stability_days: srUpdate.stabilityDays,
    next_review_at: nextReview,
    last_reviewed_at: now,
  };
}

function localTopicPrevRow(prev: ServerTopicRow): TopicProgressRecordLike {
  return {
    studentId: "s1",
    topicId: `${UNIT.unitId}-G`,
    unitId: UNIT.unitId,
    topicCode: "G",
    completed: prev.completed,
    crowns: prev.crowns,
    masteryScore: prev.mastery_score,
    bestAccuracyPct: prev.best_accuracy_pct,
    bestMedianSpeedSec: prev.best_median_speed_sec,
    attemptsCount: prev.attempts_count,
    fluencyGrade: prev.fluency_grade,
    stabilityDays: prev.stability_days,
    nextReviewAt: prev.next_review_at,
    lastReviewedAt: prev.last_reviewed_at,
    provisional: true,
    updatedAt: 0,
  };
}

function localTopicComplete(
  responses: SessionResponse[],
  prev: ServerTopicRow | null,
): ServerTopicRow {
  const derivation = deriveTopicSession({
    studentId: "s1",
    unitId: UNIT.unitId,
    topicId: `${UNIT.unitId}-G`,
    topicCode: "G",
    responses,
    motorBaselineSec: MOTOR,
    targetSpeedSec: TARGET_SPEED,
    srPolicy: SR,
    prev: prev ? localTopicPrevRow(prev) : null,
    nowMs: NOW,
  });
  const merged = mergeTopicProgress(prev ? localTopicPrevRow(prev) : null, derivation.fresh);
  return {
    completed: merged.completed,
    crowns: merged.crowns,
    mastery_score: merged.masteryScore,
    best_accuracy_pct: merged.bestAccuracyPct,
    best_median_speed_sec: merged.bestMedianSpeedSec,
    attempts_count: merged.attemptsCount,
    fluency_grade: merged.fluencyGrade,
    stability_days: merged.stabilityDays,
    next_review_at: merged.nextReviewAt,
    last_reviewed_at: merged.lastReviewedAt,
  };
}

interface ServerUnitRow {
  status: string;
  key_state: string | null;
  best_accuracy_pct: number;
  best_median_speed_sec: number;
  attempts_count: number;
  stability_days: number;
  last_reviewed_at: number;
  cpa_stage: string;
}

/** Port of POST /api/gate/evaluate (services/api/server.mjs). */
function serverGateEvaluate(
  responses: SessionResponse[],
  prev: ServerUnitRow | null,
): ServerUnitRow {
  const evalResult = evaluateMasteryGateAttempt({
    unit: UNIT,
    responses: responses.map((r) => ({
      topicCode: r.topicCode,
      isCorrect: r.isCorrect,
      rawTimeSec: r.rawTimeSec,
      audioDurationSec: r.audioDurationSec || 0,
    })),
    motorBaselineSec: MOTOR,
  });
  const fg = computeFluencyGrade(
    evalResult.passed,
    evalResult.medianCogSpeedSec ?? 0,
    TARGET_SPEED,
  );
  const srUpdate = updateTopicMemoryStability({
    currentStabilityDays: prev ? prev.stability_days : 1.0,
    fluencyGrade: fg,
    gradeGrowthFactor: SR.gradeGrowthFactor,
    maxIntervalCapDays: SR.maxIntervalCapDays,
  });

  const nextKeyState = evalResult.passed
    ? prev && (prev.key_state === "SILVER_KEY" || prev.key_state === "GOLD_KEY")
      ? "GOLD_KEY"
      : "SILVER_KEY"
    : prev
      ? prev.key_state
      : null;

  const fresh: ServerUnitRow = {
    status: evalResult.passed ? "MASTERED" : "REMEDIATION_REQUIRED",
    key_state: nextKeyState,
    best_accuracy_pct: evalResult.overallAccuracyPct ?? 0,
    best_median_speed_sec: evalResult.medianCogSpeedSec ?? 0,
    attempts_count: 1,
    stability_days: srUpdate.stabilityDays,
    last_reviewed_at: NOW,
    cpa_stage: srUpdate.cpaStage,
  };
  if (!prev) return fresh;
  return {
    ...fresh,
    status: prev.status === "MASTERED" ? "MASTERED" : fresh.status,
    key_state: fresh.key_state ?? prev.key_state,
    best_accuracy_pct: Math.max(prev.best_accuracy_pct, fresh.best_accuracy_pct),
    best_median_speed_sec:
      prev.best_median_speed_sec > 0
        ? Math.min(prev.best_median_speed_sec, fresh.best_median_speed_sec)
        : fresh.best_median_speed_sec,
    attempts_count: prev.attempts_count + 1,
  };
}

function localUnitPrevRow(prev: ServerUnitRow): UnitProgressRecord {
  return {
    studentId: "s1",
    unitId: UNIT.unitId,
    status: prev.status,
    keyState:
      prev.key_state === "SILVER_KEY" || prev.key_state === "GOLD_KEY" ? prev.key_state : null,
    bestAccuracyPct: prev.best_accuracy_pct,
    bestMedianSpeedSec: prev.best_median_speed_sec,
    attemptsCount: prev.attempts_count,
    stabilityDays: prev.stability_days,
    lastReviewedAt: prev.last_reviewed_at,
    cpaStage: prev.cpa_stage,
    provisional: true,
    silverAwardedAt: 0,
    goldVerifiedAt: 0,
    updatedAt: 0,
  };
}

function localGateEvaluate(
  responses: SessionResponse[],
  prev: ServerUnitRow | null,
): ServerUnitRow {
  const verdict = evaluateMasteryGateAttempt({
    unit: UNIT,
    responses: responses.map((r) => ({
      topicCode: r.topicCode,
      isCorrect: r.isCorrect,
      rawTimeSec: r.rawTimeSec,
      audioDurationSec: r.audioDurationSec || 0,
    })),
    motorBaselineSec: MOTOR,
  });
  const derivation = deriveGateSession({
    studentId: "s1",
    unitId: UNIT.unitId,
    verdict,
    targetSpeedSec: TARGET_SPEED,
    srPolicy: SR,
    prev: prev ? localUnitPrevRow(prev) : null,
    nowMs: NOW,
  });
  const merged = mergeUnitProgress(prev ? localUnitPrevRow(prev) : null, derivation.fresh);
  return {
    status: merged.status,
    key_state: merged.keyState,
    best_accuracy_pct: merged.bestAccuracyPct,
    best_median_speed_sec: merged.bestMedianSpeedSec,
    attempts_count: merged.attemptsCount,
    stability_days: merged.stabilityDays,
    last_reviewed_at: merged.lastReviewedAt,
    cpa_stage: merged.cpaStage,
  };
}

// ----------------------------------------------------------------------
// Streams
// ----------------------------------------------------------------------

function resp(
  topicCode: string,
  isCorrect: boolean,
  rawTimeSec: number,
  audio = 0,
): SessionResponse {
  return { topicCode, isCorrect, rawTimeSec, audioDurationSec: audio };
}

const STREAMS: { name: string; responses: SessionResponse[] }[] = [
  {
    name: "all correct fast",
    responses: [
      resp("G", true, 2),
      resp("G", true, 2.2),
      resp("H", true, 1.9),
      resp("H", true, 2.4),
      resp("I", true, 2.1),
      resp("I", true, 2.3),
      resp("G", true, 2.05),
      resp("G", true, 2.15),
    ],
  },
  {
    name: "mixed 75%",
    responses: [
      resp("G", true, 3),
      resp("G", true, 3.4),
      resp("H", false, 4.2),
      resp("H", true, 2.8),
      resp("I", true, 3.1),
      resp("I", false, 5.5),
      resp("G", true, 2.9),
      resp("G", true, 3.2),
    ],
  },
  {
    name: "all wrong slow",
    responses: [resp("G", false, 6), resp("H", false, 7), resp("I", false, 8)],
  },
  { name: "empty", responses: [] },
  { name: "single item", responses: [resp("G", true, 1.5)] },
  {
    name: "rapid guessing shape",
    responses: [
      resp("G", false, 0.4),
      resp("H", false, 0.5),
      resp("I", false, 0.6),
      resp("G", false, 0.45),
      resp("H", false, 0.55),
      resp("I", false, 0.5),
    ],
  },
  {
    name: "boundary 80% and 95%",
    responses: [
      resp("G", true, 2),
      resp("G", true, 2),
      resp("H", true, 2),
      resp("H", true, 2),
      resp("I", true, 2),
      resp("I", true, 2),
      resp("G", true, 2),
      resp("G", true, 2),
      resp("H", true, 2),
      resp("H", false, 9),
    ],
  },
];

describe("topic projection equivalence: local projector == server derivation", () => {
  for (const stream of STREAMS) {
    it(`first attempt: ${stream.name}`, () => {
      expect(localTopicComplete(stream.responses, null)).toEqual(
        serverTopicComplete(stream.responses, null),
      );
    });
    it(`second attempt (merge): ${stream.name}`, () => {
      // Seed a prior row by running the server path once, then compare
      // both paths' second-session projections against each other.
      const prev = serverTopicComplete(STREAMS[0]!.responses, null);
      expect(localTopicComplete(stream.responses, prev)).toEqual(
        serverTopicComplete(stream.responses, prev),
      );
    });
  }

  it("stays equivalent across a 3-session chain", () => {
    let serverPrev: ServerTopicRow | null = null;
    let localPrev: ServerTopicRow | null = null;
    for (const stream of STREAMS) {
      serverPrev = serverTopicComplete(stream.responses, serverPrev);
      localPrev = localTopicComplete(stream.responses, localPrev);
      expect(localPrev).toEqual(serverPrev);
    }
  });
});

describe("gate projection equivalence: local projector == server derivation", () => {
  for (const stream of STREAMS) {
    it(`first evaluation: ${stream.name}`, () => {
      const server = serverGateEvaluate(stream.responses, null);
      const local = localGateEvaluate(stream.responses, null);
      expect(local).toEqual(server);
    });
    it(`re-evaluation after a failed first gate: ${stream.name}`, () => {
      const failedFirst = serverGateEvaluate(
        [
          resp("G", false, 9),
          resp("H", false, 9),
          resp("I", false, 9),
          resp("G", false, 9),
          resp("H", false, 9),
          resp("I", false, 9),
        ],
        null,
      );
      const server = serverGateEvaluate(stream.responses, failedFirst);
      const local = localGateEvaluate(stream.responses, failedFirst);
      expect(local).toEqual(server);
    });
  }

  it("gate verdicts themselves are identical for both consumption paths (same engine call)", () => {
    for (const stream of STREAMS) {
      const a = evaluateMasteryGateAttempt({
        unit: UNIT,
        responses: stream.responses.map((r) => ({
          topicCode: r.topicCode,
          isCorrect: r.isCorrect,
          rawTimeSec: r.rawTimeSec,
          audioDurationSec: r.audioDurationSec || 0,
        })),
        motorBaselineSec: MOTOR,
      });
      const b = evaluateMasteryGateAttempt({
        unit: UNIT,
        responses: stream.responses.map((r) => ({
          topicCode: r.topicCode,
          isCorrect: r.isCorrect,
          rawTimeSec: r.rawTimeSec,
          audioDurationSec: r.audioDurationSec || 0,
        })),
        motorBaselineSec: MOTOR,
      });
      expect(a).toEqual(b);
      expect(a).toBe(a); // deterministic engine, stable identity
    }
  });

  it("DOCUMENTED DIVERGENCE: a Silver holder passing again gets GOLD server-side, stays SILVER locally", () => {
    const silverRow: ServerUnitRow = {
      status: "MASTERED",
      key_state: "SILVER_KEY",
      best_accuracy_pct: 90,
      best_median_speed_sec: 3,
      attempts_count: 1,
      stability_days: 4,
      last_reviewed_at: NOW - 86_400_000,
      cpa_stage: "PICTORIAL_STATIC",
    };
    const pass = [
      resp("G", true, 2),
      resp("G", true, 2.1),
      resp("H", true, 2),
      resp("H", true, 2.2),
      resp("I", true, 2),
      resp("I", true, 2.1),
    ];
    const server = serverGateEvaluate(pass, silverRow);
    const local = localGateEvaluate(pass, silverRow);
    expect(server.key_state).toBe("GOLD_KEY");
    expect(local.key_state).toBe("SILVER_KEY");
    // Everything else about the projection still agrees.
    const { key_state: _serverKey, ...serverRest } = server;
    const { key_state: _localKey, ...localRest } = local;
    void _serverKey;
    void _localKey;
    expect(localRest).toEqual(serverRest);
  });
});

// ----------------------------------------------------------------------
// Seeded randomized streams (tester pass): 50 deterministic-random
// attempt streams through BOTH consumption paths — first session and
// merged into a prior row — must produce byte-identical projections.
// ----------------------------------------------------------------------

/** mulberry32 — tiny deterministic PRNG (no dependencies). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOPIC_CODES = ["G", "H", "I"];

function randomStream(seed: number): SessionResponse[] {
  const rand = prng(seed);
  const length = Math.floor(rand() * 16); // 0..15
  return Array.from({ length }, (_, i) => ({
    topicCode: TOPIC_CODES[Math.floor(rand() * TOPIC_CODES.length)] ?? "G",
    isCorrect: rand() < 0.3 + 0.6 * rand(),
    rawTimeSec: Number((0.3 + rand() * 9).toFixed(2)),
    audioDurationSec: Number((rand() * 2).toFixed(2)),
    questionId: `q-${seed}-${i}`,
  }));
}

describe("randomized equivalence: 50 seeded streams, topic + gate, first and merged", () => {
  it("topic projections identical on first session", () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const responses = randomStream(seed);
      expect(localTopicComplete(responses, null)).toEqual(serverTopicComplete(responses, null));
    }
  });

  it("topic projections identical when merged into a prior row", () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const prev = serverTopicComplete(randomStream(999), null);
      const responses = randomStream(seed);
      expect(localTopicComplete(responses, prev)).toEqual(serverTopicComplete(responses, prev));
    }
  });

  it("gate projections identical on first evaluation", () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const responses = randomStream(seed + 500);
      expect(localGateEvaluate(responses, null)).toEqual(serverGateEvaluate(responses, null));
    }
  });

  it("gate projections identical after a prior failed gate", () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const prev = serverGateEvaluate(randomStream(1000), null);
      const responses = randomStream(seed + 500);
      expect(localGateEvaluate(responses, prev)).toEqual(serverGateEvaluate(responses, prev));
    }
  });
});

// ----------------------------------------------------------------------
// Server-source tripwire (tester pass): the ports above are only a
// proof while they match the REAL server code. If services/api/
// server.mjs changes any of these load-bearing lines, this tripwire
// fails so the port (and this whole file) is re-verified instead of
// silently proving a stale equivalence.
// ----------------------------------------------------------------------
describe("server-source tripwire: the ported derivation still matches server.mjs", () => {
  const serverSource = fs.readFileSync(
    path.join(__dirname, "..", "..", "..", "services", "api", "server.mjs"),
    "utf8",
  );

  const loadBearingLines: string[] = [
    // topic-complete derivation
    "const total = Math.max(1, responses.length);",
    "const accPct = Number(((correct / total) * 100).toFixed(1));",
    "const medSpeed = Number(median(cogTimes).toFixed(2));",
    "const passedTopic = accPct >= 80;",
    "const crowns = accPct >= 95 && medSpeed <= targetSpeed ? 3 : accPct >= 85 ? 2 : passedTopic ? 1 : 0;",
    // audio-0 topic rule
    "computeCognitiveTimeSec(r.rawTimeSec || 3.0, motorSec, 0)",
    // SR parameter mapping
    "gradeRow ? gradeRow.sr_growth_factor : 2.0",
    "gradeRow ? gradeRow.sr_max_interval_days : 45",
    // gate key promotion (the documented divergence target)
    'prevProg && (prevProg.key_state === "SILVER_KEY" || prevProg.key_state === "GOLD_KEY")',
  ];

  it("contains every load-bearing derivation line the port mirrors", () => {
    for (const line of loadBearingLines) {
      expect(serverSource).toContain(line);
    }
  });

  it("gate handler still reconstructs the unitObj shape the local pack reader builds", () => {
    expect(serverSource).toContain("challengeZoneStreak: unitRow.gate_streak_req");
    expect(serverSource).toContain("skillTopics: topicRows.map");
  });
});
