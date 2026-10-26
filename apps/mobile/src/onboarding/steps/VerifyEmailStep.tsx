/**
 * Step 3 - email verification (POST /api/parents/verify-email). Verifiable
 * consent (#41) requires a verified email; the server mints single-use
 * verification tokens at signup.
 *
 * Dev convenience: the API returns the verification token in the signup
 * response outside production (the documented SMTP seam - production
 * delivery is later milestone work). When that token was stashed, this
 * screen pre-fills it so the dev flow completes without a mailbox; in
 * production the parent types the code from the email.
 */
import React, { useState } from "react";
import { Text } from "react-native";
import { Button } from "../../design/primitives";
import { useTheme } from "../../design/theme";
import { typeRamp } from "../../design/tokens";
import { ApiError, type ApiClient } from "../api";
import { ErrorBanner, Field, StepHeading, StepScroll } from "./shared";

export interface VerifyEmailStepProps {
  api: ApiClient;
  email: string;
  /** The dev-seam token stashed at signup, when present. */
  devToken: string | null;
  /** #71: carries the server-minted parent session token, when present. */
  onVerified: (mintedSessionToken?: string) => void;
  /** Escape hatch when the code never arrives: back to sign-in. */
  onBackToAccount?: () => void;
}

export function VerifyEmailStep({
  api,
  email,
  devToken,
  onVerified,
  onBackToAccount,
}: VerifyEmailStepProps) {
  const { colors } = useTheme();
  // Prefill from the stashed dev-seam token at mount (the flow sets it
  // before this step renders); typed entry is the production path.
  const [token, setToken] = useState(devToken && devToken.length > 0 ? devToken : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      const result = await api.verifyEmail(token.trim());
      onVerified(result.token);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError("unknown", "Unexpected error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepScroll testID="onboarding.step.verify">
      <StepHeading
        title="Verify your email"
        subtitle={`We sent a verification code to ${email || "your email"}. Enter it below to continue.`}
      />
      {devToken ? (
        <Text style={{ ...typeRamp.caption, color: colors.textMuted }}>
          Development mode: the code was pre-filled from the signup response (no mail server is
          configured yet).
        </Text>
      ) : null}
      <ErrorBanner error={error} />
      <Field
        label="Verification code"
        value={token}
        onChangeText={setToken}
        autoCapitalize="none"
        autoCorrect={false}
        testID="onboarding.verify.token"
      />
      <Button
        label="Verify email"
        onPress={() => void submit()}
        disabled={busy || token.trim().length === 0}
        accessibilityHint="Confirm the email verification code"
        testID="onboarding.verify.submit"
      />
      {onBackToAccount ? (
        <Button
          label="Back to sign in"
          variant="outline"
          onPress={onBackToAccount}
          accessibilityHint="Return to the account step"
          testID="onboarding.verify.back"
        />
      ) : null}
    </StepScroll>
  );
}
