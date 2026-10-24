/**
 * Tactile card primitive: bordered surface with a hard bottom edge, for
 * list rows, lesson pickers, and option tiles. Touch target is at least
 * 56pt (controlHeights.md) in the press dimension.
 */
import React from "react";
import { Pressable, View, type StyleProp, type ViewStyle } from "react-native";
import { useTheme } from "../theme";
import { useReducedMotion } from "../useMotion";
import { controlHeights, radius, spacing, tactile } from "../tokens";

export interface PressableCardProps {
  onPress: () => void;
  children: React.ReactNode;
  accessibilityLabel: string;
  accessibilityHint?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function PressableCard({
  onPress,
  children,
  accessibilityLabel,
  accessibilityHint,
  disabled = false,
  style,
  testID,
}: PressableCardProps) {
  const { colors } = useTheme();
  const { motion } = useReducedMotion();

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={({ pressed }): ViewStyle => ({
        minHeight: controlHeights.md,
        backgroundColor: disabled ? colors.disabledFill : colors.surface,
        borderRadius: radius.lg,
        borderCurve: "continuous",
        borderWidth: 2,
        borderBottomWidth: pressed ? tactile.borderPressed : tactile.borderRest + 2,
        borderColor: disabled ? colors.disabledFill : colors.border,
        borderBottomColor: disabled ? colors.disabledFill : colors.border,
        padding: spacing.lg,
        transform: [{ translateY: pressed ? motion.pressTranslateY : 0 }],
        opacity: disabled ? 0.7 : 1,
      })}
    >
      <View style={style}>{children}</View>
    </Pressable>
  );
}
