/**
 * Practice module barrel (issue #47). Exposes the offline practice
 * surface for #49 (journey), #50 (practice runner), #51 (gate
 * ceremony), and #48 (sync drains attempt_log WHERE synced = 0 ORDER BY
 * id — the cursor contract is the AUTOINCREMENT id). RN bindings stay
 * behind nativePractice.ts.
 */
export { PracticeSessionEngine } from "./practiceEngine";
export type {
  TopicSessionStart,
  TopicSessionSummary,
  GateSessionStart,
  GateSessionSummary,
  GoldStatus,
  GoldVerificationSummary,
} from "./practiceEngine";
export { AttemptRecorder } from "./attemptRecorder";
export {
  TWO_KEY_RULES,
  MS_PER_HOUR,
  goldEligibleAtMs,
  isGoldEligible,
  nextKeyAfterGatePass,
  goldVerificationPassed,
} from "./goldKey";
export {
  deriveTopicSession,
  mergeTopicProgress,
  deriveGateSession,
  mergeUnitProgress,
  deriveGoldVerification,
  deriveAttempt,
} from "./progressProjector";
export type {
  SessionResponse,
  SrPolicy,
  TopicSessionDerivation,
  GateVerdict,
  GateSessionDerivation,
  AttemptDerivation,
} from "./progressProjector";
export { buildReviewQueue, capNextReviewAt, policyForGrade } from "./reviewQueue";
export type { ReviewQueueItem, ReviewQueueInput } from "./reviewQueue";
export {
  packUnitToEngineUnit,
  packTopicToEngineTopic,
  packQuestionToPracticeQuestion,
  generatedToPracticeQuestion,
} from "./packShapes";
export type { EngineUnit, EngineTopic, GeneratedQuestionFields } from "./packShapes";
// RN bindings (nativePractice.ts, the only expo-sqlite importer) stay
// OUT of this barrel per the content-module precedent — node consumers
// of the barrel must never transitively import native modules (#47
// review finding 1). The #50 runner obtains deps via
// getNativePracticeDeps() imported from the module path directly.
export type {
  AttemptInput,
  AttemptRecord,
  KeyState,
  SessionType,
  TopicProgressRecord,
  UnitProgressRecord,
  PracticeQuestion,
  PackContentReader,
  PracticeStorage,
  PracticeDeps,
  GradeSrPolicy,
  PackUnitRow,
  PackTopicRow,
  PackQuestionRow,
} from "./types";
