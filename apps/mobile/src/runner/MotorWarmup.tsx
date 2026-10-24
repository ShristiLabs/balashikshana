/**
 * Motor warm-up (issue #50): the 3-tap calibration that opens every
 * practice session. Three big targets appear one at a time; the
 * screen->tap latency of each is fed to the ENGINE's
 * computeMotorBaselineSec (median, clamped 0.15-1.5 s) and the result
 * becomes the session's motor baseline - the same math the server and
 * the #47 recorder apply to every attempt's cognitive time.
 *
 * No animation is load-bearing: targets appear instantly (reduced
 * motion changes nothing about the flow), and a mistimed series simply
 * produces a clamped baseline.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { computeMotorBaselineSec } from "@balashikshana/core-engine";
import { useTheme } from "../design/theme";
import { spacing, typeRamp } from "../design/tokens";

const TAP_COUNT = 3;

export interface MotorWarmupProps {
  onComplete: (motorBaselineSec: number) => void;
  testID?: string;
}

export function MotorWarmup({ onComplete, testID }: MotorWarmupProps): React.ReactElement {
  const { colors } = useTheme();
  const [tapsDone, setTapsDone] = useState(0);
  const shownAtRef = useRef<number>(0);
  const tapSecsRef = useRef<number[]>([]);

  // The first target's window opens at mount (never during render).
  useEffect(() => {
    shownAtRef.current = Date.now();
  }, []);

  const handleTap = useCallback(() => {
    const latencySec = shownAtRef.current > 0 ? (Date.now() - shownAtRef.current) / 1000 : 0.5;
    const taps = [...tapSecsRef.current, latencySec].slice(0, TAP_COUNT);
    tapSecsRef.current = taps;
    const done = taps.length;
    setTapsDone(done);
    if (done >= TAP_COUNT) {
      // The engine owns the math (median of the three, clamped); a
      // degenerate series can never leave the 0.15-1.5 band.
      onComplete(computeMotorBaselineSec(taps));
      return;
    }
    shownAtRef.current = Date.now();
  }, [onComplete]);

  return (
    <View
      testID={testID}
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: spacing.xl,
        padding: spacing.xxl,
      }}
      accessibilityLabel="Quick warm-up"
    >
      <Text style={{ ...typeRamp.h2, color: colors.text, textAlign: "center" }}>
        Quick finger warm-up!
      </Text>
      <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted, textAlign: "center" }}>
        {`Tap the circle as soon as it appears. ${TAP_COUNT - tapsDone} more tap${
          TAP_COUNT - tapsDone === 1 ? "" : "s"
        }!`}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Tap now"
        onPress={handleTap}
        testID={`${testID ?? "warmup"}-target`}
        style={({ pressed }) => ({
          width: 132,
          height: 132,
          borderRadius: 66,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: pressed ? colors.secondary.fillBottom : colors.secondary.fill,
          opacity: tapsDone >= TAP_COUNT ? 0.4 : 1,
        })}
      >
        <Text style={{ ...typeRamp.display, color: colors.secondary.label }}>TAP</Text>
      </Pressable>
      <View
        style={{ flexDirection: "row", gap: spacing.md }}
        accessibilityLabel={`${tapsDone} of ${TAP_COUNT} taps done`}
      >
        {Array.from({ length: TAP_COUNT }, (_, i) => (
          <View
            key={i}
            testID={`${testID ?? "warmup"}-dot-${i + 1}`}
            style={{
              width: 16,
              height: 16,
              borderRadius: 8,
              backgroundColor: i < tapsDone ? colors.success : colors.progressTrack,
            }}
          />
        ))}
      </View>
    </View>
  );
}
