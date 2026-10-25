/**
 * Boss gate runner screen (issue #51): the full gate lifecycle —
 * entry status (key state + 14-hour Gold-window countdown), 3-tap
 * motor warm-up, the five-condition gate session (70/20/10 spiral
 * composition, anti-guess freeze), the per-condition results screen
 * with remediation routing, the Silver/Gold key ceremony, and the
 * 60-second 5-item Gold verification check.
 *
 * Offline-first: everything below runs from the installed pack + the
 * engine (the SAME evaluateMasteryGateAttempt call the server runs);
 * no network call exists in this file. Audio/haptics ride the #45
 * AudioCoordinator (haptics suppressed under reduced motion; the
 * ceremony animation degrades to an instant reveal).
 *
 * The screen is the THIN RN layer: decisions flow through the pure
 * modules (gateStore reducer, resultsView, spiral, ceremony machine)
 * and the #47 engine — see src/gate/*.ts. Exit/interrupt safety
 * follows the #50 doctrine: every response is durable the moment it
 * arrives, and every error path abandons the session so sync
 * liveness never wedges.
 */
import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { badgeById } from "@balashikshana/core-engine";
import type { AudioCoordinator } from "../audio/coordinator";
import { Button, ProgressBar, Sheet } from "../design/primitives";
import { useTheme } from "../design/theme";
import { spacing, typeRamp } from "../design/tokens";
import { useReducedMotion } from "../design/useMotion";
import type { TopicProgressRecord } from "../practice/types";
import { getNativePracticeDeps } from "../practice/nativePractice";
import { MotorWarmup } from "../runner/MotorWarmup";
import { answerTextFor, stageForTopicProgress, stageLabelFor } from "../runner";
import { EMPTY_STRUCTURAL_DRAFT, QuestionBody, type StructuralDraft } from "../runner/QuestionBody";
import type { RunnerOption } from "../runner/questionShapes";
import { formatGoldCountdown } from "./countdown";
import { ceremonyCopy } from "./ceremony";
import {
  currentGateQuestion,
  gateReducer,
  goldRemainingMs,
  initialGateState,
  statusEntry,
} from "./gateStore";
import { asGradeId, getGateAudio, getGateEngine, resolveGateIdentity } from "./gateNative";
import { ANTI_GUESS, GOLD_CHECK_BUDGET_SEC, isRapidGuessViolation } from "./rules";
import { GateResultsView } from "./GateResultsView";
import { KeyCeremony } from "./KeyCeremony";
import type { BadgeBloomBadge } from "../mascot/BadgeBloomView";

/**
 * #58: resolve the ceremony's badge blooms from whichever summary is
 * live (gate pass or Gold upgrade) — catalog metadata only (title/
 * tier/description), no PII.
 */
function ceremonyBadges(ids: string[] | undefined): BadgeBloomBadge[] {
  if (!ids) return [];
  return ids.flatMap((id) => {
    const meta = badgeById(id);
    if (!meta) return [];
    return [{ id, title: meta.title, tier: meta.tier, description: meta.description }];
  });
}

export interface GateRunnerScreenProps {
  /** Journey param (or the snapshot's active grade when absent). */
  gradeId?: string;
  unitId: string;
}

