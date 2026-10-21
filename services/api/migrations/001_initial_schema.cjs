// V1 — initial PostgreSQL schema, ported verbatim from the SQLite schema
// (services/api/migrations/001_schema.sql, which remains the on-device
// SQLite reference per roadmap D2). Dialect changes: AUTOINCREMENT becomes
// GENERATED ALWAYS AS IDENTITY; everything else (TEXT/INTEGER/REAL columns,
// composite primary keys, ON DELETE CASCADE) is portable as-is.

exports.up = (pgm) => {
  pgm.createTable("grades", {
    grade_id: { type: "text", notNull: true, primaryKey: true },
    grade_name: { type: "text", notNull: true },
    target_age_years: { type: "text", notNull: true },
    sequence_order: { type: "integer", notNull: true },
    sr_growth_factor: { type: "real", notNull: true },
    sr_max_interval_days: { type: "integer", notNull: true },
    sr_schedule_json: { type: "text", notNull: true }
  }, { ifNotExists: true });

  pgm.createTable("units", {
    unit_id: { type: "text", notNull: true, primaryKey: true },
    grade_id: { type: "text", notNull: true, references: "grades(grade_id)" },
    subject: { type: "text", notNull: true },
    sequence_order: { type: "integer", notNull: true },
    title: { type: "text", notNull: true },
    prerequisite_unit_ids_json: { type: "text", notNull: true },
    gate_question_count: { type: "integer", notNull: true },
    gate_min_accuracy_pct: { type: "real", notNull: true },
    gate_max_speed_sec: { type: "real", notNull: true },
    gate_streak_req: { type: "integer", notNull: true },
    study_materials_json: { type: "text", notNull: true },
    games_json: { type: "text", notNull: true }
  }, { ifNotExists: true });
  pgm.createIndex("units", ["grade_id", "subject", "sequence_order"], { ifNotExists: true, name: "idx_units_grade_subject" });

  pgm.createTable("skill_topics", {
    topic_id: { type: "text", notNull: true, primaryKey: true },
    unit_id: { type: "text", notNull: true, references: "units(unit_id)" },
    grade_id: { type: "text", notNull: true, references: "grades(grade_id)" },
    subject: { type: "text", notNull: true },
    topic_code: { type: "text", notNull: true },
    topic_name: { type: "text", notNull: true },
    sequence_order: { type: "integer", notNull: true },
    assets_json: { type: "text", notNull: true }
  }, { ifNotExists: true });
  pgm.createIndex("skill_topics", ["unit_id", "sequence_order"], { ifNotExists: true, name: "idx_skill_topics_unit" });

  pgm.createTable("practice_questions", {
    question_id: { type: "text", notNull: true, primaryKey: true },
    topic_id: { type: "text", notNull: true, references: "skill_topics(topic_id)" },
    unit_id: { type: "text", notNull: true, references: "units(unit_id)" },
    topic_code: { type: "text", notNull: true },
    topic_name: { type: "text", notNull: true },
    difficulty_level: { type: "integer", notNull: true, default: 1 },
    interaction_type: { type: "text", notNull: true },
    prompt: { type: "text", notNull: true },
    visual_aid_svg: { type: "text", notNull: true },
    visual_objects: { type: "text" },
    target_count: { type: "integer" },
    max_counter_cells: { type: "integer" },
    counter_emoji: { type: "text" },
    tile_bank_json: { type: "text" },
    choices_json: { type: "text", notNull: true },
    correct_answer: { type: "text", notNull: true },
    misconception_tags_json: { type: "text", notNull: true },
    explanation: { type: "text", notNull: true }
  }, { ifNotExists: true });
  pgm.createIndex("practice_questions", ["topic_id"], { ifNotExists: true, name: "idx_practice_questions_topic" });
  pgm.createIndex("practice_questions", ["unit_id"], { ifNotExists: true, name: "idx_practice_questions_unit" });

  pgm.createTable("students", {
    student_id: { type: "text", notNull: true, primaryKey: true },
    username: { type: "text", notNull: true, unique: true },
    pin_hash: { type: "text", notNull: true },
    nickname: { type: "text", notNull: true },
    avatar: { type: "text", notNull: true },
    age_years: { type: "integer", notNull: true },
    current_grade: { type: "text", notNull: true, references: "grades(grade_id)" },
    motor_baseline_sec: { type: "real", notNull: true, default: 0.42 },
    streak_days: { type: "integer", notNull: true, default: 1 },
    star_coins: { type: "integer", notNull: true, default: 50 },
    hearts: { type: "integer", notNull: true, default: 5 },
    last_active_at: { type: "text", notNull: true },
    created_at: { type: "text", notNull: true }
  }, { ifNotExists: true });

  pgm.createTable("student_sessions", {
    token: { type: "text", notNull: true, primaryKey: true },
    student_id: { type: "text", notNull: true, references: "students(student_id)", onDelete: "cascade" },
    created_at: { type: "text", notNull: true },
    expires_at: { type: "text", notNull: true }
  }, { ifNotExists: true });
  pgm.createIndex("student_sessions", ["student_id"], { ifNotExists: true, name: "idx_student_sessions_student" });

  pgm.createTable("student_unit_progress", {
    student_id: { type: "text", notNull: true, references: "students(student_id)", onDelete: "cascade" },
    unit_id: { type: "text", notNull: true, references: "units(unit_id)" },
    status: { type: "text", notNull: true },
    key_state: { type: "text" },
    best_accuracy_pct: { type: "real", notNull: true, default: 0 },
    best_median_speed_sec: { type: "real", notNull: true, default: 0 },
    attempts_count: { type: "integer", notNull: true, default: 0 },
    stability_days: { type: "real", notNull: true, default: 1.0 },
    last_reviewed_at: { type: "text", notNull: true },
    cpa_stage: { type: "text", notNull: true, default: "CONCRETE_INTERACTIVE" },
    updated_at: { type: "text", notNull: true }
  }, { ifNotExists: true });
  pgm.addConstraint("student_unit_progress", "student_unit_progress_pk", "PRIMARY KEY (student_id, unit_id)");

  pgm.createTable("student_topic_progress", {
    student_id: { type: "text", notNull: true, references: "students(student_id)", onDelete: "cascade" },
    topic_id: { type: "text", notNull: true, references: "skill_topics(topic_id)" },
    unit_id: { type: "text", notNull: true, references: "units(unit_id)" },
    topic_code: { type: "text", notNull: true },
    completed: { type: "integer", notNull: true, default: 0 },
    crowns: { type: "integer", notNull: true, default: 0 },
    mastery_score: { type: "integer", notNull: true, default: 0 },
    best_accuracy_pct: { type: "real", notNull: true, default: 0 },
    best_median_speed_sec: { type: "real", notNull: true, default: 0 },
    attempts_count: { type: "integer", notNull: true, default: 0 },
    fluency_grade: { type: "integer", notNull: true, default: 3 },
    stability_days: { type: "real", notNull: true, default: 1.0 },
    next_review_at: { type: "text", notNull: true },
    last_reviewed_at: { type: "text", notNull: true }
  }, { ifNotExists: true });
  pgm.addConstraint("student_topic_progress", "student_topic_progress_pk", "PRIMARY KEY (student_id, topic_id)");
  pgm.createIndex("student_topic_progress", ["student_id", "unit_id"], { ifNotExists: true, name: "idx_student_topic_unit" });

  pgm.createTable("student_question_attempts", {
    attempt_id: { type: "bigint", notNull: true, primaryKey: true },
    student_id: { type: "text", notNull: true, references: "students(student_id)", onDelete: "cascade" },
    session_type: { type: "text", notNull: true },
    unit_id: { type: "text", notNull: true, references: "units(unit_id)" },
    topic_id: { type: "text", notNull: true, references: "skill_topics(topic_id)" },
    question_id: { type: "text", notNull: true },
    chosen_answer: { type: "text", notNull: true },
    is_correct: { type: "integer", notNull: true },
    raw_time_sec: { type: "real", notNull: true },
    cognitive_time_sec: { type: "real", notNull: true },
    fluency_grade: { type: "integer", notNull: true },
    misconception_tags_json: { type: "text", notNull: true },
    attempted_at: { type: "text", notNull: true }
  }, { ifNotExists: true });
  // Postgres replacement for SQLite AUTOINCREMENT.
  pgm.sql(`ALTER TABLE student_question_attempts ALTER COLUMN attempt_id ADD GENERATED ALWAYS AS IDENTITY;`);
  pgm.createIndex("student_question_attempts", ["student_id", "attempted_at"], { ifNotExists: true, name: "idx_attempts_student" });
};

exports.down = (pgm) => {
  pgm.dropTable("student_question_attempts", { ifExists: true });
  pgm.dropTable("student_topic_progress", { ifExists: true });
  pgm.dropTable("student_unit_progress", { ifExists: true });
  pgm.dropTable("student_sessions", { ifExists: true });
  pgm.dropTable("students", { ifExists: true });
  pgm.dropTable("practice_questions", { ifExists: true });
  pgm.dropTable("skill_topics", { ifExists: true });
  pgm.dropTable("units", { ifExists: true });
  pgm.dropTable("grades", { ifExists: true });
};
