/**
 * TTS narration coverage (issue #59 — the M4 verification gate):
 * 100% of registry line kinds across ALL topics, derived from the
 * curriculum registry IN-TEST (expectations are never hand-written —
 * the registry grows, this suite fails until narration catches up).
 *
 * Layers pinned, bottom to top:
 * 1. Registry (docs/us-curriculum-registry.json): every skillTopic
 *    carries a voiceNarration block with non-empty intro / hint /
 *    remediation SSML, at least one celebration line, and a calibrated
 *    speakingRateWpm in the 110-150 band.
 * 2. Narration manifest (assets/narration/voice-narration-manifest.json):
 *    topic set EQUALS the registry topic set (missing = coverage gap,
 *    orphan = stale manifest) and every field matches the registry
 *    verbatim (1:1).
 * 3. Compact runtime asset (assets/narration/narration-lines.json):
 *    byte-identical to a regeneration from the manifest (generator
 *    determinism) — same input, same bytes, always.
 * 4. Runtime lookups (src/audio/topicNarration.ts): every topic
 *    resolves every line kind through the SAME path the screens use.
 * 5. SSML adaptation matrix (src/audio/ssml.ts): all 614 x 3 SSML
 *    lines adapt without throwing, yield non-empty plain text, the
 *    calibrated WPM, and a sane pitch multiplier.
 *
 * Plus the runtime surface source pins: every speaking screen routes
 * through the #45 coordinator (no ad-hoc expo-speech calls), the
 * registry line kinds are spoken at their moments, and the #58
 * hint-shown mascot producer is lit.
 *
 * Deterministic by construction: pure data asserts + source scans; no
 * TTS execution, no clocks, no randomness.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adaptNarration } from "../src/audio/ssml";
import {
  hintLineForTopic,
  introLineForTopic,
  narrationTopicCount,
  remediationLineForTopic,
  topicNarrationFor,
} from "../src/audio/topicNarration";
import { celebrationLineForTopic, celebrationLinesForTopic } from "../src/mascot/celebrationLines";
import {
  deriveCompactAssetText,
  enumerateRegistryTopics,
  manifestFieldMismatches,
  manifestSetGaps,
  type ManifestShape,
  type RegistryShape,
  registryNarrationGaps,
} from "./narration-gap-helpers";

// tests/ -> apps/mobile -> repo root.
const repoRoot = join(fileURLToPath(new URL("..", import.meta.url)), "../..");
const readJson = (relative: string): unknown =>
  JSON.parse(readFileSync(join(repoRoot, relative), "utf8"));
const src = (relative: string): string => readFileSync(join(repoRoot, relative), "utf8");

const manifest = readJson("assets/narration/voice-narration-manifest.json") as ManifestShape;

/** Fail-fast helper: report counts + the first few offenders, deterministically. */
function firstOffenders(ids: string[], max = 5): string {
  const shown = ids.slice(0, max).join(", ");
  return `${ids.length} (${shown}${ids.length > max ? ", ..." : ""})`;
}

const topics = enumerateRegistryTopics(
  readJson("docs/us-curriculum-registry.json") as RegistryShape,
);

// The gap helpers are shared with the mutation suite: fixtures there
// prove these exact functions trip on every failure class.
const gaps = registryNarrationGaps(topics);

describe("layer 1: the registry carries narration for every topic", () => {
  it("enumerates the full curriculum (sanity: the DAG did not move under us)", () => {
    expect(topics.length).toBeGreaterThanOrEqual(600);
    expect(new Set(topics.map((entry) => entry.topicId)).size).toBe(topics.length);
  });

  it("every topic has a voiceNarration block with ALL line kinds non-empty", () => {
    expect(`no voiceNarration block: ${firstOffenders(gaps.noBlock)}`).toBe(
      "no voiceNarration block: 0 ()",
    );
    expect(`empty intro: ${firstOffenders(gaps.emptyIntro)}`).toBe("empty intro: 0 ()");
    expect(`empty hint: ${firstOffenders(gaps.emptyHint)}`).toBe("empty hint: 0 ()");
    expect(`empty remediation: ${firstOffenders(gaps.emptyRemediation)}`).toBe(
      "empty remediation: 0 ()",
    );
    expect(`empty celebration: ${firstOffenders(gaps.emptyCelebration)}`).toBe(
      "empty celebration: 0 ()",
    );
  });

  it("every topic's speakingRateWpm is grade-calibrated inside the 110-150 band", () => {
    expect(`wpm outside 110-150: ${firstOffenders(gaps.wpmOutside)}`).toBe(
      "wpm outside 110-150: 0 ()",
    );
    expect(`wpm not grade-calibrated: ${firstOffenders(gaps.wpmUncalibrated)}`).toBe(
      "wpm not grade-calibrated: 0 ()",
    );
  });
});

