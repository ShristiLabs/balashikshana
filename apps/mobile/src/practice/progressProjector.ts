/**
 * Progress projector (issue #47): attempts -> topic/unit progress rows.
 *
 * EQUIVALENCE CONTRACT: every derivation below is a line-for-line mirror
 * of the server's handlers (services/api/server.mjs —
 * POST /api/practice/topic/complete and POST /api/gate/evaluate), using
 * the SAME core-engine calls with the SAME parameters, rounding, and
 * GREATEST/LEAST upsert semantics, so an identical attempt stream
 * yields identical progress rows on-device and server-side. The
 * practice-server-equivalence test proves it by running both paths.
 *
 * Documented divergences (see also goldKey.ts):
 * 1. Key machine: local Gold requires the registry's 14-hour window +
 *    5-item verification; the server today promotes on a second pass.
 * 2. Topic-practice cognitive time is computed with audio duration 0
 *    exactly like the server (which has no audio); gate items use the
 *    engine's audio-aware rule because the engine itself reads
 *    r.audioDurationSec on that path.
 * 3. provisional=1 on every local write: local gate outcomes and key
 *    states stay provisional until #48 sync confirms them.
 */
import {
  computeCognitiveTimeSec,
  computeFluencyGrade,
  median,
  updateTopicMemoryStability,
} from "@balashikshana/core-engine";
import {
  goldVerificationPassed,
  isGoldEligible,
  nextKeyAfterGatePass,
  nextSilverAwardedAt,
} from "./goldKey";
import type { AttemptInput, KeyState, TopicProgressRecord, UnitProgressRecord } from "./types";

/** A raw response as a session collected it (mirrors the server payload shape). */
export interface SessionResponse {
  topicCode: string;
  questionId?: string;
  chosenAnswer?: string | number | boolean;
  isCorrect: boolean;
  rawTimeSec: number;
  audioDurationSec?: number;
  misconceptionTags?: string[];
}

export interface SrPolicy {
  gradeGrowthFactor: number;
  maxIntervalCapDays: number;
}

export interface TopicSessionDerivation {
  passedTopic: boolean;
  crowns: number;
  accuracyPct: number;
  medianCogSpeedSec: number;
  targetSpeedSec: number;
  fluencyGrade: number;
  stabilityDays: number;
  cpaStage: string;
  nextReviewAt: number;
  /** The completed progress row BEFORE merging with the previous one. */
  fresh: TopicProgressRecord;
}

/**
 * Server topic-complete derivation (mirrors services/api/server.mjs).
 * `prev` is the existing topic row (server: previous upsert target).
 */
export function deriveTopicSession(params: {
  studentId: string;
  unitId: string;
  topicId: string;
  topicCode: string;
  responses: SessionResponse[];
  motorBaselineSec: number;
  targetSpeedSec: number;
  srPolicy: SrPolicy;
  prev: TopicProgressRecord | null;
  nowMs: number;
}): TopicSessionDerivation {
  const { responses, motorBaselineSec, targetSpeedSec, srPolicy, prev, nowMs } = params;
  const total = Math.max(1, responses.length);
  const correct = responses.filter((r) => r.isCorrect).length;
  const accPct = Number(((correct / total) * 100).toFixed(1));
  // Server passes audio 0 on the topic-practice path — mirrored exactly.
  const cogTimes = responses.map((r) =>
    computeCognitiveTimeSec(r.rawTimeSec || 3.0, motorBaselineSec, 0),
  );
  const medSpeed = Number(median(cogTimes).toFixed(2));

  const passedTopic = accPct >= 80;
  const crowns =
    accPct >= 95 && medSpeed <= targetSpeedSec ? 3 : accPct >= 85 ? 2 : passedTopic ? 1 : 0;

  const fg = computeFluencyGrade(passedTopic, medSpeed, targetSpeedSec);
  const srUpdate = updateTopicMemoryStability({
    currentStabilityDays: prev ? prev.stabilityDays : 1.0,
    fluencyGrade: fg,
    gradeGrowthFactor: srPolicy.gradeGrowthFactor,
    maxIntervalCapDays: srPolicy.maxIntervalCapDays,
  });
  const nextReviewAt = nowMs + srUpdate.stabilityDays * 86_400_000;

  return {
    passedTopic,
    crowns,
    accuracyPct: accPct,
    medianCogSpeedSec: medSpeed,
    targetSpeedSec,
    fluencyGrade: fg,
    stabilityDays: srUpdate.stabilityDays,
    cpaStage: srUpdate.cpaStage,
    nextReviewAt,
    fresh: {
      studentId: params.studentId,
      topicId: params.topicId,
      unitId: params.unitId,
      topicCode: params.topicCode,
      completed: passedTopic ? 1 : 0,
      crowns,
      masteryScore: Math.round(accPct),
      bestAccuracyPct: accPct,
      bestMedianSpeedSec: medSpeed,
      attemptsCount: 1,
      fluencyGrade: fg,
      stabilityDays: srUpdate.stabilityDays,
      nextReviewAt,
      lastReviewedAt: nowMs,
      provisional: true,
      updatedAt: nowMs,
    },
  };
}

