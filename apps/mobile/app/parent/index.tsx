/**
 * Parent area (issue #44): the #43 seam is now live - NOTHING renders
 * here until the hold-to-confirm parental gate passes (roadmap D5; the
 * gate component is the same one onboarding step 1 uses). Behind the
 * gate: account summary and the token-lifecycle actions (sign out /
 * switch parent). The full parent portal surface is #61.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { Button } from "../../src/design/primitives";
import { useTheme } from "../../src/design/theme";
import { spacing, typeRamp } from "../../src/design/tokens";
import { createApiClient } from "../../src/onboarding/api";
import { ParentalGate } from "../../src/onboarding/ParentalGate";
import { createNativeDependencies } from "../../src/onboarding/nativeStores";
import { TokenStore } from "../../src/onboarding/storage";
import type { OnboardingSnapshot } from "../../src/onboarding/types";

const API_BASE = process.env.EXPO_PUBLIC_API_BASE ?? "http://localhost:4000";

export default function ParentScreen() {
  const { colors } = useTheme();
  const [gatePassed, setGatePassed] = useState(false);
  const [snapshot, setSnapshot] = useState<OnboardingSnapshot | null>(null);
  const [hasParentToken, setHasParentToken] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const native = await createNativeDependencies();
      const tokens = new TokenStore(native.secure);
      if (cancelled) return;
      setSnapshot(await native.onboardingStore.load());
      setHasParentToken((await tokens.getParentSessionToken()) !== null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Shared sign-out: revoke server-side (best effort), wipe local secrets + state. */
  const signOut = useCallback(async () => {
    setBusy(true);
    try {
      const native = await createNativeDependencies();
      const tokens = new TokenStore(native.secure);
      const token = await tokens.getParentSessionToken();
      if (token) {
        try {
          await createApiClient({ baseUrl: API_BASE }).parentLogout(token);
        } catch {
          // Offline or token already dead: local wipe still proceeds.
        }
      }
      await tokens.clearAllCredentials();
      await native.onboardingStore.clear();
    } finally {
      setBusy(false);
      router.dismissAll();
    }
  }, []);

  if (!gatePassed) {
    return (
      <View style={{ padding: spacing.xxl, backgroundColor: colors.background, minHeight: "100%" }}>
        <ParentalGate
          onPassed={() => setGatePassed(true)}
          contextLabel="parent settings"
          testID="parent.gate"
        />
      </View>
    );
  }

  return (
    <View
      style={{
        padding: spacing.xxl,
        gap: spacing.lg,
        backgroundColor: colors.background,
        minHeight: "100%",
      }}
    >
      <Text style={{ ...typeRamp.h2, color: colors.text }}>Parent area</Text>
      <View style={{ gap: spacing.xs }}>
        <Text style={{ ...typeRamp.body, color: colors.text }}>
          {snapshot?.email ?? "No parent account on this device yet."}
        </Text>
        {snapshot?.consentPolicyVersion ? (
          <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
            {`Consent recorded at policy version ${snapshot.consentPolicyVersion}.`}
          </Text>
        ) : null}
        {!hasParentToken ? (
          <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
            Signed out - run setup from the launcher to sign back in.
          </Text>
        ) : null}
      </View>

      <View style={{ gap: spacing.md, marginTop: spacing.md }}>
        <Button
          label="Back to app"
          variant="outline"
          onPress={() => router.dismissAll()}
          accessibilityHint="Return to the app launcher"
          testID="parent.home"
        />
        <Button
          label="Switch parent account"
          variant="secondary"
          onPress={() => void signOut()}
          disabled={busy}
          accessibilityHint="Sign out and restart setup with a different parent account"
          testID="parent.switch"
        />
        <Button
          label="Sign out"
          variant="danger"
          onPress={() => void signOut()}
          disabled={busy}
          accessibilityHint="Revoke this session and clear all saved sign-in data from this device"
          testID="parent.signout"
        />
      </View>
    </View>
  );
}
