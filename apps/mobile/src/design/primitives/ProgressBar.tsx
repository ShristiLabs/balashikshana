/**
 * Kid-scale progress bar: chunky rounded track with a bright fill.
 * Display-only (not a touch target); exposes progressbar semantics.
 */
import React from "react";
import { View } from "react-native";
import { useTheme } from "../theme";
import { radius } from "../tokens";

export interface ProgressBarProps {
  /** 0..1; values outside the range are clamped. */
  progress: number;
  accessibilityLabel: string;
  testID?: string;
}

const TRACK_HEIGHT = 14;

export function ProgressBar({ progress, accessibilityLabel, testID }: ProgressBarProps) {
  const { colors } = useTheme();
  const clamped = Math.min(1, Math.max(0, progress));

  return (
    <View
      accessible
      accessibilityLabel={`${accessibilityLabel}: ${Math.round(clamped * 100)} percent`}
      testID={testID}
      style={{
        height: TRACK_HEIGHT,
        borderRadius: radius.pill,
        backgroundColor: colors.progressTrack,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          height: TRACK_HEIGHT,
          width: `${Math.round(clamped * 100)}%`,
          borderRadius: radius.pill,
          backgroundColor: colors.progressFill,
        }}
      />
    </View>
  );
}
