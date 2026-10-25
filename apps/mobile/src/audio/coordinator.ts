/**
 * AudioCoordinator (issue #45) - the unified facade #50 (practice runner),
 * #51 (boss gate) and #59 (full narration) consume. PURE module: every
 * platform capability is injected (speech / sfx / haptics / bundled
 * narration engines, settings store, clock), so the whole policy surface
 * is unit-testable in node.
 *
 * Policies implemented here:
 * - rate: registry WPM -> clamped 110-150 -> platform multiplier (rateMath)
 * - ducking: SFX volume scales by duckPolicy while narration is active;
 *   cancel restores synchronously (issue: "TTS cancel stops ducking
 *   immediately")
 * - settings: narration/SFX/haptics toggles honored on every call
 * - a11y: narration defers while a screen reader is active (TTS must not
 *   fight VoiceOver); haptics are suppressed under reduced-motion
 * - Pre-K fallback: when the device has no usable TTS voice, the bundled
 *   narration seam is tried before giving up (coverage lands in #59)
 */

import { IDLE_DUCK_STATE, reduceDuck, type DuckState } from "./duckPolicy";
import { sfxIdForMoment, SFX_FILE_STEMS } from "./manifest";
import { estimateSpeechDurationSec, resolveWpm, wpmToRate } from "./rateMath";
import { adaptNarration } from "./ssml";
import { DEFAULT_AUDIO_SETTINGS } from "./settings";
import type {
  AudioSettings,
  AudioSettingsStore,
  BundledNarrationEngine,
  HapticPattern,
  HapticsEngine,
  NarrationLine,
  SpeakRequest,
  SpeakResult,
  SfxEngine,
  SfxMoment,
  SfxSoundId,
  SpeechEngine,
} from "./types";

/**
 * Narration plays at full volume: it is the primary instructional
 * channel for pre-readers, and SFX are already ducked (duckPolicy)
 * while narration is active, so prompts are never the quieter party.
 */
export const NARRATION_VOLUME = 1;
/** Base SFX volume the duck multiplier scales. */
export const SFX_BASE_VOLUME = 0.9;

export interface AudioClock {
  now(): number;
}

export interface AudioDependencies {
  speech: SpeechEngine;
  sfx: SfxEngine;
  haptics: HapticsEngine;
  bundledNarration?: BundledNarrationEngine;
  settingsStore: AudioSettingsStore;
  clock: AudioClock;
  /** Live screen-reader probe (AccessibilityInfo in the app). */
  isScreenReaderActive?(): Promise<boolean>;
  /** Live reduced-motion probe (AccessibilityInfo in the app). */
  isReduceMotionEnabled?(): Promise<boolean>;
}

const warned = new Set<string>();

export function warnOnce(key: string, message: string): void {
  if (!warned.has(key)) {
    warned.add(key);
    console.warn(`[audio] ${message}`);
  }
}

interface InFlightUtterance {
  request: SpeakRequest;
  plainText: string;
  wpm: number;
  estimateSec: number;
  startedAt: number | null;
  settled: boolean;
  resolve(result: SpeakResult): void;
}

export type SfxRequest = SfxSoundId | { moment: SfxMoment; topicId?: string };

export class AudioCoordinator {
  private readonly deps: AudioDependencies;
  private settings: AudioSettings = DEFAULT_AUDIO_SETTINGS;
  private duck: DuckState = IDLE_DUCK_STATE;
  private inFlight = new Map<number, InFlightUtterance>();
  private nextUtteranceId = 1;
  private settingsLoaded: Promise<void> | null = null;
  private supportProbe: Promise<boolean> | null = null;

  constructor(deps: AudioDependencies) {
    this.deps = deps;
  }

  /** Load persisted settings once (the native service awaits this). */
  init(): Promise<void> {
    this.settingsLoaded ??= (async () => {
      const loaded = await this.deps.settingsStore.load();
      this.settings = loaded ?? DEFAULT_AUDIO_SETTINGS;
    })();
    return this.settingsLoaded;
  }

