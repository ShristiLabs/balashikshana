/**
 * Journey-map art contract (issue #49) — PURE data.
 *
 * Maps every unit state and key state onto (a) a theme token key, (b) a
 * distinct SVG glyph, and (c) accessible labels. The a11y rule from the
 * issue: key/state encoding must be SHAPE+COLOR redundant — never
 * color-only. Each state's glyph path is unique (asserted by test), and
 * Silver vs Gold badges are different SHAPES (circle vs hexagon), so the
 * map reads correctly in the highContrast theme and for color-blind
 * users. No emoji anywhere (repo invariant); all art is SVG geometry.
 */

import type { ThemeColors } from "../design/tokens";
import type { JourneyUnitNode, UnitState } from "./model";

/** Which theme token family fills a node in a given state. */
export type StateToken = "journeyLocked" | "secondary" | "primary" | "gold" | "success" | "danger";

export interface StateArt {
  token: StateToken;
  /** Unique glyph path (SVG d) centered on (0,0) inside a 24x24 box. */
  glyph: string;
  /** Spoken label for the state itself. */
  label: string;
  /** One-line hint for what tapping does. */
  hint: string;
}

const GLYPHS = {
  // Padlock: body + shackle.
  lock: "M -7 2 h 14 v 9 h -14 Z M -4.5 2 v -3.5 a 4.5 4.5 0 0 1 9 0 V 2",
  // Progression dots: 1 (study), 2 (guided), 3 (fluency).
  oneDot: "M 0 -4 a 4 4 0 0 1 0 8 a 4 4 0 0 1 0 -8 Z",
  twoDots:
    "M -6 -4 a 3.2 3.2 0 0 1 0 6.4 a 3.2 3.2 0 0 1 0 -6.4 Z M 6 -4 a 3.2 3.2 0 0 1 0 6.4 a 3.2 3.2 0 0 1 0 -6.4 Z",
  threeDots:
    "M -8.5 -3.5 a 2.8 2.8 0 0 1 0 5.6 a 2.8 2.8 0 0 1 0 -5.6 Z M 0 -3.5 a 2.8 2.8 0 0 1 0 5.6 a 2.8 2.8 0 0 1 0 -5.6 Z M 8.5 -3.5 a 2.8 2.8 0 0 1 0 5.6 a 2.8 2.8 0 0 1 0 -5.6 Z",
  // Boss gate: upward triangle.
  gate: "M 0 -8 L 8.5 7 L -8.5 7 Z",
  // Mastery: five-point star.
  star: "M 0 -9 L 2.6 -2.9 L 9.2 -2.3 L 4.3 2.1 L 5.8 8.6 L 0 5.2 L -5.8 8.6 L -4.3 2.1 L -9.2 -2.3 L -2.6 -2.9 Z",
  // Remediation: two retry slashes.
  retry: "M -8 -6 L -1 6 M 1 -6 L 8 6",
} as const;

export const STATE_ART: Record<UnitState, StateArt> = {
  LOCKED: {
    token: "journeyLocked",
    glyph: GLYPHS.lock,
    label: "Locked",
    hint: "Finish the units before this one to unlock it",
  },
  STUDY_REQUIRED: {
    token: "secondary",
    glyph: GLYPHS.oneDot,
    label: "Ready to study",
    hint: "Start this unit's first topic",
  },
  GUIDED_PRACTICE: {
    token: "secondary",
    glyph: GLYPHS.twoDots,
    label: "In practice",
    hint: "Continue practicing this unit",
  },
  FLUENCY_READY: {
    token: "primary",
    glyph: GLYPHS.threeDots,
    label: "Fluency ready",
    hint: "All topics done. Try the boss gate",
  },
  GATE_UNLOCKED: {
    token: "gold",
    glyph: GLYPHS.gate,
    label: "Boss gate open",
    hint: "Take the unit boss gate",
  },
  MASTERED: {
    token: "success",
    glyph: GLYPHS.star,
    label: "Mastered",
    hint: "Practice again or check your Gold key",
  },
  REMEDIATION_REQUIRED: {
    token: "danger",
    glyph: GLYPHS.retry,
    label: "Needs review",
    hint: "Practice to recover, then retry the gate",
  },
};

