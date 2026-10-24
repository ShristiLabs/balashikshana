/**
 * Bubble Pop Blitz archetype renderer (issue #54, pack B) - the reflex
 * tapper registered under "bubble-pop-blitz" (250 registry fluency
 * topics across all five grades).
 *
 * Renderer contract (GameRendererProps): the component owns ONLY the
 * answer surface. Timing, durable recording, feedback, the re-queue
 * ladder, and audio moments stay with the framework screen.
 *
 * Reflex flow: every choice becomes one bubble (seeded field, pure
 * module); tapping a bubble publishes the choice label verbatim as
 * the draft and then calls the framework's reflex submit seam
 * (onSubmitAnswer) - the tap IS the answer, which is what makes the
 * registry's targetResponseSpeedSec pacing meaningful. Build-then-
 * check never applies to a reflex archetype.
 *
 * Timer pressure (fluency variant only): the chip samples the pure
 * module's quantized pressure phase off a local tick (the gate
 * screen's interval pattern; the pure module carries no clock). D6
 * age tiering: Pre-K/K/G1 topics present the gentle copy and can
 * never reach the urgent phase; only G2/G3 sprint copy names pace.
 * Pressure paces, it never punishes - there is no per-item deadline.
 *
 * Reduced motion: no animation at all - the chip is a static
 * text+tint chip that refreshes at the tick, bubbles use the shared
 * press-translate token only. Stage variants: guided is untimed with
 * the hint line; fluency adds the pressure chip.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTheme } from "../design/theme";
import { useReducedMotion } from "../design/useMotion";
import { MIN_TOUCH_TARGET, radius, spacing, tactile, typeRamp } from "../design/tokens";
import { QuestionBody, EMPTY_STRUCTURAL_DRAFT, type StructuralDraft } from "../runner/QuestionBody";
import type { RunnerOption } from "../runner/questionShapes";
import {
  bubbleFieldFor,
  guidedHintForField,
  pressureLabelFor,
  pressurePhaseFor,
  pressureTierForTopicId,
  PRESSURE_TICK_MS,
  type BubbleSpec,
} from "./bubblePopBlitz";
import type { GameRendererProps } from "./types";

/** Archetype scene title (static, not curriculum data). */
const SCENE_TITLE = "Bubble Pop Blitz";

export function BubblePopBlitzGame({
  question,
  stage,
  gameStage,
  targetResponseSpeedSec,
  disabled,
  onDraftChange,
  onReplayPrompt,
  onSubmitAnswer,
}: GameRendererProps): React.ReactElement {
  const { colors } = useTheme();
  const { motion } = useReducedMotion();
  const field = useMemo(() => bubbleFieldFor(question), [question]);
  const guided = gameStage === "guided";
  const timed = gameStage === "fluency" && targetResponseSpeedSec > 0;

  // Pressure clock: ALL clock access lives inside the effect (render
  // stays pure - no Date.now in render, no ref reads). The clock
  // restarts per item id (covers re-queued repeats on a reused
  // instance) and FROZEN while feedback shows (the interval drops and
  // elapsed state stops updating).
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!timed || disabled) return;
    const startedAt = Date.now();
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt), PRESSURE_TICK_MS);
    return () => clearInterval(id);
  }, [timed, disabled, question.questionId]);
  const tier = useMemo(() => pressureTierForTopicId(question.topicId), [question.topicId]);
  const phase = timed ? pressurePhaseFor(elapsedMs / 1000, targetResponseSpeedSec, tier) : null;

  // Substrate state (the shared widget draft), for rows the field
  // cannot serve (> MAX_FIELD_BUBBLES choices or blank labels).
  const [structural, setStructural] = useState<StructuralDraft>(EMPTY_STRUCTURAL_DRAFT);

  // Tap handlers compute and publish OUTSIDE any state updater - the
  // #53 updater-purity pattern (React updaters stay pure).
  const popBubble = useCallback(
    (bubble: BubbleSpec) => {
      if (disabled) return;
      onDraftChange(bubble.label);
      // The reflex seam: the tap submits. The screen reads the draft
      // through its ref mirror, so ordering with the dispatch is safe.
      onSubmitAnswer?.();
    },
    [disabled, onDraftChange, onSubmitAnswer],
  );

  return (
    <View style={{ flex: 1 }}>
      <SceneBanner gameStage={gameStage} targetResponseSpeedSec={targetResponseSpeedSec} />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.md,
          gap: spacing.lg,
        }}
      >
        {phase !== null ? <PressureChip phase={phase} tier={tier} /> : null}
        {guided ? (
          <Text
            style={{ ...typeRamp.bodyMuted, color: colors.textMuted, textAlign: "center" }}
            accessibilityLabel={`Hint: ${guidedHintForField()}`}
          >
            {guidedHintForField()}
          </Text>
        ) : null}

        {field !== null ? (
          <View
            accessibilityLabel="Bubble field"
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              gap: spacing.md,
              justifyContent: "center",
              paddingVertical: spacing.md,
            }}
          >
            {field.map((bubble) => (
              <BubbleButton
                key={bubble.key}
                bubble={bubble}
                disabled={disabled}
                motionTranslateY={motion.pressTranslateY}
                onPop={popBubble}
              />
            ))}
          </View>
        ) : (
          <QuestionBody
            question={question}
            stage={stage}
            disabled={disabled}
            structural={structural}
            scaffoldKey={`${question.questionId}-${stage}`}
            onToggleCell={(slot) => {
              const filledSlots = structural.filledSlots.includes(slot)
                ? structural.filledSlots.filter((entry) => entry !== slot)
                : [...structural.filledSlots, slot];
              setStructural({ ...structural, filledSlots });
              onDraftChange(String(filledSlots.length));
            }}
            onTileTapped={(option: RunnerOption) => {
              const placedTiles = [...structural.placedTiles, option];
              setStructural({ ...structural, placedTiles });
              onDraftChange(placedTiles.map((o) => o.label).join(" "));
            }}
            onClearTiles={() => {
              setStructural({ ...structural, placedTiles: [] });
              onDraftChange(null);
            }}
            onSelectChoice={(option: RunnerOption) => {
              setStructural({ ...structural, selectedChoiceKey: option.key });
              onDraftChange(option.label);
            }}
          />
        )}
      </ScrollView>
      <View style={{ padding: spacing.sm, alignItems: "center" }}>
        <Text
          accessibilityRole="button"
          accessibilityLabel="Hear the question again"
          onPress={onReplayPrompt}
          style={{
            ...typeRamp.body,
            color: colors.secondary.label,
            minHeight: MIN_TOUCH_TARGET,
            padding: spacing.sm,
          }}
        >
          {"Hear it again"}
        </Text>
      </View>
    </View>
  );
}

