/**
 * Placement copy (issue #60) — the app-copy module for every string the
 * placement surfaces render (the #59 registry owns per-TOPIC lines; this
 * module owns the flow's own copy, the games' ceremonyCopy precedent).
 *
 * Kid-safety doctrine (issue body): the diagnostic is framed as a short
 * EXPLORATION, never a test — no scores, no pass/fail, no anxiety
 * vocabulary; mistakes are neutral; the offer is skippable and the
 * gentle start is always offered. No brand references (invariant 4).
 */

export const PLACEMENT_COPY = Object.freeze({
  offer: Object.freeze({
    title: "New learning journey!",
    body: "Would you like to find just the right starting spot? A few quick questions and we begin exactly where it feels comfortable.",
    accept: "Find my starting spot",
    decline: "Start from the beginning",
  }),
  probe: Object.freeze({
    title: "Quick exploration",
    promptHint: "Pick the answer that feels right. Every answer helps.",
    progress: (asked: number, total: number) => `Question ${asked} of at most ${total}`,
  }),
  recommendation: Object.freeze({
    title: "Your starting spot is ready!",
    recommendedBody: (unitTitle: string) =>
      `Based on the exploration, beginning at "${unitTitle}" feels just right. You can always revisit earlier adventures from the journey map.`,
    gentleBody: (unitTitle: string) =>
      `Prefer to begin at the very start? "${unitTitle}" is waiting — the journey moves at your pace either way.`,
    startRecommended: (unitTitle: string) => `Start at ${unitTitle}`,
    startGentle: "Start from the beginning",
    celebration:
      "All done! Mistakes grow your brain, and every answer you gave helps us pick your perfect starting spot.",
  }),
  screen: Object.freeze({
    loading: "Getting ready...",
    noPackTitle: "Content pack needed",
    noPackBody:
      "The learning pack for this grade is not on the device yet. Connect to the internet and try again from the journey map.",
    errorTitle: "Something went wrong",
    errorBody: "The exploration could not start. You can try again from the journey map.",
    exit: "Back to the journey",
  }),
});
