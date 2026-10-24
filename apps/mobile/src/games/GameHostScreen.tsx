/**
 * Game host screen (issue #52) - the framework's front door.
 *
 * Loads the topic's games asset block off the installed pack, resolves
 * the route (archetype installed -> GameSessionScreen; anything else ->
 * the #50 PracticeRunnerScreen with the SAME topic deep-link and a
 * fallback telemetry stamp on its attempt rows - never a dead end),
 * and offers the registry's stages (guided explorer / fluency sprint)
 * when a deep link did not already pick one.
 *
 * All resolution logic is pure (resolveGameRoute / parseGamesAssetBlock
 * / availableStages); this file only wires pack reads and mounts.
 */
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { Button } from "../design/primitives";
import { useTheme } from "../design/theme";
import { spacing, typeRamp } from "../design/tokens";
import { getNativePracticeDeps } from "../practice/nativePractice";
import type { GameAttemptTelemetry } from "../practice/types";
import { packTopicToEngineTopic } from "../practice/packShapes";
import { resolveRunnerIdentity } from "../runner/runnerNative";
import { PracticeRunnerScreen } from "../runner/PracticeRunnerScreen";
import { SUPPORTED_ARCHETYPES } from "./archetypeRegistry";
import { availableStages, parseGamesAssetBlock } from "./gamesAssets";
import { resolveGameRoute } from "./archetypes";
import { GameSessionScreen } from "./GameSessionScreen";
import type { GameStage, GamesAssetBlock } from "./types";

export interface GameHostScreenProps {
  gradeId?: string;
  unitId: string;
  topicCode: string;
  /** Deep-link stage (from the picker's Play affordance); optional. */
  stage?: GameStage;
}

interface HostResolution {
  status: "game" | "fallback";
  stage: GameStage | null;
  archetype: string | null;
  gameTitle: string;
  targetResponseSpeedSec: number;
  /** Stages the topic still offers (when the param did not pin one). */
  offeredStages: GameStage[];
  /** Per offered stage: does an installed renderer exist? (preview copy). */
  supportedByStage: Record<string, boolean>;
  topicName: string;
}

