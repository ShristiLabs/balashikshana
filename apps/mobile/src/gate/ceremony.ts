/**
 * Key ceremony state machine (issue #51) — PURE.
 *
 * The ceremony is a celebration moment, NEVER a gate: every phase is
 * skippable, and under reduced motion the reveal is INSTANT (the
 * machine starts at "revealed" — no load-bearing animation exists).
 * The visual scales a key badge in when motion is enabled and renders
 * the final state immediately otherwise.
 */
export type CeremonyKind = "silver" | "gold";

export type CeremonyPhase = "building" | "revealed" | "dismissed";

export interface CeremonyState {
  kind: CeremonyKind;
  phase: CeremonyPhase;
}

export const CEREMONY_BUILD_MS = 400;

export function initialCeremony(kind: CeremonyKind, animationsEnabled: boolean): CeremonyState {
  // Reduced motion: start at the reveal — the build animation is
  // decorative, so it is skipped entirely, not sped up.
  return { kind, phase: animationsEnabled ? "building" : "revealed" };
}

export function ceremonyReducer(state: CeremonyState, event: "built" | "dismiss"): CeremonyState {
  switch (event) {
    case "built":
      return state.phase === "building" ? { ...state, phase: "revealed" } : state;
    case "dismiss":
      return { ...state, phase: "dismissed" };
  }
}

export interface CeremonyCopy {
  title: string;
  body: string;
  /** Provisional note (D8: local gate outcomes stay provisional until #48 sync confirms). */
  provisionalNote: string | null;
  a11yLabel: string;
}

export function ceremonyCopy(kind: CeremonyKind, provisional: boolean): CeremonyCopy {
  if (kind === "gold") {
    return {
      title: "Gold key earned!",
      body: "Your sleep made it stick. This key is yours for good.",
      provisionalNote: provisional ? "Checking with your online journal..." : null,
      a11yLabel: provisional
        ? "Gold key earned. Waiting for the online check to confirm it."
        : "Gold key earned and confirmed.",
    };
  }
  return {
    title: "Silver key earned!",
    body: "You beat the boss gate! A Gold key check unlocks after a good night's sleep.",
    provisionalNote: provisional ? "Checking with your online journal..." : null,
    a11yLabel: provisional
      ? "Silver key earned. Waiting for the online check to confirm it."
      : "Silver key earned and confirmed.",
  };
}
