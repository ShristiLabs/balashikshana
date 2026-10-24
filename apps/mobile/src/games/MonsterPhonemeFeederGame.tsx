/**
 * Monster Phoneme Feeder archetype renderer (issue #54, pack B) - the
 * ELA feeding surface registered under "monster-phoneme-feeder" (102
 * registry guided topics across 22 ELA units; the first ELA surface
 * on the game framework).
 *
 * Renderer contract (GameRendererProps): the component owns ONLY the
 * answer surface. Timing, durable recording, feedback, the re-queue
 * ladder, and audio stay with the framework screen.
 *
 * Audio-first by design: the item's narration (prompt text through
 * the #45 coordinator - voiceNarration pacing, ducking, screen-reader
 * deferral all live there) IS the phoneme/word audio. The renderer
 * surfaces one prominent replay affordance (the framework's
 * onReplayPrompt seam) and NEVER touches the coordinator or blocks on
 * audio - every tap stays live while speech plays.
 *
 * Feeding: the item's own tile bank becomes the food tiles; the child
 * taps them in order to "feed the monster" (the placed tray is the
 * mouth). The placed labels joined with spaces ARE the exact choice
 * label ("f a n"), so grading is by construction. Whole-word
 * multiple-choice rows (no tile bank) ride the shared QuestionBody
 * substrate - the choice grid is the universal answer surface.
 *
 * Stage variants: guided shows the hint chain and the monster face;
 * fluency suppresses hints and paces off targetResponseSpeedSec (the
 * framework header owns the aim line). Reduced motion: the only
 * motion is the shared press-translate token.
 */
import React, { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTheme } from "../design/theme";
import { useReducedMotion } from "../design/useMotion";
import { MIN_TOUCH_TARGET, radius, spacing, tactile, typeRamp } from "../design/tokens";
import { TileBuilder } from "../runner/widgets/TileBuilder";
import { QuestionBody, EMPTY_STRUCTURAL_DRAFT, type StructuralDraft } from "../runner/QuestionBody";
import type { RunnerOption } from "../runner/questionShapes";
import { draftForPlaced, feederPlanFor, guidedHintForFeed } from "./monsterPhonemeFeeder";
import type { GameRendererProps } from "./types";

/** Archetype scene title (static, not curriculum data). */
const SCENE_TITLE = "Monster Phoneme Feeder";

export function MonsterPhonemeFeederGame({
  question,
  stage,
  gameStage,
  targetResponseSpeedSec,
  disabled,
  onDraftChange,
  onReplayPrompt,
}: GameRendererProps): React.ReactElement {
  const { colors } = useTheme();
  const { motion } = useReducedMotion();
  const plan = useMemo(() => feederPlanFor(question), [question]);
  const guided = gameStage === "guided";

  // Placed tiles (parent-owned draft) and the substrate state for
  // whole-word rows. The framework mounts the renderer keyed by item
  // id, so every item starts pristine (no reset effects).
  const [placed, setPlaced] = useState<RunnerOption[]>([]);
  const [structural, setStructural] = useState<StructuralDraft>(EMPTY_STRUCTURAL_DRAFT);

  // Tap handlers compute the next sequence OUTSIDE the state updater
  // and publish the draft from the closure (#53 updater-purity
  // pattern).
  const feedTile = useCallback(
    (option: RunnerOption) => {
      if (disabled) return;
      const next = [...placed, option];
      setPlaced(next);
      onDraftChange(draftForPlaced(next));
    },
    [disabled, onDraftChange, placed],
  );

  const clearFeed = useCallback(() => {
    if (disabled) return;
    setPlaced([]);
    onDraftChange(null);
  }, [disabled, onDraftChange]);

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
        {/* Audio-first affordance (>=48pt): replay the word/phoneme
            prompt through the framework's narration seam. Never
            blocks; taps stay live while speech plays. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Hear the word again"
          accessibilityState={{ disabled }}
          disabled={disabled}
          onPress={onReplayPrompt}
          testID="feeder-replay"
          style={({ pressed }) => ({
            alignSelf: "center",
            minWidth: MIN_TOUCH_TARGET * 3,
            minHeight: MIN_TOUCH_TARGET + 8,
            alignItems: "center",
            justifyContent: "center",
            paddingHorizontal: spacing.xl,
            borderRadius: radius.md,
            borderCurve: "continuous",
            borderWidth: 2,
            borderBottomWidth: pressed ? tactile.borderPressed : tactile.borderRest,
            borderColor: colors.secondary.label,
            borderBottomColor: colors.textMuted,
            backgroundColor: colors.surface,
            transform: [{ translateY: pressed ? motion.pressTranslateY : 0 }],
          })}
        >
          <Text style={{ ...typeRamp.h3, color: colors.text }}>{"Hear the word"}</Text>
        </Pressable>

        {plan.kind === "feed" ? (
          <View style={{ gap: spacing.lg }}>
            {/* The monster: friendly face above the mouth (the placed
                tray). Shapes only - no raster, decorative rows are
                a11y-hidden; the tray carries the real labels. */}
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={{ flexDirection: "row", justifyContent: "center", gap: spacing.xl }}
            >
              <View
                style={{
                  width: MIN_TOUCH_TARGET * 0.6,
                  height: MIN_TOUCH_TARGET * 0.6,
                  borderRadius: 999,
                  borderWidth: 2,
                  borderColor: colors.border,
                  backgroundColor: colors.surfaceTinted,
                }}
              />
              <View
                style={{
                  width: MIN_TOUCH_TARGET * 0.6,
                  height: MIN_TOUCH_TARGET * 0.6,
                  borderRadius: 999,
                  borderWidth: 2,
                  borderColor: colors.border,
                  backgroundColor: colors.surfaceTinted,
                }}
              />
            </View>
            <TileBuilder
              bank={plan.bank}
              placed={placed}
              disabled={disabled}
              onTileTapped={feedTile}
              onClear={clearFeed}
              testID="feeder-tiles"
            />
            {guided ? (
              <Text
                style={{ ...typeRamp.bodyMuted, color: colors.textMuted, textAlign: "center" }}
                accessibilityLabel={`Hint: ${guidedHintForFeed(placed.length, plan.targetSegments)}`}
              >
                {guidedHintForFeed(placed.length, plan.targetSegments)}
              </Text>
            ) : null}
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
