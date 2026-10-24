/**
 * AudioCoordinator policy tests (issue #45): rate resolution, ducking,
 * settings honoring, assistive-tech deferral, Pre-K bundled fallback,
 * cancel semantics and queueing - all against injected mock engines, the
 * same seams the expo adapters satisfy at runtime.
 *
 * speak() awaits the (memoized) TTS support probe before enqueuing, so
 * tests flush the microtask queue with the enqueue() helper before
 * touching engine utterances.
 */
import { describe, expect, it, vi } from "vitest";
import {
  AudioCoordinator,
  SFX_BASE_VOLUME,
  type AudioDependencies,
} from "../src/audio/coordinator";
import { DUCK_FACTOR } from "../src/audio/duckPolicy";
import { createMemoryAudioSettingsStore } from "../src/audio/settings";
import { REFERENCE_WPM } from "../src/audio/rateMath";
import type {
  BundledNarrationEngine,
  HapticPattern,
  HapticsEngine,
  SfxEngine,
  SpeakRequest,
  SpeakResult,
  SpeechEngine,
  SpeechUtterance,
} from "../src/audio/types";

class FakeClock {
  nowMs = 1_000_000;
  now(): number {
    return this.nowMs;
  }
  advance(ms: number): void {
    this.nowMs += ms;
  }
}

class MockSpeechEngine implements SpeechEngine {
  supported = true;
  utterances: SpeechUtterance[] = [];
  stopCalls = 0;

  async isSupported(): Promise<boolean> {
    return this.supported;
  }

  speak(utterance: SpeechUtterance): void {
    this.utterances.push(utterance);
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }

  last(): SpeechUtterance {
    const utterance = this.utterances[this.utterances.length - 1];
    if (!utterance) throw new Error("no utterance enqueued");
    return utterance;
  }
}

class MockSfxEngine implements SfxEngine {
  plays: { id: string; volume: number }[] = [];
  multipliers: number[] = [];

  play(id: string, volume: number): void {
    this.plays.push({ id, volume });
  }

  setVolumeMultiplier(multiplier: number): void {
    this.multipliers.push(multiplier);
  }

  stop(): void {}
  stopAll(): void {}
  async preload(): Promise<void> {}
}

class MockHapticsEngine implements HapticsEngine {
  triggers: HapticPattern[] = [];
  fail = false;

  async trigger(pattern: HapticPattern): Promise<void> {
    if (this.fail) throw new Error("haptics unavailable");
    this.triggers.push(pattern);
  }
}

function createBundledNarration(result: {
  played: boolean;
  durationSec: number;
}): BundledNarrationEngine & {
  calls: { topicId: string; line: string }[];
} {
  const calls: { topicId: string; line: string }[] = [];
  return {
    calls,
    async play(topicId, line) {
      calls.push({ topicId, line });
      return result;
    },
  };
}

interface Harness {
  coordinator: AudioCoordinator;
  speech: MockSpeechEngine;
  sfx: MockSfxEngine;
  haptics: MockHapticsEngine;
  clock: FakeClock;
  bundled: ReturnType<typeof createBundledNarration>;
}

function createHarness(overrides: Partial<AudioDependencies> = {}): Harness {
  const speech = new MockSpeechEngine();
  const sfx = new MockSfxEngine();
  const haptics = new MockHapticsEngine();
  const clock = new FakeClock();
  const bundled = createBundledNarration({ played: false, durationSec: 0 });
  const deps: AudioDependencies = {
    speech,
    sfx,
    haptics,
    bundledNarration: bundled,
    settingsStore: createMemoryAudioSettingsStore(),
    clock,
    ...overrides,
  };
  const coordinator = new AudioCoordinator(deps);
  return { coordinator, speech, sfx, haptics, clock, bundled };
}

/**
 * speak(), then flush microtasks so the engine utterance exists. The
 * pending speak promise is wrapped in an object: returning it directly
 * from an async helper would make `await enqueue(...)` assimilate and
 * await it (deadlocking the test before it can fire engine callbacks).
 */
async function enqueue(
  h: Harness,
  request: SpeakRequest,
): Promise<{ promise: Promise<SpeakResult> }> {
  const promise = h.coordinator.speak(request);
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
  return { promise };
}

