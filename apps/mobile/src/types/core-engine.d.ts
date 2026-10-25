/**
 * Typed seam for @balashikshana/core-engine (issue #47).
 *
 * The engine is zero-dependency ESM JavaScript (packages/core-engine,
 * src/index.mjs) shared with the server; it ships no .d.ts by design
 * and we never modify its sources. This ambient declaration types the
 * surface the mobile app consumes, mirroring the implementations
 * exactly (see packages/core-engine/src/index.mjs).
 */
declare module "@balashikshana/core-engine" {
  export const UNIT_STATES: {
    readonly LOCKED: "LOCKED";
    readonly STUDY_REQUIRED: "STUDY_REQUIRED";
    readonly GUIDED_PRACTICE: "GUIDED_PRACTICE";
    readonly FLUENCY_READY: "FLUENCY_READY";
    readonly GATE_UNLOCKED: "GATE_UNLOCKED";
    readonly MASTERED: "MASTERED";
    readonly REMEDIATION_REQUIRED: "REMEDIATION_REQUIRED";
  };

  export const REMEDIATION_MODES: {
    readonly NONE: "NONE";
    readonly CONCEPT_GAP: "MODE_1_CONCEPT_GAP";
    readonly IMPULSIVE_RUSHING: "MODE_2_IMPULSIVE_RUSHING";
    readonly LOW_AUTOMATICITY: "MODE_3_LOW_AUTOMATICITY";
    readonly SINGLE_TOPIC_BLINDSPOT: "MODE_4_SINGLE_TOPIC_BLINDSPOT";
  };

  export const CPA_STAGES: {
    readonly CONCRETE: "CONCRETE_INTERACTIVE";
    readonly PICTORIAL: "PICTORIAL_STATIC";
    readonly GHOST_FLASH: "PICTORIAL_GHOST_FLASH_1S";
    readonly ABSTRACT: "PURE_ABSTRACT_SYMBOLIC";
  };

  export function median(values: number[]): number;
  export function percentile(values: number[], p: number): number;

  export function computeMotorBaselineSec(warmupTapTimesSec?: number[]): number;

  export function computeCognitiveTimeSec(
    rawTimeSec: number,
    motorBaselineSec?: number,
    audioPromptDurationSec?: number,
  ): number;

  export interface EngineGateUnit {
    unitId: string;
    title: string;
    masteryGate: {
      questionCount: number;
      minAccuracyPercent: number;
      maxMedianResponseTimeSec: number;
      challengeZoneStreak?: number;
    };
    skillTopics: { code: string; name: string }[];
  }

  export interface EngineGateResponse {
    topicCode: string;
    isCorrect: boolean;
    rawTimeSec: number;
    audioDurationSec?: number;
  }

  export interface EngineGateVerdict {
    passed: boolean;
    keyAwarded?: string | null;
    overallAccuracyPct?: number;
    /** Optional: the engine's empty-responses early return omits every
     *  field below `passed`/`reason` — coerce at the boundary (`?? 0`). */
    requiredAccuracyPct?: number;
    medianCogSpeedSec?: number;
    targetSpeedSec?: number;
    p80CogSpeedSec?: number;
    maxTailAllowedSec?: number;
    rapidGuessViolations?: number;
    finalStreakPassed?: boolean;
    failedTopics?: string[];
    topicBreakdown?: {
      code: string;
      name: string;
      total: number;
      correct: number;
      cogTimes: number[];
      accuracyPct: number;
      medianSpeedSec: number;
    }[];
    conditions?: Record<string, boolean>;
    remediationMode?: string;
    remediationPrescription?: string;
    reason?: string;
  }

  export function evaluateMasteryGateAttempt(params: {
    unit: EngineGateUnit;
    responses: EngineGateResponse[];
    motorBaselineSec?: number;
    antiGuessingMinRawSec?: number;
  }): EngineGateVerdict;

  export function computeFluencyGrade(
    isCorrect: boolean,
    cogTimeSec: number,
    targetSpeedSec: number,
  ): number;

  export function updateTopicMemoryStability(params: {
    currentStabilityDays?: number;
    fluencyGrade: number;
    gradeGrowthFactor?: number;
    maxIntervalCapDays?: number;
  }): {
    stabilityDays: number;
    cpaStage: string;
    intraSessionExpandingLags: number[];
  };

  export function computeRetrievabilityPct(elapsedDays: number, stabilityDays?: number): number;

  /** Returns the CREDIT ARRAY (one entry per prerequisite), not a map —
   *  mirrors the engine's array-of-{prerequisiteUnitId, boost} return. */
  export interface EngineDagCredit {
    prerequisiteUnitId: string;
    implicitStabilityBoostDays: number;
  }

  export function propagateImplicitDagCredit(
    unitId: string,
    deltaStabilityDays: number,
    unitMap: Record<string, unknown>,
    creditWeight?: number,
  ): EngineDagCredit[];

  export interface EngineGeneratedQuestion {
    interactionType?: string;
    prompt: string;
    visualAid?: string;
    visualObjects?: unknown;
    targetCount?: number;
    maxCounterCells?: number;
    counterEmoji?: string;
    tileBank?: unknown;
    choices?: unknown[];
    correctAnswer: string | number;
    misconceptionTags?: string[];
    explanation?: string;
  }

