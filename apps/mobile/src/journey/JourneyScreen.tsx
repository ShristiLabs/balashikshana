/**
 * Journey map screen (issue #49): the winding path, garden health, and
 * grade switcher, rendered entirely from pack data + engine-derived
 * progress (zero curriculum data in this source file — everything
 * arrives through the #46 pack reader and the #47 progress rows).
 *
 * Offline-first: the initial render is 100% local. When a child-device
 * session exists the screen kicks the shared sync controller once on
 * mount (the #48 authoritative snapshot — provisional flags clear on
 * adoption) and re-derives the model afterwards; offline the kick is a
 * no-op and the local model stands.
 *
 * Navigation contract for #50/#51: node taps route to the practice and
 * gate screens with { gradeId, unitId } params — gate-adjacent states
 * go to /gate, everything actionable goes to /practice, LOCKED is
 * disabled.
 */
import React, { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { router } from "expo-router";
import { useAnimatedScrollHandler, useSharedValue } from "react-native-reanimated";
import { useTheme } from "../design/theme";
import { Button } from "../design/primitives";
import { spacing, typeRamp } from "../design/tokens";
import { useReducedMotion } from "../design/useMotion";
import { getNativePracticeDeps } from "../practice/nativePractice";
import { getSyncController, subscribeContentOutdated } from "../sync/SyncBootstrap";
import { GardenHealthView } from "./GardenHealth";
import { GradeSwitcher } from "./GradeSwitcher";
import { JourneyPath } from "./JourneyPath";
import { loadJourneyModel } from "./loader";
import { layoutWindingPath } from "./model";
import { currencyForEnsureResult, initialJourneyState, journeyReducer } from "./store";
import {
  getContentService,
  loadGradeSlots,
  loadJourneyIdentity,
  persistActiveGrade,
} from "./nativeJourney";
import type { JourneyUnitNode } from "./model";

/** Vertical distance between node centers: node + caption + breathing room. */
const VERTICAL_STEP = 132;

function routeForNode(node: JourneyUnitNode): "/practice" | "/gate" {
  if (node.state === "GATE_UNLOCKED" || node.state === "FLUENCY_READY") return "/gate";
  return "/practice";
}

export function JourneyScreen(): React.ReactElement {
  const { colors } = useTheme();
  const { motion } = useReducedMotion();
  const [state, dispatch] = useReducer(journeyReducer, undefined, initialJourneyState);
  const { width: windowWidth } = useWindowDimensions();

  const pathWidth = Math.max(280, windowWidth - spacing.xl * 2);
  const layout = useMemo(
    () =>
      layoutWindingPath(state.model?.units.length ?? 0, {
        width: pathWidth,
        verticalStep: VERTICAL_STEP,
        amplitude: Math.min(pathWidth * 0.28, 110),
      }),
    [state.model?.units.length, pathWidth],
  );

  const identityRef = useRef<{ studentId: string | null }>({ studentId: null });
  // The LIVE selected grade (not a render closure): the mount hydration
  // can resolve long after the child switched grades, and its reload
  // must target whatever grade is selected NOW.
  const activeGradeRef = useRef("");

  const reloadModel = useCallback(async (gradeId: string) => {
    // A racer for a grade we already switched away from must not flip
    // the current view's status; model-loaded is grade-guarded in the
    // reducer, the status flips (no-pack / load-failed) are guarded here
    // because their actions carry no gradeId.
    const isStale = () => activeGradeRef.current !== gradeId;
    const studentId = identityRef.current.studentId;
    if (!studentId) {
      // The consent guard guarantees a session; reaching here without
      // one is a loud failure, never a silent spinner.
      if (!isStale()) {
        dispatch({ type: "load-failed", error: "no child-device session for progress rows" });
      }
      return;
    }
    try {
      const deps = getNativePracticeDeps();
      const result = await loadJourneyModel(deps, deps.storage, {
        gradeId,
        studentId,
        nowMs: Date.now(),
      });
      if (!result) {
        if (!isStale()) dispatch({ type: "no-pack" });
        return;
      }
      dispatch({ type: "model-loaded", model: result.model });
    } catch (err) {
      if (!isStale()) {
        dispatch({ type: "load-failed", error: err instanceof Error ? err.message : String(err) });
      }
    }
  }, []);

  // Mount: identity + grade slots + first local model, then one sync
  // hydration kick (server-authoritative snapshot adoption) + re-derive.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const identity = await loadJourneyIdentity();
      if (cancelled) return;
      identityRef.current.studentId = identity.studentId;
      const slots = await loadGradeSlots();
      if (cancelled) return;
      const activeGrade = identity.gradeId ?? slots[0]?.gradeId ?? "";
      activeGradeRef.current = activeGrade;
      dispatch({ type: "grades-initialized", grades: slots, activeGrade });
      if (activeGrade) await reloadModel(activeGrade);

      // Snapshot hydration: one bounded sync run on mount when online.
      const controller = getSyncController();
      if (controller && identity.studentId) {
        dispatch({ type: "hydration-started" });
        try {
          await controller.kick();
        } catch {
          // Sync is best-effort on mount; the battery triggers retry.
        }
        if (!cancelled) {
          dispatch({ type: "hydration-adopted", atMs: Date.now() });
          // Reload the LIVE grade — the child may have switched while
          // the network hydration was in flight.
          await reloadModel(activeGradeRef.current);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadModel]);

  // The #48 content-handshake bridge: flag stale grades in the switcher.
  useEffect(() => {
    return subscribeContentOutdated((packs) => {
      for (const pack of packs) {
        dispatch({ type: "pack-flagged-stale", gradeId: pack.gradeId });
      }
    });
  }, []);

  /** The #46 download lifecycle + model load (shared by select + retry). */
  const ensureAndLoad = useCallback(
    async (gradeId: string) => {
      const slot = state.grades.find((entry) => entry.gradeId === gradeId);
      // Missing pack: run the #46 download lifecycle, then load. An
      // installed pack switches instantly (progress is per-grade by
      // construction — rows are keyed by unit id).
      if (!slot || slot.currency === "missing" || slot.currency === "stale") {
        dispatch({ type: "pack-ensure-started", gradeId });
        const result = await getContentService().ensurePack(gradeId);
        const resolved = currencyForEnsureResult(result, slot?.contentVersion ?? null);
        dispatch({ type: "pack-ensure-resolved", gradeId, ...resolved });
        if (resolved.currency !== "installed") {
          dispatch({ type: "no-pack" });
          return;
        }
      }
      await persistActiveGrade(gradeId);
      await reloadModel(gradeId);
    },
    [reloadModel, state.grades],
  );

  const handleGradeSelect = useCallback(
    async (gradeId: string) => {
      if (gradeId === state.activeGrade) return;
      activeGradeRef.current = gradeId;
      dispatch({ type: "grade-selected", gradeId });
      await ensureAndLoad(gradeId);
    },
    [ensureAndLoad, state.activeGrade],
  );

  const handleNodePress = useCallback(
    (node: JourneyUnitNode) => {
      router.push({
        pathname: routeForNode(node),
        params: { gradeId: state.activeGrade, unitId: node.unitId },
      });
    },
    [state.activeGrade],
  );

  // Scroll-linked reveal (single reanimated surface; static when the
  // motion profile disables animations).
  const scrollProgress = useSharedValue(0);
  const scrollHandler = useAnimatedScrollHandler((event) => {
    const max = Math.max(1, event.contentSize.height - event.layoutMeasurement.height);
    scrollProgress.value = Math.min(1, Math.max(0, event.contentOffset.y / max));
  });

  if (state.status === "loading" || (state.status === "ready" && !state.model)) {
    return (
      <View style={{ padding: spacing.xxl, alignItems: "center", gap: spacing.md }}>
        <ActivityIndicator color={colors.primary.fill} accessibilityLabel="Loading your journey" />
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
          Loading your journey...
        </Text>
      </View>
    );
  }

  if (state.status === "no-pack") {
    return (
      <View style={{ padding: spacing.xxl, gap: spacing.md }}>
        <Text style={{ ...typeRamp.h3, color: colors.text }}>Content pack needed</Text>
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
          The learning pack for this grade is not on the device yet. Connect to the internet and
          pick the grade again to download it.
        </Text>
        <Button
          label="Try download again"
          variant="secondary"
          onPress={() => ensureAndLoad(state.activeGrade)}
          accessibilityHint="Retry the content pack download for this grade"
        />
        <Button
          label="Go to start"
          variant="outline"
          onPress={() => router.push("/")}
          accessibilityHint="Return to the launcher"
        />
      </View>
    );
  }

  if (state.status === "error" || !state.model) {
    return (
      <View style={{ padding: spacing.xxl, gap: spacing.md }}>
        <Text style={{ ...typeRamp.h3, color: colors.text }}>Journey unavailable</Text>
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
          Something went wrong loading the journey map. Try again.
        </Text>
        <Button
          label="Try again"
          onPress={() => reloadModel(state.activeGrade)}
          accessibilityHint="Reload the journey map"
        />
        <Button
          label="Go to start"
          variant="outline"
          onPress={() => router.push("/")}
          accessibilityHint="Return to the launcher"
        />
      </View>
    );
  }

  const model = state.model;
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <View style={{ paddingHorizontal: spacing.lg, paddingTop: spacing.sm, gap: spacing.md }}>
        <GradeSwitcher
          grades={state.grades}
          activeGrade={state.activeGrade}
          onSelect={handleGradeSelect}
        />
        <GardenHealthView garden={model.garden} />
      </View>
      <ScrollView
        contentContainerStyle={{
          alignItems: "center",
          paddingHorizontal: spacing.xl,
          paddingVertical: spacing.xl,
        }}
        scrollEventThrottle={16}
        onScroll={motion.animationsEnabled ? scrollHandler : undefined}
      >
        <JourneyPath
          layout={layout}
          nodes={model.units}
          width={pathWidth}
          scrollProgress={motion.animationsEnabled ? scrollProgress : null}
          motion={motion}
          onNodePress={handleNodePress}
        />
        {/* Trailing escape: never a dead end at the bottom of the path. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to top of the journey"
          onPress={() => router.push("/")}
          style={{ marginTop: spacing.xl, minHeight: 48, justifyContent: "center" }}
        >
          <Text style={{ ...typeRamp.label, color: colors.textMuted }}>BACK TO START</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}
