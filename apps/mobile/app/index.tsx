/**
 * Launcher screen: entry point of the M3 shell. Offers the two live
 * destinations (onboarding and journey) and demonstrates token-driven
 * theming by cycling light / dark / high-contrast. No dead ends.
 */
import React from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { Button } from "../src/design/primitives";
import { useTheme } from "../src/design/theme";
import { controlHeights, radius, spacing, typeRamp, type ThemeMode } from "../src/design/tokens";

const THEME_CYCLE: ThemeMode[] = ["light", "dark", "highContrast"];

export default function LauncherScreen() {
  const { mode, setMode, colors } = useTheme();

  return (
    <ScrollView
      contentContainerStyle={{
        padding: spacing.xxl,
        gap: spacing.xl,
        minHeight: "100%",
        justifyContent: "center",
        backgroundColor: colors.background,
      }}
    >
      <View style={{ gap: spacing.sm, alignItems: "center" }}>
        <View
          accessibilityLabel="Balashikshana mascot tile"
          style={{
            width: 84,
            height: 84,
            borderRadius: 24,
            borderCurve: "continuous",
            backgroundColor: colors.primary.fill,
            borderBottomWidth: 6,
            borderBottomColor: colors.primary.fillBottom,
            alignItems: "center",
            justifyContent: "center",
            marginBottom: spacing.sm,
          }}
        >
          <Text style={{ ...typeRamp.display, color: colors.primary.label, fontSize: 44 }}>B</Text>
        </View>
        <Text style={{ ...typeRamp.h1, color: colors.text, textAlign: "center" }}>
          Balashikshana
        </Text>
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted, textAlign: "center" }}>
          Fun learning journey - Pre-K to Grade 3
        </Text>
      </View>

      <View style={{ gap: spacing.md }}>
        <Button
          label="Start onboarding"
          onPress={() => router.push("/onboarding")}
          accessibilityHint="Open the parent-guided onboarding flow"
        />
        <Button
          label="Go to journey"
          variant="secondary"
          onPress={() => router.push("/journey")}
          accessibilityHint="Open the learning journey map"
        />
        <Button
          label="Grown-ups"
          variant="outline"
          onPress={() => router.push("/parent")}
          accessibilityHint="Open the parent area placeholder"
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Theme: ${mode}. Switch theme.`}
          onPress={() => {
            const next = THEME_CYCLE[(THEME_CYCLE.indexOf(mode) + 1) % THEME_CYCLE.length];
            if (next !== undefined) {
              setMode(next);
            }
          }}
          style={({ pressed }) => ({
            minHeight: controlHeights.sm,
            justifyContent: "center",
            alignItems: "center",
            borderRadius: radius.sm,
            borderWidth: 2,
            borderCurve: "continuous",
            borderColor: colors.border,
            backgroundColor: pressed ? colors.surfaceAlt : colors.surface,
          })}
        >
          <Text style={{ ...typeRamp.label, color: colors.textMuted }}>
            {`Theme: ${mode} (tap to switch)`}
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}
