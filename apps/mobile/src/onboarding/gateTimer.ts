/**
 * Hold-to-confirm parental gate timing model (issue #44, roadmap D5).
 *
 * PURE module: no react-native imports, clock and randomness injected, so
 * the vitest suite proves the COPPA properties directly:
 *
 * - Completion requires a SINGLE CONTINUOUS press of at least
 *   PARENTAL_GATE_HOLD_MS. Every release resets progress to zero; a new
 *   press starts over. Tap-spamming can therefore never accumulate hold
 *   time.
 * - The model is a timer, not an animation: progress is derived from
 *   elapsed wall-clock time between press and the latest tick, so it works
 *   identically with OS reduced-motion enabled (motion settings may
 *   suppress progress-bar transitions, never the timing itself).
 * - There is no "almost done" carry-over and no external event that can
 *   complete the hold: only holdTick(now) with an active press can flip
 *   complete, and only after the full duration.
 */

/** COPPA-grade hold duration (ms). 3 seconds of continuous press. */
export const PARENTAL_GATE_HOLD_MS = 3000;

export interface HoldState {
  /** True while a press is active (press started, not yet released). */
  pressing: boolean;
  /** Timestamp (ms) of the press that is currently active, if any. */
  pressStartedAt: number | null;
  /** True once the full continuous hold completed. Latches until reset. */
  complete: boolean;
}

export function initialHoldState(): HoldState {
  return { pressing: false, pressStartedAt: null, complete: false };
}

/** Begin a hold. If a hold was already complete this is a no-op latch. */
export function holdPress(state: HoldState, now: number): HoldState {
  if (state.complete) return state;
  return { ...state, pressing: true, pressStartedAt: now };
}

/**
 * End the active press. ALWAYS resets accumulated time - the gate must be
 * cleared in one continuous hold. Releasing after completion keeps the
 * latched complete state (the confirm already happened).
 */
export function holdRelease(state: HoldState): HoldState {
  if (state.complete) return state;
  return { pressing: false, pressStartedAt: null, complete: false };
}

/**
 * Observe the clock while a press is active. Pure: returns the state with
 * progress derived from (now - pressStartedAt). Completes exactly when the
 * continuous hold reaches PARENTAL_GATE_HOLD_MS; never completes without
 * an active press.
 */
export function holdTick(state: HoldState, now: number): HoldState {
  if (state.complete || !state.pressing || state.pressStartedAt == null) return state;
  if (now - state.pressStartedAt >= PARENTAL_GATE_HOLD_MS) {
    return { pressing: true, pressStartedAt: state.pressStartedAt, complete: true };
  }
  return state;
}

/** Progress toward completion, 0..1, for the progress indicator. */
export function holdProgress(state: HoldState, now: number): number {
  if (state.complete) return 1;
  if (!state.pressing || state.pressStartedAt == null) return 0;
  const elapsed = now - state.pressStartedAt;
  return Math.min(1, Math.max(0, elapsed / PARENTAL_GATE_HOLD_MS));
}

/** Clear a completed hold (re-arm the gate for the next protected surface). */
export function holdReset(): HoldState {
  return initialHoldState();
}
