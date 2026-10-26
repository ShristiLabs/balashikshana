/**
 * #67 accessibility source pins — the enforcement net for the audit's
 * mobile findings. The Expo app has no component harness (standing
 * debt), so mobile a11y is enforced the way this repo always has:
 * derived-from-source expectations that FAIL when a future edit
 * regresses a covered property (the narration-coverage style).
 *
 * Pins, per the audit report (docs/accessibility-audit.md):
 * 1. EVERY <Pressable across src/ + app/ carries an accessibility
 *    property on its opening element (role/label/hidden). Derived by
 *    scanning the tree — the list is never hand-written, so a new
 *    screen is covered the moment it lands.
 * 2. The decorative mascot subtree stays hidden from accessibility.
 * 3. Every Animated loop/sequence site sits behind the reduced-motion
 *    profile (animationsEnabled guard) — the audit verified all three
 *    animated components; this pin keeps it that way.
 * 4. The screen-reader announcement wiring (#67 fix) stays in place:
 *    both runners announce feedback + question transitions, and the
 *    gate announces Gold-check countdown crossovers.
 *
 * Deterministic by construction: pure fs reads + regex; no RN import.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mobileRoot = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(entry)) out.push(p);
  }
  return out;
}

function read(relative: string): string {
  return readFileSync(join(mobileRoot, relative), "utf8");
}

/** Props window after `<Pressable` — generous enough for multi-line
 *  prop lists, short enough not to leak into the next element. */
const PRESSABLE_PROP_WINDOW = 300;

describe("pin 1: every Pressable exposes an accessibility property", () => {
  it("covers all of src/ and app/ with zero unlabeled interactive elements", () => {
    const files = [...walk(join(mobileRoot, "src")), ...walk(join(mobileRoot, "app"))];
    expect(files.length).toBeGreaterThan(20); // the scan itself must see the app
    const missing: string[] = [];
    let sites = 0;
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const chunk of source.split(/<Pressable\b/).slice(1)) {
        sites += 1;
        const head = chunk.slice(0, PRESSABLE_PROP_WINDOW);
        // Role alone is NOT enough (mutation-tested in #67: a
        // role="button" Pressable with no label announces as a nameless
        // "button"). Require a NAME — an explicit accessibilityLabel —
        // or a decorative hiding property. Every current site labels
        // explicitly; this keeps the convention a invariant.
        const named = /accessibilityLabel=/.test(head);
        const hidden = /accessibilityElementsHidden|importantForAccessibility/.test(head);
        if (!named && !hidden) {
          missing.push(file.replace(mobileRoot, ""));
        }
      }
    }
    // The Button primitive enforces role+label centrally; this pin
    // catches RAW Pressables that bypass it. Audit baseline: 33 sites,
    // all named.
    expect(sites).toBeGreaterThanOrEqual(33);
    expect(missing, `Pressable sites without a name: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("pin 2: the mascot stays decorative (hidden from screen readers)", () => {
  it("hides the entire mascot subtree", () => {
    const source = read("src/mascot/MascotView.tsx");
    expect(source).toContain('importantForAccessibility="no-hide-descendants"');
    expect(source).toContain("accessibilityElementsHidden");
  });
});

describe("pin 3: every animated component honors reduced motion", () => {
  // Two accepted mechanisms (both verified by the #67 audit):
  //  - an `animationsEnabled` guard branch (mascot, badge bloom, key
  //    ceremony skip the Animated call entirely), or
  //  - profile-driven duration — `motion.durationMs`, which the motion
  //    profile collapses to 0 under reduced motion (the Sheet slide).
  const ANIMATED_SITES = [
    "src/mascot/MascotView.tsx",
    "src/mascot/BadgeBloomView.tsx",
    "src/gate/KeyCeremony.tsx",
    "src/design/primitives/Sheet.tsx",
  ];

  it.each(ANIMATED_SITES)("%s honors the reduced-motion profile", (file) => {
    const source = read(file);
    expect(source).toMatch(/Animated\.(loop|sequence|spring|timing)/);
    expect(
      source.includes("!animationsEnabled") || source.includes("motion.durationMs"),
      `${file} must either guard on animationsEnabled or take its duration from motion.durationMs`,
    ).toBe(true);
  });

  it("has no OTHER Animated call sites outside the audited set", () => {
    const files = walk(join(mobileRoot, "src"));
    const animated = files.filter((file) =>
      /Animated\.(loop|sequence|spring|timing|parallel|decay)/.test(readFileSync(file, "utf8")),
    );
    expect(animated.map((file) => file.replace(mobileRoot, "")).sort()).toEqual(
      [...ANIMATED_SITES].sort(),
    );
  });
});

describe("pin 4: screen-reader announcements stay wired (#67 fix)", () => {
  it("the practice runner announces feedback and question transitions", () => {
    const source = read("src/runner/PracticeRunnerScreen.tsx");
    expect(source).toContain("announceForAccessibility");
    expect(source).toContain("practiceFeedbackMessage");
    expect(source).toContain("questionTransitionMessage");
  });

  it("the boss gate announces feedback, question transitions, and countdown crossovers", () => {
    const source = read("src/gate/GateRunnerScreen.tsx");
    expect(source).toContain("announceForAccessibility");
    expect(source).toContain("gateFeedbackMessage");
    expect(source).toContain("questionTransitionMessage");
    expect(source).toContain("timerCrossoverMessage");
  });

  it("the announcement seam is the ONLY react-native import in the a11y tree", () => {
    const source = read("src/a11y/nativeAnnounce.ts");
    expect(source).toContain("AccessibilityInfo.announceForAccessibility");
    // Message builders stay pure (node-testable): no react-native import.
    expect(read("src/a11y/announceMessages.ts")).not.toMatch(/^import .*react-native/m);
  });
});