  getDuckState(): DuckState {
    return this.duck;
  }

  async speak(request: SpeakRequest): Promise<SpeakResult> {
    if (!this.settings.narrationEnabled) {
      return { outcome: "disabled", audioDurationSec: 0 };
    }
    if (this.deps.isScreenReaderActive) {
      const active = await this.deps.isScreenReaderActive();
      if (active) return { outcome: "deferred-screen-reader", audioDurationSec: 0 };
    }

    const adapted = adaptNarration(request.text);
    const wpm = resolveWpm({
      grade: request.grade,
      wpm: request.wpm ?? adapted.rateWpm ?? undefined,
    });
    const estimateSec = estimateSpeechDurationSec(adapted.plainText, wpm, adapted.breakMs);

    const supported = await this.probeSpeechSupport();
    if (!supported) {
      return this.fallBackToBundled(request, estimateSec);
    }

    const id = this.nextUtteranceId++;
    return new Promise<SpeakResult>((resolve) => {
      const utterance: InFlightUtterance = {
        request,
        plainText: adapted.plainText,
        wpm,
        estimateSec,
        startedAt: null,
        settled: false,
        resolve,
      };
      this.inFlight.set(id, utterance);

      const settle = (result: SpeakResult) => {
        if (utterance.settled) return;
        utterance.settled = true;
        this.inFlight.delete(id);
        resolve(result);
      };

      const measuredDuration = (): number => {
        if (utterance.startedAt === null) return estimateSec;
        const seconds = (this.deps.clock.now() - utterance.startedAt) / 1000;
        return Math.max(0.1, Math.round(seconds * 100) / 100);
      };

      try {
        this.deps.speech.speak({
          text: adapted.plainText,
          rate: wpmToRate(wpm),
          pitch: adapted.pitchMultiplier ?? 1,
          volume: NARRATION_VOLUME,
          language: "en-US",
          onStart: () => {
            if (utterance.settled) return;
            // A platform double-firing onStart must not inflate the duck
            // speaking count (a wedged 0.3 multiplier would silence SFX
            // for the rest of the session): one start per utterance.
            if (utterance.startedAt !== null) return;
            utterance.startedAt = this.deps.clock.now();
            this.applyDuck({ type: "speech-started" });
          },
          onDone: () => {
            if (utterance.settled) return;
            // Duck events pair with a COUNTED start: a terminal without a
            // start must not decrement the shared speaking count (it would
            // un-duck SFX while another utterance is still speaking).
            if (utterance.startedAt !== null) {
              this.applyDuck({ type: "speech-finished" });
            }
            settle({
              outcome: "spoken",
              audioDurationSec: measuredDuration(),
              wpmUsed: wpm,
              rateUsed: wpmToRate(wpm),
            });
          },
          onStopped: () => {
            if (utterance.settled) return;
            if (utterance.startedAt !== null) {
              this.applyDuck({ type: "speech-finished" });
            }
            settle({ outcome: "cancelled", audioDurationSec: measuredDuration(), wpmUsed: wpm });
          },
          onError: () => {
            if (utterance.settled) return;
            if (utterance.startedAt !== null) {
              this.applyDuck({ type: "speech-finished" });
            }
            settle({ outcome: "error", audioDurationSec: measuredDuration(), wpmUsed: wpm });
          },
        });
      } catch (error) {
        if (utterance.startedAt !== null) {
          this.applyDuck({ type: "speech-finished" });
        }
        warnOnce(
          `speech-throw:${request.topicId ?? "adhoc"}`,
          `speech engine threw while enqueuing narration: ${String(error)}`,
        );
        settle({ outcome: "error", audioDurationSec: estimateSec, wpmUsed: wpm });
      }
    });
  }

