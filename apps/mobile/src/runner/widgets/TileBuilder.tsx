/**
 * TileBuilder widget (issue #50 widget kit): the concrete-stage
 * tap-to-place manipulative - a bank of number/symbol tiles the child
 * taps in order to build a sequence or equation in the answer slots
 * (the drag-drop-ish interaction validated by the web harness, as a
 * reusable >=48pt theme-aware widget; tap-to-place, never
 * fine-motor drag, for the 3-9 age band).
 *
 * Presentational: the parent owns the built sequence and correctness.
 */
import React, { useCallback } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTheme } from "../../design/theme";
import { useReducedMotion } from "../../design/useMotion";
import { Button } from "../../design/primitives";
import { MIN_TOUCH_TARGET, radius, spacing, tactile, typeRamp } from "../../design/tokens";
import type { RunnerOption } from "../questionShapes";

export interface TileBuilderProps {
  bank: RunnerOption[];
  /** Tiles placed so far, in order (parent-owned draft). */
  placed: RunnerOption[];
  disabled: boolean;
  onTileTapped: (option: RunnerOption) => void;
  onClear: () => void;
  testID?: string;
}

export function TileBuilder({
  bank,
  placed,
  disabled,
  onTileTapped,
  onClear,
  testID,
}: TileBuilderProps): React.ReactElement {
  const { colors } = useTheme();
  const { motion } = useReducedMotion();

  const handleTap = useCallback(
    (option: RunnerOption) => {
      if (!disabled) onTileTapped(option);
    },
    [disabled, onTileTapped],
  );

  return (
    <View testID={testID} accessibilityLabel="Tile builder" style={{ gap: spacing.lg }}>
      <View
        accessibilityLabel="Answer slots"
        style={{
          minHeight: MIN_TOUCH_TARGET + spacing.md * 2,
          borderRadius: radius.md,
          borderCurve: "continuous",
          borderWidth: 2,
          borderStyle: "dashed",
          borderColor: colors.border,
          padding: spacing.md,
          flexDirection: "row",
          flexWrap: "wrap",
          gap: spacing.sm,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.surface,
        }}
      >
        {placed.length === 0 ? (
          <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
            Tap tiles below to build your answer
          </Text>
        ) : (
          placed.map((option, index) => (
            <View
              key={`${option.key}-placed-${index}`}
              accessibilityLabel={`Slot ${index + 1}: ${option.label}`}
              style={{
                minWidth: MIN_TOUCH_TARGET,
                minHeight: MIN_TOUCH_TARGET,
                alignItems: "center",
                justifyContent: "center",
                paddingHorizontal: spacing.md,
                borderRadius: radius.sm,
                borderCurve: "continuous",
                borderWidth: 2,
                borderColor: colors.info,
                backgroundColor: colors.surfaceTinted,
              }}
            >
              <Text style={{ ...typeRamp.title, color: colors.text }}>{option.label}</Text>
            </View>
          ))
        )}
      </View>

      <ScrollView
        horizontal
        accessibilityLabel="Tile bank"
        contentContainerStyle={{ gap: spacing.sm, paddingHorizontal: spacing.xs }}
      >
        {bank.map((option) => (
          <Pressable
            key={option.key}
            accessibilityRole="button"
            accessibilityLabel={`Tile ${option.label}`}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={() => handleTap(option)}
            testID={`${testID ?? "tiles"}-bank-${option.key}`}
            style={({ pressed }) => ({
              minWidth: MIN_TOUCH_TARGET,
              minHeight: MIN_TOUCH_TARGET + 8,
              alignItems: "center",
              justifyContent: "center",
              paddingHorizontal: spacing.lg,
              borderRadius: radius.sm,
              borderCurve: "continuous",
              borderWidth: 2,
              borderBottomWidth: pressed ? tactile.borderPressed : tactile.borderRest,
              borderColor: colors.border,
              borderBottomColor: colors.textMuted,
              backgroundColor: colors.surface,
              transform: [{ translateY: pressed ? motion.pressTranslateY : 0 }],
            })}
          >
            <Text style={{ ...typeRamp.title, color: colors.text }}>{option.label}</Text>
          </Pressable>
        ))}
      </ScrollView>

      <View style={{ alignItems: "center" }}>
        <Button
          label="Clear tiles"
          variant="outline"
          size="sm"
          disabled={disabled || placed.length === 0}
          onPress={onClear}
          accessibilityHint="Remove every tile and start the answer again"
        />
      </View>
    </View>
  );
}
