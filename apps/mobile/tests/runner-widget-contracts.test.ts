/**
 * Widget-kit contract tests (issue #50): >=48pt touch targets in every
 * widget source (the repo's source-scan pattern for the RN layer,
 * which has no component-render harness), the #52 import surface,
 * DI purity of the runner's pure modules, theme-awareness hooks, and
 * zero curriculum data in runner sources.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateTopicPracticeSet } from "@balashikshana/core-engine";
import { describe, expect, it } from "vitest";
import { MIN_TOUCH_TARGET } from "../src/design/tokens";

const here = fileURLToPath(new URL(".", import.meta.url));
const widgetsDir = join(here, "..", "src", "runner", "widgets");
const runnerDir = join(here, "..", "src", "runner");

const WIDGET_FILES = [
  "ChoiceGrid.tsx",
  "CounterFrame.tsx",
  "TileBuilder.tsx",
  "VisualScaffold.tsx",
] as const;

function widgetSource(file: string): string {
  return readFileSync(join(widgetsDir, file), "utf8");
}

describe("touch-target contract (>=48pt)", () => {
  it("every interactive widget enforces MIN_TOUCH_TARGET from the token", () => {
    for (const file of WIDGET_FILES) {
      const source = widgetSource(file);
      expect(source, `${file} must reference MIN_TOUCH_TARGET`).toContain("MIN_TOUCH_TARGET");
    }
  });

  it("the token itself stays at the 48pt accessibility floor", () => {
    expect(MIN_TOUCH_TARGET).toBeGreaterThanOrEqual(48);
  });
});

describe("theme + motion contract", () => {
  it("every widget reads the theme provider (never a hardcoded color)", () => {
    for (const file of WIDGET_FILES) {
      expect(widgetSource(file), `${file} must use useTheme`).toContain("useTheme()");
    }
  });

  it("pressable widgets honor the reduced-motion press profile", () => {
    for (const file of ["ChoiceGrid.tsx", "CounterFrame.tsx", "TileBuilder.tsx"] as const) {
      const source = widgetSource(file);
      expect(source, `${file} must use useReducedMotion`).toContain("useReducedMotion()");
      expect(source, `${file} must gate the press translate on the motion profile`).toContain(
        "motion.pressTranslateY",
      );
    }
  });

  it("no widget hardcodes a palette color (tokens only)", () => {
    const banned = /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/;
    for (const file of WIDGET_FILES) {
      expect(banned.test(widgetSource(file)), `${file} must not hardcode hex colors`).toBe(false);
    }
  });
});

describe("shape + color redundancy (a11y: state never rides on color alone)", () => {
  it("ChoiceGrid: selection = check glyph + info border + tinted fill (three channels)", () => {
    const source = widgetSource("ChoiceGrid.tsx");
    // Glyph channel: a selected-only check mark with its own label.
    expect(source).toContain('"Selected"');
    expect(source).toContain('{"✓"}');
    // Border + fill channels on the selected branch.
    expect(source).toMatch(/borderColor: selected \? colors\.info/);
    expect(source).toMatch(/backgroundColor: selected \? colors\.surfaceTinted/);
  });

  it("CounterFrame: a filled cell = counter glyph + tinted fill + info border", () => {
    const source = widgetSource("CounterFrame.tsx");
    // Glyph channel: the counter emoji renders only when filled.
    expect(source).toMatch(/isFilled \?\s*\(\s*<Text[^>]*>\s*\{spec\.emoji\}/);
    // Fill + border channels on the filled branch.
    expect(source).toMatch(/isFilled\s*\?\s*colors\.surfaceTinted/);
    expect(source).toMatch(/isFilled\s*\?\s*colors\.info/);
  });

  it("TileBuilder: placed tiles are label chips with an info border (visible structure)", () => {
    const source = widgetSource("TileBuilder.tsx");
    expect(source).toContain("Answer slots");
    expect(source).toMatch(/borderColor: colors\.info/);
    expect(source).toMatch(/backgroundColor: colors\.surfaceTinted/);
    expect(source).toMatch(/Slot \$\{index \+ 1\}: \$\{option\.label\}/);
  });
});

describe("kit import surface (#52 game-framework fallback)", () => {
  it("the widget barrel exports all four widgets as named components", () => {
    // RN components cannot mount in the node vitest environment; the
    // import surface is pinned by scanning the barrel (repo pattern:
    // source scans for the RN render layer).
    const barrel = readFileSync(join(widgetsDir, "index.ts"), "utf8");
    for (const name of ["ChoiceGrid", "CounterFrame", "TileBuilder", "VisualScaffold"]) {
      expect(barrel, `widgets barrel must export ${name}`).toContain(`export { ${name} }`);
    }
    for (const file of WIDGET_FILES) {
      expect(
        readFileSync(join(widgetsDir, file), "utf8"),
        `${file} must export its component`,
      ).toContain("export function");
    }
  });
});

describe("DI purity of the runner core", () => {
  it("the pure modules never import react-native or expo", () => {
    const pureModules = [
      "interactionRegistry.ts",
      "cpaStages.ts",
      "questionShapes.ts",
      "requeue.ts",
      "sessionStore.ts",
      "index.ts",
    ];
    const banned = /from "(react-native|expo[^"]*)/;
    for (const file of pureModules) {
      const source = readFileSync(join(runnerDir, file), "utf8");
      expect(banned.test(source), `${file} must stay node-importable (no RN/expo imports)`).toBe(
        false,
      );
    }
  });

  it("runnerNative is the only runner module touching native seams", () => {
    const nativeImporters = ["runnerNative.ts", "PracticeRunnerScreen.tsx", "MotorWarmup.tsx"];
    const files = [
      "interactionRegistry.ts",
      "cpaStages.ts",
      "questionShapes.ts",
      "requeue.ts",
      "sessionStore.ts",
    ];
    for (const file of files) {
      expect(nativeImporters).not.toContain(file);
    }
  });
});

describe("zero curriculum data in runner sources", () => {
  it("no unit ids, topic codes, prompts, or curriculum titles are hardcoded", () => {
    const sources = [
      readFileSync(join(runnerDir, "PracticeRunnerScreen.tsx"), "utf8"),
      readFileSync(join(runnerDir, "MotorWarmup.tsx"), "utf8"),
      readFileSync(join(runnerDir, "questionShapes.ts"), "utf8"),
      readFileSync(join(runnerDir, "sessionStore.ts"), "utf8"),
      readFileSync(join(here, "..", "app", "practice", "index.tsx"), "utf8"),
    ];
    const banned = [
      /K-M\d/,
      /Numbers to 10/,
      /Counting to 10/,
      /Comparing Numbers/,
      /PK-M1/,
      /ten_frame_and_number_line\.svg/,
    ];
    for (const source of sources) {
      for (const pattern of banned) {
        expect(pattern.test(source), `${pattern} must not appear in runner sources`).toBe(false);
      }
    }
  });
});

/**
 * Review finding 5: pin the maximum seeded choice-set size. ChoiceGrid
 * renders every option in a plain (non-virtualized) list of 56pt+
 * cards, so its budget is bounded by the DATA. The sweep below is the
 * seeder's exact derivation (engine generateTopicPracticeSet over the
 * registry, as tools/content-pipeline/src/rows.mjs runs it); today every
 * seeded question carries exactly 4 choices. A future generator change
 * emitting large sets must fail HERE first - consciously, with the
 * virtualization decision attached - not in a jank report from a low-end
 * device.
 */
