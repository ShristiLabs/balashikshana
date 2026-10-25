/**
 * Placement screen (issue #60) — the THIN RN layer of the placement
 * diagnostic. All decisions flow through the pure modules: the probe
 * state machine + outcome math live in the core-engine placement module
 * (via PlacementSessionEngine), the offer/decision policy in offer.ts,
 * every string in copy.ts. This file owns only timing capture, mounting
 * the choice surface (the #50 widget kit), audio moments through the
 * #45 coordinator (question prompts + the spoken celebration), and the
 * #58 mascot reactions. Offline-first: no network call exists here.
 *
 * Kid-safety: the flow is framed as a short exploration (copy.ts), the
 * child can leave at any time (durable attempts stay append-only; no
 * decision record means the journey offer simply re-appears), and the
 * recommendation screen ALWAYS offers the gentler unit-1 start next to
 * the recommended default. Placement never awards keys and never
 * completes anything — only the engine's provisional stability rides
 * home (PlacementSessionEngine.complete).
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { router } from "expo-router";
import { PLACEMENT_RULES } from "@balashikshana/core-engine";
import type { AudioCoordinator } from "../audio/coordinator";
import { Button } from "../design/primitives";
import { useTheme } from "../design/theme";
import { spacing, typeRamp } from "../design/tokens";
import { MascotView } from "../mascot/MascotView";
import { useMascot } from "../mascot/useMascot";
import { getNativePlacementRecordStore, getNativePracticeDeps } from "../practice/nativePractice";
import { asGradeId, getRunnerAudio, resolveRunnerIdentity } from "../runner/runnerNative";
import { ChoiceGrid } from "../runner/widgets";
import { choiceOptionsFor } from "../runner/questionShapes";
import { PLACEMENT_COPY } from "./copy";
import { acceptDecision, gentleStartUnitId } from "./offer";
import { PlacementSessionEngine } from "./session";
import type { PlacementItemView, PlacementSessionSummary } from "./session";

type Phase = "loading" | "no-pack" | "error" | "probe" | "recommend";

export interface PlacementScreenProps {
  /** Journey param (or the snapshot's active grade when absent). */
  gradeId?: string;
}