describe("speak: rate resolution", () => {
  it("derives the rate from the grade calibration", async () => {
    const h = createHarness();
    const { promise } = await enqueue(h, { text: "Count to three", grade: "pre-k" });
    expect(h.speech.last().rate).toBeCloseTo(110 / REFERENCE_WPM, 3);
    h.speech.last().onStart?.();
    h.clock.advance(2000);
    h.speech.last().onDone?.();
    await expect(promise).resolves.toMatchObject({ outcome: "spoken", wpmUsed: 110 });
  });

  it("clamps an explicit registry wpm into 110-150", async () => {
    const h = createHarness();
    const { promise } = await enqueue(h, { text: "hello", grade: "grade-3", wpm: 400 });
    expect(h.speech.last().rate).toBeCloseTo(150 / REFERENCE_WPM, 3);
    h.speech.last().onDone?.();
    const result = await promise;
    expect(result.wpmUsed).toBe(150);
    expect(result.rateUsed).toBeCloseTo(150 / REFERENCE_WPM, 3);
  });

  it("prefers request.wpm over SSML prosody over grade default", async () => {
    const h = createHarness();
    const { promise: explicit } = await enqueue(h, {
      text: '<speak><prosody rate="140wpm">A</prosody></speak>',
      grade: "pre-k",
      wpm: 120,
    });
    expect(h.speech.last().rate).toBeCloseTo(120 / REFERENCE_WPM, 3);
    h.speech.last().onDone?.();
    await explicit;

    const { promise: fromSsml } = await enqueue(h, {
      text: '<speak><prosody rate="140wpm">A</prosody></speak>',
      grade: "pre-k",
    });
    expect(h.speech.last().rate).toBeCloseTo(140 / REFERENCE_WPM, 3);
    h.speech.last().onDone?.();
    await fromSsml;
  });

  it("strips SSML before handing text to the engine", async () => {
    const h = createHarness();
    const { promise } = await enqueue(h, {
      text: '<speak>Need a clue? <break time="300ms"/> Look closely.</speak>',
      grade: "grade-1",
    });
    expect(h.speech.last().text).toBe("Need a clue? Look closely.");
    h.speech.last().onDone?.();
    await promise;
  });
});