/**
 * Server upsert merge: completed/crowns/mastery/best-accuracy keep the
 * max; best speed keeps the min once measured; counters accumulate;
 * fluency/stability/schedule take the latest session's values.
 */
export function mergeTopicProgress(
  prev: TopicProgressRecord | null,
  fresh: TopicProgressRecord,
): TopicProgressRecord {
  if (!prev) return { ...fresh };
  return {
    ...fresh,
    completed: Math.max(prev.completed, fresh.completed),
    crowns: Math.max(prev.crowns, fresh.crowns),
    masteryScore: Math.max(prev.masteryScore, fresh.masteryScore),
    bestAccuracyPct: Math.max(prev.bestAccuracyPct, fresh.bestAccuracyPct),
    bestMedianSpeedSec:
      prev.bestMedianSpeedSec > 0
        ? Math.min(prev.bestMedianSpeedSec, fresh.bestMedianSpeedSec)
        : fresh.bestMedianSpeedSec,
    attemptsCount: prev.attemptsCount + 1,
    provisional: true,
  };
}

/** The engine's full gate verdict (shape of evaluateMasteryGateAttempt's return). */
export interface GateVerdict {
  passed: boolean;
  overallAccuracyPct?: number;
  medianCogSpeedSec?: number;
}

export interface GateSessionDerivation {
  passed: boolean;
  keyState: KeyState | null;
  fresh: UnitProgressRecord;
}

/**
 * Server gate-evaluate derivation (mirrors services/api/server.mjs) with
 * the local two-key machine substituted for the server's second-pass
 * promotion — the one documented divergence (goldKey.ts). Status
 * stickiness and key COALESCE semantics live in mergeUnitProgress.
 */
export function deriveGateSession(params: {
  studentId: string;
  unitId: string;
  verdict: GateVerdict;
  /** The unit's gate_max_speed_sec — the server passes it to the fluency grade. */
  targetSpeedSec: number;
  srPolicy: SrPolicy;
  prev: UnitProgressRecord | null;
  nowMs: number;
}): GateSessionDerivation {
  const { verdict, targetSpeedSec, srPolicy, prev, nowMs } = params;
  const fg = computeFluencyGrade(verdict.passed, verdict.medianCogSpeedSec ?? 0, targetSpeedSec);
  const srUpdate = updateTopicMemoryStability({
    currentStabilityDays: prev ? prev.stabilityDays : 1.0,
    fluencyGrade: fg,
    gradeGrowthFactor: srPolicy.gradeGrowthFactor,
    maxIntervalCapDays: srPolicy.maxIntervalCapDays,
  });

  const keyState = verdict.passed
    ? nextKeyAfterGatePass(prev?.keyState ?? null)
    : (prev?.keyState ?? null);

  return {
    passed: verdict.passed,
    keyState,
    fresh: {
      studentId: params.studentId,
      unitId: params.unitId,
      status: verdict.passed ? "MASTERED" : "REMEDIATION_REQUIRED",
      keyState,
      // Empty-attempt evaluations omit these fields server-side; the
      // columns are NOT NULL there and here — coerce to the default 0.
      bestAccuracyPct: verdict.overallAccuracyPct ?? 0,
      bestMedianSpeedSec: verdict.medianCogSpeedSec ?? 0,
      attemptsCount: 1,
      stabilityDays: srUpdate.stabilityDays,
      lastReviewedAt: nowMs,
      cpaStage: srUpdate.cpaStage,
      provisional: true,
      silverAwardedAt: nextSilverAwardedAt(prev, verdict.passed, nowMs),
      goldVerifiedAt: prev?.goldVerifiedAt ?? 0,
      updatedAt: nowMs,
    },
  };
}

