/**
 * Adapter-parity tripwire (issue #47, tester pass).
 *
 * Every offline test runs against tests/helpers/practiceEnv.ts, whose
 * SQL mirrors src/practice/nativePractice.ts. If the two adapters
 * drift (different column lists, ORDER BY, LIMIT, WHERE), the offline
 * test suite proves the wrong thing. This file asserts the SQL shapes
 * are identical between production and test adapters.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const native = fs
  .readFileSync(path.join(__dirname, "..", "src", "practice", "nativePractice.ts"), "utf8")
  .replace(/\s+/g, " ");
const helper = fs
  .readFileSync(path.join(__dirname, "helpers", "practiceEnv.ts"), "utf8")
  .replace(/\s+/g, " ");

/** Both files must contain these exact (whitespace-normalized) queries. */
const SHARED_QUERY_FRAGMENTS = [
  "FROM practice_questions WHERE topic_id = ? ORDER BY difficulty_level ASC, question_id ASC LIMIT ?",
  "FROM practice_questions WHERE unit_id = ? ORDER BY question_id ASC",
  "FROM skill_topics WHERE unit_id = ? ORDER BY sequence_order ASC",
  "SELECT COUNT(*) AS cnt FROM attempt_log WHERE student_id = ? AND synced = 0",
  "ORDER BY installed_at DESC LIMIT 1",
];

describe("pack reader SQL parity: production adapter == test adapter", () => {
  for (const fragment of SHARED_QUERY_FRAGMENTS) {
    it(`both adapters contain: ...${fragment.slice(0, 60)}`, () => {
      expect(native).toContain(fragment);
      expect(helper).toContain(fragment);
    });
  }

  it("questionsForTopic/questionsForUnit select the same 18 render columns in both", () => {
    const columns =
      "question_id, topic_id, unit_id, topic_code, topic_name, difficulty_level, interaction_type, prompt, visual_aid_svg, visual_objects, target_count, max_counter_cells, counter_emoji, tile_bank_json, choices_json, correct_answer, misconception_tags_json, explanation";
    expect(native).toContain(columns);
    expect(helper).toContain(columns);
  });

  it("grades policy query selects the same SR columns in both", () => {
    const columns =
      "sr_growth_factor, sr_max_interval_days, sr_schedule_json FROM grades WHERE grade_id = ?";
    expect(native).toContain(columns);
    expect(helper).toContain(columns);
  });
});

describe("storage SQL parity", () => {
  it("attempt_log INSERT uses the identical 16-column list in both adapters", () => {
    const extractColumns = (source: string): string => {
      const match = source.match(/INSERT INTO attempt_log \( ([^)]+) \) VALUES/);
      expect(match).not.toBeNull();
      return (match as RegExpMatchArray)[1]!.replace(/\s+/g, "");
    };
    expect(extractColumns(helper)).toBe(extractColumns(native));
  });

  it("topic_progress upsert conflicts on (student_id, topic_id) in both", () => {
    expect(native).toContain("ON CONFLICT(student_id, topic_id) DO UPDATE SET");
    expect(helper).toContain("ON CONFLICT(student_id, topic_id) DO UPDATE SET");
  });

  it("unit_progress upsert conflicts on (student_id, unit_id) in both", () => {
    expect(native).toContain("ON CONFLICT(student_id, unit_id) DO UPDATE SET");
    expect(helper).toContain("ON CONFLICT(student_id, unit_id) DO UPDATE SET");
  });

  it("sync drain reads the identical 18-column ordered window in both", () => {
    const columns =
      "SELECT id, student_id, topic_id, question_id, interaction_type, is_correct, cognitive_time_sec, audio_duration_sec, answered_at, synced, unit_id, session_type, session_id, raw_time_sec, fluency_grade, misconception_tags_json, chosen_answer, motor_baseline_sec FROM attempt_log WHERE student_id = ? AND synced = 0 ORDER BY id ASC LIMIT ?";
    expect(native).toContain(columns);
    expect(helper).toContain(columns);
  });

  it("the synced-flag flip is byte-identical in both (the ONLY attempt_log mutation)", () => {
    const flip =
      "UPDATE attempt_log SET synced = 1 WHERE student_id = ? AND id <= ? AND synced = 0";
    expect(native).toContain(flip);
    expect(helper).toContain(flip);
  });
});
