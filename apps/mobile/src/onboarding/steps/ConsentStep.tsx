/**
 * Step 4 - consent screens (GET /api/consent/policy/latest +
 * POST /api/consent/records, the #41 endpoints).
 *
 * Renders the ACTIVE versioned policy text and records timestamped
 * capture against that version. A 409 policy-version-mismatch (the policy
 * was bumped server-side between render and accept) re-fetches and
 * re-renders the new text for a fresh acceptance - the client never
 * silently re-records against a version it did not show.
 */
import React, { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { Badge, Button, ProgressBar } from "../../design/primitives";
import { useTheme } from "../../design/theme";
import { spacing, typeRamp } from "../../design/tokens";
import { ApiError, type ApiClient } from "../api";
import { LegalDocuments } from "../LegalDocuments";
import { ErrorBanner, StepHeading, StepScroll } from "./shared";

export interface ConsentStepProps {
  api: ApiClient;
  /** Called with the version whose text is currently rendered. */
  onAccept: (policyVersion: string) => Promise<void>;
  /** True when this is a re-consent after a policy version bump. */
  isReconsent: boolean;
}

interface PolicyView {
  version: string;
  policyText: string;
  createdAt: string;
}

export function ConsentStep({ api, onAccept, isReconsent }: ConsentStepProps) {
  const { colors } = useTheme();
  const [policy, setPolicy] = useState<PolicyView | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [acceptError, setAcceptError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const loadPolicy = useCallback(async () => {
    try {
      const latest = await api.policyLatest();
      setLoadError(null);
      setPolicy({
        version: latest.version,
        policyText: latest.policyText,
        createdAt: latest.createdAt,
      });
    } catch (err) {
      setLoadError(err instanceof ApiError ? err : new ApiError("unknown", "Unexpected error"));
    }
  }, [api]);

  // Initial policy load runs as a cancellable macrotask (the retry button
  // calls loadPolicy directly). Keeps state updates out of the effect body.
  useEffect(() => {
    const id = setTimeout(() => void loadPolicy(), 0);
    return () => clearTimeout(id);
  }, [loadPolicy]);

  const accept = async () => {
    if (!policy) return;
    setAcceptError(null);
    setBusy(true);
    try {
      await onAccept(policy.version);
      // onAccept throws policy-version-mismatch upward: catch below
      // re-fetches so the parent reviews the NEW text before accepting.
    } catch (err) {
      if (err instanceof ApiError && err.code === "policy-version-mismatch") {
        await loadPolicy();
      }
      setAcceptError(err instanceof ApiError ? err : new ApiError("unknown", "Unexpected error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepScroll testID="onboarding.step.consent">
      <StepHeading
        title={isReconsent ? "Consent policy updated" : "Your consent"}
        subtitle={
          isReconsent
            ? "The consent policy has a new version. Please review and accept it to keep setting up your learner."
            : "Please read the consent policy. Your learner's account can only be created after you accept it."
        }
      />

      <View style={{ gap: spacing.md, marginTop: spacing.md }}>
        {policy ? (
          <>
            <Badge label={`Policy version ${policy.version}`} tone="info" />
            <View
              style={{
                borderWidth: 2,
                borderRadius: 12,
                borderCurve: "continuous",
                borderColor: colors.border,
                backgroundColor: colors.surface,
                padding: spacing.lg,
              }}
            >
              <Text style={{ ...typeRamp.bodyMuted, color: colors.text }}>{policy.policyText}</Text>
            </View>
            {/* Legal pack (issue #68): the Privacy Policy and Terms of
                Service are reachable BEFORE the accept button — the parent
                reads what they are agreeing to (COPPA good practice). */}
            <LegalDocuments api={api} testID="onboarding.consent.legal" />
            <Button
              label="I agree"
              onPress={() => void accept()}
              disabled={busy}
              accessibilityHint={`Accept policy version ${policy.version}`}
              testID="onboarding.consent.accept"
            />
          </>
        ) : loadError ? (
          <>
            <ErrorBanner error={loadError} />
            <Button
              label="Try again"
              variant="outline"
              onPress={() => void loadPolicy()}
              accessibilityHint="Retry loading the consent policy"
              testID="onboarding.consent.retry"
            />
          </>
        ) : (
          <View style={{ gap: spacing.sm, padding: spacing.lg }}>
            <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
              Loading the consent policy...
            </Text>
            <ProgressBar progress={0.5} accessibilityLabel="Loading consent policy" />
          </View>
        )}
        <ErrorBanner error={acceptError} />
      </View>
    </StepScroll>
  );
}
