/**
 * Tactile button primitive (the web harness's duo-btn treatment): solid
 * fill, hard bottom edge, uppercase label. Enforces the >=48pt minimum
 * touch target via controlHeights; hitSlop extends the press area to the
 * full minimum when a smaller visual size is ever requested.
 */
import React from "react";
import { Pressable, Text, type ViewStyle } from "react-native";
import { useTheme } from "../theme";
import { useReducedMotion } from "../useMotion";
import {
  controlHeights,
  MIN_TOUCH_TARGET,
  radius,
  spacing,
  tactile,
  typeRamp,
  type ActionToken,
} from "../tokens";

export type ButtonVariant = "primary" | "secondary" | "gold" | "danger" | "outline";
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  accessibilityHint?: string;
  testID?: string;
}

function actionFor(token: ActionToken): { fill: string; bottom: string; label: string } {
  return { fill: token.fill, bottom: token.fillBottom, label: token.label };
}

export function Button({
  label,
  onPress,
  variant = "primary",
  size = "md",
  disabled = false,
  accessibilityHint,
  testID,
}: ButtonProps) {
  const { colors } = useTheme();
  const { motion } = useReducedMotion();

  const height = controlHeights[size];
  const variantStyle =
    variant === "outline"
      ? { fill: colors.surface, bottom: colors.border, label: colors.text }
      : actionFor(colors[variant]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      hitSlop={spacing.xs}
      style={({ pressed }): ViewStyle => ({
        minHeight: height,
        minWidth: MIN_TOUCH_TARGET,
        paddingHorizontal: spacing.xl,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: radius.md,
        borderCurve: "continuous",
        backgroundColor: disabled ? colors.disabledFill : variantStyle.fill,
        borderBottomWidth: pressed ? tactile.borderPressed : tactile.borderRest,
        borderBottomColor: disabled ? colors.disabledFill : variantStyle.bottom,
        transform: [{ translateY: pressed ? motion.pressTranslateY : 0 }],
        opacity: disabled ? 0.7 : 1,
      })}
    >
      <Text
        style={{
          ...typeRamp.label,
          color: disabled ? colors.disabledLabel : variantStyle.label,
          textTransform: "uppercase",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
