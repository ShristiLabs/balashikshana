/**
 * Block Builder archetype renderer (issue #53, pack A) - the real
 * implementation registered under "block-builder" (it replaces the
 * #52 proof-of-pipeline stub).
 *
 * Renderer contract (GameRendererProps): the component owns ONLY the
 * answer surface. Timing, durable recording, feedback, the re-queue
 * ladder, and audio moments stay with the framework screen; the
 * renderer reports drafts upward as strings.
 *
 * Surfaces (per item data, via the pure blockBuilder module):
 *   count-build   - tap +1 cubes / +10 rods; the rail auto-bundles
 *                   loose ones into rods (shape+color redundant: rods
 *                   are wide tinted bars, cubes are outline squares);
 *                   draft = the built count string.
 *   tile-sequence - the shared TileBuilder widget over the item's tile
 *                   bank; draft = the placed sequence joined.
 *   substrate     - the shared QuestionBody matrix (choice grid is the
 *                   universal answer surface).
 *
 * Stage variants: guided shows the step-by-step hint chain and the
 * scaffold row; fluency suppresses hints and shows the speed pace chip
 * driven by targetResponseSpeedSec. Reduced motion: the only motion is
 * the shared press-translate token, suppressed via useReducedMotion;
 * nothing load-bearing animates.
 */
import React, { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTheme } from "../design/theme";
import { useReducedMotion } from "../design/useMotion";
import { MIN_TOUCH_TARGET, radius, spacing, tactile, typeRamp } from "../design/tokens";
import {
  anchorLabelForVisualAid,
  tileSpecFor,
  visualRowFor,
  type RunnerOption,
} from "../runner/questionShapes";
import { VisualScaffold } from "../runner/widgets/VisualScaffold";
import { TileBuilder } from "../runner/widgets/TileBuilder";
import { QuestionBody, EMPTY_STRUCTURAL_DRAFT, type StructuralDraft } from "../runner/QuestionBody";
import {
  buildBankFor,
  buildPlanFor,
  bundleViewFor,
  draftForBuild,
  guidedHintFor,
  validateBuild,
} from "./blockBuilder";
import type { GameRendererProps } from "./types";

/** Archetype scene title (static, not curriculum data). */
const SCENE_TITLE = "Block Builder";

