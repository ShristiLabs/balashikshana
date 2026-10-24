/**
 * VisualScaffold widget (issue #50 widget kit): the CPA pictorial
 * surface - renders the question's visual_objects row inside a labeled
 * card, with the two timed modes the CPA fade needs:
 * - "static":  the pictorial stage's persistent picture.
 * - "flash":   the ghost-flash stage's one-second peek, then hidden
 *              (the spec's PICTORIAL_GHOST_FLASH_1S). The window is
 *              CONTENT TIMING, not animation: under reduced motion the
 *              swap is an instant cut, never a fade, and nothing
 *              load-bearing animates.
 *
 * The manipulative anchor chip names the concrete tool in play (derived
 * from the row's visual_aid asset stem - pure data, no curriculum
 * strings in code).
 */
import React, { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { useTheme } from "../../design/theme";
import { MIN_TOUCH_TARGET, radius, spacing, typeRamp } from "../../design/tokens";

export interface VisualScaffoldProps {
  mode: "static" | "flash";
  /** The visual_objects content row (emoji/object string), or null. */
  visualRow: string | null;
  /** Friendly manipulative-anchor label from visual_aid, or null. */
  anchorLabel: string | null;
  /** Flash window in ms (engine ghost-flash stage window). */
  flashMs: number;
  testID?: string;
}

export function VisualScaffold({
  mode,
  visualRow,
  anchorLabel,
  flashMs,
  testID,
}: VisualScaffoldProps): React.ReactElement {
  const { colors } = useTheme();
  // The parent keys this widget per question, so a new question mounts
  // a fresh scaffold: the reveal state initializes for the mode and
  // the effect only ARMS the flash window's hide timer (async - no
  // synchronous setState in the effect).
  const [revealed, setRevealed] = useState(mode !== "flash" || visualRow === null);

  useEffect(() => {
    if (mode !== "flash" || visualRow === null) return undefined;
    const timer = setTimeout(() => setRevealed(false), flashMs);
    return () => clearTimeout(timer);
  }, [mode, visualRow, flashMs]);

  return (
    <View
      testID={testID}
      accessibilityLabel={
        revealed && visualRow !== null ? "Picture for this question" : "Picture hidden"
      }
      style={{
        alignItems: "center",
        gap: spacing.sm,
        minHeight: MIN_TOUCH_TARGET,
        justifyContent: "center",
        padding: spacing.lg,
        borderRadius: radius.lg,
        borderCurve: "continuous",
        borderWidth: 2,
        borderColor: colors.border,
        backgroundColor: colors.surfaceAlt,
      }}
    >
      {revealed && visualRow !== null ? (
        <Text
          testID={`${testID ?? "visual"}-row`}
          style={{ ...typeRamp.display, color: colors.text, textAlign: "center" }}
          accessibilityElementsHidden
        >
          {visualRow}
        </Text>
      ) : (
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
          {mode === "flash" ? "Quick peek over - answer from memory" : ""}
        </Text>
      )}
      {anchorLabel !== null ? (
        <Text style={{ ...typeRamp.caption, color: colors.textMuted }}>{anchorLabel}</Text>
      ) : null}
    </View>
  );
}
