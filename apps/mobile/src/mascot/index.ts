/**
 * Mascot + celebrations surface (issue #58). Pure modules first
 * (machine, events, art, lines), thin RN views above them.
 */
export {
  MASCOT_MOTION_TOKENS,
  POSE_HOLD_MS,
  REACT_POSE_FOR_EVENT,
  initialMascotState,
  mascotFrameFor,
  mascotTransition,
  moodForPose,
  type CelebrateMoment,
  type MascotEvent,
  type MascotMood,
  type MascotPose,
  type MascotState,
} from "./mascotMachine";
export {
  buildCelebrationReport,
  celebrationCopyFor,
  emptyCelebrationReport,
  planCelebrationMoments,
  type CelebrationCopy,
  type CelebrationCopyContext,
  type CelebrationMomentPlan,
  type CelebrationReport,
} from "./celebrationEvents";
export {
  FALLBACK_CELEBRATION_LINE,
  celebrationLineForTopic,
  celebrationLineTopicCount,
  celebrationLinesForTopic,
} from "./celebrationLines";
export {
  MASCOT_ART,
  badgeSilhouetteForTier,
  badgeTierColors,
  mascotAccent,
  starAt,
  starBurstPositions,
  type BadgeTier,
  type MascotArt,
} from "./mascotArt";
export { MascotView, type MascotViewProps } from "./MascotView";
export { BadgeBloomView, type BadgeBloomBadge, type BadgeBloomViewProps } from "./BadgeBloomView";
export {
  CelebrationStack,
  celebrateMascotState,
  type CelebrationStackProps,
} from "./CelebrationStack";
export { useMascot } from "./useMascot";