  export function generateProceduralQuestion(
    unit: { unitId: string; title: string; skillTopics?: unknown[] },
    topic: { code: string; name: string; assets?: Record<string, unknown> },
    seed?: number,
  ): EngineGeneratedQuestion;

  export function generateTopicPracticeSet(
    unit: { unitId: string; title: string; skillTopics?: unknown[] },
    topic: { code: string; name: string; assets?: Record<string, unknown> },
    count?: number,
  ): EngineGeneratedQuestion[];

  // --- Gamification reward rules (issue #55, roadmap D9; mirrors
  // --- packages/core-engine/src/rewards.mjs exactly) ----------------------

  export const XP_PER_CORRECT_ATTEMPT_BY_GRADE: Readonly<Record<number, number>>;
  export const TOPIC_PASS_XP_BASE: number;
  export const XP_PER_CROWN: number;
  export const GATE_PASS_XP: number;
  export const GOLD_UPGRADE_XP: number;
  export const GATE_PASS_COINS: number;
  export const MAX_LEVEL: number;

  export interface RewardAttemptInput {
    isCorrect: boolean;
    fluencyGrade: number;
  }

  export function xpForAttempt(attempt: RewardAttemptInput): number;
  export function awardXpForAttempts(attempts?: RewardAttemptInput[]): number;
  export function awardXpForSessionOutcome(params: {
    sessionType: string;
    passed?: boolean;
    crowns?: number;
    goldUpgraded?: boolean;
  }): number;
  export function coinsForTopicPass(crowns?: number): number;
  export function deriveSessionRewards(params: {
    sessionType: string;
    attempts?: RewardAttemptInput[];
    passed?: boolean;
    crowns?: number;
    goldUpgraded?: boolean;
  }): { attemptXp: number; sessionBonusXp: number; totalXp: number; coins: number };
  export function xpThresholdForLevel(level: number): number;
  export function levelForXp(totalXp: number): {
    level: number;
    maxLevel: number;
    maxed: boolean;
    levelFloorXp: number;
    nextLevelXp: number | null;
    xpIntoLevel: number;
    xpToNextLevel: number | null;
  };
  export function dayKeyForMs(ms: number, utcOffsetMinutes?: number): string;
  export function dayKeysApart(dayKeyA: string, dayKeyB: string): number;
  export function nextStreakState(params: {
    currentStreakDays?: number;
    lastActiveDayKey?: string;
    sessionDayKey?: string;
  }): { streakDays: number; lastActiveDayKey: string; changed: boolean };
  export function beatTargetSharePct(rawTimeSecs?: number[], targetSec?: number): number;

  export interface EngineBadge {
    id: string;
    title: string;
    description: string;
    tier: "bronze" | "silver" | "gold";
    metric: string;
    gte: number;
  }

  export const BADGE_CATALOG: readonly EngineBadge[];
  export function badgeById(id: string): EngineBadge | undefined;
  export function evaluateBadges(context?: Record<string, number>): string[];

  // --- Hearts policy rules (issue #56, roadmap D6; mirrors
  // --- packages/core-engine/src/hearts.mjs exactly) -----------------------

  export const HEARTS_GRADES: readonly string[];
  export const HEART_COUNT: number;
  export const HEART_REGROW_MS_PER_HEART: number;
  export const HEARTS_END_REASONS: readonly ("completed" | "hearts-empty")[];

  export function shouldMountHearts(gradeId: string, stage: string): boolean;

  export interface HeartsTransition {
    remaining: number;
    lost: boolean;
  }

  export function heartStateAfterResponse(
    heartsRemaining: number,
    response: { isCorrect: boolean; isRequeue?: boolean },
  ): HeartsTransition;

  export function heartsSessionEndReason(heartsRemaining: number): "completed" | "hearts-empty";

  export function heartsRegrowProgress(params: {
    lostHearts: number;
    endedAtMs: number;
    nowMs: number;
    msPerHeart?: number;
  }): { regrown: number; stillGrowing: boolean };

  export function heartsOutcomeProblem(outcome: {
    heartsLost: number;
    heartsRemaining: number;
    endReason: string;
  }): string | null;

  // --- Daily practice-reminder rules (issue #57, roadmap D5; mirrors
  // --- packages/core-engine/src/reminders.mjs exactly) ---------------------

  export const REMINDER_NOTIFICATION_ID: string;
  export const DEFAULT_REMINDER_HOUR: number;
  export const DEFAULT_REMINDER_MINUTE: number;
  export const REMINDER_PERMISSION_STATES: readonly ("granted" | "denied" | "undetermined")[];

  export type ReminderPermissionStatus = "granted" | "denied" | "undetermined";

  export interface ReminderSettings {
    enabled: boolean;
    hour: number;
    minute: number;
  }

  export function reminderSettingsProblem(settings: {
    enabled: unknown;
    hour: unknown;
    minute: unknown;
  }): string | null;

  export function normalizeReminderSettings(input?: {
    enabled?: unknown;
    hour?: unknown;
    minute?: unknown;
  }): ReminderSettings;

  export function nextReminderOccurrenceMs(params: {
    nowMs: number;
    hour: number;
    minute: number;
    utcOffsetMinutes?: number;
  }): number | null;

  export interface ReminderPlan {
    action: "schedule" | "cancel" | "none";
    reason: string;
    hour: number;
    minute: number;
  }

  export function reminderPlan(params: {
    settings: { enabled: unknown; hour: unknown; minute: unknown };
    permission: string;
  }): ReminderPlan;
}