  /**
   * Interrupt narration and clear the platform queue. In-flight speak()
   * promises settle as cancelled with their measured-so-far duration and
   * the duck multiplier restores SYNCHRONOUSLY (before the engine call
   * resolves) per the issue's cancel requirement.
   */
  async stopSpeech(): Promise<void> {
    for (const utterance of this.inFlight.values()) {
      if (utterance.settled) continue;
      const elapsedMs =
        utterance.startedAt === null ? 0 : this.deps.clock.now() - utterance.startedAt;
      const seconds = Math.max(0.1, Math.round((elapsedMs / 1000) * 100) / 100);
      // Only utterances whose start was counted may decrement (same
      // start/terminal pairing as the per-utterance callbacks above).
      if (utterance.startedAt !== null) {
        this.applyDuck({ type: "speech-cancelled" });
      }
      utterance.settled = true;
      utterance.resolve({
        outcome: "cancelled",
        audioDurationSec: seconds,
        wpmUsed: utterance.wpm,
      });
    }
    this.inFlight.clear();
    await this.deps.speech.stop();
  }

  /**
   * Fire-and-forget SFX. Accepts a manifest sound id directly or a
   * {moment, topicId} pair resolved through sounds-manifest.json.
   * Returns false when the sound was suppressed (setting off / unknown id).
   */
  sfx(request: SfxRequest): boolean {
    if (!this.settings.soundEffectsEnabled) return false;
    const id =
      typeof request === "string" ? request : sfxIdForMoment(request.topicId, request.moment);
    if (!SFX_FILE_STEMS.includes(id)) {
      warnOnce(`sfx-unknown:${id}`, `unknown sfx id "${id}" ignored (not in sounds-manifest.json)`);
      return false;
    }
    const volume = Math.min(1, Math.max(0, SFX_BASE_VOLUME * this.duck.sfxMultiplier));
    try {
      this.deps.sfx.play(id, volume);
      return true;
    } catch (error) {
      warnOnce(`sfx-throw:${id}`, `sfx engine threw for "${id}": ${String(error)}`);
      return false;
    }
  }

  /**
   * Haptic feedback mapped to the defined moments; suppressed when the
   * user disabled haptics or the OS reduced-motion preference is on.
   */
  async haptic(pattern: HapticPattern): Promise<void> {
    if (!this.settings.hapticsEnabled) return;
    if (this.deps.isReduceMotionEnabled) {
      if (await this.deps.isReduceMotionEnabled()) return;
    }
    try {
      await this.deps.haptics.trigger(pattern);
    } catch (error) {
      warnOnce(`haptic-throw:${pattern}`, `haptics engine threw: ${String(error)}`);
    }
  }

  async getSettings(): Promise<AudioSettings> {
    await this.init();
    return { ...this.settings };
  }

  async updateSettings(
    patch: Partial<Omit<AudioSettings, "schemaVersion">>,
  ): Promise<AudioSettings> {
    await this.init();
    this.settings = { ...this.settings, ...patch, schemaVersion: 1 };
    await this.deps.settingsStore.save(this.settings);
    return { ...this.settings };
  }

  private applyDuck(event: Parameters<typeof reduceDuck>[1]): void {
    this.duck = reduceDuck(this.duck, event);
    this.deps.sfx.setVolumeMultiplier(this.duck.sfxMultiplier);
  }

  /** Memoized TTS quality probe (voices list); probed once per session. */
  private probeSpeechSupport(): Promise<boolean> {
    this.supportProbe ??= this.deps.speech.isSupported().catch(() => false);
    return this.supportProbe;
  }

  private async fallBackToBundled(
    request: SpeakRequest,
    estimateSec: number,
  ): Promise<SpeakResult> {
    if (this.deps.bundledNarration && request.topicId !== undefined) {
      try {
        const line: NarrationLine = request.line ?? "instruction";
        const { played, durationSec } = await this.deps.bundledNarration.play(
          request.topicId,
          line,
        );
        if (played) {
          return { outcome: "fallback-bundled", audioDurationSec: durationSec };
        }
      } catch (error) {
        warnOnce(
          `bundled-throw:${request.topicId}`,
          `bundled narration seam threw: ${String(error)}`,
        );
      }
    }
    return { outcome: "unsupported", audioDurationSec: estimateSec };
  }
}
