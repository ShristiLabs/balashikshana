/**
 * Balashikshana design tokens - the single source of truth for type,
 * spacing, color, radius, and touch-target sizing across the native app.
 *
 * This module is PURE DATA: it must never import react-native or any
 * runtime framework. The API server imports nothing from here; the mobile
 * app consumes it via the theme provider, and the vitest suite enforces
 * the accessibility invariants (>=48pt touch targets, contrast floors)
 * directly against these values.
 *
 * The palette carries over the visual language already validated by the
 * static web dev harness (apps/mobile/public/index.html): bright tactile
 * fills over a light surface, chunky rounded corners, and dark ink used
 * on bright yellow fills (the gold-button precedent).
 *
 * Contrast policy (encoded in tests/tokens.test.ts):
 * - Body/reading text pairs must reach >= 4.5:1 in EVERY theme.
 * - Interactive labels in the highContrast theme must reach >= 4.5:1.
 * - Interactive labels in the playful light/dark themes follow the
 *   validated brand look (white on bright fills), asserted at >= 2.0:1;
 *   users who need stronger contrast switch to the highContrast theme,
 *   which is the accessibility escape hatch required by WCAG 1.4.3.
 */

export const MIN_TOUCH_TARGET = 48;

/** Raw brand palette (web-harness vocabulary). Screens never consume these. */
export const palette = {
  green: "#58CC02",
  greenDark: "#46A302",
  greenBg: "#D7FFB8",
  greenInk: "#173A00",
  blue: "#1CB0F6",
  blueDark: "#1899D6",
  blueBg: "#DDF4FF",
  blueInk: "#0A3D5C",
  gold: "#FFC800",
  goldDark: "#E5B400",
  goldInk: "#5C4500",
  purple: "#CE82FF",
  purpleDark: "#A568CC",
  coral: "#FF4B4B",
  coralDark: "#EA2B2B",
  coralBg: "#FFE3E3",
  coralInk: "#7A0C0C",
  orange: "#FF9600",
  orangeDark: "#CC7800",
  gray: "#E5E5E5",
  grayDark: "#AFAFAF",
  grayLocked: "#CFCFCF",
  ink: "#3C3C3C",
  inkMuted: "#6F6F6F",
  inkStrong: "#1A1A1A",
  orangeInk: "#6B3F00",
  white: "#FFFFFF",
  paper: "#FFFDF7",
  nightBg: "#14211F",
  nightSurface: "#1C2B28",
  nightSurfaceAlt: "#243733",
  nightBorder: "#3A524C",
  nightText: "#ECF7F2",
  nightMuted: "#9FB8B0",
  nightGreen: "#7CE31B",
  nightCoral: "#FF8A8A",
  scrim: "rgba(0, 0, 0, 0.45)",
} as const;

export type Palette = typeof palette;

/**
 * A tactile action token: bright fill plus a hard bottom edge (the
 * "pressable 3D" treatment), with a label color that is safe on the fill.
 */
export interface ActionToken {
  fill: string;
  fillBottom: string;
  label: string;
}

/**
 * Text-grade status colors: safe for small label text (>= 4.5:1 on the
 * theme's surface). Saturated status colors (success/warning/info and
 * danger fills) stay on borders and fills - never small text.
 */
export interface StatusInk {
  success: string;
  warning: string;
  info: string;
  danger: string;
}

export interface ThemeColors {
  background: string;
  surface: string;
  surfaceAlt: string;
  surfaceTinted: string;
  border: string;
  text: string;
  textMuted: string;
  primary: ActionToken;
  secondary: ActionToken;
  gold: ActionToken;
  danger: ActionToken;
  success: string;
  warning: string;
  info: string;
  statusInk: StatusInk;
  focusRing: string;
  scrim: string;
  disabledFill: string;
  disabledLabel: string;
  progressTrack: string;
  progressFill: string;
  journeyLocked: string;
}

export type ThemeMode = "light" | "dark" | "highContrast";

/** Playful default theme (validated web-harness look). */
const light: ThemeColors = {
  background: palette.paper,
  surface: palette.white,
  surfaceAlt: "#F7F7F7",
  surfaceTinted: palette.blueBg,
  border: palette.gray,
  text: palette.ink,
  textMuted: palette.inkMuted,
  primary: { fill: palette.green, fillBottom: palette.greenDark, label: palette.white },
  secondary: { fill: palette.blue, fillBottom: palette.blueDark, label: palette.white },
  gold: { fill: palette.gold, fillBottom: palette.goldDark, label: palette.goldInk },
  danger: { fill: palette.coral, fillBottom: palette.coralDark, label: palette.white },
  success: palette.green,
  warning: palette.orange,
  info: palette.blue,
  statusInk: {
    success: palette.greenInk,
    warning: palette.orangeInk,
    info: palette.blueInk,
    danger: palette.coralInk,
  },
  focusRing: palette.blue,
  scrim: palette.scrim,
  disabledFill: palette.gray,
  disabledLabel: palette.grayDark,
  progressTrack: palette.gray,
  progressFill: palette.green,
  journeyLocked: palette.grayLocked,
};

