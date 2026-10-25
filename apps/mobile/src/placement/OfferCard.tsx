/**
 * Placement offer card (issue #60) — the journey-map surface of the
 * placement diagnostic, shown ONCE per (student, grade) at FIRST grade
 * entry (fresh onboarding landing or a first switch into a new grade).
 *
 * NEVER BLOCKS: the card is a gentle banner in the journey header; the
 * map underneath stays fully interactive the whole time it is visible.
 * Declining writes the device-local decision (never re-asked for the
 * grade); accepting routes to the placement screen. If the app dies
 * before either, no record exists and the card re-appears on the next
 * journey mount — the #44 resumability rule carried into #60.
 */
import React from "react";
import { Text, View } from "react-native";
import { Button } from "../design/primitives";
import { useTheme } from "../design/theme";
import { spacing, typeRamp } from "../design/tokens";
import { PLACEMENT_COPY } from "./copy";

export interface PlacementOfferCardProps {
  /** The grade the offer is for (the journey's ACTIVE grade). */
  gradeId: string;
  onAccept: (gradeId: string) => void;
  onDecline: (gradeId: string) => void;
  testID?: string;
}

export function PlacementOfferCard({
  gradeId,
  onAccept,
  onDecline,
  testID,
}: PlacementOfferCardProps): React.ReactElement {
  const { colors } = useTheme();
  return (
    <View
      testID={testID}
      accessibilityLabel={PLACEMENT_COPY.offer.title}
      style={{
        padding: spacing.lg,
        borderRadius: 16,
        borderWidth: 2,
        borderColor: colors.border,
        backgroundColor: colors.surfaceTinted,
        gap: spacing.md,
      }}
    >
      <Text style={{ ...typeRamp.h3, color: colors.text }}>{PLACEMENT_COPY.offer.title}</Text>
      <Text style={{ ...typeRamp.body, color: colors.text }}>{PLACEMENT_COPY.offer.body}</Text>
      <View style={{ flexDirection: "row", gap: spacing.md, flexWrap: "wrap" }}>
        <Button
          label={PLACEMENT_COPY.offer.accept}
          onPress={() => onAccept(gradeId)}
          accessibilityHint="Start the short exploration to find a starting point"
          testID="placement-offer-accept"
        />
        <Button
          label={PLACEMENT_COPY.offer.decline}
          variant="outline"
          onPress={() => onDecline(gradeId)}
          accessibilityHint="Skip the exploration and begin at the first unit"
          testID="placement-offer-decline"
        />
      </View>
    </View>
  );
}
