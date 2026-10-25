/**
 * SSML adaptation invariants (issue #45: "narration text/SSML adapted
 * per platform"). expo-speech has no SSML support, so registry prompts
 * must degrade to plain text while preserving the prosody rate (the WPM
 * source) and break durations (the estimate input) - and never crash on
 * malformed input or math "<" characters.
 */
import { describe, expect, it } from "vitest";
import { adaptNarration, isSsml } from "../src/audio/ssml";

const REGISTRY_PROMPT =
  '<speak><prosody rate="110wpm" pitch="+5%">Let us explore <emphasis level="moderate">Numbers to 3</emphasis>! Watch closely, then try it with your finger.</prosody></speak>';

const HINT_PROMPT =
  '<speak><prosody rate="110wpm">Need a clue? <break time="300ms"/> Look at the highlighted model and count step by step.</prosody></speak>';

describe("isSsml", () => {
  it("detects speak documents", () => {
    expect(isSsml(REGISTRY_PROMPT)).toBe(true);
    expect(isSsml("  <speak>hello</speak>")).toBe(true);
  });

  it("does not misread math text as SSML", () => {
    expect(isSsml("Pick the number that is < 5")).toBe(false);
    expect(isSsml("3 < 4 < 5")).toBe(false);
    expect(isSsml("")).toBe(false);
  });
});

describe("adaptNarration", () => {
  it("extracts the prosody rate and strips all tags", () => {
    const adapted = adaptNarration(REGISTRY_PROMPT);
    expect(adapted.rateWpm).toBe(110);
    expect(adapted.plainText).toBe(
      "Let us explore Numbers to 3! Watch closely, then try it with your finger.",
    );
    expect(adapted.breakMs).toBe(0);
  });

  it("accumulates break durations across ms and s units", () => {
    const adapted = adaptNarration(
      '<speak>Wait <break time="300ms"/> and again <break time="1.5s"/> done</speak>',
    );
    expect(adapted.breakMs).toBe(1800);
    expect(adapted.plainText).toBe("Wait and again done");
  });

  it("parses the registry hint prompt end to end", () => {
    const adapted = adaptNarration(HINT_PROMPT);
    expect(adapted.rateWpm).toBe(110);
    expect(adapted.breakMs).toBe(300);
    expect(adapted.plainText).toBe(
      "Need a clue? Look at the highlighted model and count step by step.",
    );
  });

  it("passes plain text through with entity decoding", () => {
    const adapted = adaptNarration("Count &amp; say: 1, 2, 3");
    expect(adapted).toEqual({
      plainText: "Count & say: 1, 2, 3",
      rateWpm: null,
      breakMs: 0,
      pitchMultiplier: null,
    });
  });

  it("tolerates malformed SSML by degrading to tag-stripped text", () => {
    const adapted = adaptNarration("<speak><prosody rate=broken>Oops </prosody");
    expect(adapted.plainText.length).toBeGreaterThan(0);
    expect(adapted.plainText).toContain("Oops");
    expect(adapted.rateWpm).toBeNull();
  });

  it("never produces an empty utterance from non-empty input", () => {
    expect(adaptNarration("<speak>(((</speak>").plainText).toBe("(((");
  });

  it("treats SSML without prosody rate as rateless", () => {
    const adapted = adaptNarration("<speak>No prosody here</speak>");
    expect(adapted.rateWpm).toBeNull();
    expect(adapted.plainText).toBe("No prosody here");
  });

  it("parses decimal prosody rates", () => {
    const adapted = adaptNarration('<speak><prosody rate="112.5wpm">Slow down</prosody></speak>');
    expect(adapted.rateWpm).toBe(112.5);
    expect(adapted.plainText).toBe("Slow down");
  });

  it("handles empty input", () => {
    expect(adaptNarration("")).toEqual({
      plainText: "",
      rateWpm: null,
      breakMs: 0,
      pitchMultiplier: null,
    });
  });
});

describe("prosody pitch adaptation (#59)", () => {
  it("maps percent pitches to platform multipliers", () => {
    expect(
      adaptNarration('<speak><prosody rate="110wpm" pitch="+5%">Hi</prosody></speak>')
        .pitchMultiplier,
    ).toBe(1.05);
    expect(
      adaptNarration('<speak><prosody rate="110wpm" pitch="-10%">Hi</prosody></speak>')
        .pitchMultiplier,
    ).toBe(0.9);
    expect(
      adaptNarration('<speak><prosody rate="110wpm" pitch="15%">Hi</prosody></speak>')
        .pitchMultiplier,
    ).toBe(1.15);
  });

  it("clamps out-of-range pitches to the documented platform band", () => {
    expect(
      adaptNarration('<speak><prosody rate="110wpm" pitch="+500%">Hi</prosody></speak>')
        .pitchMultiplier,
    ).toBe(2);
    expect(
      adaptNarration('<speak><prosody rate="110wpm" pitch="-90%">Hi</prosody></speak>')
        .pitchMultiplier,
    ).toBe(0.5);
  });

  it("degrades to null on absent, labeled, or malformed pitch", () => {
    // Absent attribute (the registry's grade-1 lines ship pitch="default").
    expect(
      adaptNarration('<speak><prosody pitch="default">Hi</prosody></speak>').pitchMultiplier,
    ).toBeNull();
    expect(
      adaptNarration('<speak><prosody rate="110wpm">Hi</prosody></speak>').pitchMultiplier,
    ).toBeNull();
    expect(
      adaptNarration('<speak><prosody rate="110wpm" pitch="x-low">Hi</prosody></speak>')
        .pitchMultiplier,
    ).toBeNull();
    expect(
      adaptNarration('<speak><prosody rate="110wpm" pitch="+five%">Hi</prosody></speak>')
        .pitchMultiplier,
    ).toBeNull();
    // Non-SSML text never carries a pitch.
    expect(adaptNarration("Just words").pitchMultiplier).toBeNull();
  });

  it("keeps the registry prompt pitch (+5%) alongside the rate", () => {
    const adapted = adaptNarration(REGISTRY_PROMPT);
    expect(adapted.rateWpm).toBe(110);
    expect(adapted.pitchMultiplier).toBe(1.05);
  });
});
