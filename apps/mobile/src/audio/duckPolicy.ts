/**
 * Audio duck policy (issue #45) - PURE state machine.
 *
 * Policy (issue body): SFX duck while TTS speaks and restore afterwards;
 * a TTS cancel stops ducking IMMEDIATELY. Ducking is app-level - the SFX
 * players' volume is scaled by the multiplier below while narration is
 * active, and restored to 1 when the last utterance finishes, errors, or
 * is cancelled. The OS audio session itself stays mixWithOthers (see
 * nativeAudio.ts), so this never fights other apps' audio.
 *
 * Speech utterances may overlap in the platform queue, so the state is a
 * speaking COUNT: the multiplier returns to 1 only when the count reaches
 * zero (all utterances terminal).
 */

export const DUCK_FACTOR = 0.3;

export interface DuckState {
  speakingCount: number;
  /** Volume multiplier applied to every SFX player. */
  sfxMultiplier: number;
}

export type DuckEvent =
  { type: "speech-started" } | { type: "speech-finished" } | { type: "speech-cancelled" };

export const IDLE_DUCK_STATE: DuckState = { speakingCount: 0, sfxMultiplier: 1 };

function clampMultiplier(value: number): number {
  return Math.min(1, Math.max(0, Math.round(value * 1000) / 1000));
}

/**
 * Pure duck transition. speech-cancelled carries the same weight as a
 * finish (the platform fires per-utterance terminal events on stop), but
 * callers additionally restore synchronously on cancel - see
 * AudioCoordinator.stopSpeech.
 */
export function reduceDuck(state: DuckState, event: DuckEvent): DuckState {
  switch (event.type) {
    case "speech-started": {
      const speakingCount = state.speakingCount + 1;
      return { speakingCount, sfxMultiplier: clampMultiplier(DUCK_FACTOR) };
    }
    case "speech-finished":
    case "speech-cancelled": {
      const speakingCount = Math.max(0, state.speakingCount - 1);
      return {
        speakingCount,
        sfxMultiplier: speakingCount === 0 ? 1 : clampMultiplier(DUCK_FACTOR),
      };
    }
  }
}