describe("layer 2: the narration manifest covers the registry 1:1", () => {
  it("topic sets are equal — no missing narration, no orphans (registry growth fails here)", () => {
    const { missing, orphans } = manifestSetGaps(
      topics.map((entry) => entry.topicId),
      manifest.items.map((item) => item.topicId),
    );
    expect(`registry topics missing from manifest: ${firstOffenders(missing)}`).toBe(
      "registry topics missing from manifest: 0 ()",
    );
    expect(`manifest orphans not in registry: ${firstOffenders(orphans)}`).toBe(
      "manifest orphans not in registry: 0 ()",
    );
    expect(manifest.totalTopics).toBe(manifest.items.length);
  });

  it("every manifest field matches the registry verbatim", () => {
    const mismatches = manifestFieldMismatches(topics, manifest.items);
    expect(`manifest != registry fields: ${firstOffenders(mismatches)}`).toBe(
      "manifest != registry fields: 0 ()",
    );
  });

  it("every SSML line is a <speak> document carrying its calibrated prosody rate", () => {
    const offenders: string[] = [];
    for (const item of manifest.items) {
      const kinds: [string, string][] = [
        ["intro", item.introPromptSsml],
        ["hint", item.guidedHintSsml],
        ["remediation", item.remediationSsml],
      ];
      for (const [kind, line] of kinds) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("<speak") || !trimmed.endsWith("</speak>")) {
          offenders.push(`${item.topicId}:${kind}`);
          continue;
        }
        const adapted = adaptNarration(line);
        if (adapted.rateWpm !== item.speakingRateWpm) {
          offenders.push(`${item.topicId}:${kind}:rate!${String(adapted.rateWpm)}`);
        }
      }
    }
    expect(`malformed SSML or rate mismatch: ${firstOffenders(offenders)}`).toBe(
      "malformed SSML or rate mismatch: 0 ()",
    );
  });
});

