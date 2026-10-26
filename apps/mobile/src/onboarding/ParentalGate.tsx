/**
 * Parental gate: hold-to-confirm (issue #44, roadmap D5 - COPPA-grade
 * "are you a grown-up" barrier for parent/settings surfaces).
 *
 * The timing model is gateTimer.ts (pure, unit-tested): completion needs a
 * single continuous 3-second press; any release resets. The progress bar
 * reflects timer state - it is NOT the mechanism - so OS reduced-motion
 * (which suppresses animations, not layout) cannot affect gate behavior,
 * and tap-spamming accumulates nothing.
 *
 * Accessibility: the control is announced as a button with a hint
 * describing the hold gesture. There is deliberately NO tap-to-pass
 * accessibility action: a single-tap bypass would defeat the gate for
 * every user. Screen-reader users complete the same hold (double-tap-and-
 * hold / touch-and-hold with the rotor), matching the platform parental-
 * gate conventions Apple and Google publish for kids apps.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Platform, Pressable, Text, View, type ViewStyle } from "react-native";
import { ProgressBar } from "../design/primitives";
import { useTheme } from "../design/theme";
import { controlHeights, radius, spacing, tactile, typeRamp } from "../design/tokens";
import {
  holdPress,
  holdProgress,
  holdRelease,
  holdTick,
  initialHoldState,
  PARENTAL_GATE_HOLD_MS,
  type HoldState,
} from "./gateTimer";

export interface ParentalGateProps {
  /** Called exactly once when the continuous hold completes. */
  onPassed: () => void;
  /** Changes the copy for different protected surfaces. */
  contextLabel?: string;
  testID?: string;
}

const TICK_MS = 100;

export function ParentalGate({
  onPassed,
  contextLabel = "parent settings",
  testID,
}: ParentalGateProps) {
  const { colors } = useTheme();
  const [hold, setHold] = useState<HoldState>(initialHoldState);
  const [progress, setProgress] = useState(0);
  const passedRef = useRef(false);
  // Mirror of `hold` for the timer loop: side effects (setProgress,
  // onPassed) stay OUT of state updaters - the updater stays pure and the
  // interval body computes the next state from the ref.
  const holdRef = useRef<HoldState>(initialHoldState());

  const applyHold = useCallback((next: HoldState) => {
    holdRef.current = next;
    setHold(next);
  }, []);

  // Timer loop: only runs while a press is active and completion has not
  // latched. setInterval (not an animation API) so gate timing is immune
  // to reduced-motion settings by construction.
  useEffect(() => {
    if (!hold.pressing || hold.complete) return;
    const id = setInterval(() => {
      const now = Date.now();
      const next = holdTick(holdRef.current, now);
      applyHold(next);
      setProgress(holdProgress(next, now));
      if (next.complete && !passedRef.current) {
        passedRef.current = true;
        onPassed();
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, [hold.pressing, hold.complete, onPassed, applyHold]);

  const onPressIn = useCallback(() => {
    applyHold(holdPress(holdRef.current, Date.now()));
    setProgress(0);
  }, [applyHold]);

  const onPressOut = useCallback(() => {
    applyHold(holdRelease(holdRef.current));
    setProgress(0);
  }, [applyHold]);

  // KEYBOARD PARITY (#71): react-native-web renders this Pressable as a
  // native <button>, where Enter/Space fire a click (onPress) on key UP
  // but never produce the pressIn/pressOut pair the hold gesture needs.
  // The gate therefore attaches NATIVE DOM keyboard listeners on web
  // (via ref — empirically the reliable path through RNW's composed
  // event props): key DOWN begins the hold, key UP releases it —
  // identical timing model, identical gateTimer, single shared
  // implementation. Auto-repeat keydowns are filtered (repeat); Space
  // is default-prevented so it cannot scroll the page. Native platforms
  // never attach the listener.
  const gateRef = useRef<React.ComponentRef<typeof Pressable> | null>(null);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const el = gateRef.current as unknown as HTMLElement | null;
    if (el === null || typeof el.addEventListener !== "function") return;
    const isHoldKey = (key: string) => key === "Enter" || key === " ";
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isHoldKey(event.key)) return;
      event.preventDefault();
      if (!event.repeat) onPressIn();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!isHoldKey(event.key)) return;
      event.preventDefault();
      onPressOut();
    };
    el.addEventListener("keydown", onKeyDown);
    el.addEventListener("keyup", onKeyUp);
    return () => {
      el.removeEventListener("keydown", onKeyDown);
      el.removeEventListener("keyup", onKeyUp);
    };
  }, [onPressIn, onPressOut]);

  return (
    <View style={{ gap: spacing.lg }} testID={testID ? `${testID}.root` : undefined}>
      <View style={{ gap: spacing.xs }}>
        <Text style={{ ...typeRamp.h3, color: colors.text }}>Grown-ups only</Text>
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
          {`Hold the button for ${PARENTAL_GATE_HOLD_MS / 1000} seconds to unlock ${contextLabel}.`}
        </Text>
      </View>

      <Pressable
        ref={gateRef}
        accessibilityRole="button"
        accessibilityLabel="Hold to confirm you are a grown-up"
        accessibilityHint={
          Platform.OS === "web"
            ? `Hold the Enter or Space key for ${PARENTAL_GATE_HOLD_MS / 1000} seconds without releasing`
            : `Press and hold for ${PARENTAL_GATE_HOLD_MS / 1000} seconds without lifting your finger`
        }
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        testID={testID}
        style={({ pressed }): ViewStyle => ({
          minHeight: controlHeights.lg,
          borderRadius: radius.lg,
          borderCurve: "continuous",
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: spacing.xxl,
          backgroundColor: hold.complete
            ? colors.success
            : pressed
              ? colors.primary.fillBottom
              : colors.primary.fill,
          borderBottomWidth: pressed ? tactile.borderPressed : tactile.borderRest,
          borderBottomColor: colors.primary.fillBottom,
        })}
      >
        <Text style={{ ...typeRamp.label, color: colors.primary.label }}>
          {hold.complete ? "Confirmed" : "Hold to continue"}
        </Text>
      </Pressable>

      <ProgressBar
        progress={progress}
        accessibilityLabel="Parental gate hold progress"
        testID={testID ? `${testID}.progress` : undefined}
      />
    </View>
  );
}