export function BlockBuilderGame({
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
  const plan = useMemo(() => buildPlanFor(question), [question]);

  // Count-build state: values of the placed tiles. The framework
  // mounts the renderer keyed by item id, so every item starts from
  // this pristine state (no reset effects).
  const [placed, setPlaced] = useState<number[]>([]);
  // Tile-sequence + substrate state (the shared widget drafts).
  const [structural, setStructural] = useState<StructuralDraft>(EMPTY_STRUCTURAL_DRAFT);

  const bank = useMemo(
    () => (plan.kind === "count-build" && plan.target !== null ? buildBankFor(plan.target) : []),
    [plan],
  );

  // Tap handlers compute the next build OUTSIDE the state updater and
  // publish the draft from the closure - React updaters must stay pure
  // (no parent dispatches inside them).
  const placeTile = useCallback(
    (value: number) => {
      if (disabled) return;
      const next = [...placed, value];
      setPlaced(next);
      onDraftChange(draftForBuild(next));
    },
    [disabled, onDraftChange, placed],
  );

  const removeOne = useCallback(() => {
    if (disabled || placed.length === 0) return;
    const next = placed.slice(0, -1);
    setPlaced(next);
    onDraftChange(draftForBuild(next));
  }, [disabled, onDraftChange, placed]);

  const clearBuild = useCallback(() => {
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
        {plan.kind === "count-build" && plan.target !== null ? (
          <CountBuildSurface
            target={plan.target}
            placed={placed}
            bank={bank}
            disabled={disabled}
            guided={gameStage === "guided"}
            question={question}
            motionTranslateY={motion.pressTranslateY}
            onPlaceTile={placeTile}
            onRemoveOne={removeOne}
            onClearBuild={clearBuild}
          />
        ) : null}

        {plan.kind === "tile-sequence" ? (
          <TileBuilder
            bank={tileSpecFor(question).bank}
            placed={structural.placedTiles}
            disabled={disabled}
            onTileTapped={(option: RunnerOption) => {
              const placedTiles = [...structural.placedTiles, option];
              setStructural({ ...structural, placedTiles });
              onDraftChange(placedTiles.map((o) => o.label).join(" "));
            }}
            onClear={() => {
              setStructural({ ...structural, placedTiles: [] });
              onDraftChange(null);
            }}
          />
        ) : null}

        {plan.kind === "substrate" ? (
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
        ) : null}
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
 * The count-build surface: scaffold row (guided), bundled rail, build
 * bank, running total, and the guided hint chain. Presentational
 * except the taps it reports upward through the callbacks.
 */
function CountBuildSurface({
  target,
  placed,
  bank,
  disabled,
  guided,
  question,
  motionTranslateY,
  onPlaceTile,
  onRemoveOne,
  onClearBuild,
}: {
  target: number;
  placed: number[];
  bank: { key: string; label: string; value: number }[];
  disabled: boolean;
  guided: boolean;
  question: GameRendererProps["question"];
  motionTranslateY: number;
  onPlaceTile: (value: number) => void;
  onRemoveOne: () => void;
  onClearBuild: () => void;
}): React.ReactElement {
  const { colors } = useTheme();
  const view = bundleViewFor(placed);
  const validation = validateBuild(target, placed);
  const hint = guided ? guidedHintFor(target, placed) : null;

  return (
    <View style={{ gap: spacing.lg }}>
      {guided ? (
        <VisualScaffold
          mode="static"
          visualRow={visualRowFor(question)}
          anchorLabel={anchorLabelForVisualAid(question.visualAid)}
          flashMs={0}
        />
      ) : null}

      <View
        accessibilityLabel={`Build target ${target}`}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: spacing.sm,
          minHeight: MIN_TOUCH_TARGET,
          paddingHorizontal: spacing.md,
          borderRadius: radius.md,
          borderCurve: "continuous",
          borderWidth: 2,
          borderColor: colors.info,
          backgroundColor: colors.surface,
        }}
      >
        <Text style={{ ...typeRamp.label, color: colors.textMuted }}>{"BUILD"}</Text>
        <Text style={{ ...typeRamp.h3, color: colors.text }}>{String(target)}</Text>
      </View>

      {/* Bundled rail: rods (wide tinted bars) + loose cubes (outline
          squares) - shape AND color carry the ten/one distinction. */}
      <View
        accessibilityLabel={`Built ${view.total}. ${view.tens} ten rods and ${view.ones} single cubes.`}
        style={{
          minHeight: MIN_TOUCH_TARGET + spacing.md * 2,
          borderRadius: radius.md,
          borderCurve: "continuous",
          borderWidth: 2,
          borderStyle: "dashed",
          borderColor: colors.border,
          padding: spacing.md,
          flexDirection: "row",
          flexWrap: "wrap",
          gap: spacing.sm,
          alignItems: "center",
          backgroundColor: colors.surface,
        }}
      >
        {view.total === 0 ? (
          <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
            {"Tap tiles to build the number"}
          </Text>
        ) : (
          <>
            {Array.from({ length: view.tens }, (_, i) => (
              <View
                key={`rod-${i}`}
                accessibilityLabel={`Ten rod ${i + 1}`}
                style={{
                  minWidth: MIN_TOUCH_TARGET * 2,
                  minHeight: MIN_TOUCH_TARGET,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: radius.sm,
                  borderCurve: "continuous",
                  borderWidth: 2,
                  borderColor: colors.info,
                  backgroundColor: colors.surfaceTinted,
                }}
              >
                <Text style={{ ...typeRamp.title, color: colors.text }}>{"10"}</Text>
              </View>
            ))}
            {Array.from({ length: view.ones }, (_, i) => (
              <View
                key={`cube-${i}`}
                accessibilityLabel={`Single cube ${i + 1}`}
                style={{
                  minWidth: MIN_TOUCH_TARGET,
                  minHeight: MIN_TOUCH_TARGET,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: radius.sm,
                  borderCurve: "continuous",
                  borderWidth: 2,
                  borderColor: colors.border,
                  backgroundColor: colors.surface,
                }}
              >
                <Text style={{ ...typeRamp.title, color: colors.text }}>{"1"}</Text>
              </View>
            ))}
          </>
        )}
      </View>

      {/* Build bank: tap-to-place (drag-free), >=48pt tiles. */}
      <View
        accessibilityLabel="Build bank"
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: spacing.sm,
          justifyContent: "center",
        }}
      >
        {bank.map((tile) => (
          <Pressable
            key={tile.key}
            accessibilityRole="button"
            accessibilityLabel={`Add ${tile.value === 10 ? "a ten rod" : "a single cube"}`}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={() => onPlaceTile(tile.value)}
            testID={`block-bank-${tile.key}`}
            style={({ pressed }) => ({
              minWidth: MIN_TOUCH_TARGET,
              minHeight: MIN_TOUCH_TARGET + 8,
              alignItems: "center",
              justifyContent: "center",
              paddingHorizontal: spacing.lg,
              borderRadius: radius.sm,
              borderCurve: "continuous",
              borderWidth: 2,
              borderBottomWidth: pressed ? tactile.borderPressed : tactile.borderRest,
              borderColor: colors.border,
              borderBottomColor: colors.textMuted,
              backgroundColor: colors.surface,
              transform: [{ translateY: pressed ? motionTranslateY : 0 }],
            })}
          >
            <Text style={{ ...typeRamp.title, color: colors.text }}>{tile.label}</Text>
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Remove one tile"
          accessibilityState={{ disabled: disabled || placed.length === 0 }}
          disabled={disabled || placed.length === 0}
          onPress={onRemoveOne}
          testID="block-remove-one"
          style={({ pressed }) => ({
            minWidth: MIN_TOUCH_TARGET,
            minHeight: MIN_TOUCH_TARGET + 8,
            alignItems: "center",
            justifyContent: "center",
            paddingHorizontal: spacing.lg,
            borderRadius: radius.sm,
            borderCurve: "continuous",
            borderWidth: 2,
            borderBottomWidth: pressed ? tactile.borderPressed : tactile.borderRest,
            borderColor: colors.border,
            borderBottomColor: colors.textMuted,
            backgroundColor: colors.surface,
            transform: [{ translateY: pressed ? motionTranslateY : 0 }],
          })}
        >
          <Text style={{ ...typeRamp.body, color: colors.text }}>{"-1"}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Clear the build"
          accessibilityState={{ disabled: disabled || placed.length === 0 }}
          disabled={disabled || placed.length === 0}
          onPress={onClearBuild}
          testID="block-clear"
          style={({ pressed }) => ({
            minWidth: MIN_TOUCH_TARGET,
            minHeight: MIN_TOUCH_TARGET + 8,
            alignItems: "center",
            justifyContent: "center",
            paddingHorizontal: spacing.lg,
            borderRadius: radius.sm,
            borderCurve: "continuous",
            borderWidth: 2,
            borderBottomWidth: pressed ? tactile.borderPressed : tactile.borderRest,
            borderColor: colors.border,
            borderBottomColor: colors.textMuted,
            backgroundColor: colors.surface,
            transform: [{ translateY: pressed ? motionTranslateY : 0 }],
          })}
        >
          <Text style={{ ...typeRamp.body, color: colors.text }}>{"Clear"}</Text>
        </Pressable>
      </View>

      <View style={{ alignItems: "center", gap: spacing.xs }}>
        <Text
          style={{ ...typeRamp.title, color: colors.text }}
          accessibilityLabel={`Current count ${view.total}`}
        >
          {`Count: ${view.total}`}
        </Text>
        {hint ? (
          <Text
            style={{ ...typeRamp.bodyMuted, color: colors.textMuted, textAlign: "center" }}
            accessibilityLabel={`Hint: ${hint}`}
          >
            {hint}
          </Text>
        ) : null}
        {validation.overbuilt ? (
          <Text style={{ ...typeRamp.body, color: colors.statusInk.warning }}>
            {`That is more than ${target}. Remove tiles.`}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
