/**
 * Display-only badge/pill (counts, streaks, status chips). Deliberately
 * NOT pressable: it exposes no onPress, so it is not a touch target and
 * the >=48pt rule does not apply to it (see tests/tokens.test.ts).
 */
import React from "react";
import { Text, View } from "react-native";
import { useTheme } from "../theme";
import { radius, spacing, typeRamp } from "../tokens";

export type BadgeTone = "neutral" | "success" | "info" | "warning" | "danger";

export interface BadgeProps {
  label: string;
  tone?: BadgeTone;
  testID?: string;
}

export function Badge({ label, tone = "neutral", testID }: BadgeProps) {
  const { colors } = useTheme();

  // Border keeps the saturated status tone; the LABEL uses the
  // text-grade ink so small text always clears 4.5:1 on the surface
  // (see tests/tokens.test.ts - statusInk enforcement).
  const toneColor =
    tone === "success"
      ? colors.success
      : tone === "info"
        ? colors.info
        : tone === "warning"
          ? colors.warning
          : tone === "danger"
            ? colors.danger.fill
            : colors.textMuted;

  const labelColor = tone === "neutral" ? colors.textMuted : colors.statusInk[tone];

  return (
    <View
      accessible
      accessibilityLabel={label}
      testID={testID}
      style={{
        alignSelf: "flex-start",
        paddingVertical: spacing.xs,
        paddingHorizontal: spacing.md,
        borderRadius: radius.sm,
        borderCurve: "continuous",
        borderWidth: 2,
        borderColor: toneColor,
        backgroundColor: colors.surface,
      }}
    >
      <Text style={{ ...typeRamp.label, color: labelColor, textTransform: "uppercase" }}>
        {label}
      </Text>
    </View>
  );
}