describe("layer 3: the compact runtime asset is a deterministic derivation", () => {
  it("narration-lines.json is byte-identical to a fresh regeneration", () => {
    // Re-derive exactly what scripts/build-narration-lines.mjs writes
    // (shared derivation — the mutation suite trips it on drift).
    const expected = deriveCompactAssetText(manifest.items);
    const actual = readFileSync(join(repoRoot, "assets/narration/narration-lines.json"), "utf8");
    expect(actual).toBe(expected);
  });

  it("the superseded celebration-only asset is gone (folded — no drift between two assets)", () => {
    // If celebration-lines.json ever reappears, two sources can drift.
    let exists = true;
    try {
      readFileSync(join(repoRoot, "assets/narration/celebration-lines.json"), "utf8");
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });
});

describe("layer 4: runtime lookups resolve every topic through the shipping module", () => {
  it("topicNarrationFor / intro / hint / remediation cover ALL topics", () => {
    expect(narrationTopicCount()).toBe(manifest.items.length);
    const missingIntro: string[] = [];
    const missingHint: string[] = [];
    const missingRemediation: string[] = [];
    for (const item of manifest.items) {
      if (introLineForTopic(item.topicId) === null) missingIntro.push(item.topicId);
      if (hintLineForTopic(item.topicId) === null) missingHint.push(item.topicId);
      if (remediationLineForTopic(item.topicId) === null) missingRemediation.push(item.topicId);
      expect(topicNarrationFor(item.topicId)?.celebration.length).toBeGreaterThan(0);
    }
    expect(`intro lookup gaps: ${firstOffenders(missingIntro)}`).toBe("intro lookup gaps: 0 ()");
    expect(`hint lookup gaps: ${firstOffenders(missingHint)}`).toBe("hint lookup gaps: 0 ()");
    expect(`remediation lookup gaps: ${firstOffenders(missingRemediation)}`).toBe(
      "remediation lookup gaps: 0 ()",
    );
  });

  it("lookups return the manifest's own SSML verbatim (no transformation at rest)", () => {
    for (const item of manifest.items.slice(0, 40)) {
      expect(introLineForTopic(item.topicId)).toBe(item.introPromptSsml);
      expect(hintLineForTopic(item.topicId)).toBe(item.guidedHintSsml);
      expect(remediationLineForTopic(item.topicId)).toBe(item.remediationSsml);
      expect(celebrationLinesForTopic(item.topicId)).toEqual(item.celebrationPrompts);
    }
  });

  it("unknown topics degrade to silent skip (null) + celebration fallback — never a crash", () => {
    expect(topicNarrationFor("not-a-topic")).toBeNull();
    expect(introLineForTopic("not-a-topic")).toBeNull();
    expect(hintLineForTopic("not-a-topic")).toBeNull();
    expect(remediationLineForTopic("not-a-topic")).toBeNull();
    expect(celebrationLinesForTopic("not-a-topic")).toEqual([]);
    expect(celebrationLineForTopic("not-a-topic", 0)).toBe("Awesome job! Keep that focus going!");
  });
});

describe("layer 5: the SSML adaptation matrix over every shipped line", () => {
  it("all 614 x 3 SSML lines adapt deterministically to usable speech parameters", () => {
    let adapted = 0;
    for (const item of manifest.items) {
      for (const line of [item.introPromptSsml, item.guidedHintSsml, item.remediationSsml]) {
        const result = adaptNarration(line);
        // Never empty, never a crash, calibrated rate, sane pitch.
        expect(result.plainText.length).toBeGreaterThan(0);
        expect(result.rateWpm).toBe(item.speakingRateWpm);
        expect(result.rateWpm).toBeGreaterThanOrEqual(110);
        expect(result.rateWpm).toBeLessThanOrEqual(150);
        if (result.pitchMultiplier !== null) {
          expect(result.pitchMultiplier).toBeGreaterThanOrEqual(0.5);
          expect(result.pitchMultiplier).toBeLessThanOrEqual(2);
        }
        adapted += 1;
      }
    }
    expect(adapted).toBe(manifest.items.length * 3);
  });

  it("adaptation is a pure function (same input, same output object)", () => {
    const sample = manifest.items[0];
    if (!sample) throw new Error("narration manifest is empty");
    for (let i = 0; i < 3; i += 1) {
      expect(adaptNarration(sample.introPromptSsml)).toEqual(
        adaptNarration(sample.introPromptSsml),
      );
    }
  });
});

describe("runtime surface pins: every speaking moment routes through the coordinator", () => {
  const runner = src("apps/mobile/src/runner/PracticeRunnerScreen.tsx");
  const gate = src("apps/mobile/src/gate/GateRunnerScreen.tsx");
  const game = src("apps/mobile/src/games/GameSessionScreen.tsx");

  it("no screen speaks around the coordinator (zero ad-hoc expo-speech)", () => {
    for (const [name, contents] of [
      ["runner", runner],
      ["gate", gate],
      ["game", game],
      ["mascot", src("apps/mobile/src/mascot/mascotArt.ts")],
    ] as const) {
      expect(contents, name).not.toContain("expo-speech");
      expect(contents, name).not.toContain("Speech.speak");
    }
    // The only expo-speech import in the app tree is the #45 adapter.
    expect(src("apps/mobile/src/audio/nativeAudio.ts")).toContain("expo-speech");
  });

  it("practice runner speaks all registry line kinds at their moments", () => {
    // Session opens with the registry intro line.
    expect(runner).toContain("introLineForTopic");
    expect(runner).toContain('line: "intro"');
    // Guided-hint affordance speaks the hint AND lights the #58
    // mascot's hint-shown producer (the previously dormant event).
    expect(runner).toContain("hintLineForTopic");
    expect(runner).toContain('line: "hint"');
    expect(runner).toContain('fireMascot({ type: "hint-shown" })');
    expect(runner).toContain('accessibilityLabel="Get a hint"');
    expect(runner).toContain('testID="question-hint"');
    // Wrong answers speak remediation at the gentle-retry moment.
    expect(runner).toContain("remediationLineForTopic");
    expect(runner).toContain('line: "remediation"');
    // Question prompts + replay keep the instruction kind.
    expect(runner).toContain('line: "instruction"');
    // Completion summary speaks the outcome copy.
    expect(runner).toContain("summarySpeechText");
  });

  it("gate ceremony speech comes from the ceremony copy module (no hardcoded spoken strings)", () => {
    expect(gate).toContain("ceremonyCopy(kind, provisional)");
    expect(gate).not.toContain('"Gold key earned!"');
    expect(gate).not.toContain('"Silver key earned!"');
  });

  it("game celebration falls back INSIDE the module (no hardcoded spoken strings at call sites)", () => {
    expect(game).not.toContain("Great game! You met your goal.");
    expect(game).toContain("celebrationLineForTopic(celebrationTopicId, 0)");
    // The #56 hearts reframe is spoken, not just displayed.
    expect(game).toContain("gameSummarySpeechText");
    expect(game).toContain("Mistakes grow your brain!");
  });

  it("the motor warm-up stays UNNARRATED by design (baseline integrity)", () => {
    // Speaking during the 3-tap warm-up would contaminate the tap
    // latencies that feed the engine's motor baseline — the audit's
    // documented exception, pinned so it is a decision, not a gap.
    const warmup = src("apps/mobile/src/runner/MotorWarmup.tsx");
    expect(warmup).not.toContain("speak");
    expect(warmup).not.toContain("audio");
  });

  it("the generator is checked in and deterministic (spawn the real script)", async () => {
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, "scripts/build-narration-lines.mjs")],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("614 topics");
    // Regeneration must not have changed the file (byte-deterministic).
    const regenerated = readFileSync(
      join(repoRoot, "assets/narration/narration-lines.json"),
      "utf8",
    );
    expect(regenerated).toBe(deriveCompactAssetText(manifest.items));
  });
});
