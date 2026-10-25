/**
 * CelebrationStack (issue #58) — the composed celebration moment.
 *
 * One display-only block: the mascot in its celebrate pose (bloom),
 * the planned moments' badge blooms (one per newly earned badge, #55
 * catalog metadata), and the text copy for every moment — so each
 * celebration is fully text-redundant (a11y) and PII-free (counts and
 * catalog titles only). Used by the runner/game summaries and the key
 * ceremony. No pressables are introduced here; the surrounding screens
 * keep their own >=48pt actions.
 */
import React from "react";
import { Text, View } from "react-native";
import { useTheme } from "../design/theme";
import { spacing, typeRamp } from "../design/tokens";
import { BadgeBloomView, type BadgeBloomBadge } from "./BadgeBloomView";
import { MascotView } from "./MascotView";
import { celebrationCopyFor, type CelebrationMomentPlan } from "./celebrationEvents";
import { initialMascotState, type CelebrateMoment } from "./mascotMachine";

export interface CelebrationStackProps {
  /** Planned moments (planCelebrationMoments output or direct ceremony moments). */
  moments: CelebrationMomentPlan[];
  /** Moment->catalog badge metadata for the blooms (title/tier/description). */
  badgeById: Record<string, BadgeBloomBadge>;
  /** False (reduced motion): static frames throughout. */
  animationsEnabled: boolean;
  /** Topic name for topic-mastered copy (registry name; no PII). */
  topicName?: string | null;
  /** Level for level-up copy (count only; no PII). */
  level?: number;
  testID?: string;
}

/** Construct the celebrate-pose mascot state for a held moment. */
export function celebrateMascotState(
  moment: CelebrateMoment,
): ReturnType<typeof initialMascotState> {
  return {
    ...initialMascotState(0),
    mood: "celebrate",
    pose: "mastery_badge_bloom",
    moment,
    expiresAtMs: null,
  };
}

export function CelebrationStack({
  moments,
  badgeById,
  animationsEnabled,
  topicName,
  level,
  testID,
}: CelebrationStackProps): React.ReactElement | null {
  const { colors } = useTheme();
  if (moments.length === 0) return null;

  const lead = moments[0];
  if (!lead) return null;
  const leadCopy = celebrationCopyFor(lead, {
    badgeTitle: lead.badgeId ? (badgeById[lead.badgeId]?.title ?? null) : null,
    topicName: topicName ?? null,
    level,
  });

  return (
    <View style={{ alignItems: "center", gap: spacing.md }} testID={testID}>
      <MascotView
        state={celebrateMascotState(lead.moment)}
        animationsEnabled={animationsEnabled}
        size={72}
        testID="celebration-mascot"
      />
      <Text
        accessible
        accessibilityRole="header"
        accessibilityLabel={leadCopy.a11yLabel}
        style={{ ...typeRamp.h2, color: colors.text, textAlign: "center" }}
      >
        {leadCopy.title}
      </Text>
      <Text style={{ ...typeRamp.body, color: colors.textMuted, textAlign: "center" }}>
        {leadCopy.body}
      </Text>
      {moments.some((plan) => plan.badgeId && badgeById[plan.badgeId]) ? (
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            justifyContent: "center",
            gap: spacing.lg,
            paddingTop: spacing.xs,
          }}
        >
          {moments.map((plan, index) => {
            const badge = plan.badgeId ? badgeById[plan.badgeId] : undefined;
            if (!badge) return null;
            return (
              <BadgeBloomView
                key={`${plan.badgeId}-${String(index)}`}
                badge={badge}
                animationsEnabled={animationsEnabled}
                testID={`badge-bloom-${plan.badgeId}`}
              />
            );
          })}
        </View>
      ) : null}
      {moments.length > 1 ? (
        <Text style={{ ...typeRamp.caption, color: colors.textMuted, textAlign: "center" }}>
          {moments
            .slice(1)
            .map(
              (plan) =>
                celebrationCopyFor(plan, {
                  badgeTitle: plan.badgeId ? (badgeById[plan.badgeId]?.title ?? null) : null,
                  topicName: topicName ?? null,
                  level,
                }).title,
            )
            .join(" ")}
        </Text>
      ) : null}
    </View>
  );
}
