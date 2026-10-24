/**
 * Parental-gate timing invariants (issue #44, roadmap D5): the COPPA
 * hold-to-confirm cannot be bypassed. Pure model tests with an injected
 * clock - no timers, no animation APIs involved.
 */
import { describe, expect, it } from "vitest";
import {
  holdPress,
  holdProgress,
  holdRelease,
  holdTick,
  initialHoldState,
  PARENTAL_GATE_HOLD_MS,
} from "../src/onboarding/gateTimer";

describe("hold-to-confirm gate", () => {
  it("starts inert", () => {
    const state = initialHoldState();
    expect(state.pressing).toBe(false);
    expect(state.complete).toBe(false);
    expect(holdProgress(state, 10_000)).toBe(0);
  });

  it("completes only after a full continuous hold", () => {
    let s = holdPress(initialHoldState(), 0);
    s = holdTick(s, 1000);
    expect(s.complete).toBe(false);
    expect(holdProgress(s, 1000)).toBeCloseTo(1000 / PARENTAL_GATE_HOLD_MS, 5);
    s = holdTick(s, PARENTAL_GATE_HOLD_MS - 1);
    expect(s.complete).toBe(false);
    s = holdTick(s, PARENTAL_GATE_HOLD_MS);
    expect(s.complete).toBe(true);
    expect(holdProgress(s, PARENTAL_GATE_HOLD_MS)).toBe(1);
  });

  it("a release at any point resets accumulated time", () => {
    let s = holdPress(initialHoldState(), 0);
    s = holdTick(s, PARENTAL_GATE_HOLD_MS - 10);
    expect(s.complete).toBe(false);
    s = holdRelease(s);
    expect(s.pressing).toBe(false);
    expect(s.pressStartedAt).toBeNull();
    expect(holdProgress(s, PARENTAL_GATE_HOLD_MS - 10)).toBe(0);
    // Re-press starts over: no carry-over of the almost-complete hold.
    s = holdPress(s, PARENTAL_GATE_HOLD_MS);
    s = holdTick(s, PARENTAL_GATE_HOLD_MS + 10);
    expect(s.complete).toBe(false);
  });

  it("tap-spamming never accumulates hold time", () => {
    let s = initialHoldState();
    // 20 rapid taps, each 150ms of hold then release.
    for (let i = 0; i < 20; i += 1) {
      const t = i * 200;
      s = holdPress(s, t);
      s = holdTick(s, t + 150);
      expect(s.complete).toBe(false);
      s = holdRelease(s);
    }
    expect(s.complete).toBe(false);
    // Total finger-down time (3000ms) far exceeds the threshold, yet no
    // completion: only CONTINUOUS hold counts.
  });

  it("ticks without an active press never complete the gate", () => {
    let s = initialHoldState();
    s = holdTick(s, 60_000);
    expect(s.complete).toBe(false);
    // Even a stale pressStartedAt is inert while pressing is false.
    const stale = { pressing: false, pressStartedAt: 0, complete: false };
    expect(holdTick(stale, 60_000).complete).toBe(false);
  });

  it("completion latches: release after complete keeps it confirmed", () => {
    let s = holdPress(initialHoldState(), 0);
    s = holdTick(s, PARENTAL_GATE_HOLD_MS);
    expect(s.complete).toBe(true);
    s = holdRelease(s);
    expect(s.complete).toBe(true);
    expect(holdProgress(s, PARENTAL_GATE_HOLD_MS + 500)).toBe(1);
  });

  it("a new press after completion is a no-op latch", () => {
    let s = holdPress(initialHoldState(), 0);
    s = holdTick(s, PARENTAL_GATE_HOLD_MS);
    const again = holdPress(s, 5000);
    expect(again).toBe(s);
    expect(again.complete).toBe(true);
  });

  it("hold duration is at the COPPA-grade multi-second floor", () => {
    expect(PARENTAL_GATE_HOLD_MS).toBeGreaterThanOrEqual(2000);
    expect(PARENTAL_GATE_HOLD_MS).toBeLessThanOrEqual(5000);
  });
});
