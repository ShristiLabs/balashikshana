import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateTopicPracticeSet } from "../../packages/core-engine/src/index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../..");
const DATA_DIR = path.join(__dirname, "data");
const DB_PATH = process.env.SQLITE_DB_PATH || path.join(DATA_DIR, "balashikshana.sqlite");
const SCHEMA_PATH = path.join(__dirname, "migrations/001_schema.sql");
const REGISTRY_PATH = path.join(ROOT_DIR, "docs/us-curriculum-registry.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// PIN hashing.
//
// Current scheme: scrypt (node:crypto) with per-row random salt.
// Parameters follow the OWASP cheat-sheet recommendation for interactive
// logins: N=16384 (CPU/memory cost), r=8 (block size), p=1
// (parallelization), keylen=64 bytes. Stored format:
//   scrypt$<N>$<r>$<p>$<salt hex>$<key hex>
//
// Legacy scheme (pre-hardening rows): unsalted SHA-256 of
// "balashikshana:<pin>". Legacy rows are transparently rehashed with
// scrypt on the next successful login (rehash-on-login migration).
export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

function scryptKey(pin, salt, params) {
  return crypto.scryptSync(String(pin).trim(), salt, params.keylen, {
    N: params.N,
    r: params.r,
    p: params.p
  });
}

export function hashPinScrypt(pin) {
  const params = SCRYPT_PARAMS;
  const salt = crypto.randomBytes(16);
  const key = scryptKey(pin, salt, params);
  return ["scrypt", params.N, params.r, params.p, salt.toString("hex"), key.toString("hex")].join("$");
}

function legacyHashPin(pin) {
  return crypto.createHash("sha256").update(`balashikshana:${String(pin).trim()}`).digest("hex");
}

function isLegacyPinHash(stored) {
  return typeof stored === "string" && /^[0-9a-f]{64}$/.test(stored);
}

function constantTimeEquals(a, b) {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// Verifies a PIN against a stored hash. Returns true only on exact match.
export function verifyPin(pin, stored) {
  if (!stored) return false;
  if (isLegacyPinHash(stored)) {
    return constantTimeEquals(legacyHashPin(pin), stored);
  }
  const parts = String(stored).split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const key = scryptKey(pin, Buffer.from(parts[4], "hex"), {
    N: Number(parts[1]),
    r: Number(parts[2]),
    p: Number(parts[3]),
    keylen: parts[5].length / 2
  });
  return constantTimeEquals(key.toString("hex"), parts[5]);
}

export function isLegacyStoredPin(stored) {
  return isLegacyPinHash(stored);
}

export function createSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function initDatabase() {
  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA foreign_keys = ON;");

  const schemaSql = fs.readFileSync(SCHEMA_PATH, "utf8");
  db.exec(schemaSql);

  const countRow = db.prepare("SELECT COUNT(*) AS cnt FROM practice_questions").get();
  if (!countRow || countRow.cnt < 6000) {
    seedCurriculumAndQuestions(db);
  }

  const stuRow = db.prepare("SELECT COUNT(*) AS cnt FROM students").get();
  if (!stuRow || stuRow.cnt === 0) {
    seedDefaultStudents(db);
  }

  // One-time invalidation of pre-hardening sessions: tokens issued before
  // this change were never validated by any code path and use the old
  // 48-hex-char format. New tokens are 43-char base64url, so this delete
  // only ever matches legacy rows (the first boot after upgrade removes
  // them all; subsequent boots match nothing).
  db.prepare(
    "DELETE FROM student_sessions WHERE LENGTH(token) = 48 AND token GLOB '[0-9a-f][0-9a-f][0-9a-f]*'"
  ).run();

  return db;
}

function seedCurriculumAndQuestions(db) {
  console.log("[DB] Seeding grades, 130 units, 614 skill topics, and 6,140 practice questions into SQLite...");
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));

  const insertGrade = db.prepare(`
    INSERT OR REPLACE INTO grades (
      grade_id, grade_name, target_age_years, sequence_order,
      sr_growth_factor, sr_max_interval_days, sr_schedule_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertUnit = db.prepare(`
    INSERT OR REPLACE INTO units (
      unit_id, grade_id, subject, sequence_order, title,
      prerequisite_unit_ids_json, gate_question_count, gate_min_accuracy_pct,
      gate_max_speed_sec, gate_streak_req, study_materials_json, games_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertTopic = db.prepare(`
    INSERT OR REPLACE INTO skill_topics (
      topic_id, unit_id, grade_id, subject, topic_code, topic_name, sequence_order, assets_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertQuestion = db.prepare(`
    INSERT OR REPLACE INTO practice_questions (
      question_id, topic_id, unit_id, topic_code, topic_name,
      difficulty_level, interaction_type, prompt, visual_aid_svg,
      visual_objects, target_count, max_counter_cells, counter_emoji,
      tile_bank_json, choices_json, correct_answer, misconception_tags_json, explanation
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec("BEGIN TRANSACTION;");
  try {
    let totalQuestions = 0;
    registry.grades.forEach((g, gIdx) => {
      const sr = g.spacedRepetitionPolicy;
      insertGrade.run(
        g.gradeId,
        g.gradeName,
        g.targetAgeYears,
        gIdx + 1,
        sr.stabilityGrowthFactor,
        sr.maxIntervalCapDays,
        JSON.stringify(sr.baseScheduleDays)
      );

      for (const [subjKey, subj] of Object.entries(g.subjects)) {
        for (const u of subj.units) {
          const gate = u.masteryGate;
          insertUnit.run(
            u.unitId,
            g.gradeId,
            subjKey,
            u.sequenceOrder,
            u.title,
            JSON.stringify(u.prerequisiteUnitIds || []),
            gate.questionCount,
            gate.minAccuracyPercent,
            gate.maxMedianResponseTimeSec,
            gate.challengeZoneStreak || 4,
            JSON.stringify(u.studyMaterials || []),
            JSON.stringify(u.games || [])
          );

          u.skillTopics.forEach((t, tIdx) => {
            const topicId = `${u.unitId}-${t.code}`;
            insertTopic.run(
              topicId,
              u.unitId,
              g.gradeId,
              subjKey,
              t.code,
              t.name,
              tIdx + 1,
              JSON.stringify(t.assets || {})
            );

            // Generate 10 distinct practice questions per topic and persist in DB
            const problems = generateTopicPracticeSet(u, t, 10);
            problems.forEach((p, pIdx) => {
              const qId = `${topicId}-Q${pIdx + 1}`;
              const diffLevel = pIdx < 3 ? 1 : pIdx < 7 ? 2 : 3;
              insertQuestion.run(
                qId,
                topicId,
                u.unitId,
                t.code,
                t.name,
                diffLevel,
                p.interactionType || "multiple-choice",
                p.prompt,
                p.visualAid || "assets/images/ten_frame_and_number_line.svg",
                p.visualObjects || null,
                p.targetCount ?? null,
                p.maxCounterCells ?? null,
                p.counterEmoji ?? null,
                p.tileBank ? JSON.stringify(p.tileBank) : null,
                JSON.stringify(p.choices || []),
                String(p.correctAnswer),
                JSON.stringify(p.misconceptionTags || []),
                p.explanation || ""
              );
              totalQuestions += 1;
            });
          });
        }
      }
    });
    db.exec("COMMIT;");
    console.log(`[DB] Seeded ${totalQuestions} practice questions across 614 skill topics.`);
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
}

function seedDefaultStudents(db) {
  const now = new Date().toISOString();
  const insertStudent = db.prepare(`
    INSERT OR IGNORE INTO students (
      student_id, username, pin_hash, nickname, avatar, age_years,
      current_grade, motor_baseline_sec, streak_days, star_coins, hearts,
      last_active_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertUnitProg = db.prepare(`
    INSERT OR REPLACE INTO student_unit_progress (
      student_id, unit_id, status, key_state, best_accuracy_pct,
      best_median_speed_sec, attempts_count, stability_days,
      last_reviewed_at, cpa_stage, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertTopicProg = db.prepare(`
    INSERT OR REPLACE INTO student_topic_progress (
      student_id, topic_id, unit_id, topic_code, completed, crowns,
      mastery_score, best_accuracy_pct, best_median_speed_sec,
      attempts_count, fluency_grade, stability_days, next_review_at, last_reviewed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  db.exec("BEGIN TRANSACTION;");
  try {
    // Demo accounts get individually generated random PINs (there is no
    // shared default PIN anywhere). The generated PINs are printed once at
    // seed time so a local developer can log in; check the API log.
    const seedPins = {};
    for (const username of ["aarav", "maya", "liam"]) {
      seedPins[username] = String(Math.floor(1000 + Math.random() * 9000));
    }
    insertStudent.run("stu-aarav-k", "aarav", hashPinScrypt(seedPins.aarav), "Aarav", "🦁", 5, "kindergarten", 0.42, 7, 340, 5, now, now);
    insertStudent.run("stu-maya-pk", "maya", hashPinScrypt(seedPins.maya), "Maya", "🦊", 4, "pre-k", 0.55, 4, 140, 5, now, now);
    insertStudent.run("stu-liam-g2", "liam", hashPinScrypt(seedPins.liam), "Liam", "🚀", 8, "grade-2", 0.31, 12, 590, 5, now, now);

    // Seed Aarav's initial Kindergarten progress
    insertUnitProg.run("stu-aarav-k", "PK-M7", "MASTERED", "GOLD_KEY", 93.0, 4.5, 1, 21.0, now, "PURE_ABSTRACT_SYMBOLIC", now);
    insertUnitProg.run("stu-aarav-k", "K-M1", "MASTERED", "GOLD_KEY", 93.3, 3.4, 2, 8.0, now, "PICTORIAL_GHOST_FLASH_1S", now);
    insertUnitProg.run("stu-aarav-k", "K-M2", "IN_PROGRESS", null, 90.0, 4.1, 1, 3.0, now, "PICTORIAL_STATIC", now);

    for (const code of ["A", "B", "C", "D", "E", "F", "AAA"]) {
      insertTopicProg.run("stu-aarav-k", `K-M1-${code}`, "K-M1", code, 1, 3, 95, 95.0, 3.4, 1, 4, 8.0, now, now);
    }
    insertTopicProg.run("stu-aarav-k", "K-M2-G", "K-M2", "G", 1, 3, 92, 92.0, 3.8, 1, 3, 4.0, now, now);
    insertTopicProg.run("stu-aarav-k", "K-M2-H", "K-M2", "H", 1, 2, 88, 88.0, 4.2, 1, 3, 3.0, now, now);

    // Seed Maya's initial Pre-K progress
    insertTopicProg.run("stu-maya-pk", "PK-M1-A", "PK-M1", "A", 1, 3, 100, 100.0, 3.8, 1, 4, 4.0, now, now);
    insertTopicProg.run("stu-maya-pk", "PK-M1-B", "PK-M1", "B", 1, 3, 90, 90.0, 4.2, 1, 3, 4.0, now, now);

    // Seed Liam's initial Grade 2 progress
    insertUnitProg.run("stu-liam-g2", "G1-M9", "MASTERED", "GOLD_KEY", 95.0, 4.0, 1, 30.0, now, "PURE_ABSTRACT_SYMBOLIC", now);
    insertTopicProg.run("stu-liam-g2", "G2-M1-A", "G2-M1", "A", 1, 3, 95, 95.0, 3.5, 1, 4, 7.0, now, now);
    insertTopicProg.run("stu-liam-g2", "G2-M1-B", "G2-M1", "B", 1, 3, 92, 92.0, 3.9, 1, 3, 7.0, now, now);

    db.exec("COMMIT;");
    console.log(
      `[DB] Demo students seeded with one-time random PINs: aarav=${seedPins.aarav} maya=${seedPins.maya} liam=${seedPins.liam} (also stored in the API log)`
    );
  } catch (err) {
    db.exec("ROLLBACK;");
    throw err;
  }
}
