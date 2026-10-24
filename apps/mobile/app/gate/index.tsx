/**
 * Boss gate placeholder. The five-condition gate session, per-condition
 * results screen, and the Silver/Gold key ceremony are a later M3
 * issue; this placeholder keeps the route alive.
 */
import React from "react";
import { PlaceholderScreen } from "../../src/shell/PlaceholderScreen";

export default function GateScreen() {
  return (
    <PlaceholderScreen
      title="Boss Gate"
      subtitle="Unit mastery assessment"
      body="The five-condition gate session, results breakdown, and key ceremony with the 14-hour Gold verification check arrive with the boss-gate milestone."
      plannedIn="M3 boss gate"
      nextLabel="Back to the journey"
      nextHref="/journey"
    />
  );
}
