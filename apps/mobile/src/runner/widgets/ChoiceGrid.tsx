/**
 * ChoiceGrid widget (issue #50 widget kit): the universal answer
 * surface - big choice cards with a numbered badge (the validated web
 * harness treatment). Selected state is shape+color redundant: tinted
 * fill AND a solid border AND a check glyph, so selection never rides
 * on color alone (a11y + highContrast theme).
 *
 * Presentational: the parent owns selection, order (pre-shuffled by the
 * pure layer), and correctness.
 */
import React, { useCallback } from "react";
import { Pressable, Text, View } from "react-native";
import { useTheme } from "../../design/theme";
import { useReducedMotion } from "../../design/useMotion";
import { MIN_TOUCH_TARGET, radius, spacing, tactile, typeRamp } from "../../design/tokens";
import type { RunnerOption } from "../questionShapes";

export interface ChoiceGridProps {
  options: RunnerOption[];
  selectedKey: string | null;
  disabled: boolean;
  onOptionSelected: (option: RunnerOption) => void;
  testID?: string;
}

export function ChoiceGrid({
  options,
  selectedKey,
  disabled,
  onOptionSelected,
  testID,
}: ChoiceGridProps): React.ReactElement {
  const { colors } = useTheme();
  const { motion } = useReducedMotion();

  const handle = useCallback(
    (option: RunnerOption) => {
      if (!disabled) onOptionSelected(option);
    },
    [disabled, onOptionSelected],
  );

  return (
    <View testID={testID} accessibilityLabel="Answer choices" style={{ gap: spacing.md }}>
      {options.map((option, index) => {
        const selected = option.key === selectedKey;
        return (
          <Pressable
            key={option.key}
            accessibilityRole="button"
            accessibilityLabel={`Choice ${index + 1}: ${option.label}`}
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            onPress={() => handle(option)}
            testID={`${testID ?? "choices"}-option-${option.key}`}
            style={({ pressed }) => ({
              minHeight: 56,
              minWidth: MIN_TOUCH_TARGET,
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: spacing.md,
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.sm,
              borderRadius: radius.md,
              borderCurve: "continuous",
              borderWidth: 3,
              borderColor: selected ? colors.info : colors.border,
              backgroundColor: selected ? colors.surfaceTinted : colors.surface,
              borderBottomWidth: pressed ? tactile.borderPressed : tactile.borderRest,
              borderBottomColor: selected ? colors.info : colors.border,
              transform: [{ translateY: pressed ? motion.pressTranslateY : 0 }],
            })}
          >
            <Text style={{ ...typeRamp.h3, color: colors.text, flexShrink: 1 }} numberOfLines={2}>
              {option.label}
            </Text>
            {selected ? (
              <View
                accessibilityLabel="Selected"
                style={{
                  minWidth: 32,
                  minHeight: 32,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Text style={{ ...typeRamp.h3, color: colors.info }}>{"✓"}</Text>
              </View>
            ) : (
              <View
                style={{
                  minWidth: 32,
                  minHeight: 32,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: radius.sm,
                  borderWidth: 2,
                  borderColor: colors.border,
                  padding: spacing.xs,
                }}
              >
                <Text style={{ ...typeRamp.label, color: colors.textMuted }}>{index + 1}</Text>
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}
