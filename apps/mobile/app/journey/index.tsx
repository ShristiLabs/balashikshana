/**
 * Journey map screen (issue #44 seam): a CHILD surface, so it stays
 * locked until onboarding is complete and consent is current (a policy
 * version bump routes back through onboarding's re-consent screens before
 * this unlocks - the #44 acceptance criterion). Offline tolerance: when
 * the consent status cannot be refreshed (no network), the last-known
 * consent version from the snapshot stands in, so a completed setup keeps
 * working on a plane. The full winding-path map is the #49 (journey map)
 * issue; until then this renders the placeholder behind the guard.
 */
import React, { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { router } from "expo-router";
import { useTheme } from "../../src/design/theme";
import { spacing, typeRamp } from "../../src/design/tokens";
import { createApiClient } from "../../src/onboarding/api";
import { childAccessReady } from "../../src/onboarding/flowGuard";
import { createNativeDependencies } from "../../src/onboarding/nativeStores";
import { TokenStore } from "../../src/onboarding/storage";
import type { ConsentStatusInfo } from "../../src/onboarding/types";
import { PlaceholderScreen } from "../../src/shell/PlaceholderScreen";

const API_BASE = process.env.EXPO_PUBLIC_API_BASE ?? "http://localhost:4000";

export default function JourneyScreen() {
  const { colors } = useTheme();
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
          // Offline: fall back to the last-known consent version so a
          // completed setup keeps working without a network (the full
          // offline store is #46-#48; this is the tolerant seam).
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
          Finish setup with a grown-up to open the journey. Taking you there now...
        </Text>
      </View>
    );
  }

  return (
    <PlaceholderScreen
      title="Journey"
      subtitle="Your learning path through the units"
      body="The winding journey map with unit banners, topic stones, key states, and the grade switcher arrives with the journey-map milestone."
      plannedIn="#49 journey map"
      nextLabel="Start a practice session"
      nextHref="/practice"
    />
  );
}
