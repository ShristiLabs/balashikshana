/**
 * Audio settings persistence seam (issue #45) - PURE module.
 *
 * Settings are non-secret user preferences: they persist through the
 * SQLite seam (native adapter in nativeAudio.ts), never the secure
 * store - mirroring the onboarding snapshot doctrine. A persisted value
 * this build cannot faithfully parse is discarded in favor of defaults
 * (same guard shape as parseSnapshot in src/onboarding/storage.ts).
 */

import type { AudioSettings, AudioSettingsStore } from "./types";

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  schemaVersion: 1,
  soundEffectsEnabled: true,
  narrationEnabled: true,
  hapticsEnabled: true,
  // No music surface ships in M3 (out of scope); the preference persists
  // so later music milestones start from an explicit user choice.
  musicEnabled: false,
};

export function parseAudioSettings(raw: string | null): AudioSettings | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const row = parsed as Record<string, unknown>;
  if (row.schemaVersion !== 1) return null;
  // Field-level type guards: a corrupt row (e.g. "true" as a string) must
  // fall back to the default, never flow a non-boolean into a toggle.
  const booleanOf = (key: string): boolean | undefined =>
    typeof row[key] === "boolean" ? (row[key] as boolean) : undefined;
  return {
    schemaVersion: 1,
    soundEffectsEnabled:
      booleanOf("soundEffectsEnabled") ?? DEFAULT_AUDIO_SETTINGS.soundEffectsEnabled,
    narrationEnabled: booleanOf("narrationEnabled") ?? DEFAULT_AUDIO_SETTINGS.narrationEnabled,
    hapticsEnabled: booleanOf("hapticsEnabled") ?? DEFAULT_AUDIO_SETTINGS.hapticsEnabled,
    musicEnabled: booleanOf("musicEnabled") ?? DEFAULT_AUDIO_SETTINGS.musicEnabled,
  };
}

/** In-memory store for tests and previews. */
export function createMemoryAudioSettingsStore(): AudioSettingsStore & {
  dump(): AudioSettings | null;
} {
  let current: AudioSettings | null = null;
  return {
    async load() {
      return current;
    },
    async save(settings) {
      current = { ...settings };
    },
    dump() {
      return current;
    },
  };
}
