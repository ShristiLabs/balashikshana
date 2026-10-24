/**
 * Gate results view (issue #51): the five-condition breakdown with
 * metrics and thresholds, the per-topic table (75% floor), and the
 * next-step routing per the engine's remediation mode. Pass/fail rows
 * are shape (glyph) + color + text redundant; failed topics route to
 * focused practice; a pass offers the key ceremony.
 */
import React from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { Button } from "../design/primitives";
import { useTheme } from "../design/theme";
import { spacing, typeRamp } from "../design/tokens";
import type { GateSessionSummary } from "../practice/practiceEngine";
import { resultsView } from "./results";

export interface GateResultsViewProps {
  summary: GateSessionSummary;
  /** Called with the failed same-unit topic code (or undefined). */
  onPractice: (topicCode?: string) => void;
  /** Called on a pass — starts the key ceremony. */
  onCollectKey: () => void;
  testID?: string;
}

export function GateResultsView({
  summary,
  onPractice,
  onCollectKey,
  testID,
}: GateResultsViewProps): React.ReactElement {
  const { colors } = useTheme();
  const view = resultsView(summary);
  return (
    <ScrollView
      contentContainerStyle={{ padding: spacing.xl, gap: spacing.lg }}
      testID={testID}
      accessibilityLabel="Boss gate results"
    >
      <View style={{ gap: spacing.xs }}>
        <Text style={{ ...typeRamp.h1, color: colors.text }}>{view.headline}</Text>
        <Text style={{ ...typeRamp.body, color: colors.textMuted }}>{view.subline}</Text>
      </View>

      <View style={{ gap: spacing.sm }} accessibilityLabel="Five gate conditions">
        {view.conditions.map((condition, index) => (
          <View
            key={condition.key}
            accessibilityLabel={`Condition ${index + 1}: ${condition.metric}, ${condition.threshold}. ${condition.passed ? "Passed" : "Not yet"}`}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: spacing.md,
              minHeight: 64,
              paddingHorizontal: spacing.md,
              borderRadius: 16,
              borderWidth: 2,
              borderColor: condition.passed ? colors.statusInk.success : colors.border,
              backgroundColor: condition.passed ? colors.surfaceTinted : colors.surfaceAlt,
            }}
          >
            <Text
              style={{
                ...typeRamp.h2,
                color: condition.passed ? colors.statusInk.success : colors.statusInk.warning,
                minWidth: 32,
              }}
              accessibilityLabel={condition.passed ? "Passed" : "Try again"}
            >
              {condition.glyph === "check" ? "✓" : "↺"}
            </Text>
            <View style={{ flexShrink: 1, gap: spacing.xs }}>
              <Text style={{ ...typeRamp.title, color: colors.text }}>{condition.metric}</Text>
              <Text style={{ ...typeRamp.caption, color: colors.textMuted }}>
                {condition.threshold}
              </Text>
            </View>
          </View>
        ))}
      </View>

      {view.topics.length > 0 ? (
        <View style={{ gap: spacing.xs }} accessibilityLabel="Topic breakdown">
          <Text style={{ ...typeRamp.h3, color: colors.text }}>Topics</Text>
          {view.topics.map((topic) => (
            <View
              key={topic.code}
              accessibilityLabel={`Topic ${topic.name}: ${topic.accuracyPct.toFixed(1)} percent, ${topic.passed ? "above" : "below"} the 75 percent floor`}
              style={{
                flexDirection: "row",
                justifyContent: "space-between",
                alignItems: "center",
                minHeight: 48,
                paddingHorizontal: spacing.md,
                borderRadius: 12,
                borderWidth: 2,
                borderColor: topic.passed ? colors.border : colors.statusInk.warning,
                backgroundColor: colors.surface,
              }}
            >
              <Text style={{ ...typeRamp.body, color: colors.text, flexShrink: 1 }}>
                {topic.name}
              </Text>
              <Text
                style={{
                  ...typeRamp.title,
                  color: topic.passed ? colors.statusInk.success : colors.statusInk.warning,
                }}
              >
                {`${topic.accuracyPct.toFixed(1)}% ${topic.passed ? "✓" : "↺"}`}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {view.passed ? (
        <Button
          label={
            summary.keyState === "GOLD_KEY" ? "Celebrate your Gold key" : "Collect your Silver key"
          }
          onPress={onCollectKey}
          accessibilityHint="Play the key ceremony"
        />
      ) : view.nextStep ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={view.nextStep.label}
          onPress={() => onPractice(view.nextStep?.topicCode)}
          style={({ pressed }) => ({
            minHeight: 64,
            justifyContent: "center",
            paddingHorizontal: spacing.lg,
            paddingVertical: spacing.md,
            borderRadius: 16,
            borderWidth: 2,
            borderCurve: "continuous",
            borderColor: pressed ? colors.info : colors.border,
            backgroundColor: colors.surface,
          })}
        >
          <Text style={{ ...typeRamp.title, color: colors.text }}>{view.nextStep.label}</Text>
          <Text style={{ ...typeRamp.caption, color: colors.textMuted }}>
            {summary.remediationPrescription}
          </Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}
