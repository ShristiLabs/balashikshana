/**
 * Winding-path view (issue #49): renders the pure model's layout.
 *
 * Performance doctrine (60fps on the low-end Android profile):
 * - ONE react-native-svg surface carries all static art (track path,
 *   node bubbles, glyphs, key badges). Node touch targets are thin
 *   absolutely-positioned Pressables over it — no per-node native SVG
 *   hierarchies, no per-frame allocations.
 * - The path `d` and all node positions arrive PRECOMPUTED from the
 *   memoized layoutWindingPath call in the screen; this component never
 *   rebuilds path strings.
 * - The single animated surface is the scroll-linked progress reveal
 *   (reanimated shared value -> animated strokeDashoffset), mounted ONLY
 *   when the motion profile allows it; reduced motion renders the static
 *   reveal computed from the model.
 *
 * A11y: every node is a >=48pt button with a spoken label built by
 * art.ts (state + key + provisional + countdown + "you are here"), and
 * every state/key encoding is shape+color redundant (distinct glyphs;
 * Silver badge = circle, Gold = hexagon).
 */
import React, { useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import Animated, { useAnimatedProps } from "react-native-reanimated";
import type { SharedValue } from "react-native-reanimated";
import { Circle, G, Path, Svg } from "react-native-svg";
import { useTheme } from "../design/theme";
import { MIN_TOUCH_TARGET, nodeSize, spacing, typeRamp } from "../design/tokens";
import type { MotionProfile } from "../design/motion";
import {
  STATE_ART,
  formatCountdown,
  goldBadge,
  nodeAccessibilityLabel,
  silverBadge,
  stateColors,
} from "./art";
import type { JourneyUnitNode, PathLayout } from "./model";

const AnimatedPath = Animated.createAnimatedComponent(Path);

/** Y of the node the reveal should reach (travelled path length proxy). */
function revealLength(layout: PathLayout, upToIndex: number): number {
  const clamped = Math.max(0, Math.min(upToIndex, layout.positions.length - 1));
  const point = layout.positions[clamped];
  return point ? point.y : 0;
}

function NodeArt({
  node,
  index,
  layout,
}: {
  node: JourneyUnitNode;
  index: number;
  layout: PathLayout;
}) {
  const { colors } = useTheme();
  const position = layout.positions[index];
  if (!position) return null;

  const art = STATE_ART[node.state];
  const ink = stateColors(colors, art.token);
  const badge =
    node.keyState === "GOLD_KEY"
      ? goldBadge(colors)
      : node.keyState === "SILVER_KEY"
        ? silverBadge(colors)
        : null;

  return (
    <G>
      {/* Hard bottom edge first (the tactile tokens precedent). */}
      <Circle cx={position.x} cy={position.y + 5} r={32} fill={ink.bottom} />
      <Circle
        cx={position.x}
        cy={position.y}
        r={32}
        fill={ink.fill}
        stroke={node.isCurrent ? colors.focusRing : colors.border}
        strokeWidth={node.isCurrent ? 4 : 2}
        strokeDasharray={node.provisional ? "6 4" : undefined}
      />
      {/* State glyph: the shape-redundant encoding (unique path per state). */}
      <Path
        d={art.glyph}
        fill={ink.ink}
        stroke={ink.ink}
        strokeWidth={node.state === "REMEDIATION_REQUIRED" || node.state === "LOCKED" ? 3 : 0}
        transform={`translate(${position.x} ${position.y})`}
      />
      {/* "You are here" ring for the current node. */}
      {node.isCurrent ? (
        <Circle
          cx={position.x}
          cy={position.y}
          r={40}
          fill="none"
          stroke={colors.focusRing}
          strokeWidth={3}
        />
      ) : null}
      {/* Key badge: Silver = circle, Gold = hexagon (shape redundancy). */}
      {badge ? (
        <Path
          d={badge.silhouette}
          fill={badge.fill}
          stroke={colors.border}
          strokeWidth={2}
          transform={`translate(${position.x + 26} ${position.y + 22})`}
        />
      ) : null}
    </G>
  );
}

export interface JourneyPathProps {
  layout: PathLayout;
  nodes: JourneyUnitNode[];
  width: number;
  /** Scroll-linked reveal driver (0..1); null renders the static reveal. */
  scrollProgress: SharedValue<number> | null;
  motion: MotionProfile;
  onNodePress: (node: JourneyUnitNode) => void;
}

export function JourneyPath(props: JourneyPathProps) {
  const { colors } = useTheme();
  const { layout, nodes, width, motion, onNodePress } = props;

  // Static reveal (reduced motion): everything up to and including the
  // current node — or the whole path when every unit is mastered.
  const staticReveal = useMemo(() => {
    const currentIndex = nodes.findIndex((node) => node.isCurrent);
    return revealLength(layout, currentIndex >= 0 ? currentIndex : nodes.length - 1);
  }, [layout, nodes]);

  const scrollProgress = props.scrollProgress;
  const animatedProps = useAnimatedProps(() => {
    const offset = scrollProgress ? -scrollProgress.value * staticReveal : 0;
    return { strokeDashoffset: offset };
  });
  const dashArray = `${staticReveal} ${layout.height * 4}`;

  return (
    <View style={{ width, height: layout.height }}>
      <Svg width={width} height={layout.height}>
        {/* Track: the full winding path in the muted track token. */}
        <Path
          d={layout.pathD}
          fill="none"
          stroke={colors.progressTrack}
          strokeWidth={12}
          strokeLinecap="round"
        />
        {/* Traveled portion: scroll-linked when motion allows, else static. */}
        {motion.animationsEnabled && scrollProgress !== null ? (
          <AnimatedPath
            d={layout.pathD}
            fill="none"
            stroke={colors.progressFill}
            strokeWidth={12}
            strokeLinecap="round"
            strokeDasharray={dashArray}
            animatedProps={animatedProps}
          />
        ) : (
          <Path
            d={layout.pathD}
            fill="none"
            stroke={colors.progressFill}
            strokeWidth={12}
            strokeLinecap="round"
            strokeDasharray={dashArray}
          />
        )}
        {nodes.map((node, index) => (
          <NodeArt key={node.unitId} node={node} index={index} layout={layout} />
        ))}
      </Svg>

      {/* Touch/a11y overlay: one >=48pt Pressable per node, no art. */}
      {nodes.map((node, index) => {
        const position = layout.positions[index];
        if (!position) return null;
        const art = STATE_ART[node.state];
        const locked = node.state === "LOCKED";
        // Same formatter the spoken label uses — sighted and spoken
        // countdowns must agree (a11y contract).
        const countdownText =
          node.keyState === "SILVER_KEY" && node.goldCountdownMs > 0
            ? `Gold check in ${formatCountdown(node.goldCountdownMs)}`
            : node.goldEligible
              ? "Gold check ready"
              : null;
        return (
          <View
            key={node.unitId}
            style={{
              position: "absolute",
              left: position.x - nodeSize.width / 2,
              top: position.y - nodeSize.height / 2,
              width: nodeSize.width,
              minHeight: MIN_TOUCH_TARGET,
              alignItems: "center",
            }}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={nodeAccessibilityLabel(node)}
              accessibilityHint={art.hint}
              disabled={locked}
              onPress={() => onNodePress(node)}
              style={({ pressed }) => ({
                width: nodeSize.width,
                height: nodeSize.height,
                justifyContent: "center",
                alignItems: "center",
                opacity: locked ? 0.9 : pressed ? 0.75 : 1,
              })}
            >
              <Text
                numberOfLines={1}
                style={{ ...typeRamp.title, color: stateColors(colors, art.token).ink }}
              >
                {`${node.sequenceOrder}`}
              </Text>
            </Pressable>
            <View style={{ alignItems: "center", marginTop: spacing.xs, maxWidth: 160 }}>
              <Text
                numberOfLines={2}
                style={{
                  ...typeRamp.caption,
                  color: locked ? colors.textMuted : colors.text,
                  textAlign: "center",
                }}
              >
                {node.title}
              </Text>
              {countdownText ? (
                <Text
                  style={{
                    ...typeRamp.caption,
                    color: node.goldEligible ? colors.statusInk.success : colors.statusInk.warning,
                  }}
                >
                  {countdownText}
                </Text>
              ) : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}
