/**
 * Garden health header (issue #49): the aggregate mastery/gate-health
 * visual. Every number shown comes from computeGardenHealth (pure model
 * math over the student's progress rows) — nothing here is hardcoded.
 *
 * The visual: a ProgressBar for overall mastery plus a three-flower SVG
 * strip whose BLOOM state maps the computed band (buds = sprouting,
 * half-open = growing, full bloom = thriving). Flowers are SVG geometry
 * (no rasters, no emoji) and the band is also spelled out in text with
 * a statusInk color, so the metaphor survives color-blindness and the
 * highContrast theme.
 */
import React from "react";
import { Text, View } from "react-native";
import { Path, Svg } from "react-native-svg";
import { useTheme } from "../design/theme";
import { ProgressBar } from "../design/primitives";
import { spacing, typeRamp } from "../design/tokens";
import { gardenBandLabel } from "./art";
import type { GardenBand, GardenHealth as GardenHealthData } from "./model";

/** One flower: stem + petals whose spread encodes the bloom level. */
function flowerBloom(band: GardenBand): string {
  // Petal radius/shape by band: bud (tight circle), growing (5 petals),
  // thriving (6 full petals + center).
  if (band === "sprouting") return "M 0 0 m -4 0 a 4 4 0 1 0 8 0 a 4 4 0 1 0 -8 0";
  if (band === "growing") {
    return "M 0 0 m -5 0 a 5 5 0 1 0 10 0 a 5 5 0 1 0 -10 0 M 0 -9 a 3 3 0 1 0 0.1 0";
  }
  return "M 0 0 m -6 0 a 6 6 0 1 0 12 0 a 6 6 0 1 0 -12 0 M 0 -11 a 4 4 0 1 0 0.1 0 M 0 11 a 4 4 0 1 0 0.1 0 M -11 0 a 4 4 0 1 0 0.1 0 M 11 0 a 4 4 0 1 0 0.1 0";
}

export function GardenHealthView({ garden }: { garden: GardenHealthData }) {
  const { colors } = useTheme();
  const ink =
    garden.band === "thriving"
      ? colors.statusInk.success
      : garden.band === "growing"
        ? colors.statusInk.warning
        : colors.textMuted;

  return (
    <View
      accessible
      accessibilityLabel={
        `${gardenBandLabel(garden.band)}. ` +
        `${garden.masteredUnits} of ${garden.totalUnits} units mastered. ` +
        `Overall mastery ${Math.round(garden.overallPct)} percent. ` +
        `${garden.silverKeys} silver keys, ${garden.goldKeys} gold keys.`
      }
      style={{
        backgroundColor: colors.surface,
        borderRadius: 16,
        borderCurve: "continuous",
        borderWidth: 2,
        borderColor: colors.border,
        padding: spacing.lg,
        gap: spacing.sm,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
        <Svg width={64} height={40} viewBox="-32 -20 64 40">
          {[0, 1, 2].map((i) => (
            <Path
              key={i}
              d={flowerBloom(garden.band)}
              fill="none"
              stroke={ink}
              strokeWidth={2.5}
              transform={`translate(${(i - 1) * 20} ${i === 1 ? -4 : 2})`}
            />
          ))}
          <Path d="M -24 14 C -12 10, 12 18, 24 12" fill="none" stroke={ink} strokeWidth={2.5} />
        </Svg>
        <View style={{ flex: 1, gap: spacing.xs }}>
          <Text style={{ ...typeRamp.title, color: colors.text }}>
            {gardenBandLabel(garden.band)}
          </Text>
          <Text style={{ ...typeRamp.caption, color: colors.textMuted }}>
            {`${garden.masteredUnits} of ${garden.totalUnits} units mastered` +
              (garden.gateHealthPct > 0
                ? ` - gate health ${Math.round(garden.gateHealthPct)}%`
                : "")}
          </Text>
        </View>
      </View>
      <ProgressBar
        progress={Math.min(1, garden.overallPct / 100)}
        accessibilityLabel={`Overall mastery ${Math.round(garden.overallPct)} percent`}
      />
      <View style={{ flexDirection: "row", gap: spacing.md }}>
        <Text style={{ ...typeRamp.caption, color: colors.statusInk.info }}>
          {`${garden.silverKeys} silver keys`}
        </Text>
        <Text style={{ ...typeRamp.caption, color: colors.statusInk.warning }}>
          {`${garden.goldKeys} gold keys`}
        </Text>
      </View>
    </View>
  );
}
