/**
 * Journey loader (issue #49) — assembles the model inputs from the
 * #46/#47 seams. PURE with respect to the platform: it accepts injected
 * dependencies (PracticeDeps-shaped) and never imports react-native,
 * so the vitest suite runs it against the same node:sqlite practiceEnv
 * fixture the practice core uses.
 */

import { deriveJourneyModel, type JourneyModel, type UnitTopicCensus } from "./model";
import type {
  PackUnitRow,
  PracticeDeps,
  TopicProgressRecord,
  UnitProgressRecord,
} from "../practice/types";

export interface JourneyLoadResult {
  model: JourneyModel;
  /** The pack rows read (for the view's accessibility labels). */
  units: PackUnitRow[];
}

/**
 * One screen-load: pack units + topic census + progress rows -> the
 * derived journey model. Offline-first by construction — every read is
 * local (pack reader + progress tables); nothing here touches the
 * network. A missing pack for the grade resolves to null (the screen
 * shows the download state).
 */
export async function loadJourneyModel(
  deps: Pick<PracticeDeps, "openContent">,
  progressSource: {
    allUnitProgress(studentId: string): Promise<UnitProgressRecord[]>;
    allTopicProgress(studentId: string): Promise<TopicProgressRecord[]>;
  },
  params: { gradeId: string; studentId: string; nowMs: number },
): Promise<JourneyLoadResult | null> {
  const reader = await deps.openContent(params.gradeId);
  if (!reader) return null;

  const [unitRows, topicRows, unitProgress, topicProgress] = await Promise.all([
    reader.unitsForGrade(params.gradeId),
    reader.topicsForGrade(params.gradeId),
    progressSource.allUnitProgress(params.studentId),
    progressSource.allTopicProgress(params.studentId),
  ]);

  // Topic census per unit from the pack (the definition of "all topics").
  const census: UnitTopicCensus[] = [];
  const topicsByUnit = new Map<string, number>();
  for (const topic of topicRows) {
    topicsByUnit.set(topic.unit_id, (topicsByUnit.get(topic.unit_id) ?? 0) + 1);
  }
  for (const [unitId, totalTopics] of topicsByUnit) {
    census.push({ unitId, totalTopics });
  }

  // Completion per unit from the student's topic rows (completed flag +
  // crowns averaged over the unit's TOTAL topic count — untouched topics
  // contribute 0, which is exactly the pack's definition of average).
  const completionByUnit = new Map<string, { completed: number; crowns: number }>();
  for (const row of topicProgress) {
    const entry = completionByUnit.get(row.unitId) ?? { completed: 0, crowns: 0 };
    if (row.completed > 0) entry.completed += 1;
    entry.crowns += row.crowns;
    completionByUnit.set(row.unitId, entry);
  }
  const completion = [...completionByUnit.entries()].map(([unitId, entry]) => {
    const totalTopics = topicsByUnit.get(unitId) ?? 0;
    return {
      unitId,
      completedTopics: entry.completed,
      averageCrowns: totalTopics > 0 ? entry.crowns / totalTopics : 0,
    };
  });

  const units = unitRows.map((row) => ({
    unitId: row.unit_id,
    subject: row.subject,
    sequenceOrder: row.sequence_order,
    title: row.title,
    prerequisiteUnitIds: parseIds(row.prerequisite_unit_ids_json),
  }));

  return {
    model: deriveJourneyModel({
      gradeId: params.gradeId,
      units,
      census,
      completion,
      unitProgress,
      nowMs: params.nowMs,
    }),
    units: unitRows,
  };
}

function parseIds(json: string): string[] {
  try {
    const parsed = JSON.parse(json || "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}
