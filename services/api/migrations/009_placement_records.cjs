// V9 — placement records (issue #60, roadmap E10).
//
// One row per (student, grade): the placement diagnostic's authoritative
// outcome, RECOMPUTED at sync-replay time by the same core-engine
// placement module the RN client runs (D8/D3 — identical attempt stream,
// identical recommendation, by construction). The row is a projection of
// the append-only PLACEMENT attempt stream (student_question_attempts
// rows with session_type 'PLACEMENT'), never a client-asserted fact:
// the client uploads attempts, the reconciler derives.
//
// What lands here: the recommended start unit, the credited-unit prefix
// per strand (capped by the engine's skip-ahead guardrail), item count,
// and the session id of the run that produced it. The DECISION the
// family made on the recommendation screen (accept recommended vs the
// gentler unit-1 start) is client-side journey state, deliberately NOT
// stored here — the record answers "what did placement find", not "what
// did the family choose".
//
// COPPA note: unit ids and counts only — no free text, no PII. CASCADE
// on student deletion: derived data, re-derivable from the attempt
// stream (007's doctrine), not consent evidence.
//
// `down` drops additively (nothing else references the table).

exports.up = (pgm) => {
  pgm.createTable("student_placement_records", {
    id: { type: "id", primaryKey: true },
    student_id: { type: "text", notNull: true, references: "students(student_id)", onDelete: "cascade" },
    grade_id: { type: "text", notNull: true },
    // The engine's recommended start unit (guardrails already applied).
    recommended_start_unit_id: { type: "text", notNull: true },
    // Credited prefix per strand: [{strand, unitIds[]}] (engine shape).
    credited_units_json: { type: "jsonb", notNull: true, default: "[]" },
    // Per-strand frontier report (confidence summary for support/parent views).
    per_strand_json: { type: "jsonb", notNull: true, default: "[]" },
    items_asked: { type: "integer", notNull: true, check: "items_asked >= 0" },
    // Latest PLACEMENT session that produced this outcome (audit join key).
    session_id: { type: "text", notNull: true },
    placed_at: { type: "timestamptz", notNull: true },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("now()") }
  });
  // One authoritative record per (student, grade): re-entry re-derives and
  // overwrites (first-grade-entry placement; mid-grade re-runs are #60 non-goals).
  pgm.addIndex("student_placement_records", ["student_id", "grade_id"], {
    ifNotExists: true,
    name: "uq_placement_student_grade",
    unique: true
  });
};

exports.down = (pgm) => {
  pgm.dropIndex("student_placement_records", "uq_placement_student_grade", { ifExists: true });
  pgm.dropTable("student_placement_records", { ifExists: true });
};
