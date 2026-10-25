/**
 * Mutation proof for the #59 narration coverage gate (tester stage).
 *
 * The coverage suite (narration-coverage.test.ts) asserts ZERO gaps
 * against the real tree — which only proves the gate passes today.
 * These tests prove the gate TRIPS: mutated fixtures feed the SAME
 * shared gap helpers (narration-gap-helpers.ts) the coverage suite
 * consumes, and each failure class is asserted to be caught. If a
 * defect class can slip through, it fails HERE, not in production.
 *
 * Also covers the generator's edge paths (unsorted input, non-string
 * celebration lines, absent fields, double-run determinism) by copying
 * the REAL script into a temp tree — product code is never modified.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deriveCompactAssetText,
  enumerateRegistryTopics,
  type ManifestItem,
  type ManifestShape,
  type RegistryShape,
  registryNarrationGaps,
  manifestFieldMismatches,
  manifestSetGaps,
} from "./narration-gap-helpers";
import { hintLineForTopic } from "../src/audio/topicNarration";

// tests/ -> apps/mobile -> repo root.
const repoRoot = join(fileURLToPath(new URL("..", import.meta.url)), "../..");
const src = (relative: string): string => readFileSync(join(repoRoot, relative), "utf8");

/** A well-formed narration block for a pre-k topic. */
function goodNarration() {
  return {
    narrationId: "vox-TEST",
    voicePersona: "Tester",
    speakingRateWpm: 110,
    introPromptSsml: '<speak><prosody rate="110wpm" pitch="+5%">Intro</prosody></speak>',
    guidedHintSsml: '<speak><prosody rate="110wpm">Hint</prosody></speak>',
    remediationSsml: '<speak><prosody rate="110wpm">Remediation</prosody></speak>',
    celebrationPrompts: ["Great!"],
  };
}

function goodManifestItem(topicId: string, grade = "pre-k"): ManifestItem {
  const vn = goodNarration();
  return {
    topicId,
    grade,
    speakingRateWpm: vn.speakingRateWpm,
    introPromptSsml: vn.introPromptSsml,
    guidedHintSsml: vn.guidedHintSsml,
    remediationSsml: vn.remediationSsml,
    celebrationPrompts: vn.celebrationPrompts,
  };
}

/** One-grade, one-subject, one-unit registry fixture around topics. */
function registryFixture(topics: { code: string; assets?: unknown }[]): RegistryShape {
  return {
    grades: [
      {
        gradeId: "pre-k",
        subjects: {
          math: {
            units: [
              {
                unitId: "PK-M1",
                skillTopics: topics.map((topic) => ({
                  code: topic.code,
                  name: `Topic ${topic.code}`,
                  assets: topic.assets ?? { voiceNarration: goodNarration() },
                })),
              },
            ],
          },
        },
      },
    ],
  };
}

