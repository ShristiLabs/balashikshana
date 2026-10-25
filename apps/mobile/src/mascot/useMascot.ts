/**
 * useMascot (issue #58) — the session-screen hook over the pure
 * machine. Owns exactly two RN concerns: the reducer and the expiry
 * tick (a coarse interval that only dispatches `tick`; the machine
 * decides whether the pose expired). Screen callers fire the session
 * events (answer-correct / answer-gentle-retry / touch-pickup /
 * snap-confirm / hint-shown) and this hook keeps the mascot honest.
 * Under reduced motion the SAME transitions run — the view renders
 * static frames.
 */
import { useCallback, useEffect, useReducer } from "react";
import {
  initialMascotState,
  mascotTransition,
  type MascotEvent,
  type MascotState,
} from "./mascotMachine";

const TICK_MS = 200;

/**
 * The fireable event shape: every union member minus its clock field.
 * Written DISTRIBUTIVELY (Omit over a union collapses to the common
 * keys, which would drop celebrate's moment payload — #60 needs to fire
 * celebrate for the placement outcome).
 */
export type FireableMascotEvent = MascotEvent extends infer T
  ? T extends { nowMs: number }
    ? Omit<T, "nowMs">
    : T
  : never;

export function useMascot(nowMs: () => number = () => Date.now()): {
  state: MascotState;
  fire: (event: FireableMascotEvent) => void;
} {
  const [state, dispatch] = useReducer(
    (prev: MascotState, event: MascotEvent | { type: "init" }) =>
      event.type === "init" ? prev : mascotTransition(prev, event),
    undefined,
    () => initialMascotState(nowMs()),
  );

  // Expiry tick: only while a transient pose is live (idle never sets a
  // deadline, so no timer runs at rest).
  useEffect(() => {
    if (state.expiresAtMs === null) return;
    const timer = setInterval(() => {
      dispatch({ type: "tick", nowMs: nowMs() });
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [state.expiresAtMs, nowMs]);

  const fire = useCallback(
    (event: FireableMascotEvent) => {
      dispatch({ ...event, nowMs: nowMs() } as MascotEvent);
    },
    [nowMs],
  );

  return { state, fire };
}
