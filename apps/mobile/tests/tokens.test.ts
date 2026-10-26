/**
 * Design-token invariants. These tests ARE the design system's a11y
 * enforcement: if a token change breaks a touch-target floor or a
 * contrast policy, CI fails here.
 */
import { describe, expect, it } from "vitest";
import {
  controlHeights,
  MIN_TOUCH_TARGET,
  spacing,
  themes,
  typeRamp,
  type ThemeMode,
} from "../src/design/tokens";

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

const HEX = /^#[0-9a-fA-F]{6}$/;

describe("touch targets", () => {
  it("minimum touch target is at least 48pt", () => {
    expect(MIN_TOUCH_TARGET).toBeGreaterThanOrEqual(48);
  });

  it("every control height meets the 48pt minimum", () => {
    for (const [name, height] of Object.entries(controlHeights)) {
      expect(height, `controlHeights.${name}`).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET);
    }
  });

  it("spacing scale includes a 48pt rhythm step for roomy kid layouts", () => {
    expect(Object.values(spacing)).toContain(48);
  });
});

describe("type ramp (kid scale)", () => {
  it("kid-facing body text is at least 18pt", () => {
    expect(typeRamp.body.fontSize).toBeGreaterThanOrEqual(18);
  });

  it("captions stay at least 13pt (parent-facing helper text)", () => {
    expect(typeRamp.caption.fontSize).toBeGreaterThanOrEqual(13);
  });

  it("display size leads the ramp at 40pt or more", () => {
    expect(typeRamp.display.fontSize).toBeGreaterThanOrEqual(40);
  });

  it("every role has lineHeight >= fontSize", () => {
    for (const [role, style] of Object.entries(typeRamp)) {
      expect(style.lineHeight, `typeRamp.${role}`).toBeGreaterThanOrEqual(style.fontSize);
    }
  });
});

describe("themes", () => {
  const modes = Object.keys(themes) as ThemeMode[];

  it("exposes light, dark, and highContrast variants", () => {
    expect(modes.sort()).toEqual(["dark", "highContrast", "light"]);
  });

  it("all themes expose the same semantic keys", () => {
    const reference = Object.keys(themes.light!).sort();
    for (const mode of modes) {
      expect(Object.keys(themes[mode]!).sort(), mode).toEqual(reference);
    }
  });

  it("every solid token is a #RRGGBB hex value", () => {
    for (const mode of modes) {
      for (const [key, value] of Object.entries(themes[mode]!)) {
        if (typeof value === "string" && !value.startsWith("rgba")) {
          expect(value, `${mode}.${key}`).toMatch(HEX);
        }
      }
    }
  });

  it("body/reading text reaches 4.5:1 on background and surface in every theme", () => {
    for (const mode of modes) {
      const t = themes[mode]!;
      expect(contrast(t.text, t.background), `${mode} text/background`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(t.text, t.surface), `${mode} text/surface`).toBeGreaterThanOrEqual(4.5);
      expect(
        contrast(t.textMuted, t.background),
        `${mode} textMuted/background`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("high-contrast labels reach 4.5:1 on their fills (accessibility escape hatch)", () => {
    const hc = themes.highContrast!;
    for (const action of [hc.primary, hc.secondary, hc.gold, hc.danger]) {
      expect(contrast(action.label, action.fill)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("playful themes keep brand fills at >= 2:1 for labels (documented brand-locked policy)", () => {
    for (const mode of ["light", "dark"] as ThemeMode[]) {
      const t = themes[mode]!;
      for (const action of [t.primary, t.secondary, t.danger]) {
        expect(contrast(action.label, action.fill), `${mode} label/fill`).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("gold fills always pair with dark ink (the web-harness precedent) at >= 4.5:1", () => {
    for (const mode of modes) {
      const action = themes[mode]!.gold;
      expect(contrast(action.label, action.fill), `${mode} gold`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("status ink labels reach 4.5:1 on the surface for every tone in every theme", () => {
    for (const mode of modes) {
      const t = themes[mode]!;
      for (const tone of Object.keys(t.statusInk) as (keyof typeof t.statusInk)[]) {
        expect(
          contrast(t.statusInk[tone]!, t.surface),
          `${mode} statusInk.${tone}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