/**
 * Server upsert merge: MASTERED is sticky; an existing key is never
 * nulled (COALESCE(excluded, prev)); best accuracy keeps the max; best
 * speed keeps the min once measured; counters accumulate; the two-key
 * timestamps never move backwards.
 */
export function mergeUnitProgress(
  prev: UnitProgressRecord | null,
  fresh: UnitProgressRecord,
): UnitProgressRecord {
  if (!prev) return { ...fresh };
  return {
    ...fresh,
    status: prev.status === "MASTERED" ? "MASTERED" : fresh.status,
    keyState: fresh.keyState ?? prev.keyState,
    bestAccuracyPct: Math.max(prev.bestAccuracyPct, fresh.bestAccuracyPct),
    bestMedianSpeedSec:
      prev.bestMedianSpeedSec > 0
        ? Math.min(prev.bestMedianSpeedSec, fresh.bestMedianSpeedSec)
        : fresh.bestMedianSpeedSec,
    attemptsCount: prev.attemptsCount + 1,
    silverAwardedAt: Math.max(prev.silverAwardedAt, fresh.silverAwardedAt),
    goldVerifiedAt: Math.max(prev.goldVerifiedAt, fresh.goldVerifiedAt),
    provisional: true,
  };
}

/**
 * Derivation for a Gold verification session (local-only surface — the
 * server has no verification endpoint today). >= 4 of 5 correct, past
 * the 14-hour window, upgrades Silver -> Gold; anything else leaves the
 * row untouched (a retry may run later). Attempts are already logged by
 * the recorder; this only computes the unit-row transition.
 */
export function deriveGoldVerification(params: {
  studentId: string;
  unitId: string;
  correctCount: number;
  prev: UnitProgressRecord | null;
  nowMs: number;
}): { upgraded: boolean; record: UnitProgressRecord | null } {
  const prev = params.prev;
  if (!prev || prev.keyState !== "SILVER_KEY") return { upgraded: false, record: null };
  if (!isGoldEligible(prev.silverAwardedAt, params.nowMs)) {
    return { upgraded: false, record: null };
  }
  if (!goldVerificationPassed(params.correctCount)) return { upgraded: false, record: null };
  return {
    upgraded: true,
    record: {
      ...prev,
      keyState: "GOLD_KEY",
      goldVerifiedAt: params.nowMs,
      provisional: true,
      updatedAt: params.nowMs,
    },
  };
}

export interface AttemptDerivation {
  cognitiveTimeSec: number;
  fluencyGrade: number;
}

/**
 * Per-attempt projection (mirrors the server's student_question_attempts
 * insert math): topic attempts use audio 0 exactly like the server's
 * topic-complete loop; gate/verification attempts use the engine's
 * audio-aware rule because the engine itself applies it on that path.
 */
export function deriveAttempt(params: {
  response: SessionResponse;
  sessionType: AttemptInput["sessionType"];
  motorBaselineSec: number;
  targetSpeedSec: number;
}): AttemptDerivation {
  const audio = params.sessionType === "TOPIC_PRACTICE" ? 0 : params.response.audioDurationSec || 0;
  const cSec = computeCognitiveTimeSec(
    params.response.rawTimeSec || 3.0,
    params.motorBaselineSec,
    audio,
  );
  const fluencyGrade = computeFluencyGrade(params.response.isCorrect, cSec, params.targetSpeedSec);
  return { cognitiveTimeSec: cSec, fluencyGrade };
}
