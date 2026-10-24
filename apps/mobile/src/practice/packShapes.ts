/**
 * Pack row -> engine/domain shape adapters (issue #47).
 *
 * The #46 pack artifact stores curriculum rows in the compiler's column
 * contract; core-engine functions want the registry's JS shapes. These
 * mappers reproduce EXACTLY the reconstruction the server performs in
 * its /api/gate/evaluate and /api/practice/topic handlers, so the same
 * engine inputs produce the same outputs on both sides.
 */
import type { PackQuestionRow, PackTopicRow, PackUnitRow, PracticeQuestion } from "./types";

/** Server: gate-evaluate unitObj reconstruction (services/api/server.mjs). */
export interface EngineUnit {
  unitId: string;
  title: string;
  masteryGate: {
    questionCount: number;
    minAccuracyPercent: number;
    maxMedianResponseTimeSec: number;
    challengeZoneStreak: number;
  };
  skillTopics: { code: string; name: string }[];
}

/** Full topic shape for the engine's generators (needs assets). */
export interface EngineTopic {
  code: string;
  name: string;
  assets: Record<string, unknown>;
}

export function packUnitToEngineUnit(unit: PackUnitRow, topics: PackTopicRow[]): EngineUnit {
  return {
    unitId: unit.unit_id,
    title: unit.title,
    masteryGate: {
      questionCount: unit.gate_question_count,
      minAccuracyPercent: unit.gate_min_accuracy_pct,
      maxMedianResponseTimeSec: unit.gate_max_speed_sec,
      challengeZoneStreak: unit.gate_streak_req,
    },
    skillTopics: topics.map((t) => ({ code: t.topic_code, name: t.topic_name })),
  };
}

export function packTopicToEngineTopic(topic: PackTopicRow): EngineTopic {
  let assets: Record<string, unknown> = {};
  try {
    assets = JSON.parse(topic.assets_json || "{}") as Record<string, unknown>;
  } catch {
    assets = {};
  }
  return { code: topic.topic_code, name: topic.topic_name, assets };
}

/**
 * Field-for-field the server's mapQuestionRow (services/api/server.mjs):
 * #50 renders this exact shape from either the online API or the
 * offline pack with zero adapter drift.
 */
export function packQuestionToPracticeQuestion(row: PackQuestionRow): PracticeQuestion {
  let visualObjects: unknown;
  if (row.visual_objects != null && row.visual_objects !== "") {
    try {
      visualObjects = JSON.parse(row.visual_objects);
    } catch {
      visualObjects = row.visual_objects;
    }
  }
  let tileBank: unknown;
  if (row.tile_bank_json != null && row.tile_bank_json !== "") {
    try {
      tileBank = JSON.parse(row.tile_bank_json);
    } catch {
      tileBank = row.tile_bank_json;
    }
  }
  return {
    questionId: row.question_id,
    topicId: row.topic_id,
    unitId: row.unit_id,
    topicCode: row.topic_code,
    topicName: row.topic_name,
    difficultyLevel: row.difficulty_level,
    interactionType: row.interaction_type,
    prompt: row.prompt,
    visualAid: row.visual_aid_svg,
    visualObjects,
    targetCount: row.target_count ?? undefined,
    maxCounterCells: row.max_counter_cells ?? undefined,
    counterEmoji: row.counter_emoji ?? undefined,
    tileBank,
    choices: parseJsonArray(row.choices_json),
    correctAnswer: row.correct_answer,
    misconceptionTags: parseJsonArray(row.misconception_tags_json).filter(
      (t): t is string => typeof t === "string",
    ),
    explanation: row.explanation,
  };
}

function parseJsonArray(json: string | null): unknown[] {
  try {
    const parsed = JSON.parse(json || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Engine-generated questions mapped into the same PracticeQuestion
 * shape (used when a session needs more items than the pack stored for
 * a topic). Deterministic: identical (unit, topic, seed) always yields
 * the identical item, on the server and on-device alike.
 */
export interface GeneratedQuestionFields {
  interactionType?: string;
  prompt: string;
  visualAid?: string;
  visualObjects?: unknown;
  targetCount?: number;
  maxCounterCells?: number;
  counterEmoji?: string;
  tileBank?: unknown;
  choices?: unknown[];
  correctAnswer: string | number;
  misconceptionTags?: string[];
  explanation?: string;
}

export function generatedToPracticeQuestion(
  unitId: string,
  topicId: string,
  topicCode: string,
  topicName: string,
  seedIndex: number,
  generated: GeneratedQuestionFields,
): PracticeQuestion {
  const difficultyLevel = seedIndex < 3 ? 1 : seedIndex < 7 ? 2 : 3;
  return {
    questionId: `${topicId}-G${seedIndex + 1}`,
    topicId,
    unitId,
    topicCode,
    topicName,
    difficultyLevel,
    interactionType: generated.interactionType || "multiple-choice",
    prompt: generated.prompt,
    visualAid: generated.visualAid || "assets/images/ten_frame_and_number_line.svg",
    visualObjects: generated.visualObjects,
    targetCount: generated.targetCount,
    maxCounterCells: generated.maxCounterCells,
    counterEmoji: generated.counterEmoji,
    tileBank: generated.tileBank,
    choices: generated.choices || [],
    correctAnswer: String(generated.correctAnswer),
    misconceptionTags: generated.misconceptionTags || [],
    explanation: generated.explanation || "",
  };
}
