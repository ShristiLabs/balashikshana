/**
 * Shared building blocks for onboarding step screens: a labeled text
 * field, the error banner (problem+json surfaced as parent-appropriate
 * copy), and the step scroll container. Parent-facing surfaces; the copy
 * follows the plain-language tone of the design system.
 */
import React from "react";
import { ScrollView, Text, TextInput, View, type TextInputProps } from "react-native";
import { useTheme } from "../../design/theme";
import { MIN_TOUCH_TARGET, spacing, typeRamp } from "../../design/tokens";
import { ApiError, parentFacingMessage } from "../api";

export function StepScroll({ children, testID }: { children: React.ReactNode; testID?: string }) {
  const { colors } = useTheme();
  return (
    <ScrollView
      testID={testID}
      contentContainerStyle={{
        padding: spacing.xxl,
        gap: spacing.lg,
        minHeight: "100%",
        backgroundColor: colors.background,
      }}
    >
      {children}
    </ScrollView>
  );
}

export function StepHeading({ title, subtitle }: { title: string; subtitle: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: spacing.xs, marginTop: spacing.lg }}>
      <Text style={{ ...typeRamp.h2, color: colors.text }}>{title}</Text>
      <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>{subtitle}</Text>
    </View>
  );
}

export interface FieldProps extends TextInputProps {
  label: string;
  error?: string | null;
}

export function Field({ label, error, ...inputProps }: FieldProps) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: spacing.xs }}>
      <Text style={{ ...typeRamp.label, color: colors.text }}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={colors.textMuted}
        style={{
          minHeight: MIN_TOUCH_TARGET,
          borderWidth: 2,
          borderRadius: 12,
          borderCurve: "continuous",
          borderColor: error ? colors.danger.fill : colors.border,
          backgroundColor: colors.surface,
          paddingHorizontal: spacing.lg,
          fontSize: typeRamp.body.fontSize,
          fontWeight: "600",
          color: colors.text,
        }}
        {...inputProps}
      />
      {error ? (
        <Text
          style={{ ...typeRamp.caption, color: colors.statusInk.danger }}
          accessibilityRole="alert"
        >
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Surfaces an ApiError as parent-appropriate copy; the RFC 9457 detail is
 * shown as a secondary line when the server provided one (parent surfaces
 * may show it; kid surfaces never render raw server text).
 */
export function ErrorBanner({ error }: { error: ApiError | null }) {
  const { colors } = useTheme();
  if (!error) return null;
  return (
    <View
      accessibilityRole="alert"
      style={{
        borderWidth: 2,
        borderRadius: 12,
        borderCurve: "continuous",
        borderColor: colors.danger.fillBottom,
        backgroundColor: colors.surfaceTinted,
        padding: spacing.md,
        gap: spacing.xs,
      }}
    >
      <Text style={{ ...typeRamp.body, color: colors.statusInk.danger }}>
        {parentFacingMessage(error)}
      </Text>
      {error.problem?.detail ? (
        <Text style={{ ...typeRamp.caption, color: colors.textMuted }}>{error.problem.detail}</Text>
      ) : null}
    </View>
  );
}
