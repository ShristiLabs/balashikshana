/**
 * Mascot state machine (issue #58) — PURE TypeScript.
 *
 * One mascot character with the three moods the issue names
 * (idle / react / celebrate) whose pose vocabulary is EXACTLY the
 * registry's `animations.stateMachineStates` set (D7): idle_breathe,
 * touch_pickup_scale, snap_target_confirm, hint_path_bezier_glow,
 * gentle_bounce_back, mastery_badge_bloom. Every pose carries the
 * registry's own motion parameters (durations, scale, spring, star
 * burst) so a future Rive adapter can implement the same poses 1:1.
 *
 * No React Native, no core-engine imports, no I/O, no clocks: time
 * arrives as a parameter (every event carries `nowMs`) and the view
 * layer owns every animation. Under reduced motion the machine is
 * UNCHANGED — the same transitions run and the same pose renders as a
 * STATIC frame (the animation is decorative, never load-bearing; the
 * ceremony.ts precedent).
 */

/** The mascot's three moods (issue #58 body). */
export type MascotMood = "idle" | "react" | "celebrate";

/**
 * Pose vocabulary — 1:1 with the registry's stateMachineStates
 * (docs/us-curriculum-registry.json / assets/animations/animations-manifest.json,
 * asserted uniform across all 614 topics by tests/mascot-machine.test.ts).
 */
export type MascotPose =
  | "idle_breathe"
  | "touch_pickup_scale"
  | "snap_target_confirm"
  | "hint_path_bezier_glow"
  | "gentle_bounce_back"
  | "mastery_badge_bloom";

/** The celebration moments the mascot celebrates (registry + #51/#55/#57 events). */
export type CelebrateMoment =
  | "topic-mastered"
  | "badge-awarded"
  | "level-up"
  | "streak-milestone"
  | "game-goal-met"
  | "key-ceremony-silver"
  | "key-ceremony-gold"
  | "unit-complete";

/**
 * Motion tokens, taken from the registry animations block (identical for
 * every topic in the shipped data — the mascot test pins uniformity):
 * idle loop 2000ms, pickup scale 1.12 spring 320/22, snap confirm 450ms
 * with a 12-gold-star burst, hint glow loop 1500ms, bounce back 350ms,
 * badge bloom 1800ms.
 */
export const MASCOT_MOTION_TOKENS = Object.freeze({
  idleBreatheLoopMs: 2000,
  pickupScale: 1.12,
  pickupSpringStiffness: 320,
  pickupSpringDamping: 22,
  snapConfirmMs: 450,
  snapBurstStars: 12,
  hintGlowLoopMs: 1500,
  bounceBackMs: 350,
  badgeBloomMs: 1800,
});

/** How long each transient pose holds before returning to idle. */
export const POSE_HOLD_MS: Record<MascotPose, number> = Object.freeze({
  idle_breathe: Number.POSITIVE_INFINITY,
  touch_pickup_scale: 500,
  snap_target_confirm: MASCOT_MOTION_TOKENS.snapConfirmMs,
  hint_path_bezier_glow: MASCOT_MOTION_TOKENS.hintGlowLoopMs,
  gentle_bounce_back: MASCOT_MOTION_TOKENS.bounceBackMs,
  mastery_badge_bloom: MASCOT_MOTION_TOKENS.badgeBloomMs,
});

export interface MascotState {
  mood: MascotMood;
  pose: MascotPose;
  /** The celebration reason while mood is celebrate (copy/a11y context). */
  moment: CelebrateMoment | null;
  /** Clock reading the pose was entered at (the event's own nowMs). */
  enteredAtMs: number;
  /** Absolute expiry of a transient pose; null for the idle loop. */
  expiresAtMs: number | null;
}

export type MascotEvent =
  /** A correct answer (snap-confirm reaction). */
  | { type: "answer-correct"; nowMs: number }
  /**
   * A gentle retry / heart-loss moment — the #56 growth reframe: the
   * mascot bounces back warmly, never sad (positive-only copy doctrine).
   */
  | { type: "answer-gentle-retry"; nowMs: number }
  /** The child picked up / touched a manipulative (pickup-scale reaction). */
  | { type: "touch-pickup"; nowMs: number }
  /** A drag snapped to its target (snap-confirm reaction). */
  | { type: "snap-confirm"; nowMs: number }
  /** A hint path glowed (hint-glow reaction, holds one glow loop). */
  | { type: "hint-shown"; nowMs: number }
  /** A celebration moment (bloom pose). */
  | { type: "celebrate"; moment: CelebrateMoment; nowMs: number }
  /** Clock tick: expire the transient pose back to idle. */
  | { type: "tick"; nowMs: number };

/** Fresh idle state at a given clock reading. */
export function initialMascotState(nowMs: number): MascotState {
  return {
    mood: "idle",
    pose: "idle_breathe",
    moment: null,
    enteredAtMs: nowMs,
    expiresAtMs: null,
  };
}

/** Pose entered for each react event (the trigger->state mapping, test-pinned). */
export const REACT_POSE_FOR_EVENT: Record<
  "answer-correct" | "answer-gentle-retry" | "touch-pickup" | "snap-confirm" | "hint-shown",
  MascotPose
> = Object.freeze({
  "answer-correct": "snap_target_confirm",
  "answer-gentle-retry": "gentle_bounce_back",
  "touch-pickup": "touch_pickup_scale",
  "snap-confirm": "snap_target_confirm",
  "hint-shown": "hint_path_bezier_glow",
});

function enterPose(
  pose: MascotPose,
  mood: MascotMood,
  moment: CelebrateMoment | null,
  nowMs: number,
): MascotState {
  const hold = POSE_HOLD_MS[pose];
  return {
    mood,
    pose,
    moment,
    enteredAtMs: nowMs,
    expiresAtMs: Number.isFinite(hold) ? nowMs + hold : null,
  };
}

/**
 * The transition function. Priority rules:
 * - celebrate is the biggest moment: it always wins, and while it holds
 *   (its 1800ms bloom window) react events are IGNORED (a star burst is
 *   not interrupted by a tap); a new celebrate re-enters bloom and
 *   REFRESHES the window so a badge + level-up sequence reads as one
 *   held celebration.
 * - react events interrupt idle and each other (latest wins).
 * - tick expires the transient pose back to idle_breathe; the idle loop
 *   itself never expires (the view drives the breathing loop).
 */
export function mascotTransition(state: MascotState, event: MascotEvent): MascotState {
  if (event.type === "tick") {
    if (state.expiresAtMs !== null && event.nowMs >= state.expiresAtMs) {
      return enterPose("idle_breathe", "idle", null, event.nowMs);
    }
    return state;
  }

  if (event.type === "celebrate") {
    return enterPose("mastery_badge_bloom", "celebrate", event.moment, event.nowMs);
  }

  const nextPose = REACT_POSE_FOR_EVENT[event.type];
  // React never interrupts an in-flight celebration.
  if (state.mood === "celebrate") return state;
  return enterPose(nextPose, "react", null, event.nowMs);
}

/**
 * Which visual frame the view renders. With animations enabled this is
 * the live pose mid-motion; under reduced motion it is the pose's
 * END-STATE frame (scale 1, final position, burst fully spread) — the
 * same information without motion, so no meaning depends on animation.
 */
export function mascotFrameFor(state: MascotState, _animationsEnabled: boolean): MascotPose {
  return state.pose;
}

/** Mood classification for a pose (view copy + tests). */
export function moodForPose(pose: MascotPose): MascotMood {
  if (pose === "mastery_badge_bloom") return "celebrate";
  if (pose === "idle_breathe") return "idle";
  return "react";
}
