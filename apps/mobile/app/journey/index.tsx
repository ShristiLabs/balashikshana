/**
 * Journey map placeholder. The winding-path screen (unit nodes with
 * lock/Silver/Gold key states, garden health, grade switcher) is a
 * later M3 issue; this placeholder keeps the route alive.
 */
import React from "react";
import { PlaceholderScreen } from "../../src/shell/PlaceholderScreen";

export default function JourneyScreen() {
  return (
    <PlaceholderScreen
      title="Journey"
      subtitle="Your learning path through the units"
      body="The winding journey map with unit banners, topic stones, key states, and the grade switcher arrives with the journey-map milestone."
      plannedIn="M3 journey map"
      nextLabel="Start a practice session"
      nextHref="/practice"
    />
  );
}
