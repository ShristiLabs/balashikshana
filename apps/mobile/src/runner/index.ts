/**
 * Practice-runner module barrel (issue #50). PURE exports only: the
 * interaction registry, question-shape adapters, CPA stage logic,
 * expanding-retrieval scheduler, and the session store are all
 * node-testable without React Native. The RN widget kit lives in
 * ./widgets (importable directly by the M4 game framework, #52) and the
 * native seams in ./runnerNative - both stay OUT of this barrel per the
 * practice-module precedent (node consumers must never transitively
 * import native modules).
 */
export {
  INTERACTION_RENDERERS,
  TRACKED_FALLBACK_TYPES,
  interactionCoverage,
  rendererForInteractionType,
} from "./interactionRegistry";
export type {
  InteractionCoverage,
  InteractionRendererKind,
  InteractionRendererSpec,
} from "./interactionRegistry";
export {
  CPA_FADE_ORDER,
  CPA_STAGE_LABELS,
  CPA_STAGE_VALUES,
  GHOST_FLASH_MS,
  scaffoldPolicyForStage,
  stageForStabilityDays,
  stageForTopicProgress,
  stageLabelFor,
} from "./cpaStages";
export type { ScaffoldPolicy } from "./cpaStages";
export {
  anchorLabelForVisualAid,
  answerTextFor,
  choiceOptionsFor,
  counterSpecFor,
  deterministicShuffle,
  hashSeed,
  renderPlanFor,
  tileSpecFor,
  visualRowFor,
} from "./questionShapes";
export type {
  CounterSpec,
  RenderPlan,
  RunnerOption,
  RunnerWidget,
  TileSpec,
  VisualMode,
} from "./questionShapes";
export {
  applyGradedResponse,
  EXPANDING_LAGS,
  initialSchedule,
  itemAt,
  MAX_SESSION_ITEMS,
  requeuedCount,
  scheduledCount,
} from "./requeue";
export type { GradedResponseInput, ItemOrigin, RequeueSchedule, ScheduledItem } from "./requeue";
export {
  currentQuestion,
  currentStage,
  initialRunnerState,
  runnerReducer,
  topicPicksFrom,
} from "./sessionStore";
export type {
  CheckedFeedback,
  RunnerAction,
  RunnerPhase,
  RunnerState,
  TopicPick,
} from "./sessionStore";
