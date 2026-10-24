/**
 * CounterFrame widget (issue #50 widget kit): the concrete-stage
 * interactive counter - a five-column manipulative grid the child taps
 * to place counters, with a live count readout (the validated web
 * harness interaction, as a reusable >=48pt theme-aware widget).
 *
 * Presentational: no session/engine/audio knowledge. The parent owns
 * correctness (the count is reported, never graded here).
 */
import React, { useCallback, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { useTheme } from "../../design/theme";
import { useReducedMotion } from "../../design/useMotion";
import { MIN_TOUCH_TARGET, radius, spacing, typeRamp } from "../../design/tokens";
import type { CounterSpec } from "../questionShapes";

/** Cells per manipulative row (5- and 10- and 20-frames all divide evenly). */
const COLUMNS = 5;

export interface CounterFrameProps {
  spec: CounterSpec;
  /** Filled cell indexes (1-based slot numbers), owned by the parent. */
  filled: number[];
  disabled: boolean;
  /** A cell was tapped (slot indexes are 1-based). */
  onToggleCell: (slot: number) => void;
  testID?: string;
}

export function CounterFrame({
  spec,
  filled,
  disabled,
  onToggleCell,
  testID,
}: CounterFrameProps): React.ReactElement {
  const { colors } = useTheme();
  const { motion } = useReducedMotion();
  const filledSet = useMemo(() => new Set(filled), [filled]);

  const rows = Math.ceil(spec.maxCells / COLUMNS);
  const cells = useMemo(() => Array.from({ length: rows * COLUMNS }, (_, i) => i + 1), [rows]);

  const handle = useCallback(
    (slot: number) => {
      if (!disabled) onToggleCell(slot);
    },
    [disabled, onToggleCell],
  );

  return (
    <View testID={testID} accessibilityLabel="Counting frame" style={{ gap: spacing.md }}>
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: spacing.sm,
        }}
      >
        {cells.map((slot) => {
          const isFilled = filledSet.has(slot);
          const withinFrame = slot <= spec.maxCells;
          return (
            <Pressable
              key={slot}
              accessibilityRole="button"
              accessibilityLabel={`Counter ${slot}${isFilled ? ", filled" : ", empty"}`}
              accessibilityState={{ disabled: disabled || !withinFrame }}
              disabled={disabled || !withinFrame}
              onPress={() => handle(slot)}
              testID={`${testID ?? "counter"}-cell-${slot}`}
              style={({ pressed }) => ({
                minWidth: MIN_TOUCH_TARGET,
                minHeight: MIN_TOUCH_TARGET,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: radius.sm,
                borderCurve: "continuous",
                borderWidth: 2,
                // Shape+color redundancy: filled cells gain BOTH the
                // tinted fill AND the counter glyph; empty cells stay
                // outline-only. Out-of-frame slots render as inert rails.
                backgroundColor: !withinFrame
                  ? colors.surfaceAlt
                  : isFilled
                    ? colors.surfaceTinted
                    : colors.surface,
                borderColor: !withinFrame
                  ? colors.surfaceAlt
                  : isFilled
                    ? colors.info
                    : colors.border,
                opacity: withinFrame ? 1 : 0.35,
                transform: [{ translateY: pressed && withinFrame ? motion.pressTranslateY : 0 }],
              })}
            >
              {isFilled ? (
                <Text style={{ fontSize: 24 }} accessibilityElementsHidden>
                  {spec.emoji}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </View>
      <View style={{ alignItems: "center" }}>
        <Text
          style={{ ...typeRamp.title, color: colors.text }}
          accessibilityLabel={`Current count ${filled.length}`}
          testID={`${testID ?? "counter"}-count`}
        >
          {`Count: ${filled.length}`}
        </Text>
        {spec.targetCount !== null ? (
          <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
            {`Tap to make ${spec.targetCount}`}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
