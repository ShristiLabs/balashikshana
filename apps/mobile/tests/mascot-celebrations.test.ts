/**
 * Celebration events, lines, and repo source pins (issue #58):
 * the report derivation (badges/level-up/streak from projector
 * deltas), the moment planner ordering, positive-only PII-free copy,
 * the celebration-lines asset pinned 1:1 against the narration
 * manifest, and the source-scan pins — decorative mascot a11y,
 * reduced-motion static fallbacks, zero new native deps, core-engine
 * untouched, no PII, and the CI budget check.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCelebrationReport,
  celebrationCopyFor,
  emptyCelebrationReport,
  planCelebrationMoments,
  type CelebrationMomentPlan,
} from "../src/mascot/celebrationEvents";
import {
  celebrationLineForTopic,
  celebrationLineTopicCount,
  celebrationLinesForTopic,
  FALLBACK_CELEBRATION_LINE,
} from "../src/mascot/celebrationLines";
import { starBurstPositions, starAt } from "../src/mascot/mascotArt";

// tests/ -> apps/mobile -> repo root.
const repoRoot = join(fileURLToPath(new URL("..", import.meta.url)), "../..");
const src = (relative: string): string => readFileSync(join(repoRoot, relative), "utf8");

const mascotView = src("apps/mobile/src/mascot/MascotView.tsx");
const badgeBloom = src("apps/mobile/src/mascot/BadgeBloomView.tsx");
const keyCeremony = src("apps/mobile/src/gate/KeyCeremony.tsx");
const runnerScreen = src("apps/mobile/src/runner/PracticeRunnerScreen.tsx");
const gameScreen = src("apps/mobile/src/games/GameSessionScreen.tsx");
const journeyScreen = src("apps/mobile/src/journey/JourneyScreen.tsx");
const mobilePackageJson = src("apps/mobile/package.json");

const narrationManifest = JSON.parse(
  readFileSync(join(repoRoot, "assets/narration/voice-narration-manifest.json"), "utf8"),
) as { items: { topicId: string; celebrationPrompts: string[] }[] };

describe("celebration report derivation", () => {
  it("empty report carries level + streak with no transitions", () => {
    expect(emptyCelebrationReport(3, 5)).toEqual({
      badgesAwarded: [],
      leveledUp: false,
      level: 3,
      streakDays: 5,
      streakIncreased: false,
    });
  });

  it("derives badges, level-up, and streak transitions from before/after deltas", () => {
    const report = buildCelebrationReport({
      badgesAwarded: ["streak-spark", "first-steps"],
      levelBefore: 2,
      levelAfter: 3,
      streakBefore: 2,
      streakAfter: 3,
    });
    expect(report).toEqual({
      badgesAwarded: ["streak-spark", "first-steps"],
      leveledUp: true,
      level: 3,
      streakDays: 3,
      streakIncreased: true,
    });
    expect(
      buildCelebrationReport({
        badgesAwarded: [],
        levelBefore: 3,
        levelAfter: 3,
        streakBefore: 3,
        streakAfter: 3,
      }).leveledUp,
    ).toBe(false);
  });
});

describe("celebration moment planner", () => {
  const base = emptyCelebrationReport(1, 1);

  it("plans nothing for a plain session", () => {
    expect(planCelebrationMoments({ report: base, topicMastered: false })).toEqual([]);
  });

  it("orders concrete before abstract: mastery, badges, level-up, streak", () => {
    const report: typeof base = {
      badgesAwarded: ["first-steps", "streak-spark"],
      leveledUp: true,
      level: 2,
      streakDays: 3,
      streakIncreased: true,
    };
    const plans = planCelebrationMoments({ report, topicMastered: true });
    expect(plans.map((plan) => plan.moment)).toEqual([
      "topic-mastered",
      "badge-awarded",
      "badge-awarded",
      "level-up",
      "streak-milestone",
    ]);
    expect(plans[1]?.badgeId).toBe("first-steps");
  });

  it("streak milestone only at catalog thresholds (3/7), not every increase", () => {
    const at3 = planCelebrationMoments({
      report: { ...base, streakDays: 3, streakIncreased: true },
      topicMastered: false,
    });
    expect(at3.map((plan) => plan.moment)).toContain("streak-milestone");

    const at2 = planCelebrationMoments({
      report: { ...base, streakDays: 2, streakIncreased: true },
      topicMastered: false,
    });
    expect(at2).toEqual([]);

    const to6 = planCelebrationMoments({
      report: { ...base, streakDays: 6, streakIncreased: true },
      topicMastered: false,
    });
    expect(to6).toEqual([]);

    const to7 = planCelebrationMoments({
      report: { ...base, streakDays: 7, streakIncreased: true },
      topicMastered: false,
    });
    expect(to7.map((plan) => plan.moment)).toEqual(["streak-milestone"]);

    // A same-day session (no transition) never celebrates a milestone.
    const sameDay = planCelebrationMoments({
      report: { ...base, streakDays: 3, streakIncreased: false },
      topicMastered: false,
    });
    expect(sameDay).toEqual([]);
  });
});

describe("celebration copy doctrine (positive-only, PII-free)", () => {
  const plans: CelebrationMomentPlan[] = [
    { moment: "topic-mastered", badgeId: null },
    { moment: "badge-awarded", badgeId: "streak-spark" },
    { moment: "level-up", badgeId: null },
    { moment: "streak-milestone", badgeId: null },
    { moment: "game-goal-met", badgeId: null },
    { moment: "key-ceremony-silver", badgeId: null },
    { moment: "key-ceremony-gold", badgeId: null },
    { moment: "unit-complete", badgeId: null },
  ];

  it("every moment has non-empty title/body/a11y label (text redundancy)", () => {
    for (const plan of plans) {
      const copy = celebrationCopyFor(plan, { badgeTitle: "Streak Spark", level: 4 });
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.body.length).toBeGreaterThan(0);
      expect(copy.a11yLabel.length).toBeGreaterThan(0);
    }
  });

  it("copy stays positive: no loss/fail/sad wording anywhere", () => {
    const banned = /lost|losing|failed|failure|wrong|stupid|bad luck|sad|punish|shame/i;
    for (const plan of plans) {
      const copy = celebrationCopyFor(plan, {
        badgeTitle: "Streak Spark",
        topicName: "Numbers to 3",
        level: 2,
      });
      expect(banned.test(copy.title)).toBe(false);
      expect(banned.test(copy.body)).toBe(false);
      expect(banned.test(copy.a11yLabel)).toBe(false);
    }
  });

  it("copy embeds catalog titles and topic names but no identifiers", () => {
    const badge = celebrationCopyFor(
      { moment: "badge-awarded", badgeId: "streak-spark" },
      { badgeTitle: "Streak Spark" },
    );
    expect(badge.title).toContain("Streak Spark");
    const mastered = celebrationCopyFor(
      { moment: "topic-mastered", badgeId: null },
      { topicName: "Numbers to 3" },
    );
    expect(mastered.body).toContain("Numbers to 3");
    for (const plan of plans) {
      const copy = celebrationCopyFor(plan, { badgeTitle: null, topicName: null });
      // No student/child name placeholders anywhere (PII-free).
      expect(copy.title).not.toMatch(/\{|\}/);
      expect(copy.body).not.toMatch(/\{|\}/);
    }
  });
});

describe("celebration lines (registry-derived; asset folded into narration-lines.json by #59, pinned 1:1)", () => {
  it("covers every narration-manifest topic with identical lines", () => {
    expect(celebrationLineTopicCount()).toBe(narrationManifest.items.length);
    for (const item of narrationManifest.items) {
      expect(celebrationLinesForTopic(item.topicId)).toEqual(item.celebrationPrompts);
    }
  });

  it("picks deterministically and rotates; unknown topics fall back", () => {
    const first = narrationManifest.items[0];
    if (!first) throw new Error("narration manifest is empty");
    expect(celebrationLineForTopic(first.topicId, 0)).toBe(first.celebrationPrompts[0]);
    expect(celebrationLineForTopic(first.topicId, 1)).toBe(first.celebrationPrompts[1]);
    expect(celebrationLineForTopic(first.topicId, first.celebrationPrompts.length)).toBe(
      first.celebrationPrompts[0],
    );
    expect(celebrationLineForTopic("not-a-topic", 0)).toBe(FALLBACK_CELEBRATION_LINE);
  });
});

describe("star burst geometry (gold_stars_12)", () => {
  it("places 12 evenly on a ring and builds closed star paths", () => {
    const positions = starBurstPositions(12, 21);
    expect(positions.length).toBe(12);
    for (const point of positions) {
      expect(Math.hypot(point.x, point.y)).toBeCloseTo(21, 1);
    }
    const star = starAt(0, 0, 2);
    expect(star.startsWith("M ")).toBe(true);
    expect(star.endsWith("Z")).toBe(true);
  });
});

describe("source pins: a11y, reduced motion, deps, engine", () => {
  it("the mascot is decorative: a11y-hidden, never a touch target", () => {
    expect(mascotView).toContain('importantForAccessibility="no-hide-descendants"');
    expect(mascotView).toContain("accessibilityElementsHidden");
    expect(mascotView).toContain('pointerEvents="none"');
    // No pressable/onPress anywhere in the mascot view.
    expect(mascotView).not.toMatch(/onPress|Pressable/);
  });

  it("reduced motion renders static: every animated view gates on animationsEnabled", () => {
    expect(mascotView).toContain("if (!animationsEnabled)");
    expect(badgeBloom).toContain("if (!animationsEnabled) return;");
    expect(keyCeremony).toContain("animationsEnabled ? 0.5 : 1");
  });

  it("ceremonies compose the mascot + blooms (gate screens)", () => {
    expect(keyCeremony).toContain("MascotView");
    expect(keyCeremony).toContain("BadgeBloomView");
    expect(src("apps/mobile/src/gate/GateRunnerScreen.tsx")).toContain("ceremonyBadges");
  });

  it("mascot mounted on journey, practice, and game screens", () => {
    expect(journeyScreen).toContain('testID="journey-mascot"');
    expect(runnerScreen).toContain('testID="practice-mascot"');
    expect(gameScreen).toContain('testID="game-mascot"');
  });

  it("mastery bloom + registry celebration line wired into the runner", () => {
    expect(runnerScreen).toContain("planCelebrationMoments");
    expect(runnerScreen).toContain("celebrationLineForTopic");
    expect(runnerScreen).toContain('line: "celebration"');
    expect(runnerScreen).toContain('testID="practice-celebration"');
    expect(gameScreen).toContain("celebrationLineForTopic");
  });

  it("heart-loss reframe react uses the gentle bounce (positive framing)", () => {
    expect(runnerScreen).toContain(
      'fireMascot({ type: isCorrect ? "answer-correct" : "answer-gentle-retry" })',
    );
    expect(gameScreen).toContain("answer-gentle-retry");
    const machine = src("apps/mobile/src/mascot/mascotMachine.ts");
    expect(machine).toContain('"answer-gentle-retry": "gentle_bounce_back"');
  });

  it("zero new native deps: no rive/lottie in the mobile manifest", () => {
    expect(mobilePackageJson).not.toMatch(/rive|lottie/i);
  });

  it("mascot pure modules import neither react-native nor core-engine", () => {
    for (const file of [
      "apps/mobile/src/mascot/mascotMachine.ts",
      "apps/mobile/src/mascot/celebrationEvents.ts",
      "apps/mobile/src/mascot/celebrationLines.ts",
      "apps/mobile/src/mascot/mascotArt.ts",
    ]) {
      const contents = src(file);
      // Import statements only (comments may name the platforms).
      const imports = contents.match(/from "[^"]+"/g) ?? [];
      for (const specifier of imports) {
        expect(specifier).not.toContain("react-native");
        expect(specifier).not.toContain("@balashikshana/core-engine");
      }
    }
  });

  it("core-engine package untouched by the mascot layer (no mascot imports there)", () => {
    const engineIndex = readFileSync(join(repoRoot, "packages/core-engine/src/index.mjs"), "utf8");
    expect(engineIndex).not.toMatch(/mascot|celebration/i);
  });

  it("no PII in celebration content: no student/name interpolation in the mascot tree", () => {
    for (const file of [
      "apps/mobile/src/mascot/CelebrationStack.tsx",
      "apps/mobile/src/mascot/celebrationEvents.ts",
      "apps/mobile/src/mascot/celebrationLines.ts",
    ]) {
      const contents = src(file);
      expect(contents).not.toMatch(/studentId|studentName|childName/);
    }
  });

  it("CI runs the animation asset budget gate", () => {
    const workflow = src(".github/workflows/ci.yml");
    expect(workflow).toContain("check-animation-assets.mjs");
  });
});

describe("tester gap pins: screen-level suppression, lifecycle, seams", () => {
  it("game-goal-met celebration is suppressed on a hearts-empty end (the reframe owns it)", () => {
    expect(gameScreen).toContain("summary.metGoal && !heartsEmpty");
  });

  it("the runner blooms FIRST mastery only (passedTopic AND completed === 1)", () => {
    expect(runnerScreen).toContain("summary.passedTopic && summary.topicProgress.completed === 1");
  });

  it("the gold ceremony sources badges from the verification summary, falling back to the gate's", () => {
    const gate = src("apps/mobile/src/gate/GateRunnerScreen.tsx");
    expect(gate).toContain("state.verification?.celebration?.badgesAwarded");
    expect(gate).toContain("state.gateSummary?.celebration.badgesAwarded");
  });

  it("every mascot mount threads the live motion profile (reduced-motion honored at every surface)", () => {
    for (const file of [
      "apps/mobile/src/journey/JourneyScreen.tsx",
      "apps/mobile/src/runner/PracticeRunnerScreen.tsx",
      "apps/mobile/src/games/GameSessionScreen.tsx",
    ]) {
      expect(src(file)).toContain("animationsEnabled={motion.animationsEnabled}");
    }
    // The celebration stack threads the flag to the mascot + blooms.
    const stack = src("apps/mobile/src/mascot/CelebrationStack.tsx");
    expect(stack).toContain("animationsEnabled={animationsEnabled}");
  });

  it("BadgeBloomView is the accessible text-redundant element (label + visible title)", () => {
    expect(badgeBloom).toContain("accessibilityLabel=");
    expect(badgeBloom).toContain("{badge.title}");
    const stack = src("apps/mobile/src/mascot/CelebrationStack.tsx");
    expect(stack).toContain('accessibilityRole="header"');
    expect(stack).toContain("accessibilityLabel={leadCopy.a11yLabel}");
  });

  it("useMascot ticks only while a transient pose is live and always cleans up", () => {
    const hook = src("apps/mobile/src/mascot/useMascot.ts");
    expect(hook).toContain("if (state.expiresAtMs === null) return;");
    expect(hook).toContain("clearInterval(timer)");
  });

  it("hint-shown has a live producer (#59 hint narration); snap-confirm stays vocabulary-only", () => {
    // #59 lit the dormant producer: the runner's guided-hint affordance
    // fires hint-shown when it speaks the registry hint line. snap-confirm
    // deliberately has NO dispatcher (it shares the correct-answer pose
    // — the #58 decision, still true).
    const hintProducers = [
      runnerScreen,
      gameScreen,
      src("apps/mobile/src/gate/GateRunnerScreen.tsx"),
      src("apps/mobile/src/journey/JourneyScreen.tsx"),
    ].filter((contents) => contents.includes('type: "hint-shown"'));
    expect(hintProducers).toEqual([runnerScreen]);

    const snapProducers = [
      runnerScreen,
      gameScreen,
      src("apps/mobile/src/gate/GateRunnerScreen.tsx"),
      src("apps/mobile/src/journey/JourneyScreen.tsx"),
    ].filter((contents) => contents.includes('type: "snap-confirm"'));
    expect(snapProducers).toEqual([]);
  });

  it("the animation budget check passes on the real tree (spawn)", async () => {
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(
      process.execPath,
      [join(repoRoot, "scripts/check-animation-assets.mjs")],
      {
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("animation asset budget check passed");
  });
});
