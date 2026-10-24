/**
 * Market Cashier archetype renderer (issue #53, pack A) - the money /
 * making-change checkout registered under "market-cashier".
 *
 * Renderer contract (GameRendererProps): the component owns ONLY the
 * answer surface. Timing, durable recording, feedback, the re-queue
 * ladder, and audio moments stay with the framework screen.
 *
 * Surfaces (per item data, via the pure marketCashier module):
 *   coin-value - the checkout scene: a running-total readout, a tray
 *                of tapped coins (grouped per denomination), and a
 *                coin pad (plus the dollar bill when the item's data
 *                spans dollars). The built total is matched back to
 *                the item's EXACT choice label (draft === the label),
 *                so the framework's string comparison grades the
 *                manipulative. When the item's prompt names a price,
 *                guided mode surfaces paid/needed/change live.
 *   substrate  - non-money choices ride the shared QuestionBody
 *                matrix (choice grid is the universal answer surface).
 *
 * Stage variants: guided shows the tray detail, per-coin values, and
 * the hint chain; fluency suppresses hints (the framework header
 * carries the targetResponseSpeedSec pace chip). Reduced motion: the
 * only motion is the shared press-translate token, suppressed via
 * useReducedMotion; nothing load-bearing animates.
 */
import React, { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTheme } from "../design/theme";
import { useReducedMotion } from "../design/useMotion";
import { MIN_TOUCH_TARGET, radius, spacing, tactile, typeRamp } from "../design/tokens";
import { QuestionBody, EMPTY_STRUCTURAL_DRAFT, type StructuralDraft } from "../runner/QuestionBody";
import type { RunnerOption } from "../runner/questionShapes";
import {
  cashierPlanFor,
  choiceLabelForCents,
  denominationsFor,
  formatCents,
  guidedHintForCheckout,
  moneyStyleFor,
  priceCentsFromQuestion,
  sumCents,
  type CashDenomination,
} from "./marketCashier";
import type { GameRendererProps } from "./types";

/** Archetype scene title (static, not curriculum data). */
const SCENE_TITLE = "Market Cashier";

