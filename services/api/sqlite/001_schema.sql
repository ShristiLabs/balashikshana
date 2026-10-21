-- Balashikshana Relational Database Schema (SQLite / PostgreSQL compatible)
-- Stores curriculum DAG, 614 skill topics, 6,140+ practice questions, multi-student accounts,
-- auth sessions, per-unit mastery gates, per-topic crowns/FSRS stability, and granular question telemetry.

CREATE TABLE IF NOT EXISTS grades (
  grade_id TEXT PRIMARY KEY,
  grade_name TEXT NOT NULL,
  target_age_years TEXT NOT NULL,
  sequence_order INTEGER NOT NULL,
  sr_growth_factor REAL NOT NULL,
  sr_max_interval_days INTEGER NOT NULL,
  sr_schedule_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS units (
  unit_id TEXT PRIMARY KEY,
  grade_id TEXT NOT NULL REFERENCES grades(grade_id),
  subject TEXT NOT NULL,
  sequence_order INTEGER NOT NULL,
  title TEXT NOT NULL,
  prerequisite_unit_ids_json TEXT NOT NULL,
  gate_question_count INTEGER NOT NULL,
  gate_min_accuracy_pct REAL NOT NULL,
  gate_max_speed_sec REAL NOT NULL,
  gate_streak_req INTEGER NOT NULL,
  study_materials_json TEXT NOT NULL,
  games_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_units_grade_subject ON units(grade_id, subject, sequence_order);

CREATE TABLE IF NOT EXISTS skill_topics (
  topic_id TEXT PRIMARY KEY,
  unit_id TEXT NOT NULL REFERENCES units(unit_id),
  grade_id TEXT NOT NULL REFERENCES grades(grade_id),
  subject TEXT NOT NULL,
  topic_code TEXT NOT NULL,
  topic_name TEXT NOT NULL,
  sequence_order INTEGER NOT NULL,
  assets_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_skill_topics_unit ON skill_topics(unit_id, sequence_order);

CREATE TABLE IF NOT EXISTS practice_questions (
  question_id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES skill_topics(topic_id),
  unit_id TEXT NOT NULL REFERENCES units(unit_id),
  topic_code TEXT NOT NULL,
  topic_name TEXT NOT NULL,
  difficulty_level INTEGER NOT NULL DEFAULT 1,
  interaction_type TEXT NOT NULL,
  prompt TEXT NOT NULL,
  visual_aid_svg TEXT NOT NULL,
  visual_objects TEXT,
  target_count INTEGER,
  max_counter_cells INTEGER,
  counter_emoji TEXT,
  tile_bank_json TEXT,
  choices_json TEXT NOT NULL,
  correct_answer TEXT NOT NULL,
  misconception_tags_json TEXT NOT NULL,
  explanation TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_practice_questions_topic ON practice_questions(topic_id);
CREATE INDEX IF NOT EXISTS idx_practice_questions_unit ON practice_questions(unit_id);

CREATE TABLE IF NOT EXISTS students (
  student_id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  pin_hash TEXT NOT NULL,
  nickname TEXT NOT NULL,
  avatar TEXT NOT NULL,
  age_years INTEGER NOT NULL,
  current_grade TEXT NOT NULL REFERENCES grades(grade_id),
  motor_baseline_sec REAL NOT NULL DEFAULT 0.42,
  streak_days INTEGER NOT NULL DEFAULT 1,
  star_coins INTEGER NOT NULL DEFAULT 50,
  hearts INTEGER NOT NULL DEFAULT 5,
  last_active_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS student_sessions (
  token TEXT PRIMARY KEY,
  student_id TEXT NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_student_sessions_student ON student_sessions(student_id);

CREATE TABLE IF NOT EXISTS student_unit_progress (
  student_id TEXT NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  unit_id TEXT NOT NULL REFERENCES units(unit_id),
  status TEXT NOT NULL,
  key_state TEXT,
  best_accuracy_pct REAL NOT NULL DEFAULT 0,
  best_median_speed_sec REAL NOT NULL DEFAULT 0,
  attempts_count INTEGER NOT NULL DEFAULT 0,
  stability_days REAL NOT NULL DEFAULT 1.0,
  last_reviewed_at TEXT NOT NULL,
  cpa_stage TEXT NOT NULL DEFAULT 'CONCRETE_INTERACTIVE',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (student_id, unit_id)
);

CREATE TABLE IF NOT EXISTS student_topic_progress (
  student_id TEXT NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL REFERENCES skill_topics(topic_id),
  unit_id TEXT NOT NULL REFERENCES units(unit_id),
  topic_code TEXT NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0,
  crowns INTEGER NOT NULL DEFAULT 0,
  mastery_score INTEGER NOT NULL DEFAULT 0,
  best_accuracy_pct REAL NOT NULL DEFAULT 0,
  best_median_speed_sec REAL NOT NULL DEFAULT 0,
  attempts_count INTEGER NOT NULL DEFAULT 0,
  fluency_grade INTEGER NOT NULL DEFAULT 3,
  stability_days REAL NOT NULL DEFAULT 1.0,
  next_review_at TEXT NOT NULL,
  last_reviewed_at TEXT NOT NULL,
  PRIMARY KEY (student_id, topic_id)
);

CREATE INDEX IF NOT EXISTS idx_student_topic_unit ON student_topic_progress(student_id, unit_id);

CREATE TABLE IF NOT EXISTS student_question_attempts (
  attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id TEXT NOT NULL REFERENCES students(student_id) ON DELETE CASCADE,
  session_type TEXT NOT NULL,
  unit_id TEXT NOT NULL REFERENCES units(unit_id),
  topic_id TEXT NOT NULL REFERENCES skill_topics(topic_id),
  question_id TEXT NOT NULL,
  chosen_answer TEXT NOT NULL,
  is_correct INTEGER NOT NULL,
  raw_time_sec REAL NOT NULL,
  cognitive_time_sec REAL NOT NULL,
  fluency_grade INTEGER NOT NULL,
  misconception_tags_json TEXT NOT NULL,
  attempted_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attempts_student ON student_question_attempts(student_id, attempted_at);
