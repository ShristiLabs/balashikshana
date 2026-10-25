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
import { badgeById, HEART_COUNT, heartsRegrowProgress } from "@balashikshana/core-engine";
import type { AudioCoordinator } from "../audio/coordinator";
import { Button, ProgressBar, Sheet } from "../design/primitives";
import { useTheme } from "../design/theme";
import { spacing, typeRamp } from "../design/tokens";
import { useReducedMotion } from "../design/useMotion";
import { CelebrationStack } from "../mascot/CelebrationStack";
import type { BadgeBloomBadge } from "../mascot/BadgeBloomView";
import { MascotView } from "../mascot/MascotView";
import { useMascot } from "../mascot/useMascot";
import { planCelebrationMoments } from "../mascot/celebrationEvents";
import { celebrationLineForTopic } from "../mascot/celebrationLines";
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
import type { GameSessionSummary } from "../practice/practiceEngine";
import { getNativePracticeDeps } from "../practice/nativePractice";
import {
  currentGameQuestion,
  currentGameStage,
  gameReducer,
  initialGameState,
  PROVENANCE_LABELS,
} from "./gameStore";
import { rendererForArchetype } from "./archetypeRegistry";
import { HeartsDisplay } from "./HeartsDisplay";
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
  const { motion } = useReducedMotion();
  // #58: the session mascot (reacts to answers; static under reduced motion).
  const { state: mascot, fire: fireMascot } = useMascot();
  const [state, dispatch] = useReducer(gameReducer, undefined, initialGameState);
  const [exitSheetOpen, setExitSheetOpen] = useState(false);
  const [completing, setCompleting] = useState(false);
  /**
   * #56 rest-refill snapshot for the reframe screen, computed ONCE at
   * summary time (event handler, not render — the purity rule): how
   * many lost hearts have grown back by rest. Presentational only; the
   * next session always starts with a full heart row regardless.
   */
  const [heartsRegrow, setHeartsRegrow] = useState<{
    regrown: number;
    stillGrowing: boolean;
  } | null>(null);
  /** #53 carry-over fix 1: play-again double-start guard (the summary
   * unmounts on the transition; this closes the double-tap window). */
  const [restarting, setRestarting] = useState(false);

  const audioRef = useRef<AudioCoordinator | null>(null);
  const narrationSecRef = useRef(0);
  const questionStartRef = useRef(0);
  // Mirror of the latest published draft: the #54 reflex seam
  // (onSubmitAnswer) fires in the SAME tick as the draft dispatch, so
  // handleCheck must not wait for the re-render to see it.
  const draftRef = useRef<string | null>(null);
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
  // In-flight submit guard (#54 review): a second reflex tap - or a
  // Check double-tap - that lands while submitResponse is awaited
  // still sees the stale question-phase closure and would double-
  // submit the item (duplicate attempts, double re-queue fold). The
  // ref closes for the whole await span; disabled alone cannot cover
  // it (it flips only after the response dispatch commits).
  const checkingRef = useRef(false);
  const handleCheck = useCallback(
    async (draftOverride?: string) => {
      if (checkingRef.current) return;
      const activeQuestion = currentGameQuestion(state);
      const activeItem = state.schedule.items[state.index];
      if (state.phase !== "question" || !activeQuestion || !state.sessionId || !activeItem) return;
      // The reflex seam passes the just-published draft explicitly; the
      // Check button path reads the store's copy.
      const draft = draftOverride ?? state.draft;
      if (draft === null || draft.trim() === "") {
        playMoment("onGentleRetry", activeQuestion.topicId);
        return;
      }
      const rawTimeSec = Math.max(0.1, (Date.now() - questionStartRef.current) / 1000);
      const isCorrect = draft.trim() === answerTextFor(activeQuestion);
      checkingRef.current = true;
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
          // #56: re-queue repeats never cost a second heart — the
          // engine's heartStateAfterResponse rule keys off this flag.
          isRequeue: activeItem.origin === "requeue",
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
          ...(result.hearts ? { hearts: result.hearts } : {}),
        });
        playMoment(isCorrect ? "onCorrect" : "onGentleRetry", activeQuestion.topicId);
        // #58: the mascot mirrors the feedback (snap-confirm / the warm
        // growth-reframe bounce — positive framing, never a sad pose).
        fireMascot({ type: isCorrect ? "answer-correct" : "answer-gentle-retry" });
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
      } finally {
        // Re-open the submit path (summary-failed ends the session;
        // response-recorded moves to feedback - both leave the guard
        // safe to clear).
        checkingRef.current = false;
      }
    },
    [state, playMoment, fireMascot],
  );

  const handleContinue = useCallback(async () => {
    if (state.phase !== "feedback" || !state.sessionId) return;
    // #56: an emptied heart row ends the sprint HERE — the same
    // completeGameSession call (projections + #55 rewards still credit
    // the effort; the engine stamps the hearts-empty end reason). The
    // child always sees their feedback for the item first.
    const isLast = state.index + 1 >= state.schedule.items.length || state.heartsRemaining === 0;
    if (isLast) {
      setCompleting(true);
      try {
        const summary = await getRunnerEngine().completeGameSession(state.sessionId);
        dispatch({ type: "summary-ready", sessionId: state.sessionId, summary });
        // #56: snapshot the rest-refill progress for the reframe copy
        // here (event time), never in render (purity rule).
        setHeartsRegrow(
          summary.hearts && summary.hearts.endReason === "hearts-empty"
            ? heartsRegrowProgress({
                lostHearts: summary.hearts.heartsLost,
                endedAtMs: summary.hearts.endedAtMs,
                nowMs: Date.now(),
              })
            : null,
        );
        // Re-arm the play-again guard for the next summary visit.
        setRestarting(false);
        if (summary.metGoal) {
          playMoment("onCorrect", currentGameQuestion(state)?.topicId);
          // #58: the registry's own celebrationPrompts line for the
          // topic (#45 TTS, deterministic pick; #59: unknown topics
          // fall back INSIDE the module - no hardcoded spoken strings
          // at the call site).
          const celebrationTopicId = currentGameQuestion(state)?.topicId ?? state.topicId ?? "";
          void audioRef.current
            ?.speak({
              text: celebrationLineForTopic(celebrationTopicId, 0),
              grade: asGradeId(effectiveGradeRef.current),
              topicId: celebrationTopicId,
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

  // #59: speak the game summary once when it appears - pre-readers get
  // the same outcome copy readers see (the #56 hearts-empty reframe is
  // the load-bearing moment: it is spoken, not just displayed). Any
  // goal-met registry celebration line (#58) is already queued ahead of
  // this by completion order. Fires once per summary (phase+sessionId).
  useEffect(() => {
    if (state.phase !== "summary" || !state.summary) return;
    const text = gameSummarySpeechText(state.summary, heartsRegrow);
    if (!text) return;
    void audioRef.current
      ?.speak({ text, grade: asGradeId(effectiveGradeRef.current) })
      .catch(() => undefined);
  }, [state.phase, state.sessionId, state.summary, heartsRegrow]);

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
    // #56 growth reframe: a hearts-empty end is NEVER a fail state.
    // The copy celebrates effort + mistakes-as-learning (growth
    // mindset), reassures that hearts come back (next-session refill
    // by design), and leaves both exits open — no dead end, no block,
    // no punitive word anywhere. The rest-refill line is the engine's
    // heartsRegrowProgress rule (a snapshot taken at summary time,
    // never a timer — static + reduced-motion safe).
    const heartsEmpty = summary.hearts?.endReason === "hearts-empty";
    const regrow = heartsRegrow;
    // #58: the celebration queue. Ledger moments (mastery bloom, new
    // badges, level-up, streak milestone) lead; a goal-met game with no
    // ledger moment still gets its mascot celebration. Hearts-empty
    // keeps the growth reframe ONLY (effort copy, no goal fanfare).
    const ledgerMoments = planCelebrationMoments({
      report: summary.celebration,
      topicMastered: current?.passedTopic === true,
    });
    const moments =
      ledgerMoments.length > 0
        ? ledgerMoments
        : summary.metGoal && !heartsEmpty
          ? [{ moment: "game-goal-met" as const, badgeId: null }]
          : [];
    const bloomById: Record<string, BadgeBloomBadge> = {};
    for (const plan of moments) {
      if (!plan.badgeId || bloomById[plan.badgeId]) continue;
      const meta = badgeById(plan.badgeId);
      if (meta) {
        bloomById[plan.badgeId] = {
          id: plan.badgeId,
          title: meta.title,
          tier: meta.tier,
          description: meta.description,
        };
      }
    }
    return (
      <ScrollView
        contentContainerStyle={{ padding: spacing.xxl, gap: spacing.lg, alignItems: "center" }}
      >
        {moments.length > 0 ? (
          <CelebrationStack
            moments={moments}
            badgeById={bloomById}
            animationsEnabled={motion.animationsEnabled}
            topicName={state.topicName ?? null}
            level={summary.celebration.level}
            testID="game-celebration"
          />
        ) : null}
        <Text style={{ ...typeRamp.h1, color: colors.text, textAlign: "center" }}>
          {heartsEmpty ? "Mistakes grow your brain!" : summary.metGoal ? "Goal met!" : "Nice game!"}
        </Text>
        <Text style={{ ...typeRamp.body, color: colors.textMuted, textAlign: "center" }}>
          {heartsEmpty
            ? "Every tricky answer you tried made your brain stronger. That is how learning works."
            : summary.metGoal
              ? "You beat the game's goal. Keep it up!"
              : `Reach ${summary.stage === "fluency" ? "the speed goal" : "the accuracy goal"} next time.`}
        </Text>
        {heartsEmpty && summary.hearts ? (
          <>
            <HeartsDisplay remaining={summary.hearts.heartsRemaining} total={HEART_COUNT} />
            <Text style={{ ...typeRamp.body, color: colors.text, textAlign: "center" }}>
              {regrow &&
              regrow.regrown >= summary.hearts.heartsLost &&
              summary.hearts.heartsLost > 0
                ? "Your hearts are all back. Play again whenever you are ready!"
                : "Hearts grow back while you rest. Your next game starts with a full heart row!"}
            </Text>
          </>
        ) : null}
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
            setHeartsRegrow(null);
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
      {/* Session header: mascot, progress, provenance + stage chips, exit. */}
      <View style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
          <MascotView
            state={mascot}
            animationsEnabled={motion.animationsEnabled}
            size={40}
            testID="game-mascot"
          />
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
          {/* #56 D6: the hearts row exists ONLY when the engine mounted
           * hearts for this session (G2/G3 x fluency). heartsRemaining
           * is null for every Pre-K-G1 and guided session — the hearts
           * UI is structurally absent, per the roadmap M4 gate. */}
          {state.heartsRemaining !== null ? (
            <HeartsDisplay remaining={state.heartsRemaining} total={HEART_COUNT} />
          ) : null}
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
          draftRef.current = draft;
          if (state.sessionId)
            dispatch({ type: "draft-changed", sessionId: state.sessionId, draft });
        }}
        onReplayPrompt={replayPrompt}
        onSubmitAnswer={() => void handleCheck(draftRef.current ?? undefined)}
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
              label={
                state.heartsRemaining === 0
                  ? "See how you did"
                  : state.index + 1 >= total
                    ? "See results"
                    : "Keep playing"
              }
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

/**
 * #59: the spoken form of the game summary - the same copy the summary
 * renders (heading + body, plus the hearts-back reassurance line for
 * the #56 hearts-empty reframe). Pure module-scope helper so the visual
 * and spoken summaries drift together. Returns null when nothing
 * should be spoken (not expected today; keeps the contract explicit).
 */
function gameSummarySpeechText(
  summary: GameSessionSummary,
  regrow: { regrown: number } | null,
): string | null {
  const heartsEmpty = summary.hearts?.endReason === "hearts-empty";
  if (heartsEmpty) {
    const heartsBack =
      summary.hearts &&
      regrow &&
      regrow.regrown >= summary.hearts.heartsLost &&
      summary.hearts.heartsLost > 0
        ? " Your hearts are all back. Play again whenever you are ready!"
        : " Hearts grow back while you rest. Your next game starts with a full heart row!";
    return `Mistakes grow your brain! Every tricky answer you tried made your brain stronger. That is how learning works.${heartsBack}`;
  }
  if (summary.metGoal) {
    return "Goal met! You beat the game's goal. Keep it up!";
  }
  return `Nice game! Reach ${
    summary.stage === "fluency" ? "the speed goal" : "the accuracy goal"
  } next time.`;
}
