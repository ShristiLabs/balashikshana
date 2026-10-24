/**
 * Game session screen (issue #52) - the THIN RN layer of the game
 * framework. All decisions flow through the pure modules (gameStore
 * reducer, engine game-session methods, sessionModel roll-up); this
 * file owns timing capture, durable recording via the engine, audio
 * moments through the #45 coordinator, and mounting the resolved
 * archetype renderer. Offline-first: no network call exists here.
 *
 * Liveness doctrine (same as #50/#51): a failed submit or completion
 * ABANDONS the session before surfacing the error, so the #48 sync
 * batcher is never wedged by a stranded active session; already
 * recorded attempts stay durable in the append-only log.
 */
import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { ComponentType } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import type { AudioCoordinator } from "../audio/coordinator";
import { Button, ProgressBar, Sheet } from "../design/primitives";
import { useTheme } from "../design/theme";
import { spacing, typeRamp } from "../design/tokens";
import { stageForTopicProgress, stageLabelFor } from "../runner/cpaStages";
import { MotorWarmup } from "../runner/MotorWarmup";
import { answerTextFor } from "../runner/questionShapes";
import {
  asGradeId,
  getRunnerAudio,
  getRunnerEngine,
  resolveRunnerIdentity,
} from "../runner/runnerNative";
import type { TopicProgressRecord } from "../practice/types";
import { getNativePracticeDeps } from "../practice/nativePractice";
import {
  currentGameQuestion,
  currentGameStage,
  gameReducer,
  initialGameState,
  PROVENANCE_LABELS,
} from "./gameStore";
import { rendererForArchetype } from "./archetypeRegistry";
import type { GameRendererProps } from "./types";

export interface GameSessionScreenProps {
  gradeId?: string;
  unitId: string;
  topicCode: string;
  /** Registry stage the host resolved for this session. */
  stage: "guided" | "fluency";
  /** Archetype to mount (host already resolved it as supported). */
  archetype: string;
}

function GameSummaryStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}): React.ReactElement {
  const { colors } = useTheme();
  return (
    <View
      accessibilityLabel={`${label} ${value}${hint ? `, ${hint}` : ""}`}
      style={{
        minWidth: 120,
        minHeight: 72,
        alignItems: "center",
        justifyContent: "center",
        gap: spacing.xs,
        paddingHorizontal: spacing.md,
        borderRadius: 16,
        borderWidth: 2,
        borderColor: colors.border,
        backgroundColor: colors.surface,
      }}
    >
      <Text style={{ ...typeRamp.label, color: colors.textMuted }}>{label.toUpperCase()}</Text>
      <Text style={{ ...typeRamp.h3, color: colors.text }}>{value}</Text>
      {hint ? <Text style={{ ...typeRamp.caption, color: colors.textMuted }}>{hint}</Text> : null}
    </View>
  );
}

