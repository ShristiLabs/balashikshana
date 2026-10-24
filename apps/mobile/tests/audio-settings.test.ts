/**
 * Audio settings persistence invariants (issue #45: sound/music/TTS
 * toggles persisted locally). Mirrors the onboarding parse-guard
 * doctrine: corrupt or unknown-schema rows discard to defaults.
 */
import { describe, expect, it } from "vitest";
import {
  createMemoryAudioSettingsStore,
  DEFAULT_AUDIO_SETTINGS,
  parseAudioSettings,
} from "../src/audio/settings";

describe("DEFAULT_AUDIO_SETTINGS", () => {
  it("enables the instructional channels by default", () => {
    expect(DEFAULT_AUDIO_SETTINGS).toEqual({
      schemaVersion: 1,
      soundEffectsEnabled: true,
      narrationEnabled: true,
      hapticsEnabled: true,
      musicEnabled: false,
    });
  });
});

describe("parseAudioSettings", () => {
  it("round-trips persisted settings", () => {
    const persisted = JSON.stringify({ ...DEFAULT_AUDIO_SETTINGS, narrationEnabled: false });
    expect(parseAudioSettings(persisted)).toEqual({
      ...DEFAULT_AUDIO_SETTINGS,
      narrationEnabled: false,
    });
  });

  it("returns null for corrupt JSON", () => {
    expect(parseAudioSettings("{not json")).toBeNull();
  });

  it("returns null for an unknown schema version", () => {
    expect(parseAudioSettings(JSON.stringify({ schemaVersion: 2 }))).toBeNull();
    expect(parseAudioSettings(JSON.stringify({ schemaVersion: "1" }))).toBeNull();
  });

  it("returns null for null input (first run)", () => {
    expect(parseAudioSettings(null)).toBeNull();
  });

  it("fills unknown keys from defaults (forward-compatible reads)", () => {
    const parsed = parseAudioSettings('{"schemaVersion":1,"soundEffectsEnabled":false}');
    expect(parsed).toEqual({ ...DEFAULT_AUDIO_SETTINGS, soundEffectsEnabled: false });
  });

  it("falls back to defaults per field when a toggle is not a boolean", () => {
    // A corrupt row (string/number/null in a boolean field) must not flow
    // a non-boolean into a toggle: each bad field discards to its default.
    const corrupt = JSON.stringify({
      schemaVersion: 1,
      soundEffectsEnabled: "false",
      narrationEnabled: 0,
      hapticsEnabled: null,
      musicEnabled: "yes",
    });
    expect(parseAudioSettings(corrupt)).toEqual(DEFAULT_AUDIO_SETTINGS);
    expect(parseAudioSettings("5")).toBeNull();
    expect(parseAudioSettings('"enabled"')).toBeNull();
  });
});

describe("createMemoryAudioSettingsStore", () => {
  it("starts empty and round-trips saves", async () => {
    const store = createMemoryAudioSettingsStore();
    expect(await store.load()).toBeNull();
    const settings = { ...DEFAULT_AUDIO_SETTINGS, hapticsEnabled: false };
    await store.save(settings);
    expect(await store.load()).toEqual(settings);
    expect(store.dump()).toEqual(settings);
  });
});
