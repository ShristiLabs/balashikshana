/**
 * Mascot art (issue #58) — PURE SVG path data, no React Native.
 *
 * First-party vector mascot ("the Sprout" — the journey's own garden
 * metaphor: the garden bands are sprouting/growing/thriving, so the
 * learning buddy is a sprout with a leaf crown). Every pose is the
 * registry vocabulary 1:1, rendered as static end-state geometry; the
 * view applies the registry motion tokens (breathe loop, pickup
 * spring, snap burst, glow pulse, bounce, bloom scale) as transforms,
 * so the SAME geometry serves animated and reduced-motion (static)
 * rendering — no meaning depends on the animation.
 *
 * Rive seam (documented decision): the issue's title names Rive, but
 * `.riv` is a binary Rive-editor format — the repo ships none and none
 * can be authored here. Rather than a native dependency rendering
 * nothing (rive-react-native is a 417KB native module and its native
 * layer is never exercised by this repo's Expo Go / export-only
 * verification set), the mascot renders first-party SVG via
 * react-native-svg (already a dependency; ZERO new deps). The pose
 * names and motion tokens mirror the registry's stateMachineStates
 * exactly, so a future Rive adapter implements the same
 * pose->stateMachineStates contract and swaps in .riv files under the
 * CI-enforced 50KB budget (scripts/check-animation-assets.mjs).
 */
import type { MascotPose } from "./mascotMachine";
import type { ThemeColors } from "../design/tokens";

/** Badge tiers as in the #55 catalog (bronze / silver / gold). */
export type BadgeTier = "bronze" | "silver" | "gold";

/** The mascot's geometry for one pose (static end state). */
export interface MascotArt {
  /** Head + body silhouette (one path, centered on (0,0) in a 48x48 box). */
  body: string;
  /** Two leaf sprouts on the head. */
  leaves: string;
  /** Eyes path (pose-specific expression). */
  eyes: string;
  /** Mouth path (pose-specific expression). */
  mouth: string;
  /** Arms path (pose-specific gesture). */
  arms: string;
  /** Optional pose extra (e.g. star eyes sparkles); empty when none. */
  extra: string;
  /** Accent color from the theme for the pose's expression. */
  accentToken: "primary" | "success" | "info" | "warning" | "gold";
}

// Body: a rounded sprout head over a small body, centered on (0,0).
const BODY =
  "M 0 -6 a 11 11 0 0 1 11 11 a 11 11 0 0 1 -11 11 a 11 11 0 0 1 -11 -11 a 11 11 0 0 1 11 -11 Z M 0 16 a 6 6 0 0 1 6 6 a 6 6 0 0 1 -6 6 a 6 6 0 0 1 -6 -6 a 6 6 0 0 1 6 -6 Z";
// Leaf crown: two leaves atop the head.
const LEAVES = "M -1 -16 q -8 -7 -12 -2 q 5 6 12 2 Z M 1 -16 q 8 -7 12 -2 q -5 6 -12 2 Z";

// Expressions per pose (eyes + mouth + arms + extra).
const OPEN_EYES =
  "M -5 -3 a 1.8 1.8 0 0 1 3.6 0 a 1.8 1.8 0 0 1 -3.6 0 Z M 1.4 -3 a 1.8 1.8 0 0 1 3.6 0 a 1.8 1.8 0 0 1 -3.6 0 Z";
const HAPPY_ARC_EYES = "M -6.5 -3 q 3 -3.4 6 0 M 0.5 -3 q 3 -3.4 6 0";
const STAR_EYES =
  "M -5 -5 L -4.2 -3.4 L -2.6 -3.2 L -3.8 -2 L -3.4 -0.4 L -5 -1.2 L -6.6 -0.4 L -6.2 -2 L -7.4 -3.2 L -5.8 -3.4 Z M 5 -5 L 5.8 -3.4 L 7.4 -3.2 L 6.2 -2 L 6.6 -0.4 L 5 -1.2 L 3.4 -0.4 L 3.8 -2 L 2.6 -3.2 L 4.2 -3.4 Z";
const GENTLE_CLOSED_EYES = "M -6.5 -2.6 q 3 2.6 6 0 M 0.5 -2.6 q 3 2.6 6 0";
const SOFT_SMILE = "M -4 3.2 q 4 3.2 8 0";
const WIDE_SMILE = "M -5 2.4 q 5 4.6 10 0 Z";
const SMALL_WARM_SMILE = "M -2.6 3.4 q 2.6 2 5.2 0";
const NEUTRAL_ARMS = "M -11 6 q -4 2 -5 6 M 11 6 q 4 2 5 6";
const RAISED_ARMS = "M -11 4 q -5 -2 -6 -7 M 11 4 q 5 -2 6 -7";
const POINT_ARM = "M -11 6 q -4 2 -5 6 M 11 4 q 6 -1 9 -4";
// Bloom sparkle crown above the head (the badge-bloom moment).
const BLOOM_SPARKLES =
  "M 0 -24 L 1.2 -21.2 L 4 -20 L 1.2 -18.8 L 0 -16 L -1.2 -18.8 L -4 -20 L -1.2 -21.2 Z";

