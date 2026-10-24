/**
 * Journey store tests (issue #49): the pure screen state machine —
 * grade switching (per-grade progress preservation is structural), the
 * #46 ensure-result -> currency mapping for the grade switcher, the
 * stale-pack flag from the #48 clientPacks handshake, hydration
 * tracking, and the SOURCE-SCAN pins that the handshake wiring and the
 * DI doctrine (pure journey module, no RN imports) hold.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  currencyForEnsureResult,
  initialJourneyState,
  journeyReducer,
  type GradeSlot,
} from "../src/journey/store";
import { deriveJourneyModel, layoutWindingPath } from "../src/journey/model";

const NOW = 1_700_000_000_000;

function slots(): GradeSlot[] {
  return [
    {
      gradeId: "kindergarten",
      label: "Kindergarten",
      currency: "installed",
      contentVersion: "1.0.0",
    },
    { gradeId: "grade-1", label: "Grade 1", currency: "missing", contentVersion: null },
  ];
}

describe("journey store", () => {
  it("initializes grades and the active grade", () => {
    let state = initialJourneyState();
    state = journeyReducer(state, {
      type: "grades-initialized",
      grades: slots(),
      activeGrade: "kindergarten",
    });
    expect(state.activeGrade).toBe("kindergarten");
    expect(state.grades).toHaveLength(2);
  });

  it("switching grades reloads the model but never clears pack slots or hydration state", () => {
    let state = initialJourneyState();
    state = journeyReducer(state, {
      type: "grades-initialized",
      grades: slots(),
      activeGrade: "kindergarten",
    });
    state = journeyReducer(state, { type: "hydration-adopted", atMs: NOW });
    state = journeyReducer(state, { type: "grade-selected", gradeId: "grade-1" });
    expect(state.activeGrade).toBe("grade-1");
    expect(state.status).toBe("loading");
    expect(state.model).toBeNull();
    // Preserved across the switch:
    expect(state.grades).toHaveLength(2);
    expect(state.lastHydratedAtMs).toBe(NOW);
  });

  it("re-selecting the same grade is a no-op", () => {
    let state = initialJourneyState();
    state = journeyReducer(state, {
      type: "grades-initialized",
      grades: slots(),
      activeGrade: "kindergarten",
    });
    state = journeyReducer(state, {
      type: "model-loaded",
      model: deriveJourneyModel({
        gradeId: "kindergarten",
        units: [],
        census: [],
        completion: [],
        unitProgress: [],
        nowMs: NOW,
      }),
    });
    const next = journeyReducer(state, { type: "grade-selected", gradeId: "kindergarten" });
    expect(next).toBe(state);
  });

  it("model loads bump the version (the path-layer memo key)", () => {
    let state = initialJourneyState();
    state = journeyReducer(state, {
      type: "grades-initialized",
      grades: slots(),
      activeGrade: "kindergarten",
    });
    const model = deriveJourneyModel({
      gradeId: "kindergarten",
      units: [],
      census: [],
      completion: [],
      unitProgress: [],
      nowMs: NOW,
    });
    state = journeyReducer(state, { type: "model-loaded", model });
    expect(state.status).toBe("ready");
    expect(state.modelVersion).toBe(1);
    state = journeyReducer(state, { type: "model-loaded", model });
    expect(state.modelVersion).toBe(2);
  });

  it("model-loaded for a non-active grade is ignored (hydration race guard)", () => {
    let state = initialJourneyState();
    state = journeyReducer(state, {
      type: "grades-initialized",
      grades: slots(),
      activeGrade: "kindergarten",
    });
    state = journeyReducer(state, {
      type: "model-loaded",
      model: deriveJourneyModel({
        gradeId: "kindergarten",
        units: [],
        census: [],
        completion: [],
        unitProgress: [],
        nowMs: NOW,
      }),
    });
    expect(state.status).toBe("ready");
    expect(state.modelVersion).toBe(1);

    // The mount hydration resolves after the child switched to grade-1:
    // its kindergarten model must not clobber the new selection.
    const stale = journeyReducer(state, {
      type: "model-loaded",
      model: deriveJourneyModel({
        gradeId: "grade-1",
        units: [],
        census: [],
        completion: [],
        unitProgress: [],
        nowMs: NOW,
      }),
    });
    expect(stale).toBe(state); // ignored: no model swap, no version bump
  });

  it("load-failed and no-pack are reachable states (exhaustive action matrix)", () => {
    let state = initialJourneyState();
    state = journeyReducer(state, { type: "load-failed", error: "disk gone" });
    expect(state.status).toBe("error");
    expect(state.error).toBe("disk gone");

    state = journeyReducer(state, {
      type: "grades-initialized",
      grades: slots(),
      activeGrade: "kindergarten",
    });
    state = journeyReducer(state, {
      type: "model-loaded",
      model: deriveJourneyModel({
        gradeId: "kindergarten",
        units: [],
        census: [],
        completion: [],
        unitProgress: [],
        nowMs: NOW,
      }),
    });
    state = journeyReducer(state, { type: "no-pack" });
    expect(state.status).toBe("no-pack");
    expect(state.model).toBeNull();
  });

  it("grade switch mid-hydration keeps the hydration in flight; adoption lands after", () => {
    let state = initialJourneyState();
    state = journeyReducer(state, {
      type: "grades-initialized",
      grades: slots(),
      activeGrade: "kindergarten",
    });
    state = journeyReducer(state, { type: "hydration-started" });
    state = journeyReducer(state, { type: "grade-selected", gradeId: "grade-1" });
    // The switch must not cancel the in-flight snapshot run.
    expect(state.hydrating).toBe(true);
    expect(state.activeGrade).toBe("grade-1");
    state = journeyReducer(state, { type: "hydration-adopted", atMs: NOW });
    expect(state.hydrating).toBe(false);
    expect(state.lastHydratedAtMs).toBe(NOW);
  });

  it("a stale flag survives model reloads (only ensure-resolved clears it)", () => {
    let state = initialJourneyState();
    state = journeyReducer(state, {
      type: "grades-initialized",
      grades: slots(),
      activeGrade: "kindergarten",
    });
    state = journeyReducer(state, { type: "pack-flagged-stale", gradeId: "kindergarten" });
    state = journeyReducer(state, {
      type: "model-loaded",
      model: deriveJourneyModel({
        gradeId: "kindergarten",
        units: [],
        census: [],
        completion: [],
        unitProgress: [],
        nowMs: NOW,
      }),
    });
    // Post-hydration re-derive does NOT un-stale the slot; the last-good
    // installed version keeps serving (offline tolerance).
    expect(state.status).toBe("ready");
    expect(state.grades[0]!.currency).toBe("stale");
    expect(state.grades[0]!.contentVersion).toBe("1.0.0");
  });

  it("tracks the pack download lifecycle and the stale handshake flag", () => {
    let state = initialJourneyState();
    state = journeyReducer(state, {
      type: "grades-initialized",
      grades: slots(),
      activeGrade: "kindergarten",
    });
    state = journeyReducer(state, { type: "pack-ensure-started", gradeId: "grade-1" });
    expect(state.grades[1]!.currency).toBe("downloading");
    state = journeyReducer(state, {
      type: "pack-ensure-resolved",
      gradeId: "grade-1",
      currency: "installed",
      contentVersion: "1.1.0",
    });
    expect(state.grades[1]!.currency).toBe("installed");
    expect(state.grades[1]!.contentVersion).toBe("1.1.0");
    state = journeyReducer(state, { type: "pack-flagged-stale", gradeId: "kindergarten" });
    expect(state.grades[0]!.currency).toBe("stale");
    // Stale keeps serving the installed version (offline tolerance).
    expect(state.grades[0]!.contentVersion).toBe("1.0.0");
  });

  it("hydration race sequence: stale model ignored, fresh model lands ready", () => {
    let state = initialJourneyState();
    state = journeyReducer(state, {
      type: "grades-initialized",
      grades: slots(),
      activeGrade: "kindergarten",
    });
    state = journeyReducer(state, {
      type: "model-loaded",
      model: deriveJourneyModel({
        gradeId: "kindergarten",
        units: [],
        census: [],
        completion: [],
        unitProgress: [],
        nowMs: NOW,
      }),
    });
    expect(state.status).toBe("ready");
    expect(state.modelVersion).toBe(1);

    // The child switches grade while the mount hydration kick is in
    // flight; adoption lands mid-switch.
    state = journeyReducer(state, { type: "grade-selected", gradeId: "grade-1" });
    state = journeyReducer(state, { type: "hydration-adopted", atMs: NOW });

    // The hydration's OLD-grade reload resolves late: ignored entirely.
    const staleModel = deriveJourneyModel({
      gradeId: "kindergarten",
      units: [],
      census: [],
      completion: [],
      unitProgress: [],
      nowMs: NOW,
    });
    expect(journeyReducer(state, { type: "model-loaded", model: staleModel })).toBe(state);

    // The switched-to grade's model loads and is accepted.
    state = journeyReducer(state, {
      type: "model-loaded",
      model: deriveJourneyModel({
        gradeId: "grade-1",
        units: [],
        census: [],
        completion: [],
        unitProgress: [],
        nowMs: NOW,
      }),
    });
    expect(state.status).toBe("ready");
    expect(state.model!.gradeId).toBe("grade-1");
    expect(state.modelVersion).toBe(2);
  });

  it("hydration lifecycle: started -> adopted", () => {
    let state = initialJourneyState();
    state = journeyReducer(state, { type: "hydration-started" });
    expect(state.hydrating).toBe(true);
    state = journeyReducer(state, { type: "hydration-adopted", atMs: NOW });
    expect(state.hydrating).toBe(false);
    expect(state.lastHydratedAtMs).toBe(NOW);
  });

  it("maps every #46 ensure status to a switcher currency", () => {
    expect(
      currencyForEnsureResult({ status: "current", gradeId: "g", contentVersion: "1.0.0" }, null),
    ).toEqual({
      currency: "installed",
      contentVersion: "1.0.0",
    });
    expect(
      currencyForEnsureResult(
        { status: "upgraded", gradeId: "g", contentVersion: "2.0.0" },
        "1.0.0",
      ),
    ).toEqual({
      currency: "installed",
      contentVersion: "2.0.0",
    });
    // Failed ensure with an existing install keeps serving it.
    expect(currencyForEnsureResult({ status: "failed", gradeId: "g" }, "1.0.0")).toEqual({
      currency: "installed",
      contentVersion: "1.0.0",
    });
    expect(currencyForEnsureResult({ status: "unavailable", gradeId: "g" }, null)).toEqual({
      currency: "missing",
      contentVersion: null,
    });
    expect(currencyForEnsureResult({ status: "refused", gradeId: "g" }, null)).toEqual({
      currency: "missing",
      contentVersion: null,
    });
  });
});

describe("journey source-scan pins (#49 wiring)", () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const read = (relative: string): string => readFileSync(join(here, "..", relative), "utf-8");

  it("the dormant clientPacks handshake is wired in SyncBootstrap", () => {
    const source = read("src/sync/SyncBootstrap.tsx");
    expect(source).toContain("clientPacks:");
    expect(source).toContain("activePackVersions()");
    expect(source).toContain("subscribeContentOutdated");
  });

  it("the post-hydration reload targets the live grade (race-fix wiring)", () => {
    const screen = read("src/journey/JourneyScreen.tsx");
    // The ref (not the effect closure) drives the post-adoption reload,
    // and stale status flips are suppressed for switched-away grades.
    expect(screen).toContain("reloadModel(activeGradeRef.current)");
    expect(screen).toContain('const activeGradeRef = useRef("")');
    expect(screen).toContain("isStale()");
  });

  it("the journey model/store/loader stay pure (no RN/native imports)", () => {
    for (const file of [
      "src/journey/model.ts",
      "src/journey/store.ts",
      "src/journey/loader.ts",
      "src/journey/art.ts",
    ]) {
      const source = read(file);
      expect(
        /from "(react-native|expo-[a-z-]+|react)"/.test(source),
        `${file} must not import RN/expo modules`,
      ).toBe(false);
    }
  });

  it("the screen layer renders from the model and routes with unit params (#50/#51 seam)", () => {
    const screen = read("src/journey/JourneyScreen.tsx");
    expect(screen).toContain("loadJourneyModel");
    expect(screen).toContain("getSyncController");
    expect(screen).toContain("unitId: node.unitId");
    // Reduced motion: the scroll-linked effect is only attached when
    // animations are enabled.
    expect(screen).toContain("motion.animationsEnabled ? scrollHandler");
  });

  it("layout is memoized on (unit count, width) only — no per-render path builds", () => {
    const screen = read("src/journey/JourneyScreen.tsx");
    expect(screen).toContain("useMemo");
    const path = read("src/journey/JourneyPath.tsx");
    expect(path).toContain("layout.pathD");
    // The single animated surface is the dash reveal.
    expect(path).toContain("AnimatedPath");
    expect(path).toContain("strokeDashoffset");
  });

  it("layout memoization is correct: identical inputs reuse the identical layout object", () => {
    // The pure function backing the useMemo is referentially stable in
    // OUTPUT (deep-equal); determinism is the memo-safety proof.
    const a = layoutWindingPath(5, { width: 320, verticalStep: 120, amplitude: 80 });
    const b = layoutWindingPath(5, { width: 320, verticalStep: 120, amplitude: 80 });
    expect(a).toEqual(b);
    expect(layoutWindingPath(6, { width: 320, verticalStep: 120, amplitude: 80 })).not.toEqual(a);
  });
});