export function GameHostScreen({
  gradeId: gradeParam,
  unitId,
  topicCode,
  stage: stageParam,
}: GameHostScreenProps): React.ReactElement {
  const { colors } = useTheme();
  const [phase, setPhase] = useState<"loading" | "no-pack" | "error" | "stage-pick" | "resolved">(
    "loading",
  );
  const [resolution, setResolution] = useState<HostResolution | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stageChoice, setStageChoice] = useState<GameStage | null>(stageParam ?? null);
  /** The parsed games block, kept so a stage-pick re-resolves WITH the
   *  chosen stage (the fallback marker must name the intended archetype
   *  and carry that stage's speed target - never the param-less nulls). */
  const blockRef = useRef<GamesAssetBlock | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const identity = await resolveRunnerIdentity();
      if (cancelled) return;
      if (!identity.studentId) {
        setPhase("error");
        setError("no child-device session for games");
        return;
      }
      const gradeId = gradeParam ?? identity.gradeId ?? undefined;
      if (!gradeId) {
        setPhase("error");
        setError("no active grade for games");
        return;
      }
      try {
        const deps = getNativePracticeDeps();
        const reader = await deps.openContent(gradeId);
        if (!reader) {
          setPhase("no-pack");
          return;
        }
        const topicId = `${unitId}-${topicCode}`;
        const topicRow = await reader.topic(topicId);
        if (!topicRow) {
          setPhase("error");
          setError(`Topic ${topicId} is not in the installed pack`);
          return;
        }
        const block = parseGamesAssetBlock(packTopicToEngineTopic(topicRow).assets);
        blockRef.current = block;
        const offered = availableStages(block);
        const chosen = stageParam ?? null;
        const decision = resolveGameRoute(block, chosen, SUPPORTED_ARCHETYPES);
        const supportedByStage: Record<string, boolean> = {};
        for (const offeredStage of offered) {
          supportedByStage[offeredStage] =
            resolveGameRoute(block, offeredStage, SUPPORTED_ARCHETYPES).kind === "game";
        }
        if (cancelled) return;
        setResolution({
          status: decision.kind === "game" ? "game" : "fallback",
          stage: decision.stage,
          archetype: decision.archetype,
          gameTitle: decision.kind === "game" ? decision.gameTitle : "",
          targetResponseSpeedSec:
            decision.kind === "game" && decision.fluency
              ? decision.fluency.targetResponseSpeedSec
              : 0,
          offeredStages: offered,
          supportedByStage,
          topicName: topicRow.topic_name,
        });
        // Stage choice still open (no param, topic offers both, and the
        // param-less resolution hit a fallback reason that needs a stage
        // to record which game the child wanted): show the stage pick.
        if (!chosen && offered.length > 1) {
          setPhase("stage-pick");
        } else {
          setPhase("resolved");
        }
      } catch (err) {
        if (!cancelled) {
          setPhase("error");
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gradeParam, stageParam, topicCode, unitId]);

  if (phase === "loading") {
    return (
      <View style={{ padding: spacing.xxl, alignItems: "center", gap: spacing.md }}>
        <ActivityIndicator color={colors.primary.fill} accessibilityLabel="Loading game" />
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>Loading game...</Text>
      </View>
    );
  }

  if (phase === "no-pack") {
    return (
      <View style={{ padding: spacing.xxl, gap: spacing.md }}>
        <Text style={{ ...typeRamp.h3, color: colors.text }}>Content pack needed</Text>
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
          The learning pack for this grade is not on the device yet. Go back to the journey map and
          pick the grade again to download it.
        </Text>
        <Button
          label="Back to journey"
          variant="secondary"
          onPress={() => router.push("/journey")}
          accessibilityHint="Return to the journey map to download the pack"
        />
      </View>
    );
  }

  if (phase === "error") {
    return (
      <View style={{ padding: spacing.xxl, gap: spacing.md }}>
        <Text style={{ ...typeRamp.h3, color: colors.text }}>Game unavailable</Text>
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
          {error ?? "Something went wrong loading the game."}
        </Text>
        <Button
          label="Back to practice"
          variant="outline"
          onPress={() => router.back()}
          accessibilityHint="Return to the practice topic picker"
        />
      </View>
    );
  }

  if (phase === "stage-pick" && resolution) {
    return (
      <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: spacing.md }}>
        <Text style={{ ...typeRamp.h2, color: colors.text }}>{`Play ${resolution.topicName}`}</Text>
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
          Pick how you want to play.
        </Text>
        {resolution.offeredStages.map((stage) => {
          const isFallback = resolution.supportedByStage[stage] !== true;
          return (
            <Pressable
              key={stage}
              accessibilityRole="button"
              accessibilityLabel={
                stage === "guided"
                  ? "Guided explorer game. Untimed with hints."
                  : "Fluency sprint game. Beat the clock."
              }
              onPress={() => {
                // Re-resolve WITH the chosen stage so a fallback marker
                // names the intended archetype + that stage's target.
                const block = blockRef.current;
                const decision = block
                  ? resolveGameRoute(block, stage, SUPPORTED_ARCHETYPES)
                  : null;
                setStageChoice(stage);
                if (decision) {
                  setResolution((prev) =>
                    prev
                      ? {
                          ...prev,
                          status: decision.kind === "game" ? "game" : "fallback",
                          stage: decision.stage,
                          archetype: decision.archetype,
                          gameTitle: decision.kind === "game" ? decision.gameTitle : "",
                          targetResponseSpeedSec:
                            decision.kind === "game" && decision.fluency
                              ? decision.fluency.targetResponseSpeedSec
                              : 0,
                        }
                      : prev,
                  );
                }
                setPhase("resolved");
              }}
              style={({ pressed }) => ({
                minHeight: 64,
                justifyContent: "center",
                gap: spacing.xs,
                paddingHorizontal: spacing.lg,
                paddingVertical: spacing.md,
                borderRadius: 16,
                borderWidth: 2,
                borderCurve: "continuous",
                borderColor: pressed ? colors.info : colors.border,
                backgroundColor: colors.surface,
              })}
            >
              <Text style={{ ...typeRamp.title, color: colors.text }}>
                {stage === "guided" ? "Guided Explorer" : "Fluency Sprint"}
              </Text>
              <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
                {stage === "guided"
                  ? "Take your time. Hints and pictures help you."
                  : "Answer fast. Beat your best time."}
              </Text>
              {isFallback ? (
                <Text style={{ ...typeRamp.caption, color: colors.textMuted }}>
                  {"This one plays in practice mode for now."}
                </Text>
              ) : null}
            </Pressable>
          );
        })}
      </ScrollView>
    );
  }

  // Resolved: mount the game session or the practice fallback.
  if (!resolution) {
    return (
      <View style={{ padding: spacing.xxl, alignItems: "center" }}>
        <ActivityIndicator color={colors.primary.fill} accessibilityLabel="Loading game" />
      </View>
    );
  }

  const stage = stageChoice ?? resolution.stage;
  if (resolution.status === "game" && stage) {
    return (
      <GameSessionScreen
        gradeId={gradeParam}
        unitId={unitId}
        topicCode={topicCode}
        stage={stage}
        archetype={resolution.archetype ?? "block-builder"}
      />
    );
  }

  // Fallback: the SAME topic in the #50 practice runner, with the
  // fallback marker riding every attempt row (telemetry). Same item
  // sourcing as a plain practice session (stored pack rows + engine
  // padding) - transparent to the child, recorded in telemetry.
  const fallbackTelemetry: GameAttemptTelemetry = {
    spiralProvenance: "",
    targetResponseSpeedSec: resolution.targetResponseSpeedSec,
    archetype: resolution.archetype ?? "",
    fallback: true,
  };
  return (
    <PracticeRunnerScreen
      gradeId={gradeParam}
      unitId={unitId}
      topicCode={topicCode}
      gameFallback={fallbackTelemetry}
    />
  );
}
