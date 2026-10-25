/**
 * Hearts display (issue #56, roadmap D6) — the kid-facing heart row a
 * Grade 2/Grade 3 fluency sprint carries. Rendered ONLY when the
 * engine's start payload mounted hearts (heartsRemaining !== null —
 * the structural no-fail guard: Pre-K-G1 and guided sessions never
 * render this component because their state stays null).
 *
 * Kid-safety + design doctrine: shape+color redundancy (a FILLED heart
 * glyph vs an OUTLINE heart glyph carries the state, reinforced by
 * color — never color alone), text label carries the exact count for
 * screen readers, static layout with no animation (reduced-motion safe
 * by construction), display-only (nothing is pressable), and the copy
 * never frames hearts as a punishment — a lost heart is rest framing,
 * not failure. No emoji: these are text glyphs, not emoji codepoints.
 */
import React from "react";
import { Text, View } from "react-native";
import { useTheme } from "../design/theme";
import { radius, spacing, typeRamp } from "../design/tokens";

/** Filled vs outline heart GLYPHS (U+2665/U+2661 — shape redundancy). */
const HEART_FILLED = "\u2665";
const HEART_OUTLINE = "\u2661";

export function HeartsDisplay({
  remaining,
  total,
}: {
  remaining: number;
  total: number;
}): React.ReactElement {
  const { colors } = useTheme();
  const filled = Math.max(0, Math.min(remaining, total));
  const outline = Math.max(0, total - filled);
  const label =
    filled === total
      ? `All ${String(total)} hearts`
      : `${String(filled)} of ${String(total)} hearts left`;

  return (
    <View
      accessible
      accessibilityLabel={label}
      accessibilityRole="text"
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.xs,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.xs,
        borderRadius: radius.pill,
        backgroundColor: colors.surfaceAlt,
        borderWidth: 2,
        borderColor: colors.border,
      }}
    >
      <Text
        style={{
          ...typeRamp.title,
          color: filled > 0 ? colors.statusInk.warning : colors.textMuted,
          letterSpacing: 2,
        }}
      >
        {HEART_FILLED.repeat(filled) + HEART_OUTLINE.repeat(outline)}
      </Text>
      <Text style={{ ...typeRamp.caption, color: colors.textMuted }}>{label}</Text>
    </View>
  );
}
