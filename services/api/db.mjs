import { Pool } from "pg";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pgmigrate from "node-pg-migrate";
import { generateTopicPracticeSet } from "../../packages/core-engine/src/index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../..");
const REGISTRY_PATH = path.join(ROOT_DIR, "docs/us-curriculum-registry.json");

// Per roadmap D2 the SERVED datastore is PostgreSQL. The SQLite schema at
// migrations/001_schema.sql remains as the on-device (mobile client)
// reference and is not used by this server.
export const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://balashikshana:balashikshana_dev@localhost:5432/balashikshana_db";

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

// --- PostgreSQL access ------------------------------------------------------
// Thin async helpers over a pg Pool so route code stays close to the old
// prepare().get/all/run shape: get(sql, params) -> first row or undefined,
// all(...) -> rows, run(...) -> result.

export async function createDb(logger) {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 10 });

  // Idle pooled clients emit 'error' when the server terminates them
  // (restarts, failovers). Without a handler this is an uncaught
  // exception that kills the process.
  pool.on("error", (err) => {
    logger?.error?.({ err: err.message }, "Idle PostgreSQL client error");
  });

  try {
    await pool.query("SELECT 1");
  } catch (err) {
    await pool.end().catch(() => {});
    throw new Error(
      `Cannot connect to PostgreSQL at the configured DATABASE_URL (${err.message}). ` +
        "Start the database first, e.g. docker compose -f docker/docker-compose.yml up -d postgres."
    );
  }

  const db = {
    pool,
    async get(sql, params = []) {
      const result = await pool.query(sql, params);
      return result.rows[0];
    },
    async all(sql, params = []) {
      const result = await pool.query(sql, params);
      return result.rows;
    },
    async run(sql, params = []) {
      return pool.query(sql, params);
    },
    async withTransaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
    async end() {
      await pool.end();
    }
  };

  await runMigrations(pool, logger);
  await ensureSeeded(db, logger);

  return db;
}

export async function runMigrations(pool, logger) {
  await pgmigrate({
    databaseUrl: DATABASE_URL,
    migrationsTable: "pgmigrations",
    dir: path.join(__dirname, "migrations"),
    direction: "up",
    count: Infinity,
    log: (msg) => logger?.debug?.({ msg }) ?? undefined,
    verbose: false
  });
}

async function ensureSeeded(db, logger) {
  const countRow = await db.get("SELECT COUNT(*)::int AS cnt FROM practice_questions");
  if (!countRow || countRow.cnt < 6000) {
    await seedCurriculumAndQuestions(db, logger);
  }

  const stuRow = await db.get("SELECT COUNT(*)::int AS cnt FROM students");
  // SEED_DEMO_STUDENTS=0 skips the demo students (issue #41): they are dev
  // data with no consent records by design, and the consent-invariant suite
  // boots on a pristine DB so it can prove no route creates unconsented
  // child data. Default stays on for the local dev harness.
  const seedDemoStudents = String(process.env.SEED_DEMO_STUDENTS ?? "1") !== "0";
  if (seedDemoStudents && (!stuRow || stuRow.cnt === 0)) {
    await seedDefaultStudents(db, logger);
  }

  // One-time invalidation of pre-hardening sessions: tokens issued before
  // the #28 hardening were never validated by any code path and use the old
  // 48-hex-char format. New tokens are 43-char base64url, so this delete
  // only ever matches legacy rows.
  await db.run(
    "DELETE FROM student_sessions WHERE LENGTH(token) = 48 AND token ~ '^[0-9a-f]{3}'"
  );
}