describe("mutation proof: the coverage gate's gap logic trips on every failure class", () => {
  it("catches a registry topic with NO voiceNarration block", () => {
    const entries = enumerateRegistryTopics(registryFixture([{ code: "A", assets: {} }]));
    const gaps = registryNarrationGaps(entries);
    expect(gaps.noBlock).toEqual(["PK-M1-A"]);
  });

  it("catches empty string line kinds individually", () => {
    const narration = goodNarration();
    narration.introPromptSsml = "";
    narration.guidedHintSsml = "";
    narration.remediationSsml = "";
    const entries = enumerateRegistryTopics(
      registryFixture([{ code: "A", assets: { voiceNarration: narration } }]),
    );
    const gaps = registryNarrationGaps(entries);
    expect(gaps.emptyIntro).toEqual(["PK-M1-A"]);
    expect(gaps.emptyHint).toEqual(["PK-M1-A"]);
    expect(gaps.emptyRemediation).toEqual(["PK-M1-A"]);
  });

  it("catches empty celebration arrays and empty-string celebration lines", () => {
    const emptyArray = goodNarration();
    emptyArray.celebrationPrompts = [];
    const emptyLine = goodNarration();
    emptyLine.celebrationPrompts = ["Great!", ""];
    for (const narration of [emptyArray, emptyLine]) {
      const entries = enumerateRegistryTopics(
        registryFixture([{ code: "A", assets: { voiceNarration: narration } }]),
      );
      expect(registryNarrationGaps(entries).emptyCelebration).toEqual(["PK-M1-A"]);
    }
  });

  it("catches WPM outside the 110-150 band and mis-calibrated per grade", () => {
    const tooFast = goodNarration();
    tooFast.speakingRateWpm = 180;
    const wrongGrade = goodNarration();
    wrongGrade.speakingRateWpm = 130; // pre-k must be 110
    const entries = enumerateRegistryTopics(
      registryFixture([
        { code: "A", assets: { voiceNarration: tooFast } },
        { code: "B", assets: { voiceNarration: wrongGrade } },
      ]),
    );
    const gaps = registryNarrationGaps(entries);
    expect(gaps.wpmOutside).toEqual(["PK-M1-A=180"]);
    expect(gaps.wpmUncalibrated).toEqual(["PK-M1-B(pre-k)=130!110"]);
  });

  it("catches registry GROWTH without manifest narration (the M4 gate's core promise)", () => {
    const registry = registryFixture([{ code: "A" }, { code: "B" }]);
    const manifest = { totalTopics: 1, items: [goodManifestItem("PK-M1-A")] };
    const gaps = manifestSetGaps(
      enumerateRegistryTopics(registry).map((entry) => entry.topicId),
      manifest.items.map((item) => item.topicId),
    );
    expect(gaps.missing).toEqual(["PK-M1-B"]);
    expect(gaps.orphans).toEqual([]);
  });

  it("catches manifest orphans (stale topics the registry no longer knows)", () => {
    const registry = registryFixture([{ code: "A" }]);
    const manifest = {
      totalTopics: 2,
      items: [goodManifestItem("PK-M1-A"), goodManifestItem("PK-M1-ZZ")],
    };
    const gaps = manifestSetGaps(
      enumerateRegistryTopics(registry).map((entry) => entry.topicId),
      manifest.items.map((item) => item.topicId),
    );
    expect(gaps.missing).toEqual([]);
    expect(gaps.orphans).toEqual(["PK-M1-ZZ"]);
  });

  it("catches manifest field drift per kind (SSML, celebration, wpm)", () => {
    const registry = registryFixture([{ code: "A" }]);
    const entries = enumerateRegistryTopics(registry);
    const ssmlDrift = goodManifestItem("PK-M1-A");
    ssmlDrift.introPromptSsml = '<speak><prosody rate="110wpm">Drifted</prosody></speak>';
    expect(manifestFieldMismatches(entries, [ssmlDrift])).toEqual(["PK-M1-A:ssml"]);

    const celebrationDrift = goodManifestItem("PK-M1-A");
    celebrationDrift.celebrationPrompts = ["Different!"];
    expect(manifestFieldMismatches(entries, [celebrationDrift])).toEqual(["PK-M1-A:celebration"]);

    const wpmDrift = goodManifestItem("PK-M1-A");
    wpmDrift.speakingRateWpm = 120;
    expect(manifestFieldMismatches(entries, [wpmDrift])).toEqual(["PK-M1-A:wpm"]);

    // The clean item passes.
    expect(manifestFieldMismatches(entries, [goodManifestItem("PK-M1-A")])).toEqual([]);
  });

  it("compact-asset derivation is SENSITIVE: any field flip changes the bytes", () => {
    const base = [goodManifestItem("PK-M1-A"), goodManifestItem("PK-M1-B")];
    const baseline = deriveCompactAssetText(base);
    const flips: ManifestItem[] = [
      { ...base[0]!, introPromptSsml: "<speak>changed</speak>" },
      { ...base[0]!, guidedHintSsml: "<speak>changed</speak>" },
      { ...base[0]!, remediationSsml: "<speak>changed</speak>" },
      { ...base[0]!, celebrationPrompts: ["changed"] },
      { ...base[0]!, celebrationPrompts: [] },
      { ...base[0]!, grade: "kindergarten" },
    ];
    for (const flip of flips) {
      expect(deriveCompactAssetText([flip, base[1]!])).not.toBe(baseline);
    }
  });
});

