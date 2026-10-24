/**
 * Shared placeholder screen for the M3 navigation skeleton. Guarantees
 * no dead ends: every placeholder renders a primary action (nextRoute)
 * and a Home outline action, both >=48pt touch targets. Real screens
 * (#44 onboarding, #46 content, #49-#51 flows) replace these one by one.
 */
import React from "react";
import { ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { Badge, Button } from "../design/primitives";
import { useTheme } from "../design/theme";
import { spacing, typeRamp } from "../design/tokens";

export interface PlaceholderScreenProps {
  title: string;
  subtitle: string;
  body: string;
  /** The milestone issue that fills this screen in. */
  plannedIn: string;
  nextLabel?: string;
  nextHref?: string;
}

export function PlaceholderScreen({
  title,
  subtitle,
  body,
  plannedIn,
  nextLabel,
  nextHref,
}: PlaceholderScreenProps) {
  const { colors } = useTheme();

  return (
    <ScrollView
      contentContainerStyle={{
        padding: spacing.xxl,
        gap: spacing.lg,
        alignItems: "stretch",
        backgroundColor: colors.background,
        minHeight: "100%",
      }}
    >
      <View style={{ gap: spacing.sm, marginTop: spacing.lg }}>
        <Badge label={`Placeholder - lands in ${plannedIn}`} tone="info" />
        <Text style={{ ...typeRamp.h2, color: colors.text }}>{title}</Text>
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>{subtitle}</Text>
      </View>

      <Text style={{ ...typeRamp.body, color: colors.text }}>{body}</Text>

      <View style={{ gap: spacing.md, marginTop: spacing.lg }}>
        {nextHref && nextLabel ? (
          <Button
            label={nextLabel}
            onPress={() => router.push(nextHref)}
            accessibilityHint={`Continue to ${nextLabel}`}
          />
        ) : null}
        <Button
          label="Home"
          variant="outline"
          onPress={() => router.dismissAll()}
          accessibilityHint="Return to the app launcher"
        />
      </View>
    </ScrollView>
  );
}