export function MarketCashierGame({
  question,
  stage,
  gameStage,
  disabled,
  onDraftChange,
  onReplayPrompt,
}: GameRendererProps): React.ReactElement {
  const { colors } = useTheme();
  const { motion } = useReducedMotion();
  const plan = useMemo(() => cashierPlanFor(question), [question]);
  const denominations = useMemo(() => denominationsFor(question), [question]);
  const style = useMemo(() => moneyStyleFor(question), [question]);

  // Coins in the tray (values in cents). The framework mounts the
  // renderer keyed by item id, so every item starts from this pristine
  // state (no reset effects).
  const [placed, setPlaced] = useState<number[]>([]);
  // Substrate state for non-money items.
  const [structural, setStructural] = useState<StructuralDraft>(EMPTY_STRUCTURAL_DRAFT);

  const publish = useCallback(
    (tray: number[]) => {
      // The draft is the item's exact choice label for the tray total
      // (null until the total identifies exactly one card).
      onDraftChange(choiceLabelForCents(sumCents(tray), question.choices));
    },
    [onDraftChange, question.choices],
  );

  // Tap handlers compute the next tray OUTSIDE the state updater and
  // publish the draft from the closure - React updaters must stay pure
  // (no parent dispatches inside them).
  const tapDenomination = useCallback(
    (cents: number) => {
      if (disabled) return;
      const next = [...placed, cents];
      setPlaced(next);
      publish(next);
    },
    [disabled, placed, publish],
  );

  const emptyTray = useCallback(() => {
    if (disabled) return;
    setPlaced([]);
    onDraftChange(null);
  }, [disabled, onDraftChange]);

  const total = sumCents(placed);
  const price = useMemo(() => priceCentsFromQuestion(question), [question]);
  const guided = gameStage === "guided";
  const hint =
    plan.kind === "coin-value" && guided ? guidedHintForCheckout(placed, question) : null;
  const draftLabel = choiceLabelForCents(total, question.choices);

  return (
    <View style={{ flex: 1 }}>
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
          accessibilityLabel={gameStage === "fluency" ? "Fluency sprint stage" : "Guided stage"}
          style={{
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.xs,
            borderRadius: 999,
            borderWidth: 2,
            borderColor: gameStage === "fluency" ? colors.secondary.label : colors.border,
            backgroundColor: colors.surface,
            minHeight: MIN_TOUCH_TARGET,
            justifyContent: "center",
          }}
        >
          <Text style={{ ...typeRamp.label, color: colors.text }}>
            {gameStage === "fluency" ? "FLUENCY" : "GUIDED"}
          </Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.md,
          gap: spacing.lg,
        }}
      >
        {plan.kind === "coin-value" ? (
          <>
            {/* Checkout readout: price (when the item names one) and
                the tray total, both in the item's own money style. */}
            <View
              accessibilityLabel={
                price !== null
                  ? `Price ${formatCents(price, style)}. Tray total ${formatCents(total, style)}.`
                  : `Tray total ${formatCents(total, style)}.`
              }
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                alignItems: "center",
                justifyContent: "center",
                gap: spacing.md,
                minHeight: MIN_TOUCH_TARGET + spacing.md * 2,
                paddingHorizontal: spacing.md,
                borderRadius: radius.md,
                borderCurve: "continuous",
                borderWidth: 2,
                borderColor: colors.info,
                backgroundColor: colors.surface,
              }}
            >
              {price !== null ? (
                <Text style={{ ...typeRamp.h3, color: colors.textMuted }}>
                  {`Price: ${formatCents(price, style)}`}
                </Text>
              ) : null}
              <Text style={{ ...typeRamp.h2, color: colors.text }}>
                {formatCents(total, style)}
              </Text>
            </View>

            {/* Coin tray: tapped coins grouped per denomination
                (shape+color redundancy: each denomination keeps its
                own chip; the count rides the label). */}
            <View
              accessibilityLabel={trayA11y(placed)}
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
                justifyContent: "center",
                backgroundColor: colors.surface,
              }}
            >
              {placed.length === 0 ? (
                <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
                  {"Tap coins to fill the tray"}
                </Text>
              ) : (
                groupedTray(placed).map((entry) => (
                  <View
                    key={entry.label}
                    accessibilityLabel={`${entry.label}, ${entry.count} in tray`}
                    style={{
                      minWidth: MIN_TOUCH_TARGET,
                      minHeight: MIN_TOUCH_TARGET,
                      alignItems: "center",
                      justifyContent: "center",
                      paddingHorizontal: spacing.md,
                      borderRadius: radius.sm,
                      borderCurve: "continuous",
                      borderWidth: 2,
                      borderColor: colors.info,
                      backgroundColor: colors.surfaceTinted,
                    }}
                  >
                    <Text style={{ ...typeRamp.title, color: colors.text }}>{entry.label}</Text>
                    {entry.count > 1 ? (
                      <Text style={{ ...typeRamp.caption, color: colors.textMuted }}>
                        {`x${entry.count}`}
                      </Text>
                    ) : null}
                  </View>
                ))
              )}
            </View>

            {/* Coin pad: tap-to-pay (drag-free), >=48pt keys, each
                denomination named AND valued (color is never the only
                carrier - the label carries the value). */}
            <View
              accessibilityLabel="Coin pad"
              style={{
                flexDirection: "row",
                flexWrap: "wrap",
                gap: spacing.sm,
                justifyContent: "center",
              }}
            >
              {denominations.map((denomination: CashDenomination) => (
                <Pressable
                  key={denomination.key}
                  accessibilityRole="button"
                  accessibilityLabel={denomination.a11y}
                  accessibilityState={{ disabled }}
                  disabled={disabled}
                  onPress={() => tapDenomination(denomination.cents)}
                  testID={`coin-pad-${denomination.key}`}
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
                    transform: [{ translateY: pressed ? motion.pressTranslateY : 0 }],
                  })}
                >
                  <Text style={{ ...typeRamp.title, color: colors.text }}>
                    {denomination.label}
                  </Text>
                  <Text style={{ ...typeRamp.caption, color: colors.textMuted }}>
                    {denomination.key === "dollar" ? "bill" : "coin"}
                  </Text>
                </Pressable>
              ))}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Empty the tray"
                accessibilityState={{ disabled: disabled || placed.length === 0 }}
                disabled={disabled || placed.length === 0}
                onPress={emptyTray}
                testID="coin-pad-clear"
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
                  transform: [{ translateY: pressed ? motion.pressTranslateY : 0 }],
                })}
              >
                <Text style={{ ...typeRamp.body, color: colors.text }}>{"Clear"}</Text>
              </Pressable>
            </View>

            <View style={{ alignItems: "center", gap: spacing.xs }}>
              {draftLabel !== null ? (
                <Text
                  style={{ ...typeRamp.body, color: colors.statusInk.success }}
                  accessibilityLabel={`Card matched: ${draftLabel}`}
                >
                  {`Card: ${draftLabel}`}
                </Text>
              ) : null}
              {hint ? (
                <Text
                  style={{ ...typeRamp.bodyMuted, color: colors.textMuted, textAlign: "center" }}
                  accessibilityLabel={`Hint: ${hint}`}
                >
                  {hint}
                </Text>
              ) : null}
            </View>
          </>
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

/** Tray chips: one per denomination present, count grouped. */
function groupedTray(tray: readonly number[]): { label: string; count: number }[] {
  const counts = new Map<number, number>();
  for (const cents of tray) counts.set(cents, (counts.get(cents) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([cents, count]) => ({
      label: cents >= 100 ? `$${(cents / 100).toFixed(0)}` : `${cents}\u00a2`,
      count,
    }));
}

function trayA11y(tray: readonly number[]): string {
  if (tray.length === 0) return "Tray is empty";
  const groups = groupedTray(tray);
  const total = sumCents(tray);
  return `Tray holds ${groups.map((g) => `${g.count} x ${g.label}`).join(", ")}, total ${total} cents`;
}
