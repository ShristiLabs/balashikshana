/**
 * BadgeBloomView (issue #58) — the mastery badge bloom visual.
 *
 * The #55 catalog badge blooming: tier-shaped silhouette (bronze
 * circle / silver pentagon / gold hexagon — shape-redundant with
 * color, the journey art doctrine), the registry's gold_stars_12 burst
 * ring, and the badge TITLE as visible text (a11y: the moment is
 * never color- or animation-only). A spring scale-in WHEN MOTION IS
 * ENABLED; the identical fully-bloomed state renders instantly under
 * reduced motion. Display-only: no pressable, no touch target.
 */
import React, { useEffect, useState } from "react";
import { Animated, Text, View } from "react-native";
import { Path, Svg } from "react-native-svg";
import { useTheme } from "../design/theme";
import { spacing, typeRamp } from "../design/tokens";
import { badgeSilhouetteForTier, badgeTierColors, starAt, starBurstPositions } from "./mascotArt";
import { MASCOT_MOTION_TOKENS } from "./mascotMachine";

export interface BadgeBloomBadge {
  /** #55 catalog badge id. */
  id: string;
  title: string;
  tier: "bronze" | "silver" | "gold" | null;
  description: string | null;
}

export interface BadgeBloomViewProps {
  badge: BadgeBloomBadge;
  /** False (reduced motion): render the fully-bloomed state instantly. */
  animationsEnabled: boolean;
  testID?: string;
}

export function BadgeBloomView({
  badge,
  animationsEnabled,
  testID,
}: BadgeBloomViewProps): React.ReactElement {
  const { colors } = useTheme();
  const tier = badge.tier ?? "bronze";
  const silhouette = badgeSilhouetteForTier(tier);
  const tierColors = badgeTierColors(colors, tier);

  const [scale] = useState(() => new Animated.Value(animationsEnabled ? 0.4 : 1));
  useEffect(() => {
    if (!animationsEnabled) return;
    const animation = Animated.spring(scale, {
      toValue: 1,
      useNativeDriver: true,
      stiffness: MASCOT_MOTION_TOKENS.pickupSpringStiffness,
      damping: MASCOT_MOTION_TOKENS.pickupSpringDamping,
    });
    animation.start();
    return () => animation.stop();
  }, [animationsEnabled, scale]);

  const a11yLabel =
    `Badge earned: ${badge.title}.` + (badge.description ? ` ${badge.description}` : "");

  return (
    <View
      accessible
      accessibilityLabel={a11yLabel}
      accessibilityRole="image"
      style={{ alignItems: "center", gap: spacing.xs, minWidth: 132 }}
      testID={testID}
    >
      <Animated.View style={{ transform: [{ scale }] }}>
        <Svg width={104} height={104} viewBox="-30 -30 60 60">
          {starBurstPositions(MASCOT_MOTION_TOKENS.snapBurstStars, 26).map((point, index) => (
            <Path
              key={`bloom-star-${index}`}
              d={starAt(point.x, point.y, 2.6)}
              fill={colors.gold.fill}
            />
          ))}
          <Path
            d={silhouette}
            fill={tierColors.fill}
            stroke={tierColors.stroke}
            strokeWidth={1.2}
          />
          {/* Mastery star set into the badge (shape-carried meaning). */}
          <Path d={starAt(0, 0, 6)} fill={colors.primary.fill} />
        </Svg>
      </Animated.View>
      <Text style={{ ...typeRamp.label, color: colors.text, textAlign: "center" }}>
        {badge.title}
      </Text>
    </View>
  );
}
