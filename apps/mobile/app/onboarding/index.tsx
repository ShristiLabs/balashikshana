/**
 * Onboarding flow (issue #44): parental gate (hold-to-confirm) -> parent
 * signup/login -> email verification -> consent screens -> add child ->
 * grade selection; resumable after interruption at any step. The driver
 * reconciles persisted + server state on mount and lands on the right
 * step. The #43 placeholder is retired by this screen.
 */
import React from "react";
import { OnboardingFlow } from "../../src/onboarding/OnboardingFlow";

export default function OnboardingScreen() {
  return <OnboardingFlow />;
}
