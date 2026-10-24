/**
 * Step 6 - grade selection (Pre-K - Grade 3). Choosing the grade fires
 * the consent-gated child creation + device-session mint (the flow's
 * submitChild action); this screen stays presentational: pick a grade,
 * show busy/error states.
 *
 * SEAM (#46 content pipeline): once content packs exist, the grade choice
 * is also the pack-download trigger. The flow calls
 * onGradeChosen(gradeId); the download call chains AFTER the create+mint
 * sequence there - NOT here - so #46 can insert
 * contentPacks.downloadForGrade(gradeId) at a single site.
 */
import React, { useState } from "react";
import { Text, View } from "react-native";
import { PressableCard } from "../../design/primitives";
import { useTheme } from "../../design/theme";
import { spacing, typeRamp } from "../../design/tokens";
import { GRADE_IDS, GRADE_LABELS, type GradeId } from "../types";
import { ErrorBanner, StepHeading, StepScroll } from "./shared";
import { ApiError } from "../api";

export interface GradeStepProps {
  /** Draft being submitted (shown for confirmation context). */
  childNickname: string;
  childAvatar: string;
  /** True when resuming an in-flight submission (kill before response). */
  resumingSubmission: boolean;
  onGradeChosen: (gradeId: GradeId) => Promise<void>;
}

const GRADE_BLURBS: Record<GradeId, string> = {
  "pre-k": "Ages 3-4. Playful first steps with numbers and letters.",
  kindergarten: "Age 5. Counting, phonics, and first words.",
  "grade-1": "Age 6. Early reading, addition, and subtraction.",
  "grade-2": "Age 7. Fluency building across math and reading.",
  "grade-3": "Age 8. Advanced practice and mastery challenges.",
};

export function GradeStep({
  childNickname,
  childAvatar,
  resumingSubmission,
  onGradeChosen,
}: GradeStepProps) {
  const { colors } = useTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const choose = async (gradeId: GradeId) => {
    setError(null);
    setBusy(true);
    try {
      await onGradeChosen(gradeId);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError("unknown", "Unexpected error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepScroll testID="onboarding.step.grade">
      <StepHeading
        title="Choose a grade"
        subtitle={`Which grade is ${childAvatar} ${childNickname} starting in? You can change this later.`}
      />
      {resumingSubmission ? (
        <Text style={{ ...typeRamp.caption, color: colors.statusInk.info }}>
          Finishing a setup step that was interrupted - pick the grade again to complete it.
        </Text>
      ) : null}
      <ErrorBanner error={error} />
      <View style={{ gap: spacing.md, marginTop: spacing.md }}>
        {GRADE_IDS.map((gradeId) => (
          <PressableCard
            key={gradeId}
            onPress={() => void choose(gradeId)}
            disabled={busy}
            accessibilityLabel={`${GRADE_LABELS[gradeId]}: ${GRADE_BLURBS[gradeId]}`}
            accessibilityHint={`Create the learner profile in ${GRADE_LABELS[gradeId]}`}
            testID={`onboarding.grade.${gradeId}`}
          >
            <View style={{ gap: spacing.xs }}>
              <Text style={{ ...typeRamp.title, color: colors.text }}>{GRADE_LABELS[gradeId]}</Text>
              <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
                {GRADE_BLURBS[gradeId]}
              </Text>
            </View>
          </PressableCard>
        ))}
        {busy ? (
          <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
            Setting things up...
          </Text>
        ) : null}
      </View>
    </StepScroll>
  );
}
