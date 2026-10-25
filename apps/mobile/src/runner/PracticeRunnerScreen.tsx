/**
 * Practice session runner screen (issue #50): the full session
 * lifecycle - topic picker (unit entry from the journey map), 3-tap
 * motor warm-up, question flow rendered per interaction type x CPA
 * stage, answer capture with durable per-response recording (#47
 * append-only log), expanding-retrieval re-queues, completion summary,
 * and gentle exit.
 *
 * Offline-first: everything below runs from the installed pack + the
 * engine; no network call exists in this file. Audio/haptics ride the
 * #45 AudioCoordinator (per-grade WPM narration, SFX moments, duck
 * policy during narration, haptics suppressed under reduced motion).
 *
 * The screen is the THIN RN layer: all decisions flow through the pure
 * modules (sessionStore reducer, renderPlanFor matrix, requeue
 * scheduler, engine calls) - see src/runner/*.ts.
 */
import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { badgeById } from "@balashikshana/core-engine";
import type { AudioCoordinator } from "../audio/coordinator";
import { adaptNarration } from "../audio/ssml";
import {
  hintLineForTopic,
  introLineForTopic,
  remediationLineForTopic,
} from "../audio/topicNarration";
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
import type {
  GameAttemptTelemetry,
  PracticeQuestion,
  TopicProgressRecord,
} from "../practice/types";
import type { TopicSessionSummary } from "../practice/practiceEngine";
import { getNativePracticeDeps } from "../practice/nativePractice";
import { GHOST_FLASH_MS, stageForTopicProgress, stageLabelFor } from "./cpaStages";
import {
  anchorLabelForVisualAid,
  answerTextFor,
  choiceOptionsFor,
  counterSpecFor,
  renderPlanFor,
  tileSpecFor,
  visualRowFor,
} from "./questionShapes";
import type { RunnerOption } from "./questionShapes";
import {
  currentQuestion,
  currentStage,
  initialRunnerState,
  runnerReducer,
  topicPicksFrom,
} from "./sessionStore";
import type { CheckedFeedback } from "./sessionStore";
import { MotorWarmup } from "./MotorWarmup";
import { asGradeId, getRunnerAudio, getRunnerEngine, resolveRunnerIdentity } from "./runnerNative";
import { ChoiceGrid, CounterFrame, TileBuilder, VisualScaffold } from "./widgets";

export interface PracticeRunnerScreenProps {
  /** Journey param (or the snapshot's active grade when absent). */
  gradeId?: string;
  unitId: string;
  /** Optional deep-link topic (skips the picker). */
  topicCode?: string;
  /**
   * #52 game-framework fallback stamp: present only when the game host
   * routed this topic here because its archetype has no installed
   * renderer. Every attempt row of the session records the intended
   * archetype + fallback marker (telemetry); nothing else changes.
   */
  gameFallback?: GameAttemptTelemetry;
}

/** Local structural draft for the structural widgets (store keeps the string). */
interface StructuralDraft {
  filledSlots: number[];
  placedTiles: RunnerOption[];
  selectedChoiceKey: string | null;
}

const EMPTY_DRAFT: StructuralDraft = { filledSlots: [], placedTiles: [], selectedChoiceKey: null };