async function seedCurriculumAndQuestions(db, logger) {
  logger?.info?.({ msg: "Seeding grades, 130 units, 614 skill topics, and 6,140 practice questions into PostgreSQL..." });
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf8"));

  const grades = [];
  const units = [];
  const topics = [];
  const questions = [];

  registry.grades.forEach((g, gIdx) => {
    const sr = g.spacedRepetitionPolicy;
    grades.push([
      g.gradeId,
      g.gradeName,
      String(g.targetAgeYears),
      gIdx + 1,
      sr.stabilityGrowthFactor,
      sr.maxIntervalCapDays,
      JSON.stringify(sr.baseScheduleDays)
    ]);

    for (const [subjKey, subj] of Object.entries(g.subjects)) {
      for (const u of subj.units) {
        const gate = u.masteryGate;
        units.push([
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
        ]);

        u.skillTopics.forEach((t, tIdx) => {
          const topicId = `${u.unitId}-${t.code}`;
          topics.push([
            topicId,
            u.unitId,
            g.gradeId,
            subjKey,
            t.code,
            t.name,
            tIdx + 1,
            JSON.stringify(t.assets || {})
          ]);

          const problems = generateTopicPracticeSet(u, t, 10);
          problems.forEach((p, pIdx) => {
            const qId = `${topicId}-Q${pIdx + 1}`;
            const diffLevel = pIdx < 3 ? 1 : pIdx < 7 ? 2 : 3;
            questions.push([
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
            ]);
          });
        });
      }
    }
  });

  await db.withTransaction(async (client) => {
    await insertBatches(client, "grades",
      ["grade_id", "grade_name", "target_age_years", "sequence_order", "sr_growth_factor", "sr_max_interval_days", "sr_schedule_json"],
      "ON CONFLICT (grade_id) DO UPDATE SET grade_name = EXCLUDED.grade_name, sr_growth_factor = EXCLUDED.sr_growth_factor, sr_max_interval_days = EXCLUDED.sr_max_interval_days, sr_schedule_json = EXCLUDED.sr_schedule_json",
      grades);
    await insertBatches(client, "units",
      ["unit_id", "grade_id", "subject", "sequence_order", "title", "prerequisite_unit_ids_json", "gate_question_count", "gate_min_accuracy_pct", "gate_max_speed_sec", "gate_streak_req", "study_materials_json", "games_json"],
      "ON CONFLICT (unit_id) DO UPDATE SET title = EXCLUDED.title, prerequisite_unit_ids_json = EXCLUDED.prerequisite_unit_ids_json, gate_question_count = EXCLUDED.gate_question_count, gate_min_accuracy_pct = EXCLUDED.gate_min_accuracy_pct, gate_max_speed_sec = EXCLUDED.gate_max_speed_sec, gate_streak_req = EXCLUDED.gate_streak_req",
      units);
    await insertBatches(client, "skill_topics",
      ["topic_id", "unit_id", "grade_id", "subject", "topic_code", "topic_name", "sequence_order", "assets_json"],
      "ON CONFLICT (topic_id) DO UPDATE SET topic_name = EXCLUDED.topic_name, assets_json = EXCLUDED.assets_json",
      topics);
    await insertBatches(client, "practice_questions",
      ["question_id", "topic_id", "unit_id", "topic_code", "topic_name", "difficulty_level", "interaction_type", "prompt", "visual_aid_svg", "visual_objects", "target_count", "max_counter_cells", "counter_emoji", "tile_bank_json", "choices_json", "correct_answer", "misconception_tags_json", "explanation"],
      "ON CONFLICT (question_id) DO NOTHING",
      questions);
  });

  logger?.info?.({ msg: `Seeded ${questions.length} practice questions across ${topics.length} skill topics.` });
}

async function insertBatches(client, table, columns, conflictClause, rows, batchSize = 400) {
  // Multi-row VALUES expansion in batches keeps the 6,140-question seed to
  // seconds while staying inside Postgres' 65535 parameter limit.
  const columnCount = columns.length;
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const tuples = [];
    const params = [];
    batch.forEach((row, rIdx) => {
      const placeholders = [];
      for (let cIdx = 0; cIdx < columnCount; cIdx++) {
        placeholders.push(`$${rIdx * columnCount + cIdx + 1}`);
        params.push(row[cIdx]);
      }
      tuples.push(`(${placeholders.join(",")})`);
    });
    const sql = `INSERT INTO ${table} (${columns.join(",")}) VALUES ${tuples.join(",")} ${conflictClause}`;
    await client.query(sql, params);
  }
}

