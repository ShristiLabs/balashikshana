/**
 * Shared audio types (issue #45). PURE module: no react-native imports.
 *
 * The audio tree follows the onboarding doctrine (src/onboarding): every
 * module except nativeAudio.ts / assetModules.ts is node-testable and the
 * native adapters are injected through the interfaces defined here.
 */

import type { GradeId } from "../onboarding/types";

/** Feedback moments from the 9-asset contract (sounds-manifest.json). */
export const SFX_MOMENTS = [
  "onInteract",
  "onCorrect",
  "onGentleRetry",
  "onStreakCombo",
  "onSpeedTargetBeat",
] as const;

export type SfxMoment = (typeof SFX_MOMENTS)[number] | "primary";

/**
 * The 16 manifest sound ids - the file stems of assets/sounds/*.wav.
 * The native asset registry (assetModules.SFX_ASSETS) is a
 * Record<ManifestSoundId, number>, so a missing key, an extra key, or a
 * typo is a COMPILE error rather than a silent no-op sound. Tests pin
 * this list against the manifest-derived catalog (SFX_FILE_STEMS) so the
 * union cannot drift from sounds-manifest.json.
 */
export const MANIFEST_SOUND_IDS = [
  "sfx_block_snap",
  "sfx_bridge_lock",
  "sfx_chime_correct",
  "sfx_clock_tick",
  "sfx_coin_clink",
  "sfx_compass_chime",
  "sfx_count_pop",
  "sfx_gentle_nudge",
  "sfx_laser_zap",
  "sfx_pacemaker_pulse",
  "sfx_page_turn",
  "sfx_phoneme_slide",
  "sfx_science_bubble",
  "sfx_slice_whoosh",
  "sfx_star_fanfare",
  "sfx_tile_snap",
] as const;

export type ManifestSoundId = (typeof MANIFEST_SOUND_IDS)[number];

/**
 * SFX ids are the manifest file stems (e.g. "sfx_chime_correct").
 * ManifestSoundId is the exhaustive compile-time set; SfxSoundId stays
 * the wide runtime type because ids also arrive from manifest JSON and,
 * from #46 on, from downloaded content packs.
 */
export type SfxSoundId = string;

/**
 * Haptic feedback patterns mapped to the defined feedback moments. The
 * native adapter translates these to expo-haptics notification/impact
 * styles; the mapping itself lives in nativeAudio.ts.
 */
export const HAPTIC_PATTERNS = ["correct", "gentle-retry", "streak-combo", "error"] as const;

export type HapticPattern = (typeof HAPTIC_PATTERNS)[number];

/** Narration line kinds (registry SSML kinds + practice runner lines). */
export type NarrationLine = "intro" | "hint" | "remediation" | "instruction" | "celebration";

export interface SpeakRequest {
  /** Narration line: plain text or an SSML document (adapted per platform). */
  text: string;
  /** Grade picks the registry-calibrated default speaking rate. */
  grade?: GradeId;
  /** Explicit WPM (a registry topic's speakingRateWpm); still clamped. */
  wpm?: number;
  /** Topic the line belongs to (bundled fallback key for #59). */
  topicId?: string;
  /** Line kind (bundled fallback key for #59). */
  line?: NarrationLine;
}

export type SpeakOutcome =
  | "spoken"
  | "cancelled"
  | "error"
  | "disabled"
  | "unsupported"
  | "fallback-bundled"
  | "deferred-screen-reader";

export interface SpeakResult {
  outcome: SpeakOutcome;
  /**
   * Measured speech duration when the platform reported start/terminal
   * events, otherwise the pure word-count estimate. Practice timing
   * (#47/#50) subtracts this from raw attempt time - parity with
   * computeCognitiveTimeSec in core-engine.
   */
  audioDurationSec: number;
  /** Resolved (clamped) WPM actually used, when speech was attempted. */
  wpmUsed?: number;
  /** Platform rate multiplier actually used, when speech was attempted. */
  rateUsed?: number;
}

/** Options handed to the platform speech engine (expo-speech adapter). */
export interface SpeechUtterance {
  text: string;
  /** Rate multiplier, 1.0 = platform normal (see rateMath.REFERENCE_WPM). */
  rate: number;
  pitch: number;
  volume: number;
  language: string;
  onStart?(): void;
  onDone?(): void;
  /** Fired when speech is interrupted by stop() before finishing. */
  onStopped?(): void;
  onError?(error: unknown): void;
}

export interface SpeechEngine {
  /** False when the device exposes no TTS voice (quality-check probe). */
  isSupported(): Promise<boolean>;
  /**
   * Enqueue an utterance. Platform engines queue natively when speech is
   * already active (expo-speech appends to its queue); callbacks fire per
   * utterance.
   */
  speak(utterance: SpeechUtterance): void;
  /** Interrupt current speech and clear the queue. */
  stop(): Promise<void>;
}

export interface SfxEngine {
  /** Play a manifest sound id at a volume in [0,1]; retrigger restarts it. */
  play(id: SfxSoundId, volume: number): void;
  /** Apply the duck multiplier to every live player immediately. */
  setVolumeMultiplier(multiplier: number): void;
  stop(id: SfxSoundId): void;
  stopAll(): void;
  /** Eagerly load players so first playback is not delayed by IO. */
  preload(ids: readonly SfxSoundId[]): Promise<void>;
}

export interface HapticsEngine {
  trigger(pattern: HapticPattern): Promise<void>;
}

/**
 * Pre-K fallback seam (issue #45 scope: the HOOK, coverage lands in #59).
 * Returns whether bundled audio for the (topic, line) existed and played.
 */
export interface BundledNarrationEngine {
  play(topicId: string, line: NarrationLine): Promise<{ played: boolean; durationSec: number }>;
}

/**
 * User-facing audio settings (issue body: sound/music/TTS toggles; the
 * haptics toggle rides along). Non-secret: persisted via the SQLite seam,
 * never the secure store. Parent-controlled UI arrives with #61.
 */
export interface AudioSettings {
  schemaVersion: 1;
  soundEffectsEnabled: boolean;
  narrationEnabled: boolean;
  hapticsEnabled: boolean;
  /** No music surface ships yet; the preference is persisted for later. */
  musicEnabled: boolean;
}

export interface AudioSettingsStore {
  load(): Promise<AudioSettings | null>;
  save(settings: AudioSettings): Promise<void>;
}
