/**
 * Duck policy state machine invariants (issue #45 acceptance: "Ducking
 * verified: SFX level dips during speech and restores after; TTS cancel
 * stops ducking immediately").
 */
import { describe, expect, it } from "vitest";
import { DUCK_FACTOR, IDLE_DUCK_STATE, reduceDuck } from "../src/audio/duckPolicy";

describe("duckPolicy", () => {
  it("starts idle with full SFX volume", () => {
    expect(IDLE_DUCK_STATE).toEqual({ speakingCount: 0, sfxMultiplier: 1 });
  });

  it("ducks SFX when speech starts", () => {
    const next = reduceDuck(IDLE_DUCK_STATE, { type: "speech-started" });
    // Literal 0.3 (not DUCK_FACTOR) so mutating the constant fails here.
    expect(next.sfxMultiplier).toBe(0.3);
    expect(next.speakingCount).toBe(1);
  });

  it("restores SFX when the last utterance finishes", () => {
    const ducked = reduceDuck(IDLE_DUCK_STATE, { type: "speech-started" });
    const restored = reduceDuck(ducked, { type: "speech-finished" });
    expect(restored).toEqual(IDLE_DUCK_STATE);
  });

  it("treats cancel exactly like a finish transition", () => {
    const ducked = reduceDuck(IDLE_DUCK_STATE, { type: "speech-started" });
    expect(reduceDuck(ducked, { type: "speech-cancelled" })).toEqual(IDLE_DUCK_STATE);
  });

  it("stays ducked while any utterance is still speaking (platform queue)", () => {
    let state = IDLE_DUCK_STATE;
    state = reduceDuck(state, { type: "speech-started" });
    state = reduceDuck(state, { type: "speech-started" });
    state = reduceDuck(state, { type: "speech-finished" });
    expect(state.speakingCount).toBe(1);
    expect(state.sfxMultiplier).toBe(0.3);
    state = reduceDuck(state, { type: "speech-finished" });
    expect(state).toEqual(IDLE_DUCK_STATE);
  });

  it("never goes negative on spurious terminal events", () => {
    const state = reduceDuck(IDLE_DUCK_STATE, { type: "speech-finished" });
    expect(state).toEqual(IDLE_DUCK_STATE);
  });

  it("keeps the multiplier within [0, 1]", () => {
    expect(DUCK_FACTOR).toBeGreaterThan(0);
    expect(DUCK_FACTOR).toBeLessThan(1);
  });
});
