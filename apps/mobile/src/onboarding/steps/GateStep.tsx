/**
 * Step 1 - parental gate (hold-to-confirm). Everything parent-facing in
 * onboarding sits behind this gate; the same component guards /parent.
 */
import React from "react";
import { ParentalGate } from "../ParentalGate";
import { StepHeading, StepScroll } from "./shared";

export interface GateStepProps {
  onPassed: () => void;
}

export function GateStep({ onPassed }: GateStepProps) {
  return (
    <StepScroll testID="onboarding.step.gate">
      <StepHeading
        title="Set up Balashikshana"
        subtitle="This one-time setup is for a grown-up: creating your parent account, reviewing the consent policy, and adding your learner."
      />
      <ParentalGate onPassed={onPassed} contextLabel="setup" testID="onboarding.gate" />
    </StepScroll>
  );
}