export function PracticeRunnerScreen({
  gradeId: gradeParam,
  unitId,
  topicCode: topicParam,
  gameFallback,
}: PracticeRunnerScreenProps): React.ReactElement {
  const { colors } = useTheme();
  const { motion } = useReducedMotion();
  // #58: the session mascot (reacts to answers; static under reduced motion).
  const { state: mascot, fire: fireMascot } = useMascot();
  const [state, dispatch] = useReducer(runnerReducer, undefined, initialRunnerState);
  const [structural, setStructural] = useState<StructuralDraft>(EMPTY_DRAFT);
  const [exitSheetOpen, setExitSheetOpen] = useState(false);
  const [completing, setCompleting] = useState(false);
  /** #59: the revealed hint for the CURRENT question only (null = hidden). */
  const [hintShown, setHintShown] = useState<{ questionId: string; text: string } | null>(null);

  const audioRef = useRef<AudioCoordinator | null>(null);
  const narrationSecRef = useRef(0);
  const questionStartRef = useRef(0);
  const progressByTopicRef = useRef<Record<string, TopicProgressRecord>>({});
  const loadedRef = useRef(false);
  /** Effective grade, resolved ONCE at mount (gradeParam ?? identity
   *  grade) and reused for narration AND sessions - the two used to
   *  diverge (review finding 3: narration fell back to asGradeId(null)
   *  when the journey param was absent, sessions to identity.gradeId). */
  const effectiveGradeRef = useRef<string | null>(null);

  // ------------------------------------------------------------------
  // Mount: identity + pack read (offline-first; no network anywhere).
  // ------------------------------------------------------------------
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    let cancelled = false;
    (async () => {
      getRunnerAudio()
        .then((coordinator) => {
          audioRef.current = coordinator;
        })
        .catch(() => {
          // Audio is best-effort; the session runs silent without it.
        });
      const identity = await resolveRunnerIdentity();
      if (cancelled) return;
      if (!identity.studentId) {
        dispatch({ type: "load-failed", error: "no child-device session for practice" });
        return;
      }
      const gradeId = gradeParam ?? identity.gradeId ?? undefined;
      effectiveGradeRef.current = gradeId ?? null;
      if (!gradeId) {
        dispatch({ type: "load-failed", error: "no active grade for practice" });
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
        const topicRows = await reader.topicsForUnit(unitId);
        const progressRows = await deps.storage.allTopicProgress(identity.studentId);
        const progressByTopic: Record<string, TopicProgressRecord> = {};
        for (const row of progressRows) progressByTopic[row.topicId] = row;
        progressByTopicRef.current = progressByTopic;
        if (cancelled) return;
        dispatch({
          type: "unit-loaded",
          unitId,
          unitTitle: unit.title,
          topics: topicPicksFrom(topicRows, progressByTopic),
        });
        if (topicParam) dispatch({ type: "topic-selected", topicCode: topicParam });
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
  }, [gradeParam, topicParam, unitId]);

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

  const question = currentQuestion(state);
  const stage = currentStage(state);
  const scheduleItem = state.schedule.items[state.index];
  // Primitive extracts for hook dependency arrays (the repo's
  // compiler-friendly pattern: objects pass as arguments, primitives
  // as deps).
  const questionId = question?.questionId ?? null;
  const prompt = question?.prompt ?? null;
  const topicId = question?.topicId ?? null;
  // Pure cheap lookup - no memo needed (and none preservable across
  // question identity changes).
  const plan = question ? renderPlanFor(question.interactionType, stage) : null;

  // Narrate the prompt when a question first appears (duck policy and
  // per-grade WPM live in the coordinator; the measured duration rides
  // the response for cognitive-time math). Timing refs only - the
  // structural draft resets in the advance/session-start handlers.
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
        // Narration failure never blocks the question.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.phase, state.index, state.sessionId, questionId, prompt, topicId]);

  // #59: speak the completion summary once when it appears (pre-readers
  // get the outcome, not just readers). Any first-mastery celebration
  // line (#58) is already queued ahead of this by completion order.
  // Fires once per summary (phase+sessionId identity), app copy — the
  // registry owns per-topic lines, the summary text is the same copy
  // the screen renders (summarySpeechText keeps the two in lockstep).
  useEffect(() => {
    if (state.phase !== "summary" || !state.summary) return;
    const text = summarySpeechText(state.summary, state.prevCrowns ?? 0);
    void audioRef.current
      ?.speak({ text, grade: asGradeId(effectiveGradeRef.current) })
      .catch(() => undefined);
  }, [state.phase, state.sessionId, state.summary, state.prevCrowns]);

  const replayPrompt = useCallback((promptText: string, promptTopicId: string) => {
    void audioRef.current
      ?.speak({
        text: promptText,
        grade: asGradeId(effectiveGradeRef.current),
        topicId: promptTopicId,
        line: "instruction",
      })
      .catch(() => undefined);
  }, []);

  // #59: the guided-hint affordance. Speaking the topic's registry hint
  // line is the ONLY live producer of the mascot's hint-shown event
  // (the #58 machine vocabulary finally has its dispatcher). The
  // adapted plain text is ALSO revealed visually so reading kids and
  // screen-reader users (TTS defers to VoiceOver per the #45 policy)
  // get the same coaching; the reveal is keyed to the question so it
  // never leaks across question boundaries.
  const requestHint = useCallback(() => {
    const activeQuestion = currentQuestion(state);
    if (!activeQuestion || state.phase !== "question") return;
    const line = hintLineForTopic(activeQuestion.topicId);
    if (!line) return;
    setHintShown({ questionId: activeQuestion.questionId, text: adaptNarration(line).plainText });
    fireMascot({ type: "hint-shown" });
    void audioRef.current
      ?.speak({
        text: line,
        grade: asGradeId(effectiveGradeRef.current),
        topicId: activeQuestion.topicId,
        line: "hint",
      })
      .catch(() => undefined);
  }, [state, fireMascot]);

  // ------------------------------------------------------------------
  // Draft plumbing (structural widgets -> store string draft). Plain
  // handlers on purpose: the compiler owns memoization here, and each
  // tap re-renders anyway (state change -> new closures are free).
  // ------------------------------------------------------------------
  const publishDraft = (draft: string | null) => {
    if (state.sessionId) dispatch({ type: "draft-changed", sessionId: state.sessionId, draft });
  };

  const toggleCell = (slot: number) => {
    playMoment("onInteract", topicId ?? undefined);
    // #58: the mascot's touch-pickup reaction (registry vocabulary).
    fireMascot({ type: "touch-pickup" });
    setStructural((prev) => {
      const filled = prev.filledSlots.includes(slot)
        ? prev.filledSlots.filter((entry) => entry !== slot)
        : [...prev.filledSlots, slot];
      publishDraft(String(filled.length));
      return { ...prev, filledSlots: filled };
    });
  };

  const tapTile = (option: RunnerOption) => {
    playMoment("onInteract", topicId ?? undefined);
    fireMascot({ type: "touch-pickup" });
    setStructural((prev) => {
      const placed = [...prev.placedTiles, option];
      publishDraft(placed.map((entry) => entry.label).join(" "));
      return { ...prev, placedTiles: placed };
    });
  };

  const clearTiles = () => {
    setStructural((prev) => {
      publishDraft(null);
      return { ...prev, placedTiles: [] };
    });
  };

  const selectChoice = (option: RunnerOption) => {
    playMoment("onInteract", topicId ?? undefined);
    fireMascot({ type: "touch-pickup" });
    setStructural((prev) => {
      publishDraft(option.label);
      return { ...prev, selectedChoiceKey: option.key };
    });
  };

  // ------------------------------------------------------------------
  // Session start (after the warm-up produces a baseline).
  // ------------------------------------------------------------------
  /** Engine-derived stage for a question's topic (progress rows in the
   *  ref are refreshed by refreshProgressByTopic before every session). */
  const stageFromProgressRef = useCallback((item: PracticeQuestion): string => {
    const prev = progressByTopicRef.current[item.topicId] ?? null;
    return stageForTopicProgress(prev);
  }, []);

  /**
   * Re-reads the topic-progress rows (review finding 2): the mount-time
   * snapshot goes stale the moment a session completes its projection,
   * so every session start and every picker rebuild re-derives
   * stages/crowns from a FRESH read - a back-to-back second session
   * would otherwise compute one CPA stage too concrete.
   */
  const refreshProgressByTopic = useCallback(async (studentId: string) => {
    const rows = await getNativePracticeDeps().storage.allTopicProgress(studentId);
    const progressByTopic: Record<string, TopicProgressRecord> = {};
    for (const row of rows) progressByTopic[row.topicId] = row;
    progressByTopicRef.current = progressByTopic;
    return progressByTopic;
  }, []);

  const startSession = useCallback(
    async (topicCode: string, motorBaselineSec: number) => {
      const identity = await resolveRunnerIdentity();
      const gradeId = gradeParam ?? effectiveGradeRef.current ?? identity.gradeId;
      if (!identity.studentId || !gradeId) {
        dispatch({ type: "load-failed", error: "no child-device session for practice" });
        return;
      }
      try {
        await refreshProgressByTopic(identity.studentId);
        const engine = getRunnerEngine();
        const start = await engine.startTopicSession({
          studentId: identity.studentId,
          gradeId,
          unitId,
          topicCode,
          motorBaselineSec,
          gameTelemetry: gameFallback,
        });
        const stageByQuestionId: Record<string, string> = {};
        for (const item of start.questions) {
          stageByQuestionId[item.questionId] = stageFromProgressRef(item);
        }
        const prev = progressByTopicRef.current[start.topicId];
        setStructural(EMPTY_DRAFT);
        // #59: the topic's registry intro line opens the session (SSML
        // through the coordinator; the first question's prompt narration
        // queues behind it in the platform speech queue). A missing line
        // is a warned silent skip - never a block.
        const intro = introLineForTopic(start.topicId);
        if (intro) {
          void audioRef.current
            ?.speak({
              text: intro,
              grade: asGradeId(effectiveGradeRef.current),
              topicId: start.topicId,
              line: "intro",
            })
            .catch(() => undefined);
        }
        dispatch({
          type: "session-started",
          sessionId: start.sessionId,
          questions: start.questions,
          stageByQuestionId,
          prevCrowns: prev?.crowns ?? 0,
          targetSpeedSec: start.targetSpeedSec,
        });
      } catch (error) {
        dispatch({
          type: "load-failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [gradeParam, unitId, stageFromProgressRef, refreshProgressByTopic, gameFallback],
  );

  // ------------------------------------------------------------------
  // Check + continue (durable recording per response).
  // ------------------------------------------------------------------
  const handleCheck = useCallback(async () => {
    const activeQuestion = currentQuestion(state);
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
      // #58: the mascot mirrors the feedback (snap-confirm on correct,
      // the warm growth-reframe bounce on gentle retry).
      fireMascot({ type: isCorrect ? "answer-correct" : "answer-gentle-retry" });
      if (isCorrect && result.fluencyGrade === 4) {
        playMoment("onSpeedTargetBeat", activeQuestion.topicId);
      }
      const nextStreak = isCorrect ? state.streak + 1 : 0;
      if (isCorrect && nextStreak >= 3 && nextStreak % 3 === 0) {
        playMoment("onStreakCombo", activeQuestion.topicId);
      }
      void audioRef.current?.haptic(isCorrect ? "correct" : "gentle-retry");
      // #59: a wrong answer speaks the topic's registry remediation
      // line at the gentle-retry moment (speech was already stopped at
      // check time, so the queue is clear). Pre-readers get the same
      // coaching the feedback panel shows readers.
      if (!isCorrect) {
        const remediation = remediationLineForTopic(activeQuestion.topicId);
        if (remediation) {
          void audioRef.current
            ?.speak({
              text: remediation,
              grade: asGradeId(effectiveGradeRef.current),
              topicId: activeQuestion.topicId,
              line: "remediation",
            })
            .catch(() => undefined);
        }
      }
    } catch (error) {
      // Free sync liveness BEFORE surfacing the failure (review finding
      // 1): a failed submit must not strand the session id in the
      // engine's active map - syncEngine upload batching stops at the
      // first active-session group, so a stranded id would hold back
      // this session AND every later one until app restart. Abandon
      // keeps already-recorded attempts durable in the append-only log
      // (no projection is written).
      getRunnerEngine().abandonSession(state.sessionId);
      dispatch({
        type: "summary-failed",
        sessionId: state.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, [state, playMoment, fireMascot]);

  const handleContinue = useCallback(async () => {
    if (state.phase !== "feedback" || !state.sessionId) return;
    const isLast = state.index + 1 >= state.schedule.items.length;
    if (isLast) {
      setCompleting(true);
      try {
        const summary = await getRunnerEngine().completeTopicSession(state.sessionId);
        dispatch({ type: "summary-ready", sessionId: state.sessionId, summary });
        if (summary.passedTopic) playMoment("onCorrect", currentQuestion(state)?.topicId);
        // #58: the mastery bloom moment — star fanfare + the registry's
        // own celebration line through the #45 TTS coordinator.
        const firstMastery = summary.passedTopic && summary.topicProgress.completed === 1;
        if (firstMastery) {
          audioRef.current?.sfx("sfx_star_fanfare");
          void audioRef.current
            ?.speak({
              text: celebrationLineForTopic(summary.topicProgress.topicId, 0),
              grade: asGradeId(effectiveGradeRef.current),
              topicId: summary.topicProgress.topicId,
              line: "celebration",
            })
            .catch(() => undefined);
        }
      } catch (error) {
        // Same liveness rule as the submit path (review finding 1): a
        // completion that throws leaves the session open in the engine
        // (completeTopicSession only deletes it on success), so abandon
        // it before summary-failed or sync batching wedges until
        // restart. The durable attempt log is untouched either way.
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
    setStructural(EMPTY_DRAFT);
    dispatch({ type: "continue-pressed", sessionId: state.sessionId });
  }, [state, playMoment]);

  const handleWarmupComplete = useCallback(
    (motorBaselineSec: number) => {
      dispatch({ type: "warmup-completed", motorBaselineSec });
      if (state.activeTopicCode) void startSession(state.activeTopicCode, motorBaselineSec);
    },
    [startSession, state.activeTopicCode],
  );

  const confirmExit = useCallback(() => {
    setExitSheetOpen(false);
    if (state.sessionId) getRunnerEngine().abandonSession(state.sessionId);
    void audioRef.current?.stopSpeech();
    router.back();
  }, [state.sessionId]);

  const backToPicker = useCallback(async () => {
    // Practice another topic: rebuild the picker from a FRESH progress
    // read (review finding 2) so crowns/stages reflect the session that
    // just completed, never the mount-time snapshot. Best-effort: if the
    // refresh throws, the picker still opens on the previous rows.
    let topics = state.topics;
    try {
      const identity = await resolveRunnerIdentity();
      if (identity.studentId) {
        const progressByTopic = await refreshProgressByTopic(identity.studentId);
        topics = topicPicksFrom(
          state.topics.map((topic) => ({
            topic_id: topic.topicId,
            topic_code: topic.topicCode,
            topic_name: topic.topicName,
          })),
          progressByTopic,
        );
      }
    } catch {
      // Fall through with the existing picks.
    }
    dispatch({
      type: "unit-loaded",
      unitId: state.unitId ?? unitId,
      unitTitle: state.unitTitle ?? "",
      topics,
    });
  }, [state.unitId, state.unitTitle, state.topics, unitId, refreshProgressByTopic]);

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  if (state.phase === "loading") {
    return (
      <View style={{ padding: spacing.xxl, alignItems: "center", gap: spacing.md }}>
        <ActivityIndicator color={colors.primary.fill} accessibilityLabel="Loading practice" />
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>Loading practice...</Text>
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
        <Text style={{ ...typeRamp.h3, color: colors.text }}>Practice unavailable</Text>
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
          {state.error ?? "Something went wrong loading practice."}
        </Text>
        <Button
          label="Back to journey"
          variant="outline"
          onPress={() => router.push("/journey")}
          accessibilityHint="Return to the journey map"
        />
      </View>
    );
  }

  if (state.phase === "picker") {
    return (
      <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: spacing.md }}>
        <Text style={{ ...typeRamp.h2, color: colors.text }}>
          {state.unitTitle ?? "Choose a topic"}
        </Text>
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
          Pick a topic to practice. Topics you have seen before show your crowns.
        </Text>
        {state.topics.map((topic) => (
          <View key={topic.topicId} style={{ flexDirection: "row", gap: spacing.sm }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Practice topic ${topic.topicName}. ${topic.crowns} crowns. ${stageLabelFor(topic.cpaStage)} stage.`}
              onPress={() => dispatch({ type: "topic-selected", topicCode: topic.topicCode })}
              style={({ pressed }) => ({
                flex: 1,
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
              <Text style={{ ...typeRamp.title, color: colors.text }}>{topic.topicName}</Text>
              <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
                {`${"★".repeat(topic.crowns)}${topic.crowns === 0 ? "No crowns yet" : ""} · ${stageLabelFor(topic.cpaStage)}`}
              </Text>
            </Pressable>
            {/* #52 game entry: routes to the game host; unsupported
                archetypes fall back to THIS runner transparently. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Play game for topic ${topic.topicName}`}
              onPress={() =>
                router.push({
                  pathname: "/game",
                  params: { unitId, topicCode: topic.topicCode },
                })
              }
              style={({ pressed }) => ({
                minWidth: 64,
                minHeight: 64,
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 16,
                borderWidth: 2,
                borderCurve: "continuous",
                borderColor: pressed ? colors.info : colors.border,
                backgroundColor: pressed ? colors.surfaceTinted : colors.surface,
              })}
            >
              <Text style={{ ...typeRamp.h3, color: colors.secondary.label }}>{"Play"}</Text>
              <Text style={{ ...typeRamp.caption, color: colors.textMuted }}>{"game"}</Text>
            </Pressable>
          </View>
        ))}
      </ScrollView>
    );
  }

  if (state.phase === "warmup") {
    return <MotorWarmup onComplete={handleWarmupComplete} testID="practice-warmup" />;
  }

  if (state.phase === "summary" && state.summary) {
    const summary = state.summary;
    const crownDelta = summary.crownsAwarded - (state.prevCrowns ?? 0);
    // #58: the celebration queue (mastery bloom, new badges, level-up,
    // streak milestone) from the session's reward-report deltas.
    const firstMastery = summary.passedTopic && summary.topicProgress.completed === 1;
    const moments = planCelebrationMoments({
      report: summary.celebration,
      topicMastered: firstMastery,
    });
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
    const topicPick = state.topics.find(
      (pick) => pick.topicCode === summary.topicProgress.topicCode,
    );
    return (
      <ScrollView
        contentContainerStyle={{ padding: spacing.xxl, gap: spacing.lg, alignItems: "center" }}
      >
        {moments.length > 0 ? (
          <CelebrationStack
            moments={moments}
            badgeById={bloomById}
            animationsEnabled={motion.animationsEnabled}
            topicName={topicPick?.topicName ?? null}
            level={summary.celebration.level}
            testID="practice-celebration"
          />
        ) : null}
        <Text style={{ ...typeRamp.h1, color: colors.text, textAlign: "center" }}>
          {summary.passedTopic ? "Topic complete!" : "Nice practice!"}
        </Text>
        <Text style={{ ...typeRamp.body, color: colors.textMuted, textAlign: "center" }}>
          {summary.passedTopic
            ? `You earned ${"★".repeat(summary.crownsAwarded)} crowns${crownDelta > 0 ? ` (up ${crownDelta})` : ""}.`
            : "Keep going - reach 80% to earn your next crown."}
        </Text>
        <View
          style={{
            flexDirection: "row",
            gap: spacing.md,
            flexWrap: "wrap",
            justifyContent: "center",
          }}
        >
          <SummaryStat label="Accuracy" value={`${summary.accuracyPct}%`} />
          <SummaryStat
            label="Median speed"
            value={`${summary.medianCogSpeedSec}s`}
            hint={`target ${summary.targetSpeedSec}s`}
          />
          <SummaryStat label="Memory stability" value={`${summary.stabilityDays}d`} />
          <SummaryStat label="Next stage" value={stageLabelFor(summary.cpaStage)} />
        </View>
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
          label="Practice another topic"
          variant="outline"
          onPress={() => void backToPicker()}
          accessibilityHint="Choose a different topic in this unit"
        />
      </ScrollView>
    );
  }

  if (!question || !plan || !scheduleItem) {
    return (
      <View style={{ padding: spacing.xxl, alignItems: "center" }}>
        <ActivityIndicator color={colors.primary.fill} accessibilityLabel="Loading question" />
      </View>
    );
  }

  const total = state.schedule.items.length;
  const progressPct = Math.round((state.index / Math.max(1, total)) * 100);
  const isChecked = state.phase === "feedback" && state.checked !== null;

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {/* Session header: mascot, progress, stage badge, exit. */}
      <View style={{ paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
          <MascotView
            state={mascot}
            animationsEnabled={motion.animationsEnabled}
            size={40}
            testID="practice-mascot"
          />
          <View style={{ flex: 1 }}>
            <ProgressBar
              progress={progressPct / 100}
              accessibilityLabel={`Question ${state.index + 1} of ${total}`}
            />
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Exit practice"
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
            accessibilityLabel={`${stageLabelFor(stage)} stage`}
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
              {stageLabelFor(stage).toUpperCase()}
            </Text>
          </View>
          {state.streak >= 2 ? (
            <Text style={{ ...typeRamp.label, color: colors.statusInk.success }}>
              {`Streak ${state.streak}`}
            </Text>
          ) : null}
        </View>
      </View>

      {/* Question stage. */}
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.md,
          gap: spacing.lg,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Read the question again"
            onPress={() => replayPrompt(question.prompt, question.topicId)}
            style={{ minHeight: 48, minWidth: 48, alignItems: "center", justifyContent: "center" }}
          >
            <Text style={{ ...typeRamp.title, color: colors.secondary.label }}>{"▶"}</Text>
          </Pressable>
          {/* #59: guided hint - speaks the topic's registry hint line and
              reveals it as text (48pt target, same affordance row). */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Get a hint"
            accessibilityHint="Reads a clue for this question"
            onPress={requestHint}
            style={{ minHeight: 48, minWidth: 48, alignItems: "center", justifyContent: "center" }}
          >
            <Text style={{ ...typeRamp.title, color: colors.secondary.label }}>{"?"}</Text>
          </Pressable>
          <Text style={{ ...typeRamp.h3, color: colors.text, flexShrink: 1 }}>
            {question.prompt}
          </Text>
        </View>

        {hintShown?.questionId === question.questionId ? (
          <Text testID="question-hint" style={{ ...typeRamp.body, color: colors.textMuted }}>
            {hintShown.text}
          </Text>
        ) : null}

        {plan.visualMode !== "none" ? (
          <VisualScaffold
            key={`${question.questionId}-${state.index}-${plan.visualMode}`}
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
            disabled={isChecked}
            onToggleCell={toggleCell}
          />
        ) : null}
        {plan.widget === "tile-builder" ? (
          <TileBuilder
            bank={tileSpecFor(question).bank}
            placed={structural.placedTiles}
            disabled={isChecked}
            onTileTapped={tapTile}
            onClear={clearTiles}
          />
        ) : null}
        {plan.widget === "choice" ? (
          <ChoiceGrid
            options={choiceOptionsFor(question)}
            selectedKey={structural.selectedChoiceKey}
            disabled={isChecked}
            onOptionSelected={selectChoice}
          />
        ) : null}
      </ScrollView>

      {/* Feedback + action bar. */}
      <View
        style={{
          borderTopWidth: 2,
          borderTopColor: colors.border,
          backgroundColor: isChecked
            ? state.checked?.isCorrect
              ? colors.surfaceTinted
              : colors.surfaceAlt
            : colors.surface,
          padding: spacing.lg,
          gap: spacing.md,
        }}
      >
        {isChecked && state.checked ? (
          <FeedbackBar checked={state.checked} targetSpeedSec={state.targetSpeedSec ?? 0} />
        ) : (
          <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
            {structural.selectedChoiceKey !== null ||
            structural.filledSlots.length > 0 ||
            structural.placedTiles.length > 0
              ? "Tap CHECK when your answer is ready."
              : "Choose your answer, then tap CHECK."}
          </Text>
        )}
        <Button
          label={
            completing
              ? "Finishing..."
              : isChecked
                ? state.index + 1 >= total
                  ? "SEE RESULTS"
                  : "CONTINUE"
                : "CHECK"
          }
          variant={
            isChecked && state.checked
              ? state.checked.isCorrect
                ? "primary"
                : "secondary"
              : "primary"
          }
          disabled={completing}
          onPress={isChecked ? handleContinue : handleCheck}
          testID="practice-action"
          accessibilityHint={isChecked ? "Go to the next question" : "Check your answer"}
        />
      </View>

      <Sheet
        visible={exitSheetOpen}
        onClose={() => setExitSheetOpen(false)}
        title="Leave practice?"
      >
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
          Your answers so far are saved. You can come back any time.
        </Text>
        <View style={{ gap: spacing.md, marginTop: spacing.lg }}>
          <Button
            label="Keep practicing"
            variant="outline"
            onPress={() => setExitSheetOpen(false)}
          />
          <Button
            label="Leave"
            variant="danger"
            onPress={confirmExit}
            accessibilityHint="Save answers and return to the journey"
          />
        </View>
      </Sheet>
    </View>
  );
}

function FeedbackBar({
  checked,
  targetSpeedSec,
}: {
  checked: CheckedFeedback;
  targetSpeedSec: number;
}): React.ReactElement {
  const { colors } = useTheme();
  return (
    <View style={{ gap: spacing.xs }}>
      <Text
        style={{
          ...typeRamp.title,
          color: checked.isCorrect ? colors.statusInk.success : colors.statusInk.warning,
        }}
      >
        {checked.isCorrect
          ? `Awesome! Thinking time: ${checked.cognitiveTimeSec}s${targetSpeedSec > 0 ? ` (target ${targetSpeedSec}s)` : ""}`
          : "Almost! Let's look again."}
      </Text>
      {!checked.isCorrect ? (
        <Text style={{ ...typeRamp.body, color: colors.text }}>
          {`Answer: ${checked.correctAnswer}`}
        </Text>
      ) : null}
      {checked.explanation !== "" ? (
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
          {checked.explanation}
        </Text>
      ) : null}
    </View>
  );
}

function SummaryStat({
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

/**
 * #59: the spoken form of the completion summary - same copy as the
 * rendered heading/body, with the crown glyphs replaced by their count
 * (a spoken "star star star" is noise; the count is the information).
 * Pure: kept beside the screen so the visual and spoken summaries
 * drift together.
 */
function summarySpeechText(summary: TopicSessionSummary, prevCrowns: number): string {
  if (summary.passedTopic) {
    const delta = summary.crownsAwarded - prevCrowns;
    return `Topic complete! You earned ${summary.crownsAwarded} crowns${
      delta > 0 ? ` (up ${delta})` : ""
    }.`;
  }
  return "Nice practice! Keep going - reach 80% to earn your next crown.";
}