export function GateRunnerScreen({
  gradeId: gradeParam,
  unitId,
}: GateRunnerScreenProps): React.ReactElement {
  const { colors } = useTheme();
  const { motion } = useReducedMotion();
  const [state, dispatch] = useReducer(gateReducer, undefined, initialGateState);
  const [structural, setStructural] = useState<StructuralDraft>(EMPTY_STRUCTURAL_DRAFT);
  const [exitSheetOpen, setExitSheetOpen] = useState(false);
  const [completing, setCompleting] = useState(false);

  const audioRef = useRef<AudioCoordinator | null>(null);
  const narrationSecRef = useRef(0);
  const questionStartRef = useRef(0);
  const effectiveGradeRef = useRef<string | null>(null);
  const loadedRef = useRef(false);
  /** Deadline auto-complete guard (one in-flight completion). */
  const completingRef = useRef(false);

  // ------------------------------------------------------------------
  // Load: identity + pack + two-key status (offline-first).
  // ------------------------------------------------------------------
  const loadStatus = useCallback(
    async (gradeId: string, studentId: string, title: string) => {
      const gold = await getGateEngine().goldStatus(studentId, unitId);
      dispatch({
        type: "status-loaded",
        unitId,
        unitTitle: title,
        gradeId,
        gold: {
          keyState: gold.keyState,
          provisional: gold.provisional,
          silverAwardedAt: gold.silverAwardedAt,
          goldEligibleAtMs: gold.goldEligibleAtMs,
          eligible: gold.eligible,
        },
        nowMs: Date.now(),
      });
    },
    [unitId],
  );

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    let cancelled = false;
    (async () => {
      getGateAudio()
        .then((coordinator) => {
          audioRef.current = coordinator;
        })
        .catch(() => {
          // Audio is best-effort; the gate runs silent without it.
        });
      const identity = await resolveGateIdentity();
      if (cancelled) return;
      if (!identity.studentId) {
        dispatch({ type: "load-failed", error: "no child-device session for the gate" });
        return;
      }
      const gradeId = gradeParam ?? identity.gradeId ?? undefined;
      effectiveGradeRef.current = gradeId ?? null;
      if (!gradeId) {
        dispatch({ type: "load-failed", error: "no active grade for the gate" });
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
        if (cancelled) return;
        await loadStatus(gradeId, identity.studentId, unit.title);
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
  }, [gradeParam, unitId, loadStatus]);

  // ------------------------------------------------------------------
  // Audio helpers (SFX moments + narration through the coordinator) —
  // useCallbacks so inline JSX handlers never read refs during render.
  // ------------------------------------------------------------------
  const playMoment = useCallback(
    (moment: "onInteract" | "onCorrect" | "onGentleRetry", topicId: string | undefined) => {
      audioRef.current?.sfx({ moment, topicId });
    },
    [],
  );

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

  /** Completes the Gold check (natural finish AND budget deadline). */
  const completeGoldCheck = useCallback(async (sessionId: string) => {
    if (completingRef.current) return;
    completingRef.current = true;
    setCompleting(true);
    try {
      void audioRef.current?.stopSpeech();
      const summary = await getGateEngine().completeGoldVerification(sessionId);
      dispatch({ type: "verification-ready", sessionId, summary });
    } catch (error) {
      getGateEngine().abandonSession(sessionId);
      dispatch({
        type: "session-failed",
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      completingRef.current = false;
      setCompleting(false);
    }
  }, []);

  // ------------------------------------------------------------------
  // Clock ticks: countdown, freeze countdown, gold-check budget. The
  // deadline trigger itself lives here (the reducer stays pure); the
  // guard ref makes it exactly-once.
  // ------------------------------------------------------------------
  useEffect(() => {
    if (state.phase !== "status" && state.phase !== "question" && state.phase !== "feedback") {
      return;
    }
    const inGoldCheck = state.mode === "goldCheck" && state.sessionId !== null;
    const interval = setInterval(() => {
      const nowMs = Date.now();
      dispatch({ type: "tick", nowMs });
      if (
        inGoldCheck &&
        state.goldCheckDeadlineMs > 0 &&
        nowMs >= state.goldCheckDeadlineMs &&
        !completingRef.current &&
        state.sessionId
      ) {
        void completeGoldCheck(state.sessionId);
      }
    }, 500);
    return () => clearInterval(interval);
  }, [state.phase, state.mode, state.sessionId, state.goldCheckDeadlineMs, completeGoldCheck]);

  // ------------------------------------------------------------------
  // Session start (after the warm-up produces a baseline).
  // ------------------------------------------------------------------
  const startSession = useCallback(
    async (mode: "gate" | "goldCheck", motorBaselineSec: number) => {
      const identity = await resolveGateIdentity();
      const gradeId = gradeParam ?? effectiveGradeRef.current ?? identity.gradeId;
      if (!identity.studentId || !gradeId) {
        dispatch({ type: "load-failed", error: "no child-device session for the gate" });
        return;
      }
      try {
        // Fresh CPA stages for the session's questions (the #50
        // fresh-read rule: never render from a stale progress snapshot).
        const rows = await getNativePracticeDeps().storage.allTopicProgress(identity.studentId);
        const progressByTopic: Record<string, TopicProgressRecord> = {};
        for (const row of rows) progressByTopic[row.topicId] = row;

        const engine = getGateEngine();
        const start =
          mode === "gate"
            ? await engine.startGateSession({
                studentId: identity.studentId,
                gradeId,
                unitId,
                motorBaselineSec,
              })
            : await engine.startGoldVerification({
                studentId: identity.studentId,
                gradeId,
                unitId,
                motorBaselineSec,
              });
        const stageByQuestionId: Record<string, string> = {};
        for (const question of start.questions) {
          stageByQuestionId[question.questionId] = stageForTopicProgress(
            progressByTopic[question.topicId] ?? null,
          );
        }
        setStructural(EMPTY_STRUCTURAL_DRAFT);
        completingRef.current = false;
        dispatch({
          type: "session-started",
          sessionId: start.sessionId,
          questions: start.questions,
          stageByQuestionId,
          mode,
          startedAtMs: start.startedAtMs,
          deadlineMs: mode === "goldCheck" ? start.startedAtMs + GOLD_CHECK_BUDGET_SEC * 1000 : 0,
        });
      } catch (error) {
        dispatch({
          type: "load-failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [gradeParam, unitId],
  );

  // ------------------------------------------------------------------
  // Check + continue (durable recording; anti-guess freeze on rapid
  // wrong answers — the engine's exact counting rule).
  // ------------------------------------------------------------------
  const handleCheck = useCallback(async () => {
    const question = currentGateQuestion(state);
    if (state.phase !== "question" || !question || !state.sessionId) return;
    if (state.mode === "goldCheck" && goldRemainingMs(state) <= 0) return;
    const draft = state.draft;
    if (draft === null || draft.trim() === "") {
      audioRef.current?.sfx({ moment: "onGentleRetry", topicId: question.topicId });
      return;
    }
    const rawTimeSec = Math.max(0.1, (Date.now() - questionStartRef.current) / 1000);
    const isCorrect = draft.trim() === answerTextFor(question);
    const wasRapidGuess = isRapidGuessViolation(isCorrect, rawTimeSec);
    // Deadline race guard (review finding 1): during a gold check, the
    // 500 ms deadline tick could otherwise fire completeGoldVerification
    // while this submit is still awaited — the verdict would miss the
    // in-flight answer, or the session would be deleted under the tap
    // and SEE RESULTS would throw. Claiming the completion guard for
    // the submit's duration makes the deadline defer one tick and
    // complete WITH the answer recorded.
    const guardingDeadline = state.mode === "goldCheck";
    if (guardingDeadline) completingRef.current = true;
    try {
      void audioRef.current?.stopSpeech();
      const result = await getGateEngine().submitResponse(state.sessionId, {
        topicCode: question.topicCode,
        questionId: question.questionId,
        chosenAnswer: draft,
        isCorrect,
        rawTimeSec,
        audioDurationSec: narrationSecRef.current,
        misconceptionTags: question.misconceptionTags,
      });
      dispatch({
        type: "response-recorded",
        sessionId: state.sessionId,
        isCorrect,
        correctAnswer: answerTextFor(question),
        explanation: question.explanation,
        fluencyGrade: result.fluencyGrade,
        cognitiveTimeSec: result.cognitiveTimeSec,
        freezeUntilMs: wasRapidGuess ? Date.now() + ANTI_GUESS.freezePenaltySec * 1000 : 0,
        wasRapidGuess,
      });
      audioRef.current?.sfx({
        moment: isCorrect ? "onCorrect" : "onGentleRetry",
        topicId: question.topicId,
      });
      void audioRef.current?.haptic(isCorrect ? "correct" : "gentle-retry");
    } catch (error) {
      // Abandon BEFORE surfacing (the #50 liveness rule): a stranded
      // session id would wedge sync upload batching until restart.
      // Attempts already recorded stay durable in the append-only log.
      getGateEngine().abandonSession(state.sessionId);
      dispatch({
        type: "session-failed",
        sessionId: state.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      // Release the deadline race guard only after the response has
      // been folded in (or the failure surfaced): the next tick may
      // then complete the check WITH this answer counted.
      if (guardingDeadline) completingRef.current = false;
    }
  }, [state]);

  const handleContinue = useCallback(async () => {
    if (state.phase !== "feedback" || !state.sessionId || !state.checked) return;
    if (state.nowMs < state.checked.freezeUntilMs) return;
    const isLast = state.index + 1 >= state.questions.length;
    if (!isLast) {
      setStructural(EMPTY_STRUCTURAL_DRAFT);
      dispatch({ type: "continue-pressed", sessionId: state.sessionId });
      return;
    }
    if (state.mode === "goldCheck") {
      await completeGoldCheck(state.sessionId);
      return;
    }
    setCompleting(true);
    try {
      const summary = await getGateEngine().completeGateSession(state.sessionId);
      dispatch({ type: "gate-summary-ready", sessionId: state.sessionId, summary });
    } catch (error) {
      // Same liveness rule as the submit path.
      getGateEngine().abandonSession(state.sessionId);
      dispatch({
        type: "session-failed",
        sessionId: state.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCompleting(false);
    }
  }, [state, completeGoldCheck]);

  const handleWarmupComplete = useCallback(
    (motorBaselineSec: number) => {
      dispatch({ type: "warmup-completed", motorBaselineSec });
      void startSession(state.mode, motorBaselineSec);
    },
    [startSession, state.mode],
  );

  // ------------------------------------------------------------------
  // Ceremony moments: fanfare + celebration narration + haptics.
  // ------------------------------------------------------------------
  const startCeremony = useCallback(
    (kind: "silver" | "gold", provisional: boolean) => {
      dispatch({ type: "ceremony-started", kind, animationsEnabled: motion.animationsEnabled });
      audioRef.current?.sfx("sfx_star_fanfare");
      void audioRef.current?.haptic("correct");
      // #59: spoken ceremony copy comes from the SAME copy module the
      // ceremony renders (no hardcoded spoken strings) - title plus the
      // provisional note when the online journal check is pending.
      const copy = ceremonyCopy(kind, provisional);
      const spoken = copy.provisionalNote ? `${copy.title} ${copy.provisionalNote}` : copy.title;
      void audioRef.current
        ?.speak({
          text: spoken,
          grade: asGradeId(effectiveGradeRef.current),
          line: "celebration",
        })
        .catch(() => undefined);
    },
    [motion.animationsEnabled],
  );

  const confirmExit = useCallback(() => {
    setExitSheetOpen(false);
    if (state.sessionId) getGateEngine().abandonSession(state.sessionId);
    void audioRef.current?.stopSpeech();
    router.back();
  }, [state.sessionId]);

  // ------------------------------------------------------------------
  // Narration: read the prompt when a question first appears.
  // ------------------------------------------------------------------
  const question =
    state.phase === "question" || state.phase === "feedback" ? currentGateQuestion(state) : null;
  const questionId = question?.questionId ?? null;
  const prompt = question?.prompt ?? null;
  const topicId = question?.topicId ?? null;

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

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------
  if (state.phase === "loading") {
    return (
      <View style={{ padding: spacing.xxl, alignItems: "center", gap: spacing.md }}>
        <ActivityIndicator color={colors.primary.fill} accessibilityLabel="Loading the boss gate" />
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>Loading the gate...</Text>
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
        <Text style={{ ...typeRamp.h3, color: colors.text }}>Gate unavailable</Text>
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
          {state.error ?? "Something went wrong loading the gate."}
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

  if (state.phase === "status") {
    const entry = statusEntry(state.gold, state.unitTitle, state.nowMs);
    return (
      <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: spacing.lg }}>
        <Text style={{ ...typeRamp.h2, color: colors.text }}>{entry.headline}</Text>
        <Text style={{ ...typeRamp.body, color: colors.textMuted }}>{entry.subline}</Text>
        {entry.kind === "countdown" ? (
          <View
            accessibilityLabel={`Gold check unlocks in ${formatGoldCountdown(entry.remainingMs)}`}
            style={{
              minHeight: 72,
              justifyContent: "center",
              alignItems: "center",
              borderRadius: 16,
              borderWidth: 2,
              borderColor: colors.border,
              backgroundColor: colors.surface,
            }}
          >
            <Text style={{ ...typeRamp.h1, color: colors.text }}>
              {formatGoldCountdown(entry.remainingMs)}
            </Text>
            <Text style={{ ...typeRamp.caption, color: colors.textMuted }}>
              until the Gold check
            </Text>
          </View>
        ) : null}
        {entry.kind === "offer-gold-check" ? (
          <Button
            label="Start the Gold check"
            onPress={() => dispatch({ type: "gold-check-start-requested" })}
            accessibilityHint="Five questions in one minute; pass four to earn the Gold key"
          />
        ) : entry.kind === "offer-gate" ? (
          <Button
            label="Start the boss gate"
            onPress={() => dispatch({ type: "gate-start-requested" })}
            accessibilityHint="The five-condition unit mastery gate"
          />
        ) : null}
        <Button
          label="Back to journey"
          variant="outline"
          onPress={() => router.push("/journey")}
          accessibilityHint="Return to the journey map"
        />
      </ScrollView>
    );
  }

  if (state.phase === "warmup") {
    return <MotorWarmup onComplete={handleWarmupComplete} testID="gate-warmup" />;
  }

  if (state.phase === "results" && state.gateSummary) {
    // A Gold holder re-passing the gate celebrates the key they HOLD
    // (the machine keeps Gold); anyone else celebrates Silver.
    const ceremonyKind = state.gateSummary.keyState === "GOLD_KEY" ? "gold" : "silver";
    return (
      <GateResultsView
        summary={state.gateSummary}
        onCollectKey={() => startCeremony(ceremonyKind, state.gateSummary?.provisional ?? false)}
        onPractice={(topicCode) =>
          router.push({
            pathname: "/practice",
            params: topicCode
              ? { gradeId: state.gradeId ?? undefined, unitId, topicCode }
              : { gradeId: state.gradeId ?? undefined, unitId },
          })
        }
        testID="gate-results"
      />
    );
  }

  if (state.phase === "verification-result" && state.verification) {
    const verification = state.verification;
    return (
      <ScrollView contentContainerStyle={{ padding: spacing.xxl, gap: spacing.lg }}>
        <Text style={{ ...typeRamp.h1, color: colors.text, textAlign: "center" }}>
          {verification.upgraded ? "Gold check passed!" : "Almost there!"}
        </Text>
        <Text style={{ ...typeRamp.body, color: colors.textMuted, textAlign: "center" }}>
          {verification.upgraded
            ? `You got ${verification.correctCount} of 5 right. Time to collect the Gold key!`
            : `You got ${verification.correctCount} right — ${verification.requiredCount} unlocks the Gold key. A good rest helps; try again any time.`}
        </Text>
        {verification.upgraded ? (
          <Button
            label="Collect your Gold key"
            onPress={() => startCeremony("gold", state.gold.provisional)}
            accessibilityHint="Play the Gold key ceremony"
          />
        ) : null}
        <Button
          label={verification.upgraded ? "Keep going" : "Back to journey"}
          variant="outline"
          onPress={() => router.push("/journey")}
          accessibilityHint="Return to the journey map"
        />
      </ScrollView>
    );
  }

  if (state.phase === "ceremony" && state.ceremony && state.ceremony.phase !== "dismissed") {
    // #58: bloom the badges earned with whichever summary drove this
    // ceremony (gate pass or Gold upgrade).
    const earnedIds =
      state.ceremony.kind === "gold"
        ? (state.verification?.celebration?.badgesAwarded ??
          state.gateSummary?.celebration.badgesAwarded)
        : state.gateSummary?.celebration.badgesAwarded;
    return (
      <KeyCeremony
        kind={state.ceremony.kind}
        provisional={state.gold.provisional}
        animationsEnabled={motion.animationsEnabled}
        onDone={() => dispatch({ type: "ceremony-done" })}
        badges={ceremonyBadges(earnedIds)}
        testID="gate-ceremony"
      />
    );
  }

  if (state.phase === "done") {
    return (
      <View style={{ padding: spacing.xxl, gap: spacing.md, alignItems: "center" }}>
        <Text style={{ ...typeRamp.h2, color: colors.text }}>
          {/* Fresh from this flow, not the mount-time snapshot: a Gold
           * check that just upgraded would read stale Silver state.
           * Copy (and speech, in the ceremony) come from ceremonyCopy —
           * one module owns the key-earned wording. */}
          {
            ceremonyCopy(
              state.mode === "goldCheck" && state.verification?.upgraded ? "gold" : "silver",
              false,
            ).title
          }
        </Text>
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted, textAlign: "center" }}>
          Your journey continues. The next unit unlocks from the map.
        </Text>
        <Button
          label="Back to journey"
          onPress={() => router.push("/journey")}
          accessibilityHint="Return to the journey map"
        />
      </View>
    );
  }

  if (!question) {
    return (
      <View style={{ padding: spacing.xxl, alignItems: "center" }}>
        <ActivityIndicator color={colors.primary.fill} accessibilityLabel="Loading question" />
      </View>
    );
  }

  const total = state.questions.length;
  const progressPct = Math.round((state.index / Math.max(1, total)) * 100);
  const isChecked = state.phase === "feedback" && state.checked !== null;
  const stage = state.stageByQuestionId[question.questionId] ?? "CONCRETE_INTERACTIVE";
  const freezeRemainingMs =
    isChecked && state.checked ? Math.max(0, state.checked.freezeUntilMs - state.nowMs) : 0;
  const frozen = freezeRemainingMs > 0;
  const remainingBudgetSec = Math.ceil(goldRemainingMs(state) / 1000);

  const publishDraft = (draft: string | null) => {
    if (state.sessionId) dispatch({ type: "draft-changed", sessionId: state.sessionId, draft });
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {/* Session header: progress + budget + exit. */}
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
            accessibilityLabel="Exit gate"
            onPress={() => setExitSheetOpen(true)}
            style={{ minHeight: 48, minWidth: 48, alignItems: "center", justifyContent: "center" }}
          >
            <Text style={{ ...typeRamp.title, color: colors.textMuted }}>{"×"}</Text>
          </Pressable>
        </View>
        <View style={{ flexDirection: "row", gap: spacing.sm, alignItems: "center" }}>
          <View
            accessibilityLabel={`${state.mode === "goldCheck" ? "Gold check" : "Boss gate"} question`}
            style={{
              paddingHorizontal: spacing.md,
              paddingVertical: spacing.xs,
              borderRadius: 999,
              backgroundColor:
                state.mode === "goldCheck" ? colors.surfaceTinted : colors.surfaceAlt,
              borderWidth: 2,
              borderColor: colors.border,
            }}
          >
            <Text style={{ ...typeRamp.label, color: colors.textMuted }}>
              {state.mode === "goldCheck" ? "GOLD CHECK" : "BOSS GATE"}
            </Text>
          </View>
          {state.mode === "goldCheck" ? (
            <Text
              accessibilityLabel={`${remainingBudgetSec} seconds left`}
              style={{
                ...typeRamp.label,
                color: remainingBudgetSec <= 10 ? colors.danger.label : colors.textMuted,
              }}
            >
              {`${remainingBudgetSec}s left`}
            </Text>
          ) : (
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
          )}
          {state.streak >= 2 ? (
            <Text style={{ ...typeRamp.label, color: colors.statusInk.success }}>
              {`Streak ${state.streak}`}
            </Text>
          ) : null}
        </View>
      </View>

      {/* Prompt + replay + question body. */}
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.md }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Read the question again"
            onPress={() => replayPrompt(question.prompt, question.topicId)}
            style={{ minHeight: 48, minWidth: 48, alignItems: "center", justifyContent: "center" }}
          >
            <Text style={{ ...typeRamp.title, color: colors.secondary.label }}>{"▶"}</Text>
          </Pressable>
          <Text style={{ ...typeRamp.h3, color: colors.text, flexShrink: 1 }}>
            {question.prompt}
          </Text>
        </View>
      </View>

      <View style={{ flex: 1 }}>
        <QuestionBody
          question={question}
          stage={stage}
          disabled={isChecked || (state.mode === "goldCheck" && goldRemainingMs(state) <= 0)}
          structural={structural}
          scaffoldKey={`${question.questionId}-${state.index}`}
          onToggleCell={(slot) => {
            playMoment("onInteract", question.topicId);
            setStructural((prev) => {
              const filled = prev.filledSlots.includes(slot)
                ? prev.filledSlots.filter((entry) => entry !== slot)
                : [...prev.filledSlots, slot];
              publishDraft(String(filled.length));
              return { ...prev, filledSlots: filled };
            });
          }}
          onTileTapped={(option: RunnerOption) => {
            playMoment("onInteract", question.topicId);
            setStructural((prev) => {
              const placed = [...prev.placedTiles, option];
              publishDraft(placed.map((entry) => entry.label).join(" "));
              return { ...prev, placedTiles: placed };
            });
          }}
          onClearTiles={() => {
            setStructural((prev) => {
              publishDraft(null);
              return { ...prev, placedTiles: [] };
            });
          }}
          onSelectChoice={(option: RunnerOption) => {
            playMoment("onInteract", question.topicId);
            setStructural((prev) => {
              publishDraft(option.label);
              return { ...prev, selectedChoiceKey: option.key };
            });
          }}
        />
      </View>

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
          <View style={{ gap: spacing.xs }}>
            <Text
              style={{
                ...typeRamp.title,
                color: state.checked.isCorrect
                  ? colors.statusInk.success
                  : colors.statusInk.warning,
              }}
            >
              {state.checked.isCorrect
                ? `Yes! Thinking time: ${state.checked.cognitiveTimeSec}s`
                : state.checked.wasRapidGuess
                  ? "Take a breath — quick taps need a second look."
                  : "Almost! Let's look again."}
            </Text>
            {!state.checked.isCorrect ? (
              <Text style={{ ...typeRamp.body, color: colors.text }}>
                {`Answer: ${state.checked.correctAnswer}`}
              </Text>
            ) : null}
            {state.checked.explanation !== "" ? (
              <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
                {state.checked.explanation}
              </Text>
            ) : null}
            {frozen ? (
              <Text style={{ ...typeRamp.caption, color: colors.textMuted }}>
                {`Take a moment to think... (${Math.ceil(freezeRemainingMs / 1000)})`}
              </Text>
            ) : null}
          </View>
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
          disabled={
            completing || frozen || (state.mode === "goldCheck" && goldRemainingMs(state) <= 0)
          }
          onPress={isChecked ? handleContinue : handleCheck}
          testID="gate-action"
          accessibilityHint={
            frozen
              ? "Wait a moment, then continue"
              : isChecked
                ? "Go to the next question"
                : "Check your answer"
          }
        />
      </View>

      <Sheet
        visible={exitSheetOpen}
        onClose={() => setExitSheetOpen(false)}
        title="Leave the gate?"
      >
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
          Your answers so far are saved. You can come back any time.
        </Text>
        <View style={{ gap: spacing.md, marginTop: spacing.lg }}>
          <Button label="Keep going" variant="outline" onPress={() => setExitSheetOpen(false)} />
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