export function PlacementScreen({ gradeId: gradeParam }: PlacementScreenProps): React.ReactElement {
  const { colors } = useTheme();
  const { state: mascot, fire: fireMascot } = useMascot();
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [item, setItem] = useState<PlacementItemView | null>(null);
  const [asked, setAsked] = useState(0);
  const [summary, setSummary] = useState<PlacementSessionSummary | null>(null);
  const [recommendedTitle, setRecommendedTitle] = useState<string>("");
  const [gentleTitle, setGentleTitle] = useState<string>("");
  /** The two CHOICE unit ids (recommended + gentler), captured at completion. */
  const [recommendedUnitId, setRecommendedUnitId] = useState<string | null>(null);
  const [gentleUnitId, setGentleUnitId] = useState<string>("");
  const [completing, setCompleting] = useState(false);
  /** Selection + feedback state for the current item (local, thin). */
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ isCorrect: boolean; correctAnswer: string } | null>(
    null,
  );

  const engineRef = useRef<PlacementSessionEngine | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const studentIdRef = useRef<string | null>(null);
  const gradeRef = useRef<string | null>(null);
  const unitTitlesRef = useRef<Map<string, string>>(new Map());
  const journeyOrderRef = useRef<string[]>([]);
  const audioRef = useRef<AudioCoordinator | null>(null);
  const narrationSecRef = useRef(0);
  const questionStartRef = useRef(0);
  const loadedRef = useRef(false);

  /** Closes the session (pure engine math) and lands on the recommendation. */
  const finishSession = useCallback(
    async (engine: PlacementSessionEngine, sessionId: string) => {
      setCompleting(true);
      try {
        const result = await engine.complete(sessionId);
        const recommendedId = result.outcome.recommendedStartUnitId;
        const gentleId = gentleStartUnitId(journeyOrderRef.current);
        setRecommendedUnitId(recommendedId);
        setGentleUnitId(gentleId);
        setRecommendedTitle(unitTitlesRef.current.get(recommendedId ?? "") ?? recommendedId ?? "");
        setGentleTitle(unitTitlesRef.current.get(gentleId) ?? gentleId);
        setSummary(result);
        setPhase("recommend");
        // #58: the mascot celebrates the outcome; #59: the spoken
        // celebration line (app copy — the registry owns per-topic lines).
        fireMascot({ type: "celebrate", moment: "game-goal-met" });
        void audioRef.current
          ?.speak({
            text: PLACEMENT_COPY.recommendation.celebration,
            grade: asGradeId(gradeRef.current),
          })
          .catch(() => undefined);
      } catch (err) {
        setPhase("error");
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setCompleting(false);
      }
    },
    [fireMascot],
  );

  // Mount: identity + session start (offline-first; no network anywhere).
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
          // Audio is best-effort; the exploration runs silent without it.
        });
      const identity = await resolveRunnerIdentity();
      if (cancelled) return;
      if (!identity.studentId) {
        setPhase("error");
        setError("no child-device session for placement");
        return;
      }
      const gradeId = gradeParam ?? identity.gradeId ?? undefined;
      if (!gradeId) {
        setPhase("error");
        setError("no active grade for placement");
        return;
      }
      studentIdRef.current = identity.studentId;
      gradeRef.current = gradeId;
      try {
        const engine = new PlacementSessionEngine(getNativePracticeDeps());
        const start = await engine.start({ studentId: identity.studentId, gradeId });
        if (cancelled) return;
        // Journey order + titles for the recommendation screen's two
        // options (read once; the pack is immutable for the session).
        const reader = await getNativePracticeDeps().openContent(gradeId);
        const unitRows = reader ? await reader.unitsForGrade(gradeId) : [];
        journeyOrderRef.current = unitRows.map((row) => row.unit_id);
        unitTitlesRef.current = new Map(unitRows.map((row) => [row.unit_id, row.title]));
        engineRef.current = engine;
        sessionIdRef.current = start.sessionId;
        setAsked(0);
        setItem(start.firstItem);
        setPhase(start.firstItem ? "probe" : "recommend");
        if (!start.firstItem) void finishSession(engine, start.sessionId);
      } catch (err) {
        if (!cancelled) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes("No content pack installed")) {
            setPhase("no-pack");
          } else {
            setPhase("error");
            setError(message);
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gradeParam, finishSession]);

  // Narrate each probe prompt when it appears (the #59 instruction kind:
  // live question prompts, per-grade WPM + duck policy in the coordinator).
  const prompt = item?.question.prompt ?? null;
  const topicId = item?.question.topicId ?? null;
  const questionId = item?.question.questionId ?? null;
  useEffect(() => {
    if (phase !== "probe" || prompt === null || topicId === null) return;
    let cancelled = false;
    (async () => {
      narrationSecRef.current = 0;
      questionStartRef.current = Date.now();
      const coordinator = audioRef.current;
      if (!coordinator || cancelled) return;
      try {
        const result = await coordinator.speak({
          text: prompt,
          grade: asGradeId(gradeRef.current),
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
  }, [phase, questionId, prompt, topicId]);

  const handleOptionSelected = useCallback(
    (option: { key: string; label: string }) => {
      if (!item || feedback || completing) return;
      setSelectedKey(option.key);
      const isCorrect = option.key === item.question.correctAnswer;
      setFeedback({
        isCorrect,
        correctAnswer: String(item.question.correctAnswer),
      });
      audioRef.current?.sfx({
        moment: isCorrect ? "onCorrect" : "onGentleRetry",
        topicId: item.question.topicId,
      });
      fireMascot({
        type: isCorrect ? "answer-correct" : "answer-gentle-retry",
      });
    },
    [completing, feedback, fireMascot, item],
  );

  const handleContinue = useCallback(async () => {
    const engine = engineRef.current;
    const sessionId = sessionIdRef.current;
    if (!engine || !sessionId || !item || completing) return;
    const isCorrect = optionKeyIsCorrect(selectedKey, item);
    const rawTimeSec = Math.max(0.5, (Date.now() - questionStartRef.current) / 1000);
    setCompleting(true);
    try {
      const next = await engine.submit(sessionId, {
        questionId: item.question.questionId,
        chosenAnswer: selectedKey ?? "",
        isCorrect,
        rawTimeSec,
        audioDurationSec: narrationSecRef.current,
      });
      setAsked((n) => n + 1);
      setSelectedKey(null);
      setFeedback(null);
      if (next) {
        setItem(next);
      } else {
        setItem(null);
        await finishSession(engine, sessionId);
      }
    } catch (err) {
      setPhase("error");
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCompleting(false);
    }
  }, [completing, finishSession, item, selectedKey]);

  /** Writes the family's decision and routes into practice at the chosen unit. */
  const chooseStart = useCallback(
    async (acceptedUnitId: string) => {
      const studentId = studentIdRef.current;
      const gradeId = gradeRef.current;
      if (!studentId || !gradeId || !summary) return;
      try {
        await getNativePlacementRecordStore().upsert(
          acceptDecision({
            studentId,
            gradeId,
            summary,
            acceptedUnitId,
            nowMs: Date.now(),
          }),
        );
      } catch {
        // The decision row is device-local convenience; routing must not
        // strand the child on an error screen even if the write fails.
      }
      router.replace({
        pathname: "/practice",
        params: { gradeId, unitId: acceptedUnitId },
      });
    },
    [summary],
  );

  const exitToJourney = useCallback(() => {
    // Leaving mid-probe: attempts stay durable (append-only), no decision
    // record exists, so the journey offer re-appears (the resume rule).
    void audioRef.current?.stopSpeech().catch(() => undefined);
    router.back();
  }, []);

  // ------------------------------------------------------------------
  // Render
  // ------------------------------------------------------------------

  if (phase === "loading") {
    return (
      <View style={{ padding: spacing.xxl, alignItems: "center", gap: spacing.md }}>
        <ActivityIndicator color={colors.primary.fill} accessibilityLabel="Loading placement" />
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
          {PLACEMENT_COPY.screen.loading}
        </Text>
      </View>
    );
  }

  if (phase === "no-pack") {
    return (
      <View style={{ padding: spacing.xxl, gap: spacing.md }}>
        <Text style={{ ...typeRamp.h3, color: colors.text }}>
          {PLACEMENT_COPY.screen.noPackTitle}
        </Text>
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
          {PLACEMENT_COPY.screen.noPackBody}
        </Text>
        <Button
          label={PLACEMENT_COPY.screen.exit}
          variant="secondary"
          onPress={exitToJourney}
          accessibilityHint="Return to the journey map"
        />
      </View>
    );
  }

  if (phase === "error") {
    return (
      <View style={{ padding: spacing.xxl, gap: spacing.md }}>
        <Text style={{ ...typeRamp.h3, color: colors.text }}>
          {PLACEMENT_COPY.screen.errorTitle}
        </Text>
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
          {PLACEMENT_COPY.screen.errorBody}
        </Text>
        {error ? (
          <Text style={{ ...typeRamp.caption, color: colors.textMuted }}>{error}</Text>
        ) : null}
        <Button
          label={PLACEMENT_COPY.screen.exit}
          variant="secondary"
          onPress={exitToJourney}
          accessibilityHint="Return to the journey map"
        />
      </View>
    );
  }

  if (phase === "probe" && item) {
    const options = choiceOptionsFor(item.question);
    return (
      <View style={{ flex: 1, backgroundColor: colors.background }}>
        <View
          style={{
            paddingHorizontal: spacing.lg,
            paddingTop: spacing.sm,
            gap: spacing.md,
            flexDirection: "row",
            alignItems: "center",
          }}
        >
          <MascotView state={mascot} animationsEnabled size={48} testID="placement-mascot" />
          <View style={{ flex: 1, gap: spacing.xs }}>
            <Text style={{ ...typeRamp.h3, color: colors.text }}>{PLACEMENT_COPY.probe.title}</Text>
            <Text style={{ ...typeRamp.caption, color: colors.textMuted }}>
              {PLACEMENT_COPY.probe.progress(asked + 1, PLACEMENT_RULES.maxItems)}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={PLACEMENT_COPY.screen.exit}
            onPress={exitToJourney}
            style={{ minHeight: 48, justifyContent: "center", paddingHorizontal: spacing.sm }}
          >
            <Text style={{ ...typeRamp.label, color: colors.secondary.label }}>
              {PLACEMENT_COPY.screen.exit.toUpperCase()}
            </Text>
          </Pressable>
        </View>
        <ScrollView
          contentContainerStyle={{
            padding: spacing.xl,
            gap: spacing.lg,
          }}
        >
          <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
            {PLACEMENT_COPY.probe.promptHint}
          </Text>
          <View
            accessibilityLabel="Question prompt"
            style={{
              padding: spacing.lg,
              borderRadius: 16,
              borderWidth: 2,
              borderColor: colors.border,
              backgroundColor: colors.surface,
            }}
          >
            <Text style={{ ...typeRamp.h2, color: colors.text }}>{item.question.prompt}</Text>
          </View>
          <ChoiceGrid
            options={options}
            selectedKey={selectedKey}
            disabled={feedback !== null || completing}
            onOptionSelected={handleOptionSelected}
            testID="placement-choices"
          />
          {feedback ? (
            <Button
              label={feedback.isCorrect ? "Continue" : "Keep going"}
              onPress={() => void handleContinue()}
              accessibilityHint="Move to the next question"
            />
          ) : null}
        </ScrollView>
      </View>
    );
  }

  // phase === "recommend"
  const recommendedId = recommendedUnitId ?? summary?.outcome.recommendedStartUnitId ?? null;
  const gentleId = gentleUnitId;
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <ScrollView
        contentContainerStyle={{ padding: spacing.xl, gap: spacing.lg, alignItems: "stretch" }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
          <MascotView state={mascot} animationsEnabled size={64} testID="placement-mascot-done" />
          <View style={{ flex: 1 }}>
            <Text style={{ ...typeRamp.h2, color: colors.text }}>
              {PLACEMENT_COPY.recommendation.title}
            </Text>
          </View>
        </View>
        <Text style={{ ...typeRamp.body, color: colors.text }}>
          {PLACEMENT_COPY.recommendation.recommendedBody(recommendedTitle)}
        </Text>
        <Button
          label={PLACEMENT_COPY.recommendation.startRecommended(recommendedTitle)}
          onPress={() => void chooseStart(recommendedId ?? gentleId)}
          accessibilityHint="Begin practicing at the recommended unit"
          testID="placement-start-recommended"
        />
        <Text style={{ ...typeRamp.body, color: colors.text }}>
          {PLACEMENT_COPY.recommendation.gentleBody(gentleTitle)}
        </Text>
        <Button
          label={PLACEMENT_COPY.recommendation.startGentle}
          variant="secondary"
          onPress={() => void chooseStart(gentleId)}
          accessibilityHint="Begin practicing at the first unit of the grade"
          testID="placement-start-gentle"
        />
        {summary ? (
          <Text style={{ ...typeRamp.caption, color: colors.textMuted }}>
            {`Exploration complete — ${summary.itemsAsked} quick question${
              summary.itemsAsked === 1 ? "" : "s"
            }, ${summary.creditedTopics.length} topic${
              summary.creditedTopics.length === 1 ? "" : "s"
            } recognized.`}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}

/** The chosen option is graded against the question's correct answer key. */
function optionKeyIsCorrect(selectedKey: string | null, item: PlacementItemView): boolean {
  return selectedKey !== null && selectedKey === String(item.question.correctAnswer);
}
