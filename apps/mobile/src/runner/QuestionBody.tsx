/**
 * Presentational question body (issue #51): the interaction-type x CPA
 * stage rendering extracted as an importable component so the gate
 * runner renders EXACTLY what the #50 practice runner renders — the
 * renderPlanFor matrix drives everything; this file holds no logic.
 *
 * The #50 screen keeps its inline copy (shipped surface, untouched);
 * the M4 game framework (#52) can adopt this component too.
 */
import React from "react";
import { ScrollView } from "react-native";
import { spacing } from "../design/tokens";
import type { PracticeQuestion } from "../practice/types";
import { GHOST_FLASH_MS } from "./cpaStages";
import {
  anchorLabelForVisualAid,
  choiceOptionsFor,
  counterSpecFor,
  renderPlanFor,
  tileSpecFor,
  visualRowFor,
  type RunnerOption,
} from "./questionShapes";
import { ChoiceGrid, CounterFrame, TileBuilder, VisualScaffold } from "./widgets";

/** Structural draft shape (the store keeps the string form). */
export interface StructuralDraft {
  filledSlots: number[];
  placedTiles: RunnerOption[];
  selectedChoiceKey: string | null;
}

export const EMPTY_STRUCTURAL_DRAFT: StructuralDraft = {
  filledSlots: [],
  placedTiles: [],
  selectedChoiceKey: null,
};

export interface QuestionBodyProps {
  question: PracticeQuestion;
  /** Engine-derived CPA stage for the question's topic. */
  stage: string;
  /** True while feedback shows (input locked). */
  disabled: boolean;
  structural: StructuralDraft;
  onToggleCell: (slot: number) => void;
  onTileTapped: (option: RunnerOption) => void;
  onClearTiles: () => void;
  onSelectChoice: (option: RunnerOption) => void;
  /** Key to force a fresh scaffold when the visual mode changes. */
  scaffoldKey: string;
}

export function QuestionBody({
  question,
  stage,
  disabled,
  structural,
  onToggleCell,
  onTileTapped,
  onClearTiles,
  onSelectChoice,
  scaffoldKey,
}: QuestionBodyProps): React.ReactElement {
  const plan = renderPlanFor(question.interactionType, stage);
  return (
    <ScrollView
      contentContainerStyle={{
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md,
        gap: spacing.lg,
      }}
    >
      {plan.visualMode !== "none" ? (
        <VisualScaffold
          key={scaffoldKey}
          mode={plan.visualMode}
          visualRow={visualRowFor(question)}
          anchorLabel={plan.anchorVisible ? anchorLabelForVisualAid(question.visualAid) : null}
          flashMs={GHOST_FLASH_MS}
        />
      ) : null}

      {plan.widget === "interactive-counter" ? (
        <CounterFrame
          spec={counterSpecFor(question)}
          filled={structural.filledSlots}
          disabled={disabled}
          onToggleCell={onToggleCell}
        />
      ) : null}
      {plan.widget === "tile-builder" ? (
        <TileBuilder
          bank={tileSpecFor(question).bank}
          placed={structural.placedTiles}
          disabled={disabled}
          onTileTapped={onTileTapped}
          onClear={onClearTiles}
        />
      ) : null}
      {plan.widget === "choice" ? (
        <ChoiceGrid
          options={choiceOptionsFor(question)}
          selectedKey={structural.selectedChoiceKey}
          disabled={disabled}
          onOptionSelected={onSelectChoice}
        />
      ) : null}
    </ScrollView>
  );
}
