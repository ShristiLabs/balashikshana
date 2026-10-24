/**
 * Reduced-motion logic. Pure data + pure function: no react-native
 * imports, so the vitest suite can exercise it directly. The RN-facing
 * provider/hook lives in useMotion.tsx and feeds the OS accessibility
 * setting into motionProfileFor().
 *
 * Rule: no animation in this app is load-bearing. When the OS
 * reduced-motion setting is on, animated primitives receive a profile
 * with animationsEnabled=false, zero durations, and zero press
 * translation; they must render their end state instantly.
 */

export interface MotionProfile {
  /** Master switch: false means "render final state, no transitions". */
  animationsEnabled: boolean;
  /** Transition duration in ms; 0 when animations are disabled. */
  durationMs: number;
  /** Tactile press translate in points; 0 when animations are disabled. */
  pressTranslateY: number;
  /** Spring config for gesture-driven motion; null when disabled. */
  spring: { damping: number; stiffness: number } | null;
}

/** Named durations (ms) used across animated primitives. */
export const MOTION_DURATIONS = {
  fast: 120,
  normal: 200,
  slow: 300,
} as const;

const FULL_MOTION_PROFILE: MotionProfile = {
  animationsEnabled: true,
  durationMs: MOTION_DURATIONS.normal,
  pressTranslateY: 3,
  spring: { damping: 16, stiffness: 220 },
};

const REDUCED_MOTION_PROFILE: MotionProfile = {
  animationsEnabled: false,
  durationMs: 0,
  pressTranslateY: 0,
  spring: null,
};

/** Resolve the motion profile for the OS reduce-motion setting. */
export function motionProfileFor(reduceMotion: boolean): MotionProfile {
  return reduceMotion ? REDUCED_MOTION_PROFILE : FULL_MOTION_PROFILE;
}
