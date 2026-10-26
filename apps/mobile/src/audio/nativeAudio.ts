/**
 * React-native audio bindings (issue #45).
 *
 * This is the ONLY module in the audio tree that imports native modules
 * (expo-speech, expo-audio, expo-haptics, expo-sqlite, AccessibilityInfo);
 * every pure module above stays node-testable. The screen/service layer
 * calls createAudioService() once and consumes the AudioCoordinator.
 *
 * Platform decisions (documented per the issue body):
 * - Audio session: mixWithOthers (short instructional SFX must not steal
 *   focus from other apps), playsInSilentMode TRUE - narration is the
 *   primary instructional channel for pre-readers, so educational audio
 *   intentionally plays with the mute switch on (Apple HIG permits this
 *   when audio is the point of the app; revisit if review flags it).
 * - iOS speech uses the application audio session
 *   (useApplicationAudioSession) so speech and SFX share one session and
 *   the app-level duck policy (duckPolicy.ts) is the single duck authority.
 * - Haptics map: correct -> Success notification, gentle-retry -> Warning,
 *   error -> Error, streak-combo -> Medium impact (distinct from correct).
 * - Ducking is app-level volume scaling, never an OS session trick, so
 *   VoiceOver (which the coordinator defers narration for) is unaffected.
 * - Every failure path is a logged warning + no-op: a missing asset or a
 *   dead engine must never crash a child's session.
 */

import { AccessibilityInfo } from "react-native";
import * as Haptics from "expo-haptics";
import * as Speech from "expo-speech";
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from "expo-audio";
import * as SQLite from "../platform/sqlite";
import { SFX_ASSETS, SFX_ASSET_KEYS } from "./assetModules";
import { AudioCoordinator } from "./coordinator";
import { SFX_BASE_VOLUME, warnOnce, type AudioDependencies } from "./coordinator";
import { parseAudioSettings } from "./settings";
import type {
  AudioSettings,
  AudioSettingsStore,
  BundledNarrationEngine,
  HapticPattern,
  HapticsEngine,
  NarrationLine,
  SfxEngine,
  SfxSoundId,
  SpeechEngine,
  SpeechUtterance,
} from "./types";

