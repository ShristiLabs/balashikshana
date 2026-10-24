/**
 * Game-framework shared contracts (issue #52) - TYPES ONLY, zero runtime
 * code, no React Native imports: every module in src/games is testable
 * in vitest/node against these shapes.
 *
 * Data source of truth: the per-topic `assets.games` block that rides
 * #46 content packs VERBATIM inside skill_topics.assets_json (parsed by
 * packTopicToEngineTopic). The registry carries two game configs per
 * topic - guidedPracticeGame (Stage 2 untimed explorer) and
 * fluencySprintGame (Stage 3 timed automaticity) - and the framework
 * consumes them without any hardcoded per-topic screens (AGENTS.md
 * data-driven rule).
 */

/** The two registry game stages a topic can offer. */
export type GameStage = "guided" | "fluency";

/**
 * Spiral-mix provenance tag for one item in a game session (registry
 * assets.games fluencySprintGame.spiralMix buckets). The empty string
 * marks a session that carries no spiral attribution (the practice
 * fallback path) - never null, so the telemetry column stays NOT NULL.
 */
export type SpiralProvenance = "current" | "contrastive" | "spaced-review" | "";

/** Registry assets.games.guidedPracticeGame (Stage 2, untimed). */
export interface GuidedGameConfig {
  gameId: string;
  archetype: string;
  title: string;
  mechanics: string;
  /** Registry targetMasteryScore (80 across today's data; data-driven). */
  targetMasteryScore: number;
  /** Registry minQuestionsToComplete (8 across today's data; data-driven). */
  minQuestionsToComplete: number;
}

/** Registry assets.games.fluencySprintGame (Stage 3, timed). */
export interface FluencyGameConfig {
  gameId: string;
  archetype: string;
  title: string;
  mechanics: string;
  /** Per-topic speed target in seconds (3.0-16.0 across the registry). */
  targetResponseSpeedSec: number;
  /** 70/20/10 across today's registry; carried per topic as data. */
  spiralMix: {
    currentTopic: number;
    contrastivePrerequisite: number;
    spacedReview: number;
  };
}

/** Validated view over a topic's assets.games block (either side may be
 * absent in malformed data; the parser never throws). */
export interface GamesAssetBlock {
  guidedPracticeGame: GuidedGameConfig | null;
  fluencySprintGame: FluencyGameConfig | null;
}

/** The route decision the game host makes BEFORE opening any session. */
export type GameRouteDecision =
  | {
      kind: "game";
      stage: GameStage;
      archetype: string;
      gameId: string;
      gameTitle: string;
      /** The stage's config, narrowed to the decided stage. */
      guided: GuidedGameConfig | null;
      fluency: FluencyGameConfig | null;
    }
  | {
      kind: "practice-fallback";
      stage: GameStage | null;
      archetype: string | null;
      /** Machine-readable fallback cause (telemetry + parent-facing copy). */
      reason: "no-games-block" | "stage-missing" | "archetype-not-installed";
    };

/**
 * Per-attempt game telemetry stamped on attempt_log rows (issue #52
 * schema migration 4). Defined in src/practice/types.ts (attempt-log
 * domain, alongside AttemptInput) and re-exported here for archetype
 * authors. LOCAL-ONLY columns: the #48 sync wire is unchanged (facts
 * only - the server derives progress from the same attempt facts as
 * topic practice); these fields carry the game provenance the wire
 * deliberately does not. No PII (COPPA): archetype ids, stage timing,
 * and provenance tags only.
 */
export type { GameAttemptTelemetry } from "../practice/types";

/**
 * The parameters every archetype renderer receives. The framework
 * session screen owns timing, durable recording, feedback, and the
 * re-queue ladder; the renderer owns the game's answer surface and
 * reports drafts upward. #53/#54 archetype packs implement this
 * contract and register into ARCHETYPE_RENDERERS.
 */
export interface GameRendererProps {
  /** The current item (spiral-mixed stream; re-queues repeat originals). */
  question: import("../practice/types").PracticeQuestion;
  /** Engine-derived CPA stage for the question's topic. */
  stage: string;
  /** guided (untimed explorer) or fluency (timed automaticity). */
  gameStage: GameStage;
  /** Registry targetResponseSpeedSec (fluency); 0 when untimed. */
  targetResponseSpeedSec: number;
  /** True while feedback shows (renderer locks its inputs). */
  disabled: boolean;
  /** Current draft answer (string form; renderer keeps its own structure). */
  draft: string | null;
  /** Publish a new draft (null clears). */
  onDraftChange: (draft: string | null) => void;
  /** Replay the item's narration (audio seam lives in the screen). */
  onReplayPrompt: () => void;
  /**
   * Reflex submit seam (issue #54, pack B - the one conscious
   * GameRendererProps extension, added WITH tests): tap-to-answer
   * archetypes (bubble-pop-blitz) call this immediately after
   * onDraftChange so the answer submits on the tap itself - a
   * build-then-Check flow would double the motor cost and break the
   * registry's targetResponseSpeedSec pacing semantics. Optional and
   * deliberately absent for pack A: build-then-check manipulatives
   * keep the framework Check button and ignore this seam.
   */
  onSubmitAnswer?: () => void;
}
