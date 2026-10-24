/**
 * Reduced-motion logic. The RN provider feeds the OS setting into
 * motionProfileFor(); these tests pin the contract that animated
 * primitives rely on: reduce-motion on means zero-duration, zero-offset,
 * no-spring - the final state renders instantly.
 */
import { describe, expect, it } from "vitest";
import { MOTION_DURATIONS, motionProfileFor } from "../src/design/motion";

describe("motionProfileFor", () => {
  it("enables animations when reduce-motion is off", () => {
    const profile = motionProfileFor(false);
    expect(profile.animationsEnabled).toBe(true);
    expect(profile.durationMs).toBeGreaterThan(0);
    expect(profile.pressTranslateY).toBeGreaterThan(0);
    expect(profile.spring).not.toBeNull();
  });

  it("disables every animation dimension when reduce-motion is on", () => {
    const profile = motionProfileFor(true);
    expect(profile.animationsEnabled).toBe(false);
    expect(profile.durationMs).toBe(0);
    expect(profile.pressTranslateY).toBe(0);
    expect(profile.spring).toBeNull();
  });

  it("keeps named durations ordered fast < normal < slow", () => {
    expect(MOTION_DURATIONS.fast).toBeLessThan(MOTION_DURATIONS.normal);
    expect(MOTION_DURATIONS.normal).toBeLessThan(MOTION_DURATIONS.slow);
  });

  it("is deterministic (pure function, no hidden state)", () => {
    expect(motionProfileFor(true)).toEqual(motionProfileFor(true));
    expect(motionProfileFor(false)).toEqual(motionProfileFor(false));
  });
});