/** Art for each pose (all six registry states; uniqueness pinned by test). */
export const MASCOT_ART: Record<MascotPose, MascotArt> = {
  idle_breathe: {
    body: BODY,
    leaves: LEAVES,
    eyes: OPEN_EYES,
    mouth: SOFT_SMILE,
    arms: NEUTRAL_ARMS,
    extra: "",
    accentToken: "primary",
  },
  touch_pickup_scale: {
    body: BODY,
    leaves: LEAVES,
    eyes: OPEN_EYES,
    mouth: WIDE_SMILE,
    arms: RAISED_ARMS,
    extra: "",
    accentToken: "info",
  },
  snap_target_confirm: {
    body: BODY,
    leaves: LEAVES,
    eyes: HAPPY_ARC_EYES,
    mouth: WIDE_SMILE,
    arms: RAISED_ARMS,
    extra: "",
    accentToken: "success",
  },
  hint_path_bezier_glow: {
    body: BODY,
    leaves: LEAVES,
    eyes: OPEN_EYES,
    mouth: SMALL_WARM_SMILE,
    arms: POINT_ARM,
    extra: "",
    accentToken: "info",
  },
  gentle_bounce_back: {
    // The #56 growth reframe: gentle closed-happy eyes and a warm small
    // smile — empathetic and encouraging, never sad.
    body: BODY,
    leaves: LEAVES,
    eyes: GENTLE_CLOSED_EYES,
    mouth: SMALL_WARM_SMILE,
    arms: NEUTRAL_ARMS,
    extra: "",
    accentToken: "primary",
  },
  mastery_badge_bloom: {
    body: BODY,
    leaves: LEAVES,
    eyes: STAR_EYES,
    mouth: WIDE_SMILE,
    arms: RAISED_ARMS,
    extra: BLOOM_SPARKLES,
    accentToken: "gold",
  },
};

/** Resolve the pose accent from the live theme. */
export function mascotAccent(colors: ThemeColors, token: MascotArt["accentToken"]): string {
  switch (token) {
    case "primary":
      return colors.primary.fill;
    case "success":
      return colors.success;
    case "info":
      return colors.info;
    case "warning":
      return colors.warning;
    case "gold":
      return colors.gold.fill;
  }
}

/**
 * Star burst positions (registry vocabulary: gold_stars_12). Pure
 * geometry: `count` points evenly on a circle of `radius`, each point a
 * small five-point star's center offset. Used by the snap-confirm and
 * badge-bloom views for the particle burst (static ring under reduced
 * motion — same information, no motion).
 */
export function starBurstPositions(count: number, radius: number): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    const angle = (2 * Math.PI * i) / count - Math.PI / 2;
    points.push({
      x: Math.round(radius * Math.cos(angle) * 100) / 100,
      y: Math.round(radius * Math.sin(angle) * 100) / 100,
    });
  }
  return points;
}

/** One small five-point star path centered at (x, y). */
export function starAt(x: number, y: number, size = 2.2): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i += 1) {
    const r = i % 2 === 0 ? size : size * 0.45;
    const angle = (Math.PI * i) / 5 - Math.PI / 2;
    pts.push(`${(x + r * Math.cos(angle)).toFixed(2)} ${(y + r * Math.sin(angle)).toFixed(2)}`);
  }
  return `M ${pts.join(" L ")} Z`;
}

/**
 * Badge silhouettes for the #55 catalog tiers — SHAPE-redundant with
 * color (the journey art doctrine): bronze = circle, silver = pentagon,
 * gold = hexagon, all ~22x22 centered on (0,0).
 */
export function badgeSilhouetteForTier(tier: BadgeTier): string {
  switch (tier) {
    case "bronze":
      return "M 0 -9 a 9 9 0 0 1 0 18 a 9 9 0 0 1 0 -18 Z";
    case "silver":
      return "M 0 -9.5 L 9 -3.1 L 5.6 7.4 L -5.6 7.4 L -9 -3.1 Z";
    case "gold":
      return "M 0 -10 L 8.7 -5 L 8.7 5 L 0 10 L -8.7 5 L -8.7 -5 Z";
  }
}

/** Tier fill/stroke from the live theme (shape carries the tier too). */
export function badgeTierColors(
  colors: ThemeColors,
  tier: BadgeTier,
): { fill: string; stroke: string } {
  switch (tier) {
    case "bronze":
      return { fill: colors.textMuted, stroke: colors.text };
    case "silver":
      return { fill: colors.surfaceTinted, stroke: colors.textMuted };
    case "gold":
      return { fill: colors.gold.fill, stroke: colors.gold.fillBottom };
  }
}
