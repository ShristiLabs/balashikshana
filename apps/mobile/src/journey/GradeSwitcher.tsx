/**
 * Grade switcher (issue #49): one chip per platform grade (Pre-K to
 * Grade 3), each a >=48pt touch target. The chip's subtitle carries the
 * pack currency from the store: installed grades switch instantly;
 * missing grades show "Download" and run the #46 ensurePack lifecycle on
 * selection; "downloading" shows the spinner; "stale" (the #48
 * clientPacks handshake flagged a newer server version) shows the
 * update hint while still serving the installed pack.
 *
 * Per-grade progress preservation is structural (unit ids are globally
 * unique), so switching is instant and lossless by construction.
 */
import React from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { useTheme } from "../design/theme";
import { controlHeights, radius, spacing, typeRamp } from "../design/tokens";
import type { GradeSlot } from "./store";

export interface GradeSwitcherProps {
  grades: GradeSlot[];
  activeGrade: string;
  onSelect: (gradeId: string) => void;
}

function currencyCaption(slot: GradeSlot): string {
  switch (slot.currency) {
    case "installed":
      return "Installed";
    case "downloading":
      return "Downloading";
    case "stale":
      return "Update available";
    case "missing":
      return "Download";
  }
}

export function GradeSwitcher({ grades, activeGrade, onSelect }: GradeSwitcherProps) {
  const { colors } = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: spacing.sm, paddingHorizontal: spacing.xs }}
      accessibilityLabel="Grade switcher"
    >
      {grades.map((slot) => {
        const selected = slot.gradeId === activeGrade;
        const busy = slot.currency === "downloading";
        const captionColor =
          slot.currency === "stale"
            ? colors.statusInk.warning
            : slot.currency === "missing"
              ? colors.statusInk.info
              : colors.textMuted;
        return (
          <Pressable
            key={slot.gradeId}
            accessibilityRole="button"
            accessibilityLabel={`Switch to ${slot.label}. ${currencyCaption(slot)}`}
            accessibilityState={{ selected, busy }}
            onPress={() => onSelect(slot.gradeId)}
            style={({ pressed }) => ({
              minHeight: controlHeights.sm,
              minWidth: 92,
              paddingHorizontal: spacing.lg,
              justifyContent: "center",
              alignItems: "center",
              borderRadius: radius.sm,
              borderCurve: "continuous",
              borderWidth: 2,
              borderColor: selected ? colors.primary.fillBottom : colors.border,
              backgroundColor: selected
                ? colors.primary.fill
                : pressed
                  ? colors.surfaceAlt
                  : colors.surface,
            })}
          >
            <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.xs }}>
              {busy ? <ActivityIndicator size="small" color={colors.textMuted} /> : null}
              <Text
                style={{
                  ...typeRamp.label,
                  color: selected ? colors.primary.label : colors.text,
                }}
              >
                {slot.label}
              </Text>
            </View>
            <Text style={{ ...typeRamp.caption, color: captionColor }}>
              {currencyCaption(slot)}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}