async function seedDefaultStudents(db, logger) {
  const now = new Date().toISOString();

  // Demo accounts get individually generated random PINs (there is no
  // shared default PIN anywhere). The generated PINs are printed once at
  // seed time so a local developer can log in; check the API log.
  const seedPins = {};
  for (const username of ["aarav", "maya", "liam"]) {
    seedPins[username] = String(Math.floor(1000 + Math.random() * 9000));
  }

  await db.withTransaction(async (client) => {
    // Demo students are standalone dev data: they carry status 'legacy' so
    // they sit in the claim-eligible population on fresh databases too
    // (migration 005's back-fill only flags rows that exist at migrate
    // time; a fresh boot seeds after migrating and would otherwise default
    // them to 'active', making them unclaimable).
    const insertStudent = `INSERT INTO students (
      student_id, username, pin_hash, nickname, avatar, age_years,
      current_grade, motor_baseline_sec, streak_days, star_coins, hearts,
      last_active_at, created_at, status
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'legacy') ON CONFLICT (student_id) DO NOTHING`;

    await client.query(insertStudent, ["stu-aarav-k", "aarav", hashPinScrypt(seedPins.aarav), "Aarav", "\u{1F981}", 5, "kindergarten", 0.42, 7, 340, 5, now, now]);
    await client.query(insertStudent, ["stu-maya-pk", "maya", hashPinScrypt(seedPins.maya), "Maya", "\u{1F98A}", 4, "pre-k", 0.55, 4, 140, 5, now, now]);
    await client.query(insertStudent, ["stu-liam-g2", "liam", hashPinScrypt(seedPins.liam), "Liam", "\u{1F680}", 8, "grade-2", 0.31, 12, 590, 5, now, now]);

    const insertUnitProg = `INSERT INTO student_unit_progress (
      student_id, unit_id, status, key_state, best_accuracy_pct,
      best_median_speed_sec, attempts_count, stability_days,
      last_reviewed_at, cpa_stage, updated_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (student_id, unit_id) DO NOTHING`;

    await client.query(insertUnitProg, ["stu-aarav-k", "PK-M7", "MASTERED", "GOLD_KEY", 93.0, 4.5, 1, 21.0, now, "PURE_ABSTRACT_SYMBOLIC", now]);
    await client.query(insertUnitProg, ["stu-aarav-k", "K-M1", "MASTERED", "GOLD_KEY", 93.3, 3.4, 2, 8.0, now, "PICTORIAL_GHOST_FLASH_1S", now]);
    await client.query(insertUnitProg, ["stu-aarav-k", "K-M2", "IN_PROGRESS", null, 90.0, 4.1, 1, 3.0, now, "PICTORIAL_STATIC", now]);

    const insertTopicProg = `INSERT INTO student_topic_progress (
      student_id, topic_id, unit_id, topic_code, completed, crowns,
      mastery_score, best_accuracy_pct, best_median_speed_sec,
      attempts_count, fluency_grade, stability_days, next_review_at, last_reviewed_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT (student_id, topic_id) DO NOTHING`;

    for (const code of ["A", "B", "C", "D", "E", "F", "AAA"]) {
      await client.query(insertTopicProg, ["stu-aarav-k", `K-M1-${code}`, "K-M1", code, 1, 3, 95, 95.0, 3.4, 1, 4, 8.0, now, now]);
    }
    await client.query(insertTopicProg, ["stu-aarav-k", "K-M2-G", "K-M2", "G", 1, 3, 92, 92.0, 3.8, 1, 3, 4.0, now, now]);
    await client.query(insertTopicProg, ["stu-aarav-k", "K-M2-H", "K-M2", "H", 1, 2, 88, 88.0, 4.2, 1, 3, 3.0, now, now]);

    await client.query(insertTopicProg, ["stu-maya-pk", "PK-M1-A", "PK-M1", "A", 1, 3, 100, 100.0, 3.8, 1, 4, 4.0, now, now]);
    await client.query(insertTopicProg, ["stu-maya-pk", "PK-M1-B", "PK-M1", "B", 1, 3, 90, 90.0, 4.2, 1, 3, 4.0, now, now]);

    await client.query(insertUnitProg, ["stu-liam-g2", "G1-M9", "MASTERED", "GOLD_KEY", 95.0, 4.0, 1, 30.0, now, "PURE_ABSTRACT_SYMBOLIC", now]);
    await client.query(insertTopicProg, ["stu-liam-g2", "G2-M1-A", "G2-M1", "A", 1, 3, 95, 95.0, 3.5, 1, 4, 7.0, now, now]);
    await client.query(insertTopicProg, ["stu-liam-g2", "G2-M1-B", "G2-M1", "B", 1, 3, 92, 92.0, 3.9, 1, 3, 7.0, now, now]);
  });

  logger?.info?.({ msg: `Demo students seeded with one-time random PINs: aarav=${seedPins.aarav} maya=${seedPins.maya} liam=${seedPins.liam}` });
}
