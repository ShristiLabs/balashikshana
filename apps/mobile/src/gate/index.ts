/**
 * Gate-runner module barrel (issue #51). PURE exports only: the
 * registry-cited session rules, spiral-mix composition, session store,
 * results/ceremony/countdown view models are all node-testable without
 * React Native. The RN views (GateRunnerScreen, GateResultsView,
 * KeyCeremony) and the native seams (gateNative) stay OUT of this
 * barrel per the practice/runner module precedent.
 */
export { ANTI_GUESS, GOLD_CHECK_BUDGET_SEC, SPIRAL_MIX, isRapidGuessViolation } from "./rules";
export {
  allocateSpiral,
  interleaveSpiral,
  type SpiralAvailability,
  type SpiralCounts,
  type SpiralSource,
} from "./spiral";
export {
  currentGateQuestion,
  gateReducer,
  goldRemainingMs,
  initialGateState,
  statusEntry,
  type GateAction,
  type GateCheckedFeedback,
  type GateGoldStatus,
  type GateMode,
  type GatePhase,
  type GateState,
  type StatusEntry,
} from "./gateStore";
export {
  CONDITION_KEYS,
  REMEDIATION_ROUTES,
  remediationStep,
  resultsView,
  type ConditionKey,
  type ConditionRow,
  type ResultsView,
  type TopicRow,
} from "./results";
export {
  CEREMONY_BUILD_MS,
  ceremonyCopy,
  ceremonyReducer,
  initialCeremony,
  type CeremonyCopy,
  type CeremonyKind,
  type CeremonyPhase,
  type CeremonyState,
} from "./ceremony";
export { formatGoldCountdown, goldWindow, type GoldWindowState } from "./countdown";
