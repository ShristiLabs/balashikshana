/**
 * Audio service public API (issue #45). Consumed by #50 (practice
 * runner), #51 (boss gate) and #59 (full narration coverage).
 *
 * This barrel stays node-importable (pure modules only): screens get the
 * wired runtime service from the native binding module instead, e.g.
 *
 *   import { getAudioService } from "../src/audio/nativeAudio";
 *   const audio = await getAudioService();           // app runtime
 *   await audio.speak({ text, grade: "pre-k" });     // narration
 *   audio.sfx({ moment: "onCorrect", topicId });     // feedback sound
 *   await audio.haptic("correct");                   // feedback haptic
 */

export { AudioCoordinator, warnOnce } from "./coordinator";
export type { AudioClock, AudioDependencies, SfxRequest } from "./coordinator";
export { DUCK_FACTOR, IDLE_DUCK_STATE, reduceDuck } from "./duckPolicy";
export type { DuckEvent, DuckState } from "./duckPolicy";
export {
  DEFAULT_TOPIC_SOUNDS,
  manifestItemCount,
  resolveTopicSounds,
  SFX_FILE_STEMS,
  sfxIdForMoment,
  validateSfxRegistry,
} from "./manifest";
export type {
  ManifestFeedbackSounds,
  ManifestItem,
  SfxRegistryCheck,
  TopicSounds,
} from "./manifest";
export {
  DEFAULT_AUDIO_SETTINGS,
  createMemoryAudioSettingsStore,
  parseAudioSettings,
} from "./settings";
export {
  estimateSpeechDurationSec,
  GRADE_DEFAULT_WPM,
  MAX_RATE,
  MAX_WPM,
  MIN_RATE,
  MIN_WPM,
  REFERENCE_WPM,
  clampWpm,
  countWords,
  resolveWpm,
  wpmToRate,
} from "./rateMath";
export { adaptNarration, isSsml } from "./ssml";
export type { AdaptedNarration } from "./ssml";
export {
  HAPTIC_PATTERNS,
  MANIFEST_SOUND_IDS,
  SFX_MOMENTS,
  type AudioSettings,
  type AudioSettingsStore,
  type BundledNarrationEngine,
  type HapticPattern,
  type HapticsEngine,
  type ManifestSoundId,
  type NarrationLine,
  type SpeakOutcome,
  type SpeakRequest,
  type SpeakResult,
  type SfxEngine,
  type SfxMoment,
  type SfxSoundId,
  type SpeechEngine,
  type SpeechUtterance,
} from "./types";
