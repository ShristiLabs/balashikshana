/**
 * Stub archetype renderer (issue #52) - the THIN proof-of-pipeline
 * renderer for "block-builder", registered until #53 ships the real
 * Block Builder + Market Cashier renderers into ARCHETYPE_RENDERERS.
 *
 * It implements the GameRendererProps contract exactly as a real
 * archetype would: game chrome (title banner + stage framing) around
 * the shared #50/#51 rendering substrate (QuestionBody -> renderPlanFor
 * matrix -> widget kit), reporting drafts upward. A child playing a
 * block-builder topic today gets a real, playable, data-driven session
 * through the whole framework - registry games block -> route
 * resolution -> GAME session -> spiral stream -> telemetry -> sync.
 *
 * Reduced motion: no load-bearing animation anywhere in the stub; the
 * framework owns the audio/haptics seams and suppresses haptics under
 * reduced motion via the #45 coordinator.
 */
import React, { useState } from "react";
import { Text, View } from "react-native";
import { useTheme } from "../design/theme";
import { spacing, typeRamp } from "../design/tokens";
import { QuestionBody, EMPTY_STRUCTURAL_DRAFT, type StructuralDraft } from "../runner/QuestionBody";
import type { RunnerOption } from "../runner/questionShapes";
import type { GameRendererProps } from "./types";

export function StubArchetypeGame({
  question,
  stage,
  gameStage,
  targetResponseSpeedSec,
  disabled,
  draft,
  onDraftChange,
  onReplayPrompt,
}: GameRendererProps): React.ReactElement {
  const { colors } = useTheme();
  const [structural, setStructural] = useState<StructuralDraft>(EMPTY_STRUCTURAL_DRAFT);

  const publish = (next: StructuralDraft, draftString: string | null): void => {
    setStructural(next);
    onDraftChange(draftString);
  };

  return (
    <View style={{ flex: 1 }}>
      <View
        accessibilityLabel="Block builder game"
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
        <Text style={{ ...typeRamp.title, color: colors.text, flexShrink: 1 }}>
          {"Block Builder"}
        </Text>
        <View
          accessibilityLabel={gameStage === "fluency" ? "Fluency sprint stage" : "Guided stage"}
          style={{
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.xs,
            borderRadius: 999,
            borderWidth: 2,
            borderColor: gameStage === "fluency" ? colors.secondary.label : colors.border,
            backgroundColor: colors.surface,
            minHeight: 48,
            justifyContent: "center",
          }}
        >
          <Text style={{ ...typeRamp.label, color: colors.text }}>
            {gameStage === "fluency" ? `FLUENCY ${targetResponseSpeedSec}s` : "GUIDED"}
          </Text>
        </View>
      </View>
      <QuestionBody
        question={question}
        stage={stage}
        disabled={disabled}
        structural={structural}
        scaffoldKey={`${question.questionId}-${stage}`}
        onToggleCell={(slot) => {
          const filled = structural.filledSlots.includes(slot)
            ? structural.filledSlots.filter((entry) => entry !== slot)
            : [...structural.filledSlots, slot];
          publish({ ...structural, filledSlots: filled }, String(filled.length));
        }}
        onTileTapped={(option: RunnerOption) => {
          const placed = [...structural.placedTiles, option];
          publish({ ...structural, placedTiles: placed }, placed.map((o) => o.label).join(" "));
        }}
        onClearTiles={() => publish({ ...structural, placedTiles: [] }, null)}
        onSelectChoice={(option: RunnerOption) =>
          publish({ ...structural, selectedChoiceKey: option.key }, option.label)
        }
      />
      {draft === null ? null : (
        <Text style={{ ...typeRamp.caption, color: colors.textMuted, padding: spacing.sm }}>
          {`Your answer: ${draft}`}
        </Text>
      )}
      <View style={{ padding: spacing.sm, alignItems: "center" }}>
        <Text
          accessibilityRole="button"
          accessibilityLabel="Hear the question again"
          onPress={onReplayPrompt}
          style={{
            ...typeRamp.body,
            color: colors.secondary.label,
            minHeight: 48,
            padding: spacing.sm,
          }}
        >
          {"Hear it again"}
        </Text>
      </View>
    </View>
  );
}
