/**
 * Gamification header strip (issue #55) — the kid-facing surfacing of the
 * reward ledger on the journey home: level, XP progress toward the next
 * level, star coins, streak days, and the earned-badge count. Every
 * number comes from the projector's summary (engine math); nothing is
 * hardcoded and no PII is displayed.
 *
 * Kid-safety + design doctrine: text-with-color redundancy (the high
 * contrast and color-blind safe rule — no meaning by color alone), no
 * emoji (SVG-free text chip treatment over the design tokens), static
 * layout with no animation (reduced-motion safe by construction), and
 * display-only (no sub-48pt touch targets are introduced because nothing
 * is pressable). Full badge/celebration rendering lands with #58.
 */
import React from "react";
import { Text, View } from "react-native";
import { useTheme } from "../design/theme";
import { ProgressBar } from "../design/primitives";
import { radius, spacing, typeRamp } from "../design/tokens";
import type { GamificationSummary } from "./types";

function StatChip({
  label,
  value,
  ink,
  chipBg,
}: {
  label: string;
  value: string;
  ink: string;
  chipBg: string;
}) {
  return (
    <View
      style={{
        backgroundColor: chipBg,
        borderRadius: radius.md,
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.xs,
      }}
      accessibilityLabel={`${label} ${value}`}
    >
      <Text style={{ ...typeRamp.caption, color: ink }}>
        {label} {value}
      </Text>
    </View>
  );
}

export function GamificationHeaderStrip({ summary }: { summary: GamificationSummary }) {
  const { colors } = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={
        `Level ${String(summary.level)}. ` +
        `${summary.maxed ? "Maximum level reached." : `${String(summary.xpToNextLevel ?? 0)} XP to the next level.`} ` +
        `${String(summary.starCoins)} star coins. ${String(summary.streakDays)} day streak. ` +
        `${String(summary.badges.length)} badges earned.`
      }
      style={{ gap: spacing.xs }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <View
          style={{
            backgroundColor: colors.primary.fill,
            borderRadius: radius.pill,
            paddingHorizontal: spacing.sm,
            paddingVertical: spacing.xs,
          }}
          accessibilityLabel={`Level ${String(summary.level)}`}
        >
          <Text style={{ ...typeRamp.body, color: colors.primary.label }}>
            {`Lv ${String(summary.level)}`}
          </Text>
        </View>
        <View style={{ flex: 1 }}>
          <ProgressBar
            progress={summary.levelProgressPct / 100}
            accessibilityLabel={`XP progress ${String(summary.levelProgressPct)} percent`}
          />
          <Text style={{ ...typeRamp.caption, color: colors.textMuted }}>
            {summary.maxed
              ? `Max level - ${String(summary.totalXp)} XP`
              : `${String(summary.xpIntoLevel)} / ${String((summary.xpIntoLevel ?? 0) + (summary.xpToNextLevel ?? 0))} XP`}
          </Text>
        </View>
      </View>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        <StatChip
          label="Coins"
          value={String(summary.starCoins)}
          ink={colors.statusInk.warning}
          chipBg={colors.surfaceAlt}
        />
        <StatChip
          label="Day streak"
          value={String(summary.streakDays)}
          ink={colors.statusInk.success}
          chipBg={colors.surfaceAlt}
        />
        <StatChip
          label="Badges"
          value={String(summary.badges.length)}
          ink={colors.text}
          chipBg={colors.surfaceAlt}
        />
        {summary.provisional ? (
          <StatChip label="Syncing" value="" ink={colors.textMuted} chipBg={colors.surfaceAlt} />
        ) : null}
      </View>
    </View>
  );
}