/**
 * Resolve a node's fill/bottom/ink from the live theme. Only ActionToken
 * families carry glyph/number ink (the tokens doctrine: saturated fills
 * never carry small surface-colored text except through their label
 * token); the locked gray carries the dark disabled label exactly like
 * the validated harness treatment (#CFCFCF fill / #666 ink).
 */
export function stateColors(
  colors: ThemeColors,
  token: StateToken,
): { fill: string; bottom: string; ink: string } {
  switch (token) {
    case "journeyLocked":
      return {
        fill: colors.journeyLocked,
        bottom: colors.disabledLabel,
        ink: colors.disabledLabel,
      };
    case "secondary":
      return {
        fill: colors.secondary.fill,
        bottom: colors.secondary.fillBottom,
        ink: colors.secondary.label,
      };
    case "primary":
      return {
        fill: colors.primary.fill,
        bottom: colors.primary.fillBottom,
        ink: colors.primary.label,
      };
    case "gold":
      return { fill: colors.gold.fill, bottom: colors.gold.fillBottom, ink: colors.gold.label };
    case "success":
      return {
        fill: colors.primary.fill,
        bottom: colors.primary.fillBottom,
        ink: colors.primary.label,
      };
    case "danger":
      return {
        fill: colors.danger.fill,
        bottom: colors.danger.fillBottom,
        ink: colors.danger.label,
      };
  }
}

// ----------------------------------------------------------------------
// Key badges: Silver = circle, Gold = hexagon (shape redundancy)
// ----------------------------------------------------------------------

export interface KeyBadgeArt {
  /** Badge silhouette as an SVG path centered on (0,0), ~22x22 box. */
  silhouette: string;
  label: string;
  fill: string;
}

const SILVER_SILHOUETTE = "M 0 -9 a 9 9 0 0 1 0 18 a 9 9 0 0 1 0 -18 Z";
const GOLD_HEX_SILHOUETTE = "M 0 -10 L 8.7 -5 L 8.7 5 L 0 10 L -8.7 5 L -8.7 -5 Z";

export function silverBadge(colors: ThemeColors): KeyBadgeArt {
  return {
    silhouette: SILVER_SILHOUETTE,
    label: "Silver key",
    fill: colors.textMuted,
  };
}

export function goldBadge(colors: ThemeColors): KeyBadgeArt {
  return {
    silhouette: GOLD_HEX_SILHOUETTE,
    label: "Gold key",
    fill: colors.warning,
  };
}

/** Human label for the full node: state + key + provisional + countdown. */
export function nodeAccessibilityLabel(node: JourneyUnitNode): string {
  const parts: string[] = [
    `Unit ${node.sequenceOrder}: ${node.title}. ${STATE_ART[node.state].label}`,
  ];
  if (node.keyState === "SILVER_KEY") parts.push("Silver key earned");
  if (node.keyState === "GOLD_KEY") parts.push("Gold key earned");
  if (node.provisional) parts.push("Waiting for server check");
  if (node.keyState === "SILVER_KEY" && node.goldCountdownMs > 0) {
    parts.push(`Gold check unlocks in ${formatCountdown(node.goldCountdownMs)}`);
  } else if (node.goldEligible) {
    parts.push("Gold check ready");
  }
  if (node.totalTopics > 0) {
    parts.push(`${node.completedTopics} of ${node.totalTopics} topics done`);
  }
  if (node.isCurrent) parts.push("You are here");
  return `${parts.join(". ")}.`;
}

export function formatCountdown(msRemaining: number): string {
  const hours = Math.ceil(msRemaining / 3_600_000);
  if (hours <= 1) return "under an hour";
  return `${hours} hours`;
}

/** Garden band copy (band drives the visual's bloom state). */
export function gardenBandLabel(band: "sprouting" | "growing" | "thriving"): string {
  switch (band) {
    case "sprouting":
      return "Garden sprouting";
    case "growing":
      return "Garden growing";
    case "thriving":
      return "Garden thriving";
  }
}