const SETTINGS_DB = "balashikshana_audio.db";
const SETTINGS_TABLE = `
  CREATE TABLE IF NOT EXISTS audio_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    settings TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

/** Non-secret settings persist in a one-row SQLite document (#46 owns the real schema). */
export async function createSqliteAudioSettingsStore(): Promise<AudioSettingsStore> {
  const db = await SQLite.openDatabaseAsync(SETTINGS_DB);
  await db.execAsync(SETTINGS_TABLE);
  return {
    async load(): Promise<AudioSettings | null> {
      const rows = await db.getAllAsync<{ settings: string }>(
        "SELECT settings FROM audio_settings WHERE id = 1",
      );
      // Corrupt rows fall back to defaults via the pure parse guard.
      return parseAudioSettings(rows[0]?.settings ?? null);
    },
    async save(settings: AudioSettings): Promise<void> {
      await db.runAsync(
        "INSERT INTO audio_settings (id, settings, updated_at) VALUES (1, ?, ?) " +
          "ON CONFLICT(id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at",
        [JSON.stringify(settings), new Date().toISOString()],
      );
    },
  };
}

export function createExpoSpeechEngine(): SpeechEngine {
  return {
    async isSupported() {
      try {
        const voices = await Speech.getAvailableVoicesAsync();
        return voices.length > 0;
      } catch {
        // Engine unavailable (unsupported platform): bundled fallback path.
        return false;
      }
    },
    speak(utterance: SpeechUtterance) {
      Speech.speak(utterance.text, {
        language: utterance.language,
        rate: utterance.rate,
        pitch: utterance.pitch,
        volume: utterance.volume,
        // Share the app session so duck/mix policy sees speech + SFX as one.
        useApplicationAudioSession: true,
        onStart: utterance.onStart,
        onDone: utterance.onDone,
        onStopped: utterance.onStopped,
        onError: utterance.onError,
      });
    },
    async stop() {
      await Speech.stop();
    },
  };
}

interface LiveSfxVoice {
  player: AudioPlayer;
  baseVolume: number;
}

export function createExpoSfxEngine(): SfxEngine {
  const voices = new Map<SfxSoundId, LiveSfxVoice>();
  let multiplier = 1;

  const voiceFor = (id: SfxSoundId): LiveSfxVoice | null => {
    const existing = voices.get(id);
    if (existing) return existing;
    // Dynamic lookup by a runtime id: the map's key set is compile-pinned
    // (Record<ManifestSoundId, number>), but ids can still arrive from
    // runtime data, so a miss stays a logged no-op rather than a crash.
    const asset = (SFX_ASSETS as Record<string, number | undefined>)[id];
    if (asset === undefined) {
      warnOnce(`sfx-asset-missing:${id}`, `sfx "${id}" has no bundled asset; ignored`);
      return null;
    }
    try {
      // One player per sound id = per-id retrigger restarts, and total
      // polyphony is bounded by the 16-sound catalog.
      const player = createAudioPlayer(asset);
      const voice: LiveSfxVoice = { player, baseVolume: SFX_BASE_VOLUME };
      voices.set(id, voice);
      return voice;
    } catch (error) {
      warnOnce(`sfx-create-failed:${id}`, `could not create player for "${id}": ${String(error)}`);
      return null;
    }
  };

  return {
    play(id, volume) {
      const voice = voiceFor(id);
      if (!voice) return;
      try {
        voice.baseVolume = Math.min(1, Math.max(0, volume));
        voice.player.volume = voice.baseVolume * multiplier;
        voice.player.seekTo(0);
        voice.player.play();
      } catch (error) {
        warnOnce(`sfx-play-failed:${id}`, `playing "${id}" failed: ${String(error)}`);
      }
    },
    setVolumeMultiplier(next) {
      multiplier = Math.min(1, Math.max(0, next));
      for (const [id, voice] of voices) {
        try {
          voice.player.volume = voice.baseVolume * multiplier;
        } catch (error) {
          warnOnce(`sfx-volume-failed:${id}`, `volume update failed: ${String(error)}`);
        }
      }
    },
    stop(id) {
      const voice = voices.get(id);
      if (!voice) return;
      try {
        voice.player.pause();
        voice.player.seekTo(0);
      } catch (error) {
        warnOnce(`sfx-stop-failed:${id}`, `stop failed: ${String(error)}`);
      }
    },
    stopAll() {
      for (const id of voices.keys()) {
        this.stop(id);
      }
    },
    async preload(ids) {
      for (const id of ids) {
        voiceFor(id);
      }
    },
  };
}

export function createExpoHapticsEngine(): HapticsEngine {
  return {
    async trigger(pattern: HapticPattern) {
      switch (pattern) {
        case "correct":
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          return;
        case "gentle-retry":
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          return;
        case "error":
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          return;
        case "streak-combo":
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          return;
      }
    },
  };
}

/**
 * Pre-K fallback seam hook: bundled narration audio does not exist until
 * #59 ships the manifests, so this always reports not-playled (with a
 * single warning) - the coordinator then reports `unsupported` and the
 * caller renders the text visually instead.
 */
export function createBundledNarrationSeam(): BundledNarrationEngine {
  return {
    async play(topicId: string, line: NarrationLine) {
      warnOnce(
        "bundled-narration-pending",
        `bundled narration for (${topicId}, ${line}) unavailable until #59`,
      );
      return { played: false, durationSec: 0 };
    },
  };
}

async function probe(predicate: () => Promise<boolean>): Promise<boolean> {
  try {
    return await predicate();
  } catch {
    return false;
  }
}

export async function createNativeAudioDependencies(): Promise<AudioDependencies> {
  // Configure the shared session once; failures degrade to platform
  // defaults with a warning rather than breaking audio entirely.
  try {
    await setAudioModeAsync({
      playsInSilentMode: true,
      interruptionMode: "mixWithOthers",
      allowsRecording: false,
      shouldPlayInBackground: false,
      shouldRouteThroughEarpiece: false,
    });
  } catch (error) {
    warnOnce("audio-mode", `setAudioModeAsync failed, using platform defaults: ${String(error)}`);
  }

  return {
    speech: createExpoSpeechEngine(),
    sfx: createExpoSfxEngine(),
    haptics: createExpoHapticsEngine(),
    bundledNarration: createBundledNarrationSeam(),
    settingsStore: await createSqliteAudioSettingsStore(),
    clock: { now: () => Date.now() },
    isScreenReaderActive: () => probe(() => AccessibilityInfo.isScreenReaderEnabled()),
    isReduceMotionEnabled: () => probe(() => AccessibilityInfo.isReduceMotionEnabled()),
  };
}

let audioServicePromise: Promise<AudioCoordinator> | null = null;

/**
 * Lazy singleton accessor for screens (#50/#51 consume this). The native
 * dependencies and settings load once per app session; a failed
 * initialization clears the memo so the next call retries instead of
 * staying poisoned forever (audio must never take the app down with it).
 */
export function getAudioService(): Promise<AudioCoordinator> {
  audioServicePromise ??= (async () => {
    const deps = await createNativeAudioDependencies();
    const coordinator = new AudioCoordinator(deps);
    await coordinator.init();
    await deps.sfx.preload(SFX_ASSET_KEYS);
    return coordinator;
  })().catch((error: unknown) => {
    audioServicePromise = null;
    warnOnce("service-init", `audio service init failed, will retry next call: ${String(error)}`);
    throw error;
  });
  return audioServicePromise;
}
