/**
 * Root layout: safe-area, theme, and reduced-motion providers wrap the
 * expo-router stack. Header colors come from semantic tokens; the
 * background comes from the active theme, never a hardcoded value.
 */
import React, { useEffect } from "react";
import { Platform, View } from "react-native";
import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AudioServiceProvider } from "../src/audio/AudioServiceProvider";
import { ContentPackProvider } from "../src/content/ContentPackProvider";
import { ReminderBootstrap } from "../src/notifications/ReminderBootstrap";
import { PracticeWarmup } from "../src/practice/PracticeWarmup";
import { SyncBootstrap } from "../src/sync/SyncBootstrap";
import { ThemeProvider, useTheme } from "../src/design/theme";
import { MotionProvider } from "../src/design/useMotion";
import { WebStorageNotice } from "../src/platform/WebStorageNotice";

/**
 * Web edition (#71): register the app-shell service worker. Production
 * exports only (never the dev server), secure contexts only (the SW
 * spec requires https or localhost). The worker's policy is
 * conservative: static shell caching, NEVER API responses (COPPA) —
 * see public/sw.js.
 */
function ServiceWorkerBootstrap(): null {
  useEffect(() => {
    if (Platform.OS !== "web") return;
    if (typeof __DEV__ !== "undefined" && __DEV__) return;
    const nav = navigator as Navigator & { serviceWorker?: ServiceWorkerContainer };
    if (!nav.serviceWorker) return;
    nav.serviceWorker.register("/sw.js").catch(() => {
      // Progressive enhancement: offline support degrades, app unaffected.
    });
  }, []);
  return null;
}

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
              <ServiceWorkerBootstrap />
              <View style={{ flex: 1 }}>
                <WebStorageNotice />
                <RootStack />
              </View>
            </ContentPackProvider>
          </AudioServiceProvider>
        </MotionProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
