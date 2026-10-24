/**
 * Ceremony machine + gate-surface RN contracts (issue #51): the pure
 * ceremony state machine and copy, plus the repo's source-scan pins —
 * reduced-motion safety (no load-bearing animation), abandon-on-error
 * liveness in every error path, offline-first (zero network in the
 * gate tree), DI doctrine (native seams isolated to gateNative), the
 * 48pt target bar, and interaction rendering via the #50 renderPlanFor
 * matrix (no hardcoded interaction types).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ceremonyCopy, initialCeremony, ceremonyReducer } from "../src/gate/ceremony";

const src = (relative: string): string =>
  readFileSync(join(fileURLToPath(new URL("..", import.meta.url)), relative), "utf-8");

const screen = src("src/gate/GateRunnerScreen.tsx");
const ceremony = src("src/gate/KeyCeremony.tsx");
const results = src("src/gate/GateResultsView.tsx");
const questionBody = src("src/runner/QuestionBody.tsx");
const gateRoute = src("app/gate/index.tsx");

describe("ceremony machine", () => {
  it("reduced motion reveals instantly; animation builds then reveals", () => {
    expect(initialCeremony("silver", false).phase).toBe("revealed");
    const animated = initialCeremony("gold", true);
    expect(animated.phase).toBe("building");
    expect(ceremonyReducer(animated, "built").phase).toBe("revealed");
    // 'built' after the reveal is a no-op (idempotent).
    expect(ceremonyReducer(ceremonyReducer(animated, "built"), "built").phase).toBe("revealed");
    expect(ceremonyReducer(animated, "dismiss").phase).toBe("dismissed");
  });

  it("copy is gentle, provisional-aware, and key-distinct", () => {
    const silver = ceremonyCopy("silver", true);
    expect(silver.title).toContain("Silver");
    expect(silver.provisionalNote).toContain("Checking");
    expect(ceremonyCopy("silver", false).provisionalNote).toBeNull();
    const gold = ceremonyCopy("gold", true);
    expect(gold.title).toContain("Gold");
    expect(gold.body).not.toContain("Silver");
  });
});

describe("gate-surface source contracts", () => {
  it("the ceremony animation is decorative: reduced motion renders the final state", () => {
    expect(ceremony).toContain("animationsEnabled");
    expect(ceremony).toContain("Animated.spring");
    // The reveal is reachable without any animation timing.
    expect(ceremony).toContain("onDone");
    // Shape+color redundancy: the badge silhouettes come from the
    // journey art (Silver circle / Gold hexagon).
    expect(ceremony).toContain("silverBadge");
    expect(ceremony).toContain("goldBadge");
  });

  it("every gate error path frees sync liveness via abandonSession", () => {
    const abandons = screen.match(/abandonSession\(/g) ?? [];
    expect(abandons.length).toBeGreaterThanOrEqual(3); // submit, complete, exit
    expect(screen).toContain("Abandon BEFORE surfacing");
  });

  it("consumes the reduced-motion provider (ceremony + question flow)", () => {
    expect(screen).toContain("useReducedMotion");
    expect(screen).toContain("motion.animationsEnabled");
  });

  it("the Gold-check budget and anti-guess freeze come from the pinned rules module", () => {
    expect(screen).toContain("GOLD_CHECK_BUDGET_SEC");
    expect(screen).toContain("ANTI_GUESS.freezePenaltySec");
    expect(screen).toContain("isRapidGuessViolation");
    // No literal forks of the pinned values.
    expect(screen).not.toContain("60 * 1000");
    expect(screen).not.toContain("2000");
  });

  it("deadline race guard: a gold-check submit claims the completion guard (review finding 1)", () => {
    // The guard must exist in BOTH the submit path and the deadline
    // completion, so the 500 ms deadline tick can never complete a
    // gold check while an answer's submit is still in flight.
    expect(screen).toContain("guardingDeadline");
    expect(screen).toContain("Deadline race guard");
    const claims = screen.match(/completingRef\.current = true/g) ?? [];
    expect(claims.length).toBeGreaterThanOrEqual(2); // submit guard + completeGoldCheck
  });

  it("offline-first: no network or third-party SDK anywhere in the gate tree", () => {
    for (const source of [screen, ceremony, results, questionBody, gateRoute]) {
      expect(source).not.toContain("fetch(");
      expect(source).not.toContain("XMLHttpRequest");
      expect(source).not.toContain("node:net");
    }
  });

  it("DI doctrine: the native seams live only in gateNative", () => {
    expect(screen).toContain("getGateEngine");
    expect(screen).toContain("getGateAudio");
    for (const source of [results, questionBody]) {
      expect(source).not.toContain("nativePractice");
      expect(source).not.toContain("nativeAudio");
    }
  });

  it("question rendering goes through the #50 renderPlanFor matrix (no type switches)", () => {
    expect(questionBody).toContain("renderPlanFor");
    // The interaction TYPE never drives rendering directly — only the
    // plan's widget kind does (widget kinds are the plan's output).
    expect(questionBody).not.toContain("question.interactionType ===");
    expect(questionBody).not.toContain('case "multiple-choice"');
  });

  it("targets meet the 48pt bar (buttons via the primitive; rows >= 48)", () => {
    expect(screen).toMatch(/minHeight: 48/g);
    expect(results).toContain("minHeight: 48");
    expect(results).toContain("minHeight: 64");
    expect(ceremony).toContain("minHeight: 96");
  });

  it("results are shape+color+text redundant and accessibility-labelled", () => {
    expect(results).toContain("accessibilityLabel");
    expect(results).toContain('"✓"');
    expect(results).toContain('"↺"');
    expect(results).toContain("statusInk.success");
    expect(results).toContain("statusInk.warning");
  });

  it("the route keeps the #44 consent guard and the real runner", () => {
    expect(gateRoute).toContain("childAccessReady");
    expect(gateRoute).toContain("GateRunnerScreen");
    expect(gateRoute).not.toContain("PlaceholderScreen");
  });
});