describe("speak: outcomes", () => {
  it("reports measured duration between start and done", async () => {
    const h = createHarness();
    const { promise } = await enqueue(h, { text: "one two three", grade: "grade-2" });
    h.clock.advance(500);
    h.speech.last().onStart?.();
    h.clock.advance(4200);
    h.speech.last().onDone?.();
    const result = await promise;
    expect(result.outcome).toBe("spoken");
    expect(result.audioDurationSec).toBe(4.2);
  });

  it("falls back to the estimate when no start event fired", async () => {
    const h = createHarness();
    // 3 words at 130 WPM = 1.3846s -> 1.38
    const { promise } = await enqueue(h, { text: "a b c", grade: "grade-1" });
    h.speech.last().onDone?.();
    const result = await promise;
    expect(result.outcome).toBe("spoken");
    expect(result.audioDurationSec).toBe(1.38);
  });

  it("resolves cancelled with measured-so-far duration when the engine interrupts", async () => {
    const h = createHarness();
    const { promise } = await enqueue(h, { text: "speaking", grade: "kindergarten" });
    h.speech.last().onStart?.();
    h.clock.advance(1500);
    h.speech.last().onStopped?.();
    const result = await promise;
    expect(result.outcome).toBe("cancelled");
    expect(result.audioDurationSec).toBe(1.5);
  });

  it("resolves error and restores ducking when the engine errors", async () => {
    const h = createHarness();
    const { promise } = await enqueue(h, { text: "speaking", grade: "kindergarten" });
    h.speech.last().onStart?.();
    h.clock.advance(700);
    h.speech.last().onError?.(new Error("engine"));
    const result = await promise;
    expect(result.outcome).toBe("error");
    expect(result.audioDurationSec).toBe(0.7);
    expect(h.coordinator.getDuckState().sfxMultiplier).toBe(1);
  });

  it("resolves error without crashing when engine.speak throws", async () => {
    const h = createHarness();
    h.speech.speak = () => {
      throw new Error("dead engine");
    };
    const result = await h.coordinator.speak({ text: "hello", grade: "pre-k" });
    expect(result.outcome).toBe("error");
    expect(result.audioDurationSec).toBeGreaterThan(0);
  });

  it("does not speak while narration is disabled in settings", async () => {
    const h = createHarness();
    await h.coordinator.updateSettings({ narrationEnabled: false });
    const result = await h.coordinator.speak({ text: "hello", grade: "pre-k" });
    expect(result).toMatchObject({ outcome: "disabled", audioDurationSec: 0 });
    expect(h.speech.utterances).toHaveLength(0);
  });

  it("defers narration while a screen reader is active (a11y)", async () => {
    const h = createHarness({ isScreenReaderActive: async () => true });
    const result = await h.coordinator.speak({ text: "hello", grade: "pre-k" });
    expect(result).toMatchObject({ outcome: "deferred-screen-reader", audioDurationSec: 0 });
    expect(h.speech.utterances).toHaveLength(0);
  });

  it("probes support once and caches the result", async () => {
    const h = createHarness();
    const probe = vi.fn(async () => true);
    h.speech.isSupported = probe;
    await enqueue(h, { text: "a", grade: "pre-k" });
    h.speech.last().onDone?.();
    await enqueue(h, { text: "b", grade: "pre-k" });
    h.speech.last().onDone?.();
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe("speak: unsupported TTS and the Pre-K bundled fallback", () => {
  it("plays bundled narration when available", async () => {
    const bundled = createBundledNarration({ played: true, durationSec: 2.5 });
    const h = createHarness({ bundledNarration: bundled });
    h.speech.supported = false;
    const result = await h.coordinator.speak({
      text: "count with me",
      grade: "pre-k",
      topicId: "PK-M1-A",
      line: "intro",
    });
    expect(result).toEqual({ outcome: "fallback-bundled", audioDurationSec: 2.5 });
    expect(bundled.calls).toEqual([{ topicId: "PK-M1-A", line: "intro" }]);
    expect(h.speech.utterances).toHaveLength(0);
  });

  it("reports unsupported when bundled audio is absent (until #59)", async () => {
    const h = createHarness();
    h.speech.supported = false;
    const result = await h.coordinator.speak({
      text: "count with me",
      grade: "pre-k",
      topicId: "PK-M1-A",
    });
    expect(result.outcome).toBe("unsupported");
    expect(result.audioDurationSec).toBeGreaterThan(0);
  });

  it("skips the bundled seam without a topic id", async () => {
    const h = createHarness();
    h.speech.supported = false;
    const result = await h.coordinator.speak({ text: "hello", grade: "grade-1" });
    expect(result.outcome).toBe("unsupported");
    expect(h.bundled.calls).toHaveLength(0);
  });

  it("survives a throwing bundled seam", async () => {
    const h = createHarness({
      bundledNarration: {
        play: async () => {
          throw new Error("boom");
        },
      },
    });
    h.speech.supported = false;
    const result = await h.coordinator.speak({ text: "x", topicId: "PK-M1-A" });
    expect(result.outcome).toBe("unsupported");
  });
});

describe("ducking", () => {
  it("ducks SFX while speech is active and restores after", async () => {
    const h = createHarness();
    const { promise } = await enqueue(h, { text: "narration", grade: "grade-1" });
    h.speech.last().onStart?.();
    // Literals (not the constants) so mutating DUCK_FACTOR/SFX_BASE_VOLUME
    // fails here instead of passing tautologically.
    expect(h.coordinator.getDuckState().sfxMultiplier).toBe(0.3);
    expect(h.sfx.multipliers.at(-1)).toBe(0.3);

    expect(h.coordinator.sfx("sfx_coin_clink")).toBe(true);
    expect(h.sfx.plays.at(-1)).toEqual({
      id: "sfx_coin_clink",
      volume: 0.9 * 0.3,
    });

    h.speech.last().onDone?.();
    await promise;
    expect(h.coordinator.getDuckState().sfxMultiplier).toBe(1);
    expect(h.sfx.multipliers.at(-1)).toBe(1);

    h.coordinator.sfx("sfx_coin_clink");
    expect(h.sfx.plays.at(-1)?.volume).toBe(SFX_BASE_VOLUME);
  });

  it("restores ducking synchronously on stopSpeech", async () => {
    const h = createHarness();
    const { promise } = await enqueue(h, { text: "narration", grade: "grade-1" });
    h.speech.last().onStart?.();
    h.clock.advance(900);

    const beforeEngineStop = h.speech.stopCalls;
    await h.coordinator.stopSpeech();
    // Duck restored synchronously with the cancel call itself:
    expect(h.coordinator.getDuckState().sfxMultiplier).toBe(1);
    expect(h.sfx.multipliers.at(-1)).toBe(1);
    expect(h.speech.stopCalls).toBe(beforeEngineStop + 1);

    const result = await promise;
    expect(result).toMatchObject({ outcome: "cancelled", audioDurationSec: 0.9 });
  });

  it("stopSpeech still clears the platform queue when nothing is in flight", async () => {
    const h = createHarness();
    await h.coordinator.stopSpeech();
    expect(h.speech.stopCalls).toBe(1);
    expect(h.coordinator.getDuckState()).toEqual({ speakingCount: 0, sfxMultiplier: 1 });
  });

  it("ignores a late platform onStopped after cancel already settled the promise", async () => {
    const h = createHarness();
    const { promise } = await enqueue(h, { text: "narration", grade: "grade-1" });
    h.speech.last().onStart?.();
    await h.coordinator.stopSpeech();
    // expo-speech fires onStopped per utterance after Speech.stop():
    h.speech.last().onStopped?.();
    const result = await promise;
    expect(result.outcome).toBe("cancelled");
    // No double decrement: multiplier stays 1, count stays 0.
    expect(h.coordinator.getDuckState()).toEqual({ speakingCount: 0, sfxMultiplier: 1 });
  });

  it("does not wedge the duck state when the platform double-fires onStart", async () => {
    const h = createHarness();
    const { promise } = await enqueue(h, { text: "narration", grade: "grade-1" });
    h.speech.last().onStart?.();
    h.speech.last().onStart?.();
    expect(h.coordinator.getDuckState().speakingCount).toBe(1);
    h.clock.advance(800);
    h.speech.last().onDone?.();
    const result = await promise;
    expect(result.outcome).toBe("spoken");
    // Duration measured from the FIRST start, and duck fully restored:
    expect(result.audioDurationSec).toBe(0.8);
    expect(h.coordinator.getDuckState()).toEqual({ speakingCount: 0, sfxMultiplier: 1 });
  });

  it("stays ducked until every queued utterance finishes", async () => {
    const h = createHarness();
    const { promise: first } = await enqueue(h, { text: "first", grade: "grade-1" });
    const { promise: second } = await enqueue(h, { text: "second", grade: "grade-1" });
    expect(h.speech.utterances).toHaveLength(2);

    const firstUtterance = h.speech.utterances[0];
    const secondUtterance = h.speech.utterances[1];
    if (!firstUtterance || !secondUtterance) throw new Error("queue not enqueued");
    firstUtterance.onStart?.();
    secondUtterance.onStart?.();
    expect(h.coordinator.getDuckState().speakingCount).toBe(2);

    firstUtterance.onDone?.();
    await first;
    expect(h.coordinator.getDuckState().sfxMultiplier).toBe(DUCK_FACTOR);

    h.clock.advance(1000);
    secondUtterance.onDone?.();
    await second;
    expect(h.coordinator.getDuckState().sfxMultiplier).toBe(1);
  });

  it("does not un-duck when a never-started utterance errors while another speaks", async () => {
    const h = createHarness();
    const { promise: first } = await enqueue(h, { text: "first", grade: "grade-1" });
    const { promise: second } = await enqueue(h, { text: "second", grade: "grade-1" });

    const firstUtterance = h.speech.utterances[0];
    const secondUtterance = h.speech.utterances[1];
    if (!firstUtterance || !secondUtterance) throw new Error("queue not enqueued");
    firstUtterance.onStart?.();
    // The queued utterance errors BEFORE its start event fires: its
    // terminal must not decrement the count the started utterance owns,
    // or SFX would un-duck mid-narration.
    secondUtterance.onError?.(new Error("voice unavailable"));
    const secondResult = await second;
    expect(secondResult.outcome).toBe("error");
    expect(h.coordinator.getDuckState()).toEqual({ speakingCount: 1, sfxMultiplier: DUCK_FACTOR });

    h.clock.advance(600);
    firstUtterance.onDone?.();
    await first;
    expect(h.coordinator.getDuckState()).toEqual({ speakingCount: 0, sfxMultiplier: 1 });
  });
});

describe("sfx", () => {
  it("plays a manifest sound id directly", async () => {
    const h = createHarness();
    await h.coordinator.init();
    expect(h.coordinator.sfx("sfx_star_fanfare")).toBe(true);
    expect(h.sfx.plays).toEqual([{ id: "sfx_star_fanfare", volume: SFX_BASE_VOLUME }]);
  });

  it("resolves feedback moments through the manifest", async () => {
    const h = createHarness();
    await h.coordinator.init();
    h.coordinator.sfx({ moment: "onCorrect", topicId: "PK-M1-A" });
    h.coordinator.sfx({ moment: "onGentleRetry", topicId: "PK-M1-A" });
    expect(h.sfx.plays.map((play) => play.id)).toEqual(["sfx_chime_correct", "sfx_gentle_nudge"]);
  });

  it("ignores unknown sound ids without throwing", async () => {
    const h = createHarness();
    await h.coordinator.init();
    expect(h.coordinator.sfx("sfx_not_in_manifest")).toBe(false);
    expect(h.sfx.plays).toHaveLength(0);
  });

  it("suppresses SFX when the sound toggle is off", async () => {
    const h = createHarness();
    await h.coordinator.updateSettings({ soundEffectsEnabled: false });
    expect(h.coordinator.sfx("sfx_star_fanfare")).toBe(false);
    expect(h.coordinator.sfx({ moment: "onCorrect", topicId: "PK-M1-A" })).toBe(false);
    expect(h.sfx.plays).toHaveLength(0);
  });
});

describe("haptic", () => {
  it("fires the defined feedback moments", async () => {
    const h = createHarness();
    await h.coordinator.init();
    await h.coordinator.haptic("correct");
    await h.coordinator.haptic("gentle-retry");
    await h.coordinator.haptic("streak-combo");
    await h.coordinator.haptic("error");
    expect(h.haptics.triggers).toEqual(["correct", "gentle-retry", "streak-combo", "error"]);
  });

  it("suppresses haptics under the user setting", async () => {
    const h = createHarness();
    await h.coordinator.updateSettings({ hapticsEnabled: false });
    await h.coordinator.haptic("correct");
    expect(h.haptics.triggers).toHaveLength(0);
  });

  it("suppresses haptics under reduced-motion", async () => {
    const h = createHarness({ isReduceMotionEnabled: async () => true });
    await h.coordinator.haptic("correct");
    expect(h.haptics.triggers).toHaveLength(0);
  });

  it("swallows engine failures", async () => {
    const h = createHarness();
    h.haptics.fail = true;
    await expect(h.coordinator.haptic("correct")).resolves.toBeUndefined();
  });
});

describe("settings lifecycle", () => {
  it("persists updates and honors them on later calls", async () => {
    const h = createHarness();
    const saved = await h.coordinator.updateSettings({ narrationEnabled: false });
    expect(saved.narrationEnabled).toBe(false);
    const stored = await h.coordinator.getSettings();
    expect(stored.narrationEnabled).toBe(false);
    const result = await h.coordinator.speak({ text: "hello", grade: "pre-k" });
    expect(result.outcome).toBe("disabled");
  });

  it("re-reads persisted settings through init once", async () => {
    const h = createHarness();
    await h.coordinator.init();
    const settings = await h.coordinator.getSettings();
    expect(settings).toEqual({
      schemaVersion: 1,
      soundEffectsEnabled: true,
      narrationEnabled: true,
      hapticsEnabled: true,
      musicEnabled: false,
    });
  });

  it("uses defaults before init completes (first-frame calls)", async () => {
    const h = createHarness();
    expect(h.coordinator.sfx("sfx_count_pop")).toBe(true);
  });
});
