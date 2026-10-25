/**
 * MascotView (issue #58) — the thin RN layer over the pure machine.
 *
 * Renders the first-party SVG mascot for the current pose. The mascot
 * is DECORATIVE: the whole subtree is hidden from accessibility
 * (screen readers get the ceremony copy instead — text redundancy) and
 * pointerEvents="none" so it can never block or swallow a touch
 * target. Animations are transform-only on the RN Animated driver
 * (native/UI thread — the 60fps target); under reduced motion no
 * Animated call runs at all and the pose's end-state geometry renders
 * statically (same information, zero motion; the ceremony.ts
 * precedent: decorative animation is skipped, never load-bearing).
 */
import React, { useEffect, useState } from "react";
import { Animated } from "react-native";
import { Path, Svg } from "react-native-svg";
import { useTheme } from "../design/theme";
import { MASCOT_ART, mascotAccent, starAt, starBurstPositions } from "./mascotArt";
import { MASCOT_MOTION_TOKENS, type MascotState, mascotFrameFor } from "./mascotMachine";

export interface MascotViewProps {
  /** Live machine state (from useMascot or a constructed celebrate state). */
  state: MascotState;
  /** False (reduced motion): render the static end-state frame. */
  animationsEnabled: boolean;
  /** Rendered square size in points. */
  size?: number;
  testID?: string;
}

export function MascotView({
  state,
  animationsEnabled,
  size = 64,
  testID,
}: MascotViewProps): React.ReactElement {
  const { colors } = useTheme();
  const pose = mascotFrameFor(state, animationsEnabled);
  const art = MASCOT_ART[pose];
  const accent = mascotAccent(colors, art.accentToken);

  // Animated.Value created once (lazy useState — the KeyCeremony
  // pattern); never read during render.
  const [anim] = useState(() => new Animated.Value(1));

  useEffect(() => {
    if (!animationsEnabled) {
      // Reduced motion: end-state frame, no animation at all.
      anim.setValue(1);
      return;
    }
    let animation: Animated.CompositeAnimation | null = null;
    switch (pose) {
      case "idle_breathe": {
        // Registry: loop, 2000ms — a gentle 3% breathe.
        animation = Animated.loop(
          Animated.sequence([
            Animated.timing(anim, {
              toValue: 1.03,
              duration: MASCOT_MOTION_TOKENS.idleBreatheLoopMs / 2,
              useNativeDriver: true,
            }),
            Animated.timing(anim, {
              toValue: 1,
              duration: MASCOT_MOTION_TOKENS.idleBreatheLoopMs / 2,
              useNativeDriver: true,
            }),
          ]),
        );
        break;
      }
      case "touch_pickup_scale": {
        // Registry: scale 1.12, spring stiffness 320 / damping 22.
        animation = Animated.spring(anim, {
          toValue: MASCOT_MOTION_TOKENS.pickupScale,
          stiffness: MASCOT_MOTION_TOKENS.pickupSpringStiffness,
          damping: MASCOT_MOTION_TOKENS.pickupSpringDamping,
          useNativeDriver: true,
        });
        break;
      }
      case "snap_target_confirm": {
        // Registry: 450ms pop with the 12-star burst (stars are part of
        // the end-state geometry; the transform is the pop).
        animation = Animated.sequence([
          Animated.timing(anim, {
            toValue: 1.18,
            duration: MASCOT_MOTION_TOKENS.snapConfirmMs,
            useNativeDriver: true,
          }),
          Animated.timing(anim, {
            toValue: 1,
            duration: MASCOT_MOTION_TOKENS.snapConfirmMs,
            useNativeDriver: true,
          }),
        ]);
        break;
      }
      case "hint_path_bezier_glow": {
        // Registry: loop, 1500ms — a soft glow pulse.
        animation = Animated.loop(
          Animated.sequence([
            Animated.timing(anim, {
              toValue: 1.05,
              duration: MASCOT_MOTION_TOKENS.hintGlowLoopMs / 2,
              useNativeDriver: true,
            }),
            Animated.timing(anim, {
              toValue: 1,
              duration: MASCOT_MOTION_TOKENS.hintGlowLoopMs / 2,
              useNativeDriver: true,
            }),
          ]),
        );
        break;
      }
      case "gentle_bounce_back": {
        // Registry: 350ms settle-back bounce (the growth reframe).
        animation = Animated.sequence([
          Animated.timing(anim, {
            toValue: 0.9,
            duration: MASCOT_MOTION_TOKENS.bounceBackMs / 2,
            useNativeDriver: true,
          }),
          Animated.spring(anim, {
            toValue: 1,
            stiffness: MASCOT_MOTION_TOKENS.pickupSpringStiffness,
            damping: MASCOT_MOTION_TOKENS.pickupSpringDamping,
            useNativeDriver: true,
          }),
        ]);
        break;
      }
      case "mastery_badge_bloom": {
        // Registry: 1800ms bloom — scale in from a bud.
        animation = Animated.spring(anim, {
          toValue: 1,
          stiffness: MASCOT_MOTION_TOKENS.pickupSpringStiffness,
          damping: MASCOT_MOTION_TOKENS.pickupSpringDamping,
          useNativeDriver: true,
        });
        break;
      }
    }
    if (animation) {
      if (pose === "mastery_badge_bloom") anim.setValue(0.6);
      animation.start();
      return () => animation?.stop();
    }
    return undefined;
  }, [anim, animationsEnabled, pose]);

  return (
    <Animated.View
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      pointerEvents="none"
      style={{ width: size, height: size, transform: [{ scale: anim }] }}
      testID={testID}
    >
      <Svg width={size} height={size} viewBox="-24 -30 48 60">
        {/* Star burst ring for the celebrate/snap moments (registry
            gold_stars_12): part of the END-STATE geometry so the static
            reduced-motion frame carries the same burst, fully spread. */}
        {pose === "mastery_badge_bloom" || pose === "snap_target_confirm"
          ? starBurstPositions(MASCOT_MOTION_TOKENS.snapBurstStars, 21).map((point, index) => (
              <Path
                key={`burst-star-${index}`}
                d={starAt(point.x, point.y, 2.4)}
                fill={colors.gold.fill}
              />
            ))
          : null}
        {art.extra.length > 0 ? <Path d={art.extra} fill={colors.gold.fill} /> : null}
        <Path d={art.leaves} fill={accent} />
        <Path d={art.body} fill={colors.primary.fill} />
        <Path d={art.eyes} fill={colors.text} />
        <Path d={art.mouth} fill={colors.text} />
        <Path
          d={art.arms}
          fill="none"
          stroke={colors.text}
          strokeWidth={1.6}
          strokeLinecap="round"
        />
      </Svg>
    </Animated.View>
  );
}
