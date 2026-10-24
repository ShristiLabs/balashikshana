/**
 * Adversarial design-system invariants: cross-module consistency and
 * drift resistance. These complement tokens.test.ts (policy floors) by
 * catching the failure modes of FUTURE edits - a token renamed or
 * nudged in one module but not its counterpart.
 */
import { describe, expect, it } from "vitest";
import { MOTION_DURATIONS, motionProfileFor } from "../src/design/motion";
import {
  controlHeights,
  MIN_TOUCH_TARGET,
  nodeSize,
  radius,
  spacing,
  tactile,
  themes,
  typeRamp,
} from "../src/design/tokens";

/* WCAG relative-luminance contrast, shared with tokens.test.ts policy. */
function luminance(hex: string): number {
  const c = hex.replace("#", "");
  const channels = [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(channels[0]!) + 0.7152 * lin(channels[1]!) + 0.0722 * lin(channels[2]!);
}

function contrast(a: string, b: string): number {
  const pair = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (pair[0]! + 0.05) / (pair[1]! + 0.05);
}

describe("contrast utility sanity", () => {
  it("scores pure black on white at the 21:1 maximum", () => {
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
  });

  it("scores identical colors at 1:1", () => {
    expect(contrast("#58CC02", "#58cc02")).toBeCloseTo(1, 5);
  });
});

describe("touch-scale drift resistance", () => {
  it("control heights are monotonic sm <= md <= lg", () => {
    expect(controlHeights.sm).toBeLessThanOrEqual(controlHeights.md);
    expect(controlHeights.md).toBeLessThanOrEqual(controlHeights.lg);
  });

  it("journey nodes meet the touch minimum in both dimensions", () => {
    expect(nodeSize.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
    expect(nodeSize.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
  });
});

describe("scales", () => {
  it("spacing scale is strictly increasing and unique", () => {
    const values = Object.values(spacing);
    expect(new Set(values).size).toBe(values.length);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
  });

  it("radius scale is strictly increasing with pill at the top", () => {
    const values = Object.values(radius);
    expect(new Set(values).size).toBe(values.length);
    expect([...values].sort((a, b) => a - b)).toEqual(values);
    expect(radius.pill).toBeGreaterThan(radius.xl);
  });

  it("type ramp exposes exactly the eight designed roles", () => {
    expect(Object.keys(typeRamp).sort()).toEqual([
      "body",
      "bodyMuted",
      "caption",
      "display",
      "h1",
      "h2",
      "h3",
      "label",
      "title",
    ]);
  });
});

describe("tactile treatment and motion agree (single source of truth)", () => {
  it("full-motion press translate equals the tactile token", () => {
    expect(motionProfileFor(false).pressTranslateY).toBe(tactile.pressTranslateY);
  });

  it("full-motion duration equals the named normal duration", () => {
    expect(motionProfileFor(false).durationMs).toBe(MOTION_DURATIONS.normal);
  });

  it("reduced motion zeroes the same translate the tactile token defines", () => {
    expect(motionProfileFor(true).pressTranslateY).toBe(0);
    expect(tactile.pressTranslateY).toBeGreaterThan(0);
  });

  it("press edge collapse stays visible (pressed edge < rest edge)", () => {
    expect(tactile.borderPressed).toBeLessThan(tactile.borderRest);
  });
});

describe("theme structural invariants", () => {
  it("every action edge differs from its fill (visible tactile edge)", () => {
    for (const [mode, theme] of Object.entries(themes)) {
      for (const name of ["primary", "secondary", "gold", "danger"] as const) {
        expect(theme[name].fillBottom, `${mode}.${name}`).not.toBe(theme[name].fill);
      }
    }
  });

  it("muted text is strictly dimmer than primary text in every theme", () => {
    for (const [mode, theme] of Object.entries(themes)) {
      expect(
        contrast(theme.text, theme.background),
        `${mode} text must out-contrast muted`,
      ).toBeGreaterThan(contrast(theme.textMuted, theme.background));
    }
  });

  it("focus ring is distinguishable from background and surface", () => {
    for (const [mode, theme] of Object.entries(themes)) {
      expect(theme.focusRing, `${mode}`).not.toBe(theme.background);
      expect(theme.focusRing, `${mode}`).not.toBe(theme.surface);
    }
  });

  it("scrims are translucent overlays, not opaque colors", () => {
    for (const [mode, theme] of Object.entries(themes)) {
      expect(theme.scrim, `${mode}`).toMatch(/^rgba\(/);
    }
  });

  it("locked journey nodes never read as progress", () => {
    for (const [mode, theme] of Object.entries(themes)) {
      expect(theme.journeyLocked, `${mode}`).not.toBe(theme.progressFill);
    }
  });
});
