/**
 * Monster Phoneme Feeder pure-module tests (issue #54, pack B): the
 * anchored phoneme grammar, plan validation (multiset bank cover),
 * seeded tile determinism, the draft-serialization contract, and the
 * guided hint chain. Fixtures mirror the pack rows verified for the
 * ELA tile-builder interaction (tile bank + space-separated phoneme
 * choice labels) - synthetic here, no registry data copied.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PracticeQuestion } from "../src/practice/types";
import {
  draftForPlaced,
  feederPlanFor,
  guidedHintForFeed,
  phonemeSegmentsForLabel,
} from "../src/games/monsterPhonemeFeeder";

function row(overrides: Partial<PracticeQuestion>): PracticeQuestion {
  return {
    questionId: "q-feed",
    topicId: "K-E3-L",
    unitId: "K-E3",
    topicCode: "L",
    topicName: "Test topic",
    difficultyLevel: 1,
    interactionType: "tile-builder",
    prompt: "Tap the sound tiles in order to blend the word",
    visualAid: "",
    tileBank: ["p", "i", "g", "z", "m"],
    choices: ["p i g", "g i p", "p u g", "m i p"],
    correctAnswer: "p i g",
    misconceptionTags: [],
    explanation: "",
    ...overrides,
  };
}

describe("phonemeSegmentsForLabel (ANCHORED grammar - #53 advisory)", () => {
  it("segments multi-token lowercase sequences (letters, digraphs, affixes)", () => {
    expect(phonemeSegmentsForLabel("f a n")).toEqual(["f", "a", "n"]);
    expect(phonemeSegmentsForLabel("ch i ck")).toEqual(["ch", "i", "ck"]);
    expect(phonemeSegmentsForLabel("s t r a p")).toEqual(["s", "t", "r", "a", "p"]);
  });

  it("REFUSES everything out of the phoneme vocabulary - the parser can never mis-grade", () => {
    expect(phonemeSegmentsForLabel("chip")).toBeNull(); // single whole word
    expect(phonemeSegmentsForLabel("C A T")).toBeNull(); // uppercase
    expect(phonemeSegmentsForLabel("f a 1")).toBeNull(); // digits
    expect(phonemeSegmentsForLabel("f-a-n")).toBeNull(); // hyphens are one token
    expect(phonemeSegmentsForLabel("")).toBeNull();
    expect(phonemeSegmentsForLabel("   ")).toBeNull();
    expect(phonemeSegmentsForLabel("fantastic")).toBeNull();
  });
});

describe("feederPlanFor (plan validation + determinism)", () => {
  it("mounts feed for a tile-bank row: target splits, bank covers, extras become distractors", () => {
    const plan = feederPlanFor(row({}));
    expect(plan.kind).toBe("feed");
    expect(plan.targetSegments).toEqual(["p", "i", "g"]);
    expect(plan.bank).toHaveLength(5);
    expect(plan.distractorCount).toBe(2);
    // Every bank tile is a real token from the row (letters + distractors).
    const labels = plan.bank.map((tile) => tile.label).sort();
    expect(labels).toEqual(["g", "i", "m", "p", "z"]);
  });

  it("same question id -> identical bank order (seeded shuffle)", () => {
    expect(feederPlanFor(row({})).bank).toEqual(feederPlanFor(row({})).bank);
    expect(feederPlanFor(row({ questionId: "q-other" })).bank.length).toBe(5);
  });

  it("bank keys are unique per tile (duplicates in the bank stay distinct React keys)", () => {
    const plan = feederPlanFor(
      row({ tileBank: ["a", "a", "x", "m"], correctAnswer: "a x", choices: ["a x", "x a"] }),
    );
    expect(plan.kind).toBe("feed");
    const keys = new Set(plan.bank.map((tile) => tile.key));
    expect(keys.size).toBe(plan.bank.length);
  });

  it("MULTISET cover: a target needing a repeated segment requires repeats in the bank", () => {
    const covers = feederPlanFor(
      row({ tileBank: ["a", "a", "x"], correctAnswer: "a x a", choices: ["a x a", "x a a"] }),
    );
    expect(covers.kind).toBe("feed");
    expect(covers.targetSegments).toEqual(["a", "x", "a"]);
    const misses = feederPlanFor(
      row({ tileBank: ["a", "x", "m"], correctAnswer: "a x a", choices: ["a x a", "x a a"] }),
    );
    expect(misses.kind).toBe("substrate");
  });

  it("degrades to substrate: no tile bank (whole-word multiple choice), empty bank, bad tokens, unsegmentable answer", () => {
    const { tileBank: _tb, ...noBank } = row({});
    void _tb;
    expect(feederPlanFor(noBank as PracticeQuestion).kind).toBe("substrate");
    expect(feederPlanFor(row({ tileBank: [] })).kind).toBe("substrate");
    expect(feederPlanFor(row({ tileBank: ["p", "PIG", "g"] })).kind).toBe("substrate");
    expect(feederPlanFor(row({ correctAnswer: "pig", choices: ["pig", "pug"] })).kind).toBe(
      "substrate",
    );
    expect(
      feederPlanFor(
        row({ tileBank: ["q", "v", "w"], correctAnswer: "p i g", choices: ["p i g", "g i p"] }),
      ).kind,
    ).toBe("substrate");
  });
});

describe("draftForPlaced (grading by construction)", () => {
  it("the placed labels joined with single spaces ARE the exact choice label", () => {
    const placed = [
      { key: "t0", label: "f" },
      { key: "t1", label: "a" },
      { key: "t2", label: "n" },
    ];
    expect(draftForPlaced(placed)).toBe("f a n");
  });

  it("empty sequence drafts null (nothing placed, nothing graded)", () => {
    expect(draftForPlaced([])).toBeNull();
  });

  it("e2e: feeding the target segments of a real-shaped row drafts the correct answer", () => {
    const plan = feederPlanFor(row({}));
    expect(plan.kind).toBe("feed");
    if (plan.kind !== "feed") return;
    const byLabel = (label: string) => plan.bank.find((tile) => tile.label === label)!;
    const fed = plan.targetSegments.map(byLabel);
    expect(draftForPlaced(fed)).toBe("p i g");
    expect(draftForPlaced(fed)).toBe(row({}).correctAnswer);
  });
});

describe("guidedHintForFeed (deterministic chain)", () => {
  const target = ["f", "a", "n"];

  it("walks: invite -> sounds left -> one left -> celebrate", () => {
    expect(guidedHintForFeed(0, target)).toContain("3 sounds to go");
    expect(guidedHintForFeed(1, target)).toContain("2 sounds left");
    expect(guidedHintForFeed(2, target)).toContain("One sound left");
    expect(guidedHintForFeed(3, target)).toContain("Tap Check");
  });

  it("empty target stays safe (substrate rows never hint nonsense)", () => {
    expect(guidedHintForFeed(0, [])).toContain("Listen");
  });
});

describe("source pins (no RN harness - the renderer rides the seams)", () => {
  const rendererSource = readFileSync(
    fileURLToPath(new URL("../src/games/MonsterPhonemeFeederGame.tsx", import.meta.url)),
    "utf-8",
  );

  it("audio ONLY through the framework replay seam - never the coordinator, never awaited", () => {
    expect(rendererSource).toContain("onReplayPrompt");
    // Pin the CODE forms (doc prose may name the coordinator it avoids).
    expect(rendererSource).not.toContain("AudioCoordinator");
    expect(rendererSource).not.toContain("audioRef");
    expect(rendererSource).not.toContain(".speak(");
    expect(rendererSource).not.toContain(".sfx(");
    expect(rendererSource).not.toContain("await");
    expect(rendererSource).toContain('accessibilityLabel="Hear the word again"');
  });

  it("updater purity: taps compute the next sequence OUTSIDE the updater (#53 pattern)", () => {
    expect(rendererSource).toContain("const next = [...placed, option];");
    expect(rendererSource).toContain("setPlaced(next);");
    expect(rendererSource).toContain("onDraftChange(draftForPlaced(next));");
  });

  it("no clock, no animation (feeding is untimed by the archetype)", () => {
    expect(rendererSource).not.toContain("setInterval");
    expect(rendererSource).not.toContain("setTimeout");
    expect(rendererSource).not.toContain("Animated");
    expect(rendererSource).not.toContain("Date.now");
  });
});
