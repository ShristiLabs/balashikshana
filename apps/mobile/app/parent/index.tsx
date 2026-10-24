/**
 * Parent area placeholder.
 *
 * SEAM (#44): the parental gate (hold-to-confirm challenge per the
 * roadmap's parental-gate seam) mounts here BEFORE any parent content
 * renders. Nothing behind this seam may touch child data until the
 * gate passes; the milestone that builds the parent surface owns it.
 */
import React from "react";
import { PlaceholderScreen } from "../../src/shell/PlaceholderScreen";

export default function ParentScreen() {
  return (
    <PlaceholderScreen
      title="Parent Area"
      subtitle="Settings and progress for grown-ups"
      body="The parental gate and parent surface land with the onboarding milestone; this shell keeps the route reachable but inert."
      plannedIn="#44"
    />
  );
}
