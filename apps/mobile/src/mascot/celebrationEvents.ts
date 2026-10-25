/**
 * Celebration event hooks (issue #58) — PURE TypeScript.
 *
 * Derives the celebration MOMENTS (#55 badge awards, level-up, #57
 * streak transitions, topic mastery, #52-#54 game outcomes, #51 key
 * ceremonies) from the reward projection's before/after deltas and
 * plans them into an ordered, deduplicated queue the screens play as
 * mascot bloom moments. Pure data in, pure data out: no React Native,
 * no core-engine imports (the practice engine computes the levels and
 * feeds plain numbers in), no PII — copy carries counts and catalog
 * titles only, never the child's name or any identifier.
 */

import type { CelebrateMoment } from "./mascotMachine";

/**
 * The #55/#57 event deltas of one completed session (computed inside
 * PracticeSessionEngine.projectRewards where the before-state exists).
 */
export interface CelebrationReport {
  /** Badge ids newly earned this session (#55 catalog, forward-only). */
  badgesAwarded: string[];
  /** True when the session's XP crossed into a new level. */
  leveledUp: boolean;
  /** The level AFTER the session (engine levelForXp). */
  level: number;
  /** Streak days AFTER the session (#57 rule). */
  streakDays: number;
  /** True when this session's day-transition grew the streak. */
  streakIncreased: boolean;
}

/** The empty report (no gamification seam / no transitions). */
export function emptyCelebrationReport(level: number, streakDays: number): CelebrationReport {
  return { badgesAwarded: [], leveledUp: false, level, streakDays, streakIncreased: false };
}

/** Build the report from before/after projector values. */
export function buildCelebrationReport(params: {
  badgesAwarded: string[];
  levelBefore: number;
  levelAfter: number;
  streakBefore: number;
  streakAfter: number;
}): CelebrationReport {
  return {
    badgesAwarded: params.badgesAwarded,
    leveledUp: params.levelAfter > params.levelBefore,
    level: params.levelAfter,
    streakDays: params.streakAfter,
    streakIncreased: params.streakAfter > params.streakBefore,
  };
}

/** One planned celebration moment with its resolved copy context. */
export interface CelebrationMomentPlan {
  moment: CelebrateMoment;
  /** #55 catalog badge id for bloom art (badge-awarded / topic-mastered). */
  badgeId: string | null;
}

/**
 * Streak milestones: the #55 catalog's own streak badge thresholds
 * (streak-spark at 3 days, streak-star at 7). A streak increase that
 * does not cross a catalog threshold is surfacing (the journey strip),
 * not a ceremony — the catalog defines what is milestone-worthy.
 */
const STREAK_MILESTONE_DAYS = [3, 7] as const;

function isStreakMilestone(before: number, after: number): boolean {
  return STREAK_MILESTONE_DAYS.some((threshold) => before < threshold && after >= threshold);
}

/**
 * Plan the celebration queue for a completed session. Order is
 * deliberate (kid-psych: concrete before abstract): topic mastery
 * first, then each newly earned badge (catalog order), then level-up,
 * then streak milestone. Game-goal and key ceremonies are requested
 * directly by their screens (they own the moment) and are NOT derived
 * here. Deduplicated by construction (each source contributes at most
 * its own moments; badge ids are unique).
 *
 * Streak-before is derived from the report: a #57 transition grows the
 * streak by exactly one day per new active day (or resets to 1, which
 * can never cross a milestone upward), so `increased => before = after
 * - 1` reconstructs the crossing side exactly.
 */
export function planCelebrationMoments(params: {
  report: CelebrationReport;
  /** The session completed the topic's FIRST mastery (the bloom moment). */
  topicMastered: boolean;
}): CelebrationMomentPlan[] {
  const plans: CelebrationMomentPlan[] = [];
  if (params.topicMastered) {
    plans.push({ moment: "topic-mastered", badgeId: null });
  }
  for (const badgeId of params.report.badgesAwarded) {
    plans.push({ moment: "badge-awarded", badgeId });
  }
  if (params.report.leveledUp) {
    plans.push({ moment: "level-up", badgeId: null });
  }
  const streakBefore = params.report.streakIncreased
    ? params.report.streakDays - 1
    : params.report.streakDays;
  if (isStreakMilestone(streakBefore, params.report.streakDays)) {
    plans.push({ moment: "streak-milestone", badgeId: null });
  }
  return plans;
}

export interface CelebrationCopy {
  title: string;
  body: string;
  a11yLabel: string;
}

/** Copy context: catalog badge title, topic name, and the report level (counts only — never PII). */
export interface CelebrationCopyContext {
  badgeTitle?: string | null;
  topicName?: string | null;
  level?: number;
}

/** Positive-only, PII-free copy for each moment (text redundancy for every visual). */
export function celebrationCopyFor(
  plan: CelebrationMomentPlan,
  ctx: CelebrationCopyContext,
): CelebrationCopy {
  switch (plan.moment) {
    case "topic-mastered":
      return {
        title: "Topic mastered!",
        body: ctx.topicName
          ? `You mastered ${ctx.topicName}. Your badge is blooming!`
          : "You mastered this topic. Your badge is blooming!",
        a11yLabel: ctx.topicName
          ? `Topic mastered: ${ctx.topicName}. Badge blooming.`
          : "Topic mastered. Badge blooming.",
      };
    case "badge-awarded":
      return {
        title: ctx.badgeTitle ? `Badge earned: ${ctx.badgeTitle}!` : "Badge earned!",
        body: "A new badge for your collection. Great work!",
        a11yLabel: ctx.badgeTitle ? `Badge earned: ${ctx.badgeTitle}.` : "Badge earned.",
      };
    case "level-up": {
      const level = ctx.level ?? 0;
      const levelText = level > 0 ? ` You reached level ${String(level)}.` : "";
      return {
        title: "Level up!",
        body: `Your practice added up.${levelText} Keep going!`,
        a11yLabel: level > 0 ? `Level up. Level ${String(level)} reached.` : "Level up.",
      };
    }
    case "streak-milestone":
      return {
        title: "Streak milestone!",
        body: "You practiced day after day. That is how learning sticks!",
        a11yLabel: "Streak milestone reached.",
      };
    case "game-goal-met":
      return {
        title: "Great game!",
        body: "You met your goal. Your brain is getting super fast and accurate!",
        a11yLabel: "Game goal met. Great work.",
      };
    case "key-ceremony-silver":
      return {
        title: "Silver key earned!",
        body: "You beat the boss gate! A Gold key check unlocks after a good night's sleep.",
        a11yLabel: "Silver key earned.",
      };
    case "key-ceremony-gold":
      return {
        title: "Gold key earned!",
        body: "Your sleep made it stick. This key is yours for good.",
        a11yLabel: "Gold key earned.",
      };
    case "unit-complete":
      return {
        title: "Unit complete!",
        body: "Every topic in this unit is mastered. Onward!",
        a11yLabel: "Unit complete.",
      };
  }
}