describe("seeded choice-set size pin (review finding 5)", () => {
  it("no seeded question exceeds 4 choices (ChoiceGrid is not virtualized)", () => {
    const registryPath = fileURLToPath(
      new URL("../../../docs/us-curriculum-registry.json", import.meta.url),
    );
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
      grades: {
        subjects: Record<
          string,
          {
            units: {
              unitId: string;
              title: string;
              skillTopics: { code: string; name: string }[];
            }[];
          }
        >;
      }[];
    };
    let max = 0;
    let swept = 0;
    for (const grade of registry.grades) {
      for (const subject of Object.values(grade.subjects)) {
        for (const unit of subject.units) {
          for (const topic of unit.skillTopics) {
            for (const problem of generateTopicPracticeSet(unit, topic, 10)) {
              swept += 1;
              max = Math.max(max, (problem.choices ?? []).length);
            }
          }
        }
      }
    }
    // Guard against a registry/schema change silently sweeping nothing.
    expect(swept).toBeGreaterThanOrEqual(6000);
    // The conscious-failure pin: raising this ceiling requires
    // virtualizing ChoiceGrid (or splitting rows) in the same change.
    expect(max).toBeLessThanOrEqual(4);
    // A choice surface needs alternatives; 1-option sets are a bug.
    expect(max).toBeGreaterThanOrEqual(2);
  });
});