export function GameSessionScreen({
  gradeId: gradeParam,
  unitId,
  topicCode,
  stage,
  archetype,
}: GameSessionScreenProps): React.ReactElement {
  const { colors } = useTheme();
  const [state, dispatch] = useReducer(gameReducer, undefined, initialGameState);
  const [exitSheetOpen, setExitSheetOpen] = useState(false);
  const [completing, setCompleting] = useState(false);
  /** #53 carry-over fix 1: play-again double-start guard (the summary
   * unmounts on the transition; this closes the double-tap window). */
  const [restarting, setRestarting] = useState(false);

  const audioRef = useRef<AudioCoordinator | null>(null);
  const narrationSecRef = useRef(0);
  const questionStartRef = useRef(0);
  const progressByTopicRef = useRef<Record<string, TopicProgressRecord>>({});
  const effectiveGradeRef = useRef<string | null>(null);
  /**
   * The archetype renderer, resolved ONCE per mount with a LAZY state
   * initializer (the static-components rule forbids component lookups
   * in the render body; #53/#54 registrations swap the component inside
   * the registry map, not here).
   */
  const [Renderer] = useState<ComponentType<GameRendererProps> | null>(() =>
    rendererForArchetype(archetype),
  );

  // ------------------------------------------------------------------
  // Mount: identity + pack read, then the motor warm-up (the session
  // opens only after it produces a baseline - same doctrine as the #50
  // runner).
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!Renderer) {
      dispatch({ type: "load-failed", error: `archetype ${archetype} has no renderer` });
      return;
    }
    let cancelled = false;
    (async () => {
      getRunnerAudio()
        .then((coordinator) => {
          audioRef.current = coordinator;
        })
        .catch(() => {
          // Audio is best-effort; the game runs silent without it.
        });
      const identity = await resolveRunnerIdentity();
      if (cancelled) return;
      if (!identity.studentId) {
        dispatch({ type: "load-failed", error: "no child-device session for games" });
        return;
      }
      const gradeId = gradeParam ?? identity.gradeId ?? undefined;
      effectiveGradeRef.current = gradeId ?? null;
      if (!gradeId) {
        dispatch({ type: "load-failed", error: "no active grade for games" });
        return;
      }
      try {
        const deps = getNativePracticeDeps();
        const reader = await deps.openContent(gradeId);
        if (!reader) {
          dispatch({ type: "no-pack" });
          return;
        }
        const unit = await reader.unit(unitId);
        if (!unit) {
          dispatch({ type: "load-failed", error: `Unit ${unitId} is not in the installed pack` });
          return;
        }
        const progressRows = await deps.storage.allTopicProgress(identity.studentId);
        const progressByTopic: Record<string, TopicProgressRecord> = {};
        for (const row of progressRows) progressByTopic[row.topicId] = row;
        progressByTopicRef.current = progressByTopic;
        if (cancelled) return;
        dispatch({
          type: "resolved",
          unitId,
          unitTitle: unit.title,
          topicCode,
          topicName: topicCode,
          offeredStages: [stage],
        });
      } catch (error) {
        if (!cancelled) {
          dispatch({
            type: "load-failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [Renderer, archetype, gradeParam, stage, topicCode, unitId]);

  // ------------------------------------------------------------------
  // Audio helpers (SFX moments + narration through the coordinator).
  // ------------------------------------------------------------------
  const playMoment = useCallback(
    (
      moment: "onInteract" | "onCorrect" | "onGentleRetry" | "onStreakCombo" | "onSpeedTargetBeat",
      topicId: string | undefined,
    ) => {
      audioRef.current?.sfx({ moment, topicId });
    },
    [],
  );

  const question = currentGameQuestion(state);
  const cpaStage = currentGameStage(state);
  const scheduleItem = state.schedule.items[state.index];
  const questionId = question?.questionId ?? null;
  const prompt = question?.prompt ?? null;
  const topicId = question?.topicId ?? null;

  // Narrate the item when it first appears (duck policy + per-grade WPM
  // live in the coordinator; the measured duration rides the response).
  useEffect(() => {
    if (state.phase !== "question" || prompt === null || topicId === null) return;
    let cancelled = false;
    (async () => {
      narrationSecRef.current = 0;
      questionStartRef.current = Date.now();
      const coordinator = audioRef.current;
      if (!coordinator || cancelled) return;
      try {
        const result = await coordinator.speak({
          text: prompt,
          grade: asGradeId(effectiveGradeRef.current),
          topicId,
          line: "instruction",
        });
        if (!cancelled) narrationSecRef.current = result.audioDurationSec;
      } catch {
        // Narration failure never blocks the game.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.phase, state.index, state.sessionId, questionId, prompt, topicId]);

  const replayPrompt = useCallback(() => {
    if (prompt === null || topicId === null) return;
    void audioRef.current
      ?.speak({
        text: prompt,
        grade: asGradeId(effectiveGradeRef.current),
        topicId,
        line: "instruction",
      })
      .catch(() => undefined);
  }, [prompt, topicId]);

  // ------------------------------------------------------------------
  // Session start (after the warm-up produces a baseline).
  // ------------------------------------------------------------------
  const startSession = useCallback(
    async (motorBaselineSec: number) => {
      const identity = await resolveRunnerIdentity();
      const gradeId = gradeParam ?? effectiveGradeRef.current ?? identity.gradeId;
      if (!identity.studentId || !gradeId) {
        dispatch({ type: "load-failed", error: "no child-device session for games" });
        return;
      }
      try {
        // Fresh progress read (the #50 stale-snapshot rule): CPA stages
        // must reflect every session that already completed.
        const progressRows = await getNativePracticeDeps().storage.allTopicProgress(
          identity.studentId,
        );
        const progressByTopic: Record<string, TopicProgressRecord> = {};
        for (const row of progressRows) progressByTopic[row.topicId] = row;
        progressByTopicRef.current = progressByTopic;

        const start = await getRunnerEngine().startGameSession({
          studentId: identity.studentId,
          gradeId,
          unitId,
          topicCode,
          stage,
          motorBaselineSec,
        });
        const stageByQuestionId: Record<string, string> = {};
        for (const item of start.questions) {
          stageByQuestionId[item.questionId] = stageForTopicProgress(
            progressByTopic[item.topicId] ?? null,
          );
        }
        dispatch({
          type: "session-started",
          sessionId: start.sessionId,
          start,
          stageByQuestionId,
        });
      } catch (error) {
        dispatch({
          type: "load-failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [gradeParam, stage, topicCode, unitId],
  );

  // ------------------------------------------------------------------
  // Check + continue (durable recording per response; the engine owns
  // derivation + telemetry stamping).
  // ------------------------------------------------------------------
  const handleCheck = useCallback(async () => {
    const activeQuestion = currentGameQuestion(state);
    const activeItem = state.schedule.items[state.index];
    if (state.phase !== "question" || !activeQuestion || !state.sessionId || !activeItem) return;
    const draft = state.draft;
    if (draft === null || draft.trim() === "") {
      playMoment("onGentleRetry", activeQuestion.topicId);
      return;
    }
    const rawTimeSec = Math.max(0.1, (Date.now() - questionStartRef.current) / 1000);
    const isCorrect = draft.trim() === answerTextFor(activeQuestion);
    try {
      void audioRef.current?.stopSpeech();
      const result = await getRunnerEngine().submitResponse(state.sessionId, {
        topicCode: activeQuestion.topicCode,
        questionId: activeQuestion.questionId,
        chosenAnswer: draft,
        isCorrect,
        rawTimeSec,
        audioDurationSec: narrationSecRef.current,
        misconceptionTags: activeQuestion.misconceptionTags,
      });
      dispatch({
        type: "response-recorded",
        sessionId: state.sessionId,
        isCorrect,
        correctAnswer: answerTextFor(activeQuestion),
        explanation: activeQuestion.explanation,
        isRequeue: activeItem.origin === "requeue",
        fluencyGrade: result.fluencyGrade,
        cognitiveTimeSec: result.cognitiveTimeSec,
        origin: activeItem.origin,
        index: state.index,
        questionId: activeQuestion.questionId,
      });
      playMoment(isCorrect ? "onCorrect" : "onGentleRetry", activeQuestion.topicId);
      if (isCorrect && result.fluencyGrade === 4) {
        playMoment("onSpeedTargetBeat", activeQuestion.topicId);
      }
      const nextStreak = isCorrect ? state.streak + 1 : 0;
      if (isCorrect && nextStreak >= 3 && nextStreak % 3 === 0) {
        playMoment("onStreakCombo", activeQuestion.topicId);
      }
      void audioRef.current?.haptic(isCorrect ? "correct" : "gentle-retry");
    } catch (error) {
      // Free sync liveness BEFORE surfacing the failure (#50/#51
      // doctrine): a failed submit must not strand the session id.
      getRunnerEngine().abandonSession(state.sessionId);
      dispatch({
        type: "summary-failed",
        sessionId: state.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [state, playMoment]);

  const handleContinue = useCallback(async () => {
    if (state.phase !== "feedback" || !state.sessionId) return;
    const isLast = state.index + 1 >= state.schedule.items.length;
    if (isLast) {
      setCompleting(true);
      try {
        const summary = await getRunnerEngine().completeGameSession(state.sessionId);
        dispatch({ type: "summary-ready", sessionId: state.sessionId, summary });
        // Re-arm the play-again guard for the next summary visit.
        setRestarting(false);
        if (summary.metGoal) {
          playMoment("onCorrect", currentGameQuestion(state)?.topicId);
          void audioRef.current
            ?.speak({
              text: "Great game! You met your goal.",
              grade: asGradeId(effectiveGradeRef.current),
              topicId: currentGameQuestion(state)?.topicId ?? undefined,
              line: "celebration",
            })
            .catch(() => undefined);
        }
      } catch (error) {
        getRunnerEngine().abandonSession(state.sessionId);
        dispatch({
          type: "summary-failed",
          sessionId: state.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setCompleting(false);
      }
      return;
    }
    dispatch({ type: "continue-pressed", sessionId: state.sessionId });
  }, [state, playMoment]);

  const confirmExit = useCallback(() => {
    setExitSheetOpen(false);
    if (state.sessionId) getRunnerEngine().abandonSession(state.sessionId);
    void audioRef.current?.stopSpeech();
    router.back();
  }, [state.sessionId]);

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  if (state.phase === "loading") {
    return (
      <View style={{ padding: spacing.xxl, alignItems: "center", gap: spacing.md }}>
        <ActivityIndicator color={colors.primary.fill} accessibilityLabel="Loading game" />
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>Loading game...</Text>
      </View>
    );
  }

  if (state.phase === "no-pack") {
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

  if (state.phase === "error") {
    return (
      <View style={{ padding: spacing.xxl, gap: spacing.md }}>
        <Text style={{ ...typeRamp.h3, color: colors.text }}>Game unavailable</Text>
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
          {state.error ?? "Something went wrong loading the game."}
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

  if (state.phase === "stage-pick") {
    // #53 carry-over fix 3: EVERY resolution (single stage included)
    // routes through this explicit affordance - the child taps the
    // stage card before any warm-up or session starts.
    return (
      <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: spacing.md }}>
        <Text style={{ ...typeRamp.h2, color: colors.text }}>
          {state.topicName ?? "Ready to play"}
        </Text>
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
          {"Pick how you want to play."}
        </Text>
        {state.offeredStages.map((offered) => (
          <Pressable
            key={offered}
            accessibilityRole="button"
            accessibilityLabel={
              offered === "guided"
                ? "Guided explorer game. Untimed with hints."
                : "Fluency sprint game. Beat the clock."
            }
            onPress={() => dispatch({ type: "stage-selected", stage: offered })}
            testID={`game-stage-${offered}`}
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
              {offered === "guided" ? "Guided Explorer" : "Fluency Sprint"}
            </Text>
            <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
              {offered === "guided"
                ? "Take your time. Hints and pictures help you."
                : "Answer fast. Beat your best time."}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    );
  }

  if (state.phase === "warmup") {
    return (
      <MotorWarmup onComplete={(baseline) => void startSession(baseline)} testID="game-warmup" />
    );
  }

  if (state.phase === "summary" && state.summary) {
    const summary = state.summary;
    // #53 carry-over fix 2: select THIS session's topic row by topic
    // id - a spiral-heavy stream can order a foreign topic first, so
    // perTopic[0] is not the current topic. Missing row hides the chip
    // rather than showing a foreign topic.
    const current = state.topicId
      ? (summary.perTopic.find((row) => row.topicId === state.topicId) ?? null)
      : null;
    return (
      <ScrollView
        contentContainerStyle={{ padding: spacing.xxl, gap: spacing.lg, alignItems: "center" }}
      >
        <Text style={{ ...typeRamp.h1, color: colors.text, textAlign: "center" }}>
          {summary.metGoal ? "Goal met!" : "Nice game!"}
        </Text>
        <Text style={{ ...typeRamp.body, color: colors.textMuted, textAlign: "center" }}>
          {summary.metGoal
            ? "You beat the game's goal. Keep it up!"
            : `Reach ${summary.stage === "fluency" ? "the speed goal" : "the accuracy goal"} next time.`}
        </Text>
        <View
          style={{
            flexDirection: "row",
            gap: spacing.md,
            flexWrap: "wrap",
            justifyContent: "center",
          }}
        >
          <GameSummaryStat label="Accuracy" value={`${summary.accuracyPct}%`} />
          {summary.speed.targetSec > 0 ? (
            <GameSummaryStat
              label="Speed"
              value={`${summary.speed.medianRawSec}s`}
              hint={`target ${summary.speed.targetSec}s`}
            />
          ) : null}
          <GameSummaryStat
            label="On target"
            value={summary.speed.targetSec > 0 ? `${summary.speed.beatTargetPct}%` : "-"}
            hint={summary.speed.targetSec > 0 ? "answers at speed" : "untimed stage"}
          />
          {current ? (
            <GameSummaryStat
              label="Topic crowns"
              value={"★".repeat(current.crowns) || "0"}
              hint={current.passedTopic ? "topic passed" : "keep practicing"}
            />
          ) : null}
        </View>
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted, textAlign: "center" }}>
          {`Mix: ${summary.provenanceCounts.current} this topic, ${summary.provenanceCounts.contrastive} warm-up, ${summary.provenanceCounts["spaced-review"]} memory boost.`}
        </Text>
        {state.requeuedSeen > 0 ? (
          <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted, textAlign: "center" }}>
            {`${state.requeuedSeen} spaced replays helped lock in tricky questions.`}
          </Text>
        ) : null}
        <Button
          label="Back to journey"
          onPress={() => router.push("/journey")}
          accessibilityHint="Return to the journey map"
        />
        <Button
          label="Play again"
          variant="outline"
          disabled={restarting}
          onPress={() => {
            // #53 carry-over fix 1: the ONLY transition is back to the
            // stage affordance -> warm-up, whose motor calibration
            // produces the baseline for the next startSession call.
            // The direct startSession(0.42) (double-start against the
            // warm-up's own start, hardcoded baseline) is gone.
            if (restarting) return;
            setRestarting(true);
            dispatch({ type: "stage-selected", stage: summary.stage });
          }}
          accessibilityHint="Start another game session on this topic"
        />
      </ScrollView>
    );
  }

  if (!question || !scheduleItem || !Renderer) {
    return (
      <View style={{ padding: spacing.xxl, alignItems: "center" }}>
        <ActivityIndicator color={colors.primary.fill} accessibilityLabel="Loading question" />
      </View>
    );
  }

  const total = state.schedule.items.length;
  const progressPct = Math.round((state.index / Math.max(1, total)) * 100);
  const provenance = state.provenanceByQuestionId[question.questionId] ?? "current";
  const speedHint =
    state.route?.targetResponseSpeedSec && state.route.targetResponseSpeedSec > 0
      ? `Aim for ${state.route.targetResponseSpeedSec}s`
      : null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {/* Session header: progress, provenance + stage chips, exit. */}
      <View style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
          <View style={{ flex: 1 }}>
            <ProgressBar
              progress={progressPct / 100}
              accessibilityLabel={`Question ${state.index + 1} of ${total}`}
            />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Exit game"
            onPress={() => setExitSheetOpen(true)}
            style={{ minHeight: 48, minWidth: 48, alignItems: "center", justifyContent: "center" }}
          >
            <Text style={{ ...typeRamp.title, color: colors.textMuted }}>{"×"}</Text>
          </Pressable>
        </View>
        <View style={{ flexDirection: "row", gap: spacing.sm, alignItems: "center" }}>
          {scheduleItem.origin === "requeue" ? (
            <View
              accessibilityLabel="Spaced replay"
              style={{
                paddingHorizontal: spacing.md,
                paddingVertical: spacing.xs,
                borderRadius: 999,
                backgroundColor: colors.surfaceTinted,
                borderWidth: 2,
                borderColor: colors.info,
              }}
            >
              <Text style={{ ...typeRamp.label, color: colors.info }}>SPACED REPLAY</Text>
            </View>
          ) : null}
          <View
            accessibilityLabel={`${PROVENANCE_LABELS[provenance] ?? provenance} question`}
            style={{
              paddingHorizontal: spacing.md,
              paddingVertical: spacing.xs,
              borderRadius: 999,
              backgroundColor: colors.surfaceAlt,
              borderWidth: 2,
              borderColor: colors.border,
            }}
          >
            <Text style={{ ...typeRamp.label, color: colors.textMuted }}>
              {(PROVENANCE_LABELS[provenance] ?? provenance).toUpperCase()}
            </Text>
          </View>
          <View
            accessibilityLabel={`${stageLabelFor(cpaStage)} stage`}
            style={{
              paddingHorizontal: spacing.md,
              paddingVertical: spacing.xs,
              borderRadius: 999,
              backgroundColor: colors.surface,
              borderWidth: 2,
              borderColor: colors.border,
            }}
          >
            <Text style={{ ...typeRamp.label, color: colors.textMuted }}>
              {stageLabelFor(cpaStage).toUpperCase()}
            </Text>
          </View>
          {state.streak >= 2 ? (
            <Text style={{ ...typeRamp.label, color: colors.statusInk.success }}>
              {`Streak ${state.streak}`}
            </Text>
          ) : null}
        </View>
        {speedHint && state.phase === "question" ? (
          <Text style={{ ...typeRamp.caption, color: colors.textMuted }}>{speedHint}</Text>
        ) : null}
      </View>

      {/* The archetype renderer owns the answer surface. Keyed by the
       * item id so every item (and every re-queued repeat) starts from
       * the renderer's pristine internal state - no reset effects. */}
      <Renderer
        key={question.questionId}
        question={question}
        stage={cpaStage}
        gameStage={stage}
        targetResponseSpeedSec={state.route?.targetResponseSpeedSec ?? 0}
        disabled={state.phase === "feedback"}
        draft={state.draft}
        onDraftChange={(draft) => {
          if (state.sessionId)
            dispatch({ type: "draft-changed", sessionId: state.sessionId, draft });
        }}
        onReplayPrompt={replayPrompt}
      />

      {/* Check + feedback + continue. */}
      <View
        style={{
          padding: spacing.lg,
          gap: spacing.sm,
          borderTopWidth: 2,
          borderTopColor: colors.border,
        }}
      >
        {state.phase === "feedback" && state.checked ? (
          <>
            <Text
              style={{
                ...typeRamp.h3,
                color: state.checked.isCorrect
                  ? colors.statusInk.success
                  : colors.statusInk.warning,
              }}
              accessibilityLabel={state.checked.isCorrect ? "Correct" : "Try again next time"}
            >
              {state.checked.isCorrect ? "Correct!" : "Not quite - the answer is shown"}
            </Text>
            <Text style={{ ...typeRamp.body, color: colors.text }}>
              {`Answer: ${state.checked.correctAnswer}`}
            </Text>
            {state.checked.explanation ? (
              <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
                {state.checked.explanation}
              </Text>
            ) : null}
            <Button
              label={state.index + 1 >= total ? "See results" : "Keep playing"}
              onPress={() => void handleContinue()}
              accessibilityHint="Continue the game"
            />
          </>
        ) : (
          <Button
            label="Check"
            onPress={() => void handleCheck()}
            disabled={completing}
            accessibilityHint="Check your answer"
          />
        )}
      </View>

      <Sheet
        visible={exitSheetOpen}
        onClose={() => setExitSheetOpen(false)}
        title="Leave the game?"
      >
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
          Your answers so far are saved. You can come back any time.
        </Text>
        <View style={{ gap: spacing.md, marginTop: spacing.lg }}>
          <Button label="Keep playing" variant="outline" onPress={() => setExitSheetOpen(false)} />
          <Button label="Leave" onPress={confirmExit} />
        </View>
      </Sheet>
    </View>
  );
}
