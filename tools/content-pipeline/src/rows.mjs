/**
 * Registry -> pack row extraction (issue #46).
 *
 * The mapping mirrors services/api/db.mjs seedCurriculumAndQuestions row
 * for row (grade/unit/topic/question columns, id scheme, difficulty tiers)
 * so a compiled pack and the served PostgreSQL database hold IDENTICAL
 * content by construction — the D3 shared-engine doctrine extended to the
 * pack compiler. Questions come from core-engine's deterministic
 * generateTopicPracticeSet (10 per topic; 614 topics -> 6,140 questions);
 * the engine source is imported read-only and never modified.
 *
 * Row objects are shaped exactly like the pack tables' columns
 * (snake_case) so the writer binds them positionally with zero mapping.
 * Every array is explicitly sorted so artifact bytes depend only on
 * content, never on input-file ordering.
 */
import { generateTopicPracticeSet } from "../../../packages/core-engine/src/index.mjs";
import { stableStringify } from "./canonical.mjs";

const QUESTIONS_PER_TOPIC = 10;

/**
 * Extract all rows for one grade.
 *
 * @returns {{ grade: object, units: object[], topics: object[],
 *             questions: object[], sounds: object[], narration: object[],
 *             counts: { unitCount: number, topicCount: number, questionCount: number } }}
 */
export function extractGradeRows(registry, gradeId) {
  const gradeDef = registry.grades.find((g) => g.gradeId === gradeId);
  if (!gradeDef) {
    throw new Error(`Unknown gradeId "${gradeId}" (registry has: ${registry.grades.map((g) => g.gradeId).join(", ")})`);
  }

  const subjectOrder = Object.keys(gradeDef.subjects).sort();
  const units = [];
  const topics = [];
  const questions = [];
  const sounds = [];
  const narration = [];

  for (const subject of subjectOrder) {
    for (const unit of gradeDef.subjects[subject].units) {
      const gate = unit.masteryGate;
      units.push({
        unit_id: unit.unitId,
        grade_id: gradeDef.gradeId,
        subject,
        sequence_order: unit.sequenceOrder,
        title: unit.title,
        prerequisite_unit_ids_json: stableStringify(unit.prerequisiteUnitIds || []),
        gate_question_count: gate.questionCount,
        gate_min_accuracy_pct: gate.minAccuracyPercent,
        gate_max_speed_sec: gate.maxMedianResponseTimeSec,
        gate_streak_req: gate.challengeZoneStreak || 4,
        study_materials_json: stableStringify(unit.studyMaterials || []),
        games_json: stableStringify(unit.games || []),
      });

      unit.skillTopics.forEach((topic, tIdx) => {
        const topicId = `${unit.unitId}-${topic.code}`;
        topics.push({
          topic_id: topicId,
          unit_id: unit.unitId,
          grade_id: gradeDef.gradeId,
          subject,
          topic_code: topic.code,
          topic_name: topic.name,
          sequence_order: tIdx + 1,
          assets_json: stableStringify(topic.assets || {}),
        });

        // Audio-manifest slice: first-class rows so #47/#50 resolve SFX and
        // narration WPM/SSML from the pack without parsing the whole asset
        // contract. Paths are lazy references — no audio bytes in packs.
        const sfx = topic.assets?.sounds ?? {};
        const feedback = sfx.feedbackSounds ?? {};
        sounds.push({
          topic_id: topicId,
          sound_pack_id: sfx.soundPackId ?? null,
          primary_sfx: sfx.primarySfx ?? null,
          on_interact: feedback.onInteract ?? null,
          on_correct: feedback.onCorrect ?? null,
          on_gentle_retry: feedback.onGentleRetry ?? null,
          on_streak_combo: feedback.onStreakCombo ?? null,
          on_speed_target_beat: feedback.onSpeedTargetBeat ?? null,
        });
        narration.push({
          topic_id: topicId,
          narration_json: stableStringify(topic.assets?.voiceNarration ?? {}),
        });

        // Same generation, id scheme, and difficulty tiers as the server seed.
        const problems = generateTopicPracticeSet(unit, topic, QUESTIONS_PER_TOPIC);
        problems.forEach((p, pIdx) => {
          questions.push({
            question_id: `${topicId}-Q${pIdx + 1}`,
            topic_id: topicId,
            unit_id: unit.unitId,
            topic_code: topic.code,
            topic_name: topic.name,
            difficulty_level: pIdx < 3 ? 1 : pIdx < 7 ? 2 : 3,
            interaction_type: p.interactionType || "multiple-choice",
            prompt: p.prompt,
            visual_aid_svg: p.visualAid || "assets/images/ten_frame_and_number_line.svg",
            visual_objects: p.visualObjects || null,
            target_count: p.targetCount ?? null,
            max_counter_cells: p.maxCounterCells ?? null,
            counter_emoji: p.counterEmoji ?? null,
            tile_bank_json: p.tileBank ? stableStringify(p.tileBank) : null,
            choices_json: stableStringify(p.choices || []),
            correct_answer: String(p.correctAnswer),
            misconception_tags_json: stableStringify(p.misconceptionTags || []),
            explanation: p.explanation || "",
          });
        });
      });
    }
  }

  units.sort(
    (a, b) =>
      a.subject !== b.subject
        ? a.subject.localeCompare(b.subject)
        : a.sequence_order - b.sequence_order || a.unit_id.localeCompare(b.unit_id),
  );
  topics.sort((a, b) => a.topic_id.localeCompare(b.topic_id));
  questions.sort((a, b) => a.question_id.localeCompare(b.question_id));
  sounds.sort((a, b) => a.topic_id.localeCompare(b.topic_id));
  narration.sort((a, b) => a.topic_id.localeCompare(b.topic_id));

  const sr = gradeDef.spacedRepetitionPolicy;
  const grade = {
    grade_id: gradeDef.gradeId,
    grade_name: gradeDef.gradeName,
    target_age_years: String(gradeDef.targetAgeYears),
    sequence_order: registry.grades.findIndex((g) => g.gradeId === gradeId) + 1,
    sr_growth_factor: sr.stabilityGrowthFactor,
    sr_max_interval_days: sr.maxIntervalCapDays,
    sr_schedule_json: stableStringify(sr.baseScheduleDays),
  };

  return {
    grade,
    units,
    topics,
    questions,
    sounds,
    narration,
    counts: { unitCount: units.length, topicCount: topics.length, questionCount: questions.length },
  };
}
