/**
 * Final step - setup complete. Summarizes what was created and hands off
 * to the journey (child surfaces unlock once the flow reports completion).
 */
import React from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { Badge, Button } from "../../design/primitives";
import { useTheme } from "../../design/theme";
import { spacing, typeRamp } from "../../design/tokens";
import { GRADE_LABELS, type GradeId } from "../types";
import type { ApiError } from "../api";
import { ErrorBanner, StepHeading, StepScroll } from "./shared";

export interface CompleteStepProps {
  childNickname: string;
  childAvatar: string;
  gradeId?: GradeId;
  /** Set when a resumed device-session re-mint failed (retryable). */
  mintError?: ApiError | null;
  onRetryMint?: () => void;
}

export function CompleteStep({
  childNickname,
  childAvatar,
  gradeId,
  mintError,
  onRetryMint,
}: CompleteStepProps) {
  const { colors } = useTheme();
  return (
    <StepScroll testID="onboarding.step.complete">
      <StepHeading
        title="All set!"
        subtitle={`${childAvatar} ${childNickname} is ready to start learning.`}
      />
      <View style={{ gap: spacing.md, marginTop: spacing.md }}>
        {gradeId ? (
          <Badge label={`Starting grade: ${GRADE_LABELS[gradeId]}`} tone="success" />
        ) : null}
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
          The learner can now sign in on this device with their avatar and PIN. You can review
          consent, manage learners, and sign out from the Grown-ups area.
        </Text>
        {mintError ? (
          <>
            <ErrorBanner error={mintError} />
            {onRetryMint ? (
              <Button
                label="Retry device setup"
                variant="outline"
                onPress={onRetryMint}
                accessibilityHint="Retry creating the device sign-in for this learner"
                testID="onboarding.complete.retryMint"
              />
            ) : null}
          </>
        ) : null}
        <Button
          label="Start the journey"
          onPress={() => router.replace("/journey")}
          accessibilityHint="Open the learning journey map"
          testID="onboarding.complete.gotoJourney"
        />
        <Button
          label="Home"
          variant="outline"
          onPress={() => router.dismissAll()}
          accessibilityHint="Return to the app launcher"
          testID="onboarding.complete.home"
        />
      </View>
    </StepScroll>
  );
}