/** Archetype banner: title + stage badge (shape+color redundant chip). */
function SceneBanner({
  gameStage,
  targetResponseSpeedSec,
}: {
  gameStage: GameRendererProps["gameStage"];
  targetResponseSpeedSec: number;
}): React.ReactElement {
  const { colors } = useTheme();
  const fluency = gameStage === "fluency";
  return (
    <View
      accessibilityLabel={`${SCENE_TITLE} game`}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.sm,
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.sm,
        borderBottomWidth: 2,
        borderBottomColor: colors.border,
        backgroundColor: colors.surfaceTinted,
      }}
    >
      <Text style={{ ...typeRamp.title, color: colors.text, flexShrink: 1 }}>{SCENE_TITLE}</Text>
      <View
        accessibilityLabel={fluency ? "Fluency sprint stage" : "Guided stage"}
        style={{
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.xs,
          borderRadius: 999,
          borderWidth: 2,
          borderColor: fluency ? colors.secondary.label : colors.border,
          backgroundColor: colors.surface,
          minHeight: MIN_TOUCH_TARGET,
          justifyContent: "center",
        }}
      >
        <Text style={{ ...typeRamp.label, color: colors.text }}>
          {fluency ? `FLUENCY ${targetResponseSpeedSec}s` : "GUIDED"}
        </Text>
      </View>
    </View>
  );
}

/**
 * The pressure chip: static text + tint that refreshes at the tick
 * (no animation - reduced-motion safe by construction; the phase word
 * always accompanies the tint so color never carries state alone).
 * Gentle-tier chips stay in the encouraging ink set.
 */
function PressureChip({
  phase,
  tier,
}: {
  phase: NonNullable<ReturnType<typeof pressurePhaseFor>>;
  tier: "gentle" | "sprint";
}): React.ReactElement {
  const { colors } = useTheme();
  const label = pressureLabelFor(phase, tier);
  const ink =
    phase === "urgent" && tier === "sprint"
      ? colors.statusInk.warning
      : phase === "rising"
        ? tier === "gentle"
          ? colors.info
          : colors.secondary.label
        : colors.border;
  return (
    <View
      accessibilityLabel={`Pacing: ${label}`}
      style={{
        alignSelf: "center",
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.xs,
        borderRadius: 999,
        borderWidth: 2,
        borderColor: ink,
        backgroundColor: colors.surface,
        minHeight: MIN_TOUCH_TARGET,
        justifyContent: "center",
      }}
    >
      <Text style={{ ...typeRamp.label, color: colors.text }}>{label}</Text>
    </View>
  );
}

/** One bubble: >=48pt tap target, shape+label redundant. */
function BubbleButton({
  bubble,
  disabled,
  motionTranslateY,
  onPop,
}: {
  bubble: BubbleSpec;
  disabled: boolean;
  motionTranslateY: number;
  onPop: (bubble: BubbleSpec) => void;
}): React.ReactElement {
  const { colors } = useTheme();
  // Shape token: border radius + (for the diamond) a STATIC rotate -
  // static transforms are not motion, so reduced motion keeps them.
  const borderRadius =
    bubble.shape === "circle" ? 999 : bubble.shape === "hexagon" ? radius.lg : radius.sm;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Bubble ${bubble.label}`}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => onPop(bubble)}
      testID={`bubble-${bubble.slot}`}
      style={({ pressed }) => ({
        minWidth: MIN_TOUCH_TARGET * 1.4,
        minHeight: MIN_TOUCH_TARGET * 1.4,
        alignItems: "center",
        justifyContent: "center",
        paddingHorizontal: spacing.lg,
        borderWidth: 2,
        borderColor: colors.border,
        borderBottomWidth: pressed ? tactile.borderPressed : tactile.borderRest,
        borderBottomColor: colors.textMuted,
        backgroundColor: pressed ? colors.surfaceTinted : colors.surface,
        transform: [
          ...(bubble.shape === "diamond" ? [{ rotate: "45deg" }] : []),
          { translateY: pressed ? motionTranslateY : 0 },
        ],
        borderRadius,
      })}
    >
      <Text style={{ ...typeRamp.title, color: colors.text }}>{bubble.label}</Text>
    </Pressable>
  );
}