describe("generator edge paths: the real script on a mutated temp tree", () => {
  /**
   * Copy the REAL generator into a temp tree with a mutated manifest
   * (the script resolves repoRoot from its own location, so the temp
   * copy writes only inside the temp dir; the real tree is untouched).
   */
  function runGenerator(mutate: (manifest: ManifestShape) => void): {
    stdout: string;
    assetText: string;
  } {
    const dir = mkdtempSync(join(tmpdir(), "balashi-narration-gen-"));
    try {
      mkdirSync(join(dir, "scripts"), { recursive: true });
      mkdirSync(join(dir, "assets", "narration"), { recursive: true });
      cpSync(
        join(repoRoot, "scripts/build-narration-lines.mjs"),
        join(dir, "scripts/build-narration-lines.mjs"),
      );
      const manifest: ManifestShape = {
        totalTopics: 3,
        items: [
          goodManifestItem("PK-M1-C"),
          goodManifestItem("PK-M1-A"),
          goodManifestItem("PK-M1-B"),
        ],
      };
      mutate(manifest);
      writeFileSync(
        join(dir, "assets/narration/voice-narration-manifest.json"),
        JSON.stringify(manifest),
      );
      const result = spawnSync(process.execPath, [join(dir, "scripts/build-narration-lines.mjs")], {
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      return {
        stdout: result.stdout,
        assetText: readFileSync(join(dir, "assets/narration/narration-lines.json"), "utf8"),
      };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("sorts output by topicId regardless of input order (determinism vs input permutation)", () => {
    const { assetText } = runGenerator(() => {
      /* unsorted input: C, A, B as built above */
    });
    const parsed = JSON.parse(assetText) as { totalTopics: number; items: ManifestItem[] };
    const ids = parsed.items.map((item) => item.topicId);
    expect(ids).toEqual(["PK-M1-A", "PK-M1-B", "PK-M1-C"]);
    // Byte-equal to the derivation from the same items PRE-SORTED (the
    // generator's output order must not depend on its input order).
    const presorted = deriveCompactAssetText([
      goodManifestItem("PK-M1-A"),
      goodManifestItem("PK-M1-B"),
      goodManifestItem("PK-M1-C"),
    ]);
    expect(assetText).toBe(presorted);
  });

  it("filters empty and non-string celebration lines; absent celebration becomes []", () => {
    const { assetText } = runGenerator((manifest) => {
      // items[0] is PK-M1-C, items[1] is PK-M1-A (unsorted fixture).
      manifest.items[0]!.celebrationPrompts = ["Great!", "", 42 as unknown as string];
      delete (manifest.items[1] as unknown as Record<string, unknown>).celebrationPrompts;
    });
    const parsed = JSON.parse(assetText) as {
      items: { topicId: string; celebration: string[] }[];
    };
    const byId = new Map(parsed.items.map((item) => [item.topicId, item]));
    expect(byId.get("PK-M1-C")!.celebration).toEqual(["Great!"]);
    expect(byId.get("PK-M1-A")!.celebration).toEqual([]);
  });

  it("is byte-deterministic across double runs on the same mutated input", () => {
    const first = runGenerator((manifest) => {
      manifest.items[0]!.grade = "grade-2";
    });
    const second = runGenerator((manifest) => {
      manifest.items[0]!.grade = "grade-2";
    });
    expect(first.assetText).toBe(second.assetText);
  });
});

describe("runtime fallback seam: missing lines warn once and skip silently", () => {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  afterEach(() => {
    warnSpy.mockClear();
  });

  it("an unknown topic's hint lookup returns null and warns exactly once", () => {
    const uniqueTopic = `mutation-unknown-${Date.now()}`; // fresh warnOnce key
    expect(hintLineForTopic(uniqueTopic)).toBeNull();
    expect(hintLineForTopic(uniqueTopic)).toBeNull();
    const calls = warnSpy.mock.calls.filter(([message]) => message.includes(uniqueTopic));
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toContain("no hint narration line");
  });
});

describe("seam boundary pins: which speech carries topic identity", () => {
  const runner = src("apps/mobile/src/runner/PracticeRunnerScreen.tsx");
  const game = src("apps/mobile/src/games/GameSessionScreen.tsx");
  const gate = src("apps/mobile/src/gate/GateRunnerScreen.tsx");

  it("registry-line speech in the runner threads topicId AND the line kind together", () => {
    for (const kind of ["intro", "hint", "remediation"]) {
      const site = runner.match(new RegExp(`line: "${kind}"[\\s\\S]{0,120}?`, "m"));
      expect(site, `line "${kind}" site`).not.toBeNull();
    }
    // Every registry-kind speak block in the runner carries a topicId
    // (bundled-fallback + telemetry identity): count of `line: "kind"`
    // equals count of topicId references in speak blocks.
    const kindLines = (runner.match(/line: "(intro|hint|remediation|instruction|celebration)"/g) ??
      []) as string[];
    expect(kindLines.length).toBeGreaterThanOrEqual(6);
    const topicIdRefs = runner.match(/topicId: /g) ?? [];
    expect(topicIdRefs.length).toBeGreaterThanOrEqual(kindLines.length);
  });

  it("app-copy speech (summaries, ceremonies) deliberately carries NO topic id", () => {
    // The games + runner summary speech and the gate ceremony are app
    // copy, not registry lines: their speak calls pass only text+grade.
    // The text is computed from the copy helper and handed to speak()
    // without any topicId (window after the helper call covers the
    // whole speak expression).
    const window = (contents: string, anchor: string): string => {
      const idx = contents.indexOf(anchor);
      expect(idx).toBeGreaterThanOrEqual(0);
      return contents.slice(idx, idx + 500);
    };
    const gameBlock = window(game, "const text = gameSummarySpeechText(state.summary");
    expect(gameBlock).toContain("speak({ text, grade:");
    expect(gameBlock.slice(0, gameBlock.indexOf("}, ["))).not.toContain("topicId");
    const runnerBlock = window(runner, "const text = summarySpeechText(state.summary");
    expect(runnerBlock).toContain("speak({ text, grade:");
    expect(runnerBlock.slice(0, runnerBlock.indexOf("}, ["))).not.toContain("topicId");
    expect(gate).toContain("ceremonyCopy(kind, provisional)");
  });

  it("the hint reveal is keyed to the current question and stores tag-free text", () => {
    expect(runner).toContain("setHintShown({ questionId: activeQuestion.questionId");
    expect(runner).toContain("text: adaptNarration(line).plainText");
    expect(runner).toContain("hintShown?.questionId === question.questionId");
  });

  it("summary speech effects fire once per summary (phase+sessionId identity, no re-speak loops)", () => {
    const runnerEffect = runner.match(
      /useEffect\(\(\) => \{\s*if \(state\.phase !== "summary" \|\| !state\.summary\) return;[\s\S]*?\}, \[[^\]]+\]\);/,
    );
    expect(runnerEffect).not.toBeNull();
    expect(runnerEffect![0]).toContain("state.phase");
    expect(runnerEffect![0]).toContain("state.sessionId");
    const gameEffect = game.match(
      /useEffect\(\(\) => \{\s*if \(state\.phase !== "summary" \|\| !state\.summary\) return;[\s\S]*?\}, \[[^\]]+\]\);/,
    );
    expect(gameEffect).not.toBeNull();
    expect(gameEffect![0]).toContain("state.sessionId");
  });
});
