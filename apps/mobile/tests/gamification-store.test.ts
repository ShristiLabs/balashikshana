/**
 * Gamification store + surfacing (issue #55): the pure reducer behind
 * the kid-facing strip, and source pins for the display layer's kid-safety
 * posture (design tokens only — no hardcoded hex; no emoji; static
 * layout — reduced-motion safe by construction; a11y labels carry the
 * full state in text).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  gamificationReducer,
  initialGamificationStoreState,
} from "../src/gamification/gamificationStore";
import { initialGamificationState } from "../src/gamification/rewardsProjector";
import type { GamificationState } from "../src/gamification/types";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const stripSource = readFileSync(
  `${repoRoot}/apps/mobile/src/gamification/GamificationHeaderStrip.tsx`,
  "utf-8",
);
const hookSource = readFileSync(
  `${repoRoot}/apps/mobile/src/gamification/useGamificationSummary.ts`,
  "utf-8",
);

function stateFixture(overrides: Partial<GamificationState> = {}): GamificationState {
  return { ...initialGamificationState("s1", 0), totalXp: 175, ...overrides };
}

describe("gamificationReducer (pure)", () => {
  it("starts empty and loads a state into a ready summary", () => {
    const initial = initialGamificationStoreState();
    expect(initial.status).toBe("empty");
    const loaded = gamificationReducer(initial, { type: "state-loaded", state: stateFixture() });
    expect(loaded.status).toBe("ready");
    expect(loaded.summary?.level).toBe(3); // 175 XP -> level 3 (floor 150)
    expect(loaded.version).toBe(1);
  });

  it("ledger adoption confirms values, bumps the version, and keeps the student binding", () => {
    const loaded = gamificationReducer(initialGamificationStoreState(), {
      type: "state-loaded",
      state: stateFixture(),
    });
    const adopted = gamificationReducer(loaded, {
      type: "ledger-adopted",
      ledger: {
        studentId: "s1",
        totalXp: 49,
        level: {
          level: 2,
          maxLevel: 50,
          maxed: false,
          levelFloorXp: 50,
          nextLevelXp: 150,
          xpIntoLevel: 0,
          xpToNextLevel: 101,
        },
        starCoins: 80,
        streakDays: 1,
        bestBeatTargetPct: 0,
        badges: [
          {
            id: "first-steps",
            title: "First Steps",
            description: null,
            tier: "bronze",
            scope: "global",
            awardedAt: "2026-10-23T00:00:00Z",
          },
        ],
        generatedAt: "2026-10-23T00:00:00Z",
      },
      nowMs: 10,
    });
    expect(adopted.state?.totalXp).toBe(49);
    expect(adopted.state?.provisional).toBe(false);
    expect(adopted.version).toBe(2);
    // A ledger for a DIFFERENT student never lands.
    const foreign = gamificationReducer(adopted, {
      type: "ledger-adopted",
      ledger: {
        studentId: "someone-else",
        totalXp: 999,
        level: {
          level: 9,
          maxLevel: 50,
          maxed: false,
          levelFloorXp: 0,
          nextLevelXp: 1,
          xpIntoLevel: 0,
          xpToNextLevel: 1,
        },
        starCoins: 0,
        streakDays: 0,
        bestBeatTargetPct: 0,
        badges: [],
        generatedAt: "2026-10-23T00:00:00Z",
      },
      nowMs: 11,
    });
    expect(foreign.state?.totalXp).toBe(49);
    expect(foreign.version).toBe(2);
  });

  it("reset clears everything", () => {
    const loaded = gamificationReducer(initialGamificationStoreState(), {
      type: "state-loaded",
      state: stateFixture(),
    });
    expect(gamificationReducer(loaded, { type: "reset" })).toEqual(initialGamificationStoreState());
  });
});

describe("surfacing source pins (kid-facing display layer)", () => {
  it("the strip uses design tokens only (no hardcoded hex, no emoji, no animation)", () => {
    expect(stripSource).toContain("useTheme");
    expect(stripSource).not.toMatch(/#[0-9A-Fa-f]{6}/);
    // No emoji anywhere in the display layer (COPPA house style).
    expect(stripSource).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    // Static by construction: no Animated/reanimated import.
    expect(stripSource).not.toContain("react-native-reanimated");
    expect(stripSource).not.toContain("Animated");
  });

  it("the strip states every value in text (a11y: labels + visible text-with-color)", () => {
    expect(stripSource).toContain("accessibilityLabel");
    expect(stripSource).toContain("Coins");
    expect(stripSource).toContain("Day streak");
    expect(stripSource).toContain("Badges");
  });

  it("the hook swallows ledger failures (provisional stands; a kid never sees an error)", () => {
    expect(hookSource).toContain("catch");
    expect(hookSource).toContain("provisional");
  });
});
