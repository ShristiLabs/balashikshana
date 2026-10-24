/**
 * Practice session placeholder. The interaction runner (tap-count,
 * drag-tile, choice, CPA scaffold stages, Lag +2/+5/+10 re-queue) is a
 * later M3 issue; this placeholder keeps the route alive.
 */
import React from "react";
import { PlaceholderScreen } from "../../src/shell/PlaceholderScreen";

export default function PracticeScreen() {
  return (
    <PlaceholderScreen
      title="Practice"
      subtitle="Seeded interaction practice for the current topic"
      body="The practice runner with all seeded interaction types, CPA scaffold rendering, and in-session re-queueing arrives with the practice-runner milestone."
      plannedIn="M3 practice runner"
      nextLabel="Enter the boss gate"
      nextHref="/gate"
    />
  );
}