/** Dark theme: deep green-tinted surfaces, bright brand accents. */
const dark: ThemeColors = {
  background: palette.nightBg,
  surface: palette.nightSurface,
  surfaceAlt: palette.nightSurfaceAlt,
  surfaceTinted: "#12333F",
  border: palette.nightBorder,
  text: palette.nightText,
  textMuted: palette.nightMuted,
  primary: { fill: palette.green, fillBottom: palette.greenDark, label: palette.white },
  secondary: { fill: palette.blue, fillBottom: palette.blueDark, label: palette.white },
  gold: { fill: palette.gold, fillBottom: palette.goldDark, label: palette.goldInk },
  danger: { fill: palette.coral, fillBottom: palette.coralDark, label: palette.white },
  success: palette.nightGreen,
  warning: palette.orange,
  info: "#84D8FF",
  statusInk: {
    success: palette.nightGreen,
    warning: palette.orange,
    info: "#84D8FF",
    danger: palette.nightCoral,
  },
  focusRing: "#84D8FF",
  scrim: "rgba(0, 0, 0, 0.65)",
  disabledFill: palette.nightSurfaceAlt,
  disabledLabel: palette.nightMuted,
  progressTrack: palette.nightSurfaceAlt,
  progressFill: palette.nightGreen,
  journeyLocked: palette.nightBorder,
};

/**
 * High-contrast accessibility theme: dark ink on tinted light fills with
 * >= 4.5:1 on every interactive label pair. This is the contrast escape
 * hatch; it deliberately trades the bright brand look for legibility.
 */
const highContrast: ThemeColors = {
  background: palette.white,
  surface: palette.white,
  surfaceAlt: "#EFEFEF",
  surfaceTinted: palette.blueBg,
  border: palette.inkStrong,
  text: palette.inkStrong,
  textMuted: "#444444",
  primary: { fill: palette.greenBg, fillBottom: palette.greenInk, label: palette.greenInk },
  secondary: { fill: palette.blueBg, fillBottom: palette.blueInk, label: palette.blueInk },
  gold: { fill: palette.gold, fillBottom: palette.goldInk, label: palette.goldInk },
  danger: { fill: palette.coralBg, fillBottom: palette.coralInk, label: palette.coralInk },
  success: palette.greenInk,
  warning: palette.orangeInk,
  info: palette.blueInk,
  statusInk: {
    success: palette.greenInk,
    warning: palette.orangeInk,
    info: palette.blueInk,
    danger: palette.coralInk,
  },
  focusRing: palette.blue,
  scrim: "rgba(0, 0, 0, 0.7)",
  disabledFill: palette.gray,
  disabledLabel: "#5A5A5A",
  progressTrack: palette.gray,
  progressFill: palette.greenInk,
  journeyLocked: palette.grayDark,
};

export const themes: Record<ThemeMode, ThemeColors> = { light, dark, highContrast };

/** Spacing scale (logical points). */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 48,
} as const;

/** Corner radius scale (continuous-curve feel comes from RN borderCurve). */
export const radius = {
  sm: 12,
  md: 16,
  lg: 20,
  xl: 28,
  pill: 999,
} as const;

/**
 * Kid-scale type ramp: reading sizes run large (adult body text is not
 * kid body text), headings are extra-black. Kid-facing body >= 18pt;
 * captions are reserved for parent-facing helper text.
 */
export const typeRamp = {
  display: { fontSize: 40, fontWeight: "900", lineHeight: 48 },
  h1: { fontSize: 32, fontWeight: "900", lineHeight: 38 },
  h2: { fontSize: 26, fontWeight: "900", lineHeight: 32 },
  h3: { fontSize: 22, fontWeight: "800", lineHeight: 28 },
  title: { fontSize: 20, fontWeight: "800", lineHeight: 26 },
  body: { fontSize: 18, fontWeight: "700", lineHeight: 24 },
  bodyMuted: { fontSize: 17, fontWeight: "600", lineHeight: 23 },
  label: { fontSize: 15, fontWeight: "800", lineHeight: 20, letterSpacing: 0.6 },
  caption: { fontSize: 13, fontWeight: "700", lineHeight: 17 },
} as const;

export type TypeRole = keyof typeof typeRamp;

/**
 * Control heights. Every interactive control must measure at least
 * MIN_TOUCH_TARGET in both dimensions; the scale starts there and grows.
 */
export const controlHeights = {
  sm: MIN_TOUCH_TARGET,
  md: 56,
  lg: 64,
} as const;

/** Journey-map node bubble (74x68 in the web harness, rounded to 72x68). */
export const nodeSize = { width: 72, height: 68 } as const;

/**
 * Tactile press treatment: resting hard bottom edge of borderRest points,
 * collapsing to borderPressed with a translate on press. When the OS
 * reduced-motion setting is on, the translate is suppressed (see
 * motion.ts) and only the edge collapse remains.
 */
export const tactile = {
  borderRest: 5,
  borderPressed: 1,
  pressTranslateY: 3,
} as const;

/** Focus indication width for keyboard/switch-access users. */
export const focusRingWidth = 3;
