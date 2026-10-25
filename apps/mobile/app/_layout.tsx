/**
 * Root layout: safe-area, theme, and reduced-motion providers wrap the
 * expo-router stack. Header colors come from semantic tokens; the
 * background comes from the active theme, never a hardcoded value.
 */
import React from "react";
import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AudioServiceProvider } from "../src/audio/AudioServiceProvider";
import { ContentPackProvider } from "../src/content/ContentPackProvider";
import { ReminderBootstrap } from "../src/notifications/ReminderBootstrap";
import { PracticeWarmup } from "../src/practice/PracticeWarmup";
import { SyncBootstrap } from "../src/sync/SyncBootstrap";
import { ThemeProvider, useTheme } from "../src/design/theme";
import { MotionProvider } from "../src/design/useMotion";

function RootStack() {
  const { colors } = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShadowVisible: false,
        headerLargeTitle: true,
        contentStyle: { backgroundColor: colors.background },
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
      }}
    >
      <Stack.Screen name="index" options={{ title: "Balashikshana" }} />
      <Stack.Screen name="onboarding/index" options={{ title: "Onboarding" }} />
      <Stack.Screen name="journey/index" options={{ title: "Journey" }} />
      <Stack.Screen name="practice/index" options={{ title: "Practice" }} />
      <Stack.Screen name="game/index" options={{ title: "Game" }} />
      <Stack.Screen name="placement/index" options={{ title: "Quick Exploration" }} />
      <Stack.Screen name="gate/index" options={{ title: "Boss Gate" }} />
      <Stack.Screen name="parent/index" options={{ title: "Parent Area" }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <MotionProvider>
          <AudioServiceProvider>
            <ContentPackProvider>
              <PracticeWarmup />
              <SyncBootstrap />
              <ReminderBootstrap />
              <RootStack />
            </ContentPackProvider>
          </AudioServiceProvider>
        </MotionProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
