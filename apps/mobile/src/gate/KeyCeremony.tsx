/**
 * Key ceremony (issue #51): the Silver/Gold award celebration moment.
 *
 * Audio (star fanfare + celebration narration) and haptics fire from
 * the screen when the ceremony mounts; this component is the visual —
 * the journey's key badge silhouettes (Silver circle / Gold hexagon,
 * shape-redundant with color), a spring scale-in WHEN MOTION IS
 * ENABLED, and the exact same revealed state rendered instantly when
 * reduced motion is on. The animation is decorative: every action and
 * every piece of information works without it.
 *
 * #58 composition: the ceremony is the unit-complete moment — the
 * mascot celebrates beside the key and this session's newly earned
 * #55 badges bloom below (text-redundant titles; static frames under
 * reduced motion). Badges arrive RESOLVED (title/tier/description)
 * from the gate screen; none were earned renders exactly the #51
 * ceremony, nothing new.
 */
import React, { useEffect, useState } from "react";
import { Animated, Pressable, Text, View } from "react-native";
import { Path, Svg } from "react-native-svg";
import { Button } from "../design/primitives";
import { useTheme } from "../design/theme";
import { spacing, typeRamp } from "../design/tokens";
import { goldBadge, silverBadge } from "../journey/art";
import { BadgeBloomView, type BadgeBloomBadge } from "../mascot/BadgeBloomView";
import { MascotView } from "../mascot/MascotView";
import { celebrateMascotState } from "../mascot/CelebrationStack";
import type { CeremonyKind } from "./ceremony";
import { ceremonyCopy } from "./ceremony";

export interface KeyCeremonyProps {
  kind: CeremonyKind;
  provisional: boolean;
  /** False (reduced motion): render the revealed state instantly. */
  animationsEnabled: boolean;
  onDone: () => void;
  /** #58: badges newly earned with the gate session (resolved catalog metadata). */
  badges?: BadgeBloomBadge[];
  testID?: string;
}

export function KeyCeremony({
  kind,
  provisional,
  animationsEnabled,
  onDone,
  badges,
  testID,
}: KeyCeremonyProps): React.ReactElement {
  const { colors } = useTheme();
  const copy = ceremonyCopy(kind, provisional);
  const badge = kind === "gold" ? goldBadge(colors) : silverBadge(colors);
  const mascotState = celebrateMascotState(
    kind === "gold" ? "key-ceremony-gold" : "key-ceremony-silver",
  );

  // Lazy useState (not a ref initializer): the Animated.Value is
  // created exactly once and never read during render.
  const [scale] = useState(() => new Animated.Value(animationsEnabled ? 0.5 : 1));
  useEffect(() => {
    if (!animationsEnabled) return;
    const animation = Animated.spring(scale, {
      toValue: 1,
      useNativeDriver: true,
      speed: 18,
      bounciness: 7,
    });
    animation.start();
    return () => animation.stop();
  }, [animationsEnabled, scale]);

  return (
    <View
      accessible
      accessibilityLabel={copy.a11yLabel}
      accessibilityRole="summary"
      style={{
        flex: 1,
        backgroundColor: colors.background,
        alignItems: "center",
        justifyContent: "center",
        padding: spacing.xxl,
        gap: spacing.lg,
      }}
      testID={testID}
    >
      <Pressable
        accessibilityLabel={badge.label}
        onPress={onDone}
        style={{ minHeight: 96, minWidth: 96, alignItems: "center", justifyContent: "center" }}
      >
        <Animated.View style={{ transform: [{ scale }] }}>
          <Svg width={88} height={88} viewBox="-12 -12 24 24">
            <Path d={badge.silhouette} fill={badge.fill} stroke={colors.text} strokeWidth={0.8} />
          </Svg>
        </Animated.View>
      </Pressable>
      {/* #58: the celebrating mascot beside the key (decorative; the
          summary label above carries the information). */}
      <MascotView
        state={mascotState}
        animationsEnabled={animationsEnabled}
        size={64}
        testID="key-ceremony-mascot"
      />
      <Text style={{ ...typeRamp.h1, color: colors.text, textAlign: "center" }}>{copy.title}</Text>
      <Text style={{ ...typeRamp.body, color: colors.textMuted, textAlign: "center" }}>
        {copy.body}
      </Text>
      {copy.provisionalNote ? (
        <Text style={{ ...typeRamp.caption, color: colors.textMuted, textAlign: "center" }}>
          {copy.provisionalNote}
        </Text>
      ) : null}
      {badges && badges.length > 0 ? (
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            justifyContent: "center",
            gap: spacing.lg,
            paddingTop: spacing.sm,
          }}
        >
          {badges.map((bloom, index) => (
            <BadgeBloomView
              key={`${bloom.id}-${String(index)}`}
              badge={bloom}
              animationsEnabled={animationsEnabled}
              testID={`key-ceremony-bloom-${bloom.id}`}
            />
          ))}
        </View>
      ) : null}
      <View style={{ paddingTop: spacing.lg, minWidth: 220 }}>
        <Button label="Keep going" onPress={onDone} accessibilityHint="Back to the journey map" />
      </View>
    </View>
  );
}
