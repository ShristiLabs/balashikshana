/**
 * Game screen (#52 framework host): a CHILD surface, so it stays
 * locked until onboarding is complete and consent is current (same
 * offline-tolerant guard as the journey, practice, and gate routes).
 * Behind the guard sits the game host: it resolves the topic's games
 * asset block and either mounts the archetype game session or falls
 * back to the #50 practice runner with the same topic.
 */
import React, { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { useTheme } from "../../src/design/theme";
import { spacing, typeRamp } from "../../src/design/tokens";
import { GameHostScreen } from "../../src/games/GameHostScreen";
import { createApiClient } from "../../src/onboarding/api";
import { childAccessReady } from "../../src/onboarding/flowGuard";
import { createNativeDependencies } from "../../src/onboarding/nativeStores";
import { TokenStore } from "../../src/onboarding/storage";
import type { ConsentStatusInfo } from "../../src/onboarding/types";

const API_BASE = process.env.EXPO_PUBLIC_API_BASE ?? "http://localhost:4000";

export default function GameScreen() {
  const { colors } = useTheme();
  const params = useLocalSearchParams<{
    gradeId?: string;
    unitId?: string;
    topicCode?: string;
    stage?: string;
  }>();
  const [decision, setDecision] = useState<"checking" | "open" | "locked">("checking");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const native = await createNativeDependencies();
      const tokens = new TokenStore(native.secure);
      const snapshot = await native.onboardingStore.load();
      const parentToken = await tokens.getParentSessionToken();
      const childDeviceSession = await tokens.getChildDeviceSession();

      let consentStatus: ConsentStatusInfo | null = null;
      if (parentToken) {
        try {
          consentStatus = await createApiClient({ baseUrl: API_BASE }).consentStatus(parentToken);
        } catch {
          // Offline: the last-known consent version stands in (the
          // same tolerant seam as the journey route).
          consentStatus =
            snapshot?.consentPolicyVersion != null
              ? { currentPolicyVersion: snapshot.consentPolicyVersion, consentCurrent: true }
              : null;
        }
      }

      const readiness = childAccessReady({
        snapshot,
        parentToken,
        childDeviceSession,
        consentStatus,
      });
      if (cancelled) return;
      setDecision(readiness.ready ? "open" : "locked");
      if (!readiness.ready) {
        router.replace("/onboarding");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (decision === "checking") {
    return (
      <View style={{ padding: spacing.xxl, alignItems: "center", gap: spacing.md }}>
        <ActivityIndicator color={colors.primary.fill} accessibilityLabel="Checking setup" />
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
          Checking your setup...
        </Text>
      </View>
    );
  }

  if (decision === "locked") {
    return (
      <View style={{ padding: spacing.xxl, gap: spacing.md }}>
        <Text style={{ ...typeRamp.h3, color: colors.text }}>Almost there</Text>
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
          Finish setup with a grown-up to open games. Taking you there now...
        </Text>
      </View>
    );
  }

  const unitId = typeof params.unitId === "string" ? params.unitId : "";
  const topicCode = typeof params.topicCode === "string" ? params.topicCode : "";
  const gradeId = typeof params.gradeId === "string" ? params.gradeId : undefined;
  const stage = params.stage === "guided" || params.stage === "fluency" ? params.stage : undefined;

  if (unitId === "" || topicCode === "") {
    return (
      <View style={{ padding: spacing.xxl, gap: spacing.md }}>
        <Text style={{ ...typeRamp.h3, color: colors.text }}>Pick a topic first</Text>
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
          Games open from a topic in the practice picker.
        </Text>
        <Text
          accessibilityRole="button"
          accessibilityLabel="Go back to practice"
          onPress={() => router.back()}
          style={{ ...typeRamp.body, color: colors.secondary.label, minHeight: 48 }}
        >
          {"Go back to practice"}
        </Text>
      </View>
    );
  }

  return <GameHostScreen gradeId={gradeId} unitId={unitId} topicCode={topicCode} stage={stage} />;
}
