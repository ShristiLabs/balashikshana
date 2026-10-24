/**
 * Onboarding placeholder. #44 implements the real flow: parental gate
 * (hold-to-confirm) -> parent signup/login -> consent screens -> add
 * child -> grade selection, with interruption-safe resume.
 */
import React from "react";
import { PlaceholderScreen } from "../../src/shell/PlaceholderScreen";

export default function OnboardingScreen() {
  return (
    <PlaceholderScreen
      title="Onboarding"
      subtitle="Parent-guided setup for a new device"
      body="The parental gate, parent account, consent capture, child profile, and grade selection land here in the onboarding milestone."
      plannedIn="#44"
      nextLabel="Continue to journey"
      nextHref="/journey"
    />
  );
}
