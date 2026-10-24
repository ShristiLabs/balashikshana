// PostgreSQL migration coverage for issue #30: migration tracking, seed
// completeness, referential integrity, cascade behavior, upsert semantics
// (the GREATEST/LEAST port), and identity columns. Runs against a
// throwaway database, same harness style as the sibling suites.
// Vitest suite (issue #32); assertions are the node:test originals,
// unchanged.

import { test, describe, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { Client } from "pg";
import { createTestDatabase, dropTestDatabase, startTestServer, waitForHealth, createVerifiedParentWithConsent } from "./helpers.mjs";

const API = "http://127.0.0.1:4797";

let serverProcess;
let testDatabase;
let db;

async function api(pathname, { method = "GET", token, body } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // non-JSON response
  }
  return { status: res.status, json };
}

// #41: POST /api/students is consent-gated; one shared consented parent
// covers this suite's registrations (buckets are wide open here; consent
// behavior is covered in consent.test.mjs).
let suiteParent;

async function registerStudent(name, pin = "5533") {
  suiteParent ||= await createVerifiedParentWithConsent(API);
  const res = await api("/api/students", {
    method: "POST",
    token: suiteParent.token,
    body: { nickname: name, username: name, currentGrade: "kindergarten", pin }
  });
  assert.equal(res.status, 201, `registration failed: ${JSON.stringify(res.json)}`);
  return res.json;
}

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  serverProcess = await startTestServer({
    port: 4797,
    databaseUrl: testDatabase.url,
    env: {
      RATE_LIMIT_PER_IP_MIN: "1000",
      RATE_LIMIT_PER_TOKEN_MIN: "1000",
      RATE_LIMIT_LOGIN_PER_IP_MIN: "1000"
    }
  });
  serverProcess.stderr.on("data", () => {});
  await waitForHealth(API, 120000);
  db = new Client({ connectionString: testDatabase.url });
  await db.connect();
});

afterAll(async () => {
  try {
    await db?.end();
  } catch {
    // already closed
  }
  serverProcess?.kill("SIGTERM");
  if (testDatabase) await dropTestDatabase(testDatabase.name);
});

describe("migration tracking", () => {
  test("pgmigrations records exactly the applied migrations after boot", async () => {
    const rows = (await db.query("SELECT name FROM pgmigrations ORDER BY name")).rows;
    assert.deepEqual(
      rows.map((r) => r.name),
      [
        "001_initial_schema",
        "002_parent_accounts_consent",
        "003_parent_auth_tokens",
        "004_consent_policy_versions",
        "005_child_profiles_device_sessions"
      ]
    );
  });
});

describe("seed completeness", () => {
  test("database counts match the registry (5/130/614/6140) and health agrees", async () => {
    const counts = (
      await db.query(`
        SELECT
          (SELECT COUNT(*)::int FROM grades) AS grades,
          (SELECT COUNT(*)::int FROM units) AS units,
          (SELECT COUNT(*)::int FROM skill_topics) AS topics,
          (SELECT COUNT(*)::int FROM practice_questions) AS questions
      `)
    ).rows[0];

    assert.equal(counts.grades, 5);
    assert.equal(counts.units, 130);
    assert.equal(counts.topics, 614);
    assert.equal(counts.questions, 6140);

    const health = await api("/api/health");
    assert.equal(health.status, 200);
    assert.equal(health.json.totalGrades, 5);
    assert.equal(health.json.totalUnits, 130);
    assert.equal(health.json.totalSkillTopics, 614);
    assert.equal(health.json.totalPracticeQuestionsInDb, 6140);
    assert.match(health.json.databaseEngine, /^PostgreSQL/);
  });
});

describe("referential integrity", () => {
  test("session insert for a nonexistent student fails with FK violation 23503", async () => {
    await assert.rejects(
      db.query(
        "INSERT INTO student_sessions (token, student_id, created_at, expires_at) VALUES ($1, $2, $3, $4)",
        ["fake-token-xyz", "stu-does-not-exist", new Date().toISOString(), new Date().toISOString()]
      ),
      (err) => err.code === "23503"
    );
  });

  test("deleting a student cascades to their sessions", async () => {
    const created = await registerStudent("cascadeprobe", "4141");
    await db.query(
      "INSERT INTO student_sessions (token, student_id, created_at, expires_at) VALUES ($1, $2, $3, $4)",
      ["stray-session-token", created.student.studentId, new Date().toISOString(), new Date().toISOString()]
    );

    // #41: gated registration writes the consent binding row; students are
    // RESTRICT from delete while consent evidence cites them (002). Handle
    // the evidence first — the documented #62 data-rights order — then the
    // student row delete demonstrates the session cascade.
    await db.query("DELETE FROM consent_records WHERE student_id = $1", [created.student.studentId]);
    await db.query("DELETE FROM students WHERE student_id = $1", [created.student.studentId]);

    const row = (await db.query("SELECT token FROM student_sessions WHERE student_id = $1", [
      created.student.studentId
    ])).rows[0];
    assert.equal(row, undefined, "sessions must cascade-delete with the student");
  });
});

describe("upsert semantics on PostgreSQL", () => {
  test("practice complete twice: attempts_count increments, crowns never decrease", async () => {
    const created = await registerStudent("upsertprobe", "4242");
    const studentId = created.student.studentId;
    const complete = (responses) =>
      api("/api/practice/topic/complete", {
        method: "POST",
        token: created.token,
        body: {
          studentId,
          unitId: "K-M2",
          topicCode: "I",
          motorBaselineSec: 0.4,
          responses
        }
      });

    const first = await complete([{ questionId: "K-M2-I-Q1", chosenAnswer: "6", isCorrect: true, rawTimeSec: 2.5 }]);
    assert.equal(first.status, 200, JSON.stringify(first.json));

    // A weaker second attempt (correctness that cannot exceed first crowns).
    const second = await complete([{ questionId: "K-M2-I-Q2", chosenAnswer: "1", isCorrect: false, rawTimeSec: 3.5 }]);
    assert.equal(second.status, 200, JSON.stringify(second.json));

    const row = (
      await db.query(
        "SELECT attempts_count, crowns, completed FROM student_topic_progress WHERE student_id = $1 AND topic_id = $2",
        [studentId, "K-M2-I"]
      )
    ).rows[0];
    assert.ok(row, "progress row must exist");
    assert.equal(row.attempts_count, 2, "attempts_count must increment per completion");
    assert.ok(row.crowns >= second.json.crownsAwarded, "stored crowns must not decrease");
    assert.equal(row.completed, 1, "GREATEST keeps completed latched at 1 after a weaker attempt");
  });
});

describe("curriculum, practice and gate endpoints (happy paths, issue #32 scope)", () => {
  test("curriculum/summary returns the full seeded overview with gate metadata", async () => {
    const res = await api("/api/curriculum/summary");
    assert.equal(res.status, 200);
    assert.equal(res.json.summary.totalGrades, 5);
    assert.equal(res.json.summary.totalUnits, 130);
    assert.equal(res.json.summary.totalSkillTopics, 614);
    assert.equal(res.json.summary.totalPracticeQuestionsInDb, 6140);
    const firstUnit = res.json.grades[0].subjects[Object.keys(res.json.grades[0].subjects)[0]].units[0];
    assert.ok(firstUnit.unitId);
    assert.ok(firstUnit.masteryGate.minAccuracyPercent > 0);
    assert.ok(Array.isArray(firstUnit.skillTopics) && firstUnit.skillTopics.length > 0);
  });

  test("practice/topic fetch serves seeded questions and honors ?count=", async () => {
    const res = await api("/api/practice/topic/K-M2/I?count=3");
    assert.equal(res.status, 200);
    assert.equal(res.json.topic.topicId, "K-M2-I");
    assert.equal(res.json.practiceProblems.length, 3);
    for (const q of res.json.practiceProblems) {
      assert.ok(q.prompt, "question prompt missing");
      assert.ok(Array.isArray(q.choices) && q.choices.length >= 3);
      assert.ok(q.correctAnswer !== undefined);
    }
  });

  test("gate/evaluate happy path: passing responses award the SILVER_KEY and persist mastery", async () => {
    const created = await registerStudent("gatehappy", "4545");
    const studentId = created.student.studentId;
    const topicCodes = (
      await db.query("SELECT topic_code FROM skill_topics WHERE unit_id = $1 ORDER BY sequence_order ASC", ["PK-M1"])
    ).rows.map((r) => r.topic_code);
    assert.ok(topicCodes.length > 0, "PK-M1 must have seeded topics");

    const coinsBefore = (await db.query("SELECT star_coins FROM students WHERE student_id = $1", [studentId])).rows[0].star_coins;
    const responses = topicCodes.flatMap((code) => [
      { topicCode: code, isCorrect: true, rawTimeSec: 3.5 },
      { topicCode: code, isCorrect: true, rawTimeSec: 3.8 },
      { topicCode: code, isCorrect: true, rawTimeSec: 4.0 }
    ]);

    const res = await api("/api/gate/evaluate", {
      method: "POST",
      token: created.token,
      body: { studentId, unitId: "PK-M1", motorBaselineSec: 0.42, responses }
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.evaluation.passed, true);
    assert.equal(res.json.evaluation.keyAwarded, "SILVER_KEY");
    assert.ok(res.json.spacedRepetition.stabilityDays > 0);

    const coinsAfter = (await db.query("SELECT star_coins FROM students WHERE student_id = $1", [studentId])).rows[0].star_coins;
    assert.equal(coinsAfter - coinsBefore, 50, "a passed gate must award 50 star coins");
    const progress = (
      await db.query("SELECT status, key_state FROM student_unit_progress WHERE student_id = $1 AND unit_id = $2", [studentId, "PK-M1"])
    ).rows[0];
    assert.ok(progress, "gate evaluation must persist unit progress");
    assert.equal(progress.status, "MASTERED");
    assert.equal(progress.key_state, "SILVER_KEY");
  });

  test("gate/evaluate fail path: empty responses return a remediation outcome, not an error", async () => {
    const created = await registerStudent("gatefail", "4646");
    const studentId = created.student.studentId;

    const res = await api("/api/gate/evaluate", {
      method: "POST",
      token: created.token,
      body: { studentId, unitId: "PK-M1", motorBaselineSec: 0.42, responses: [] }
    });
    assert.equal(res.status, 200, "a failed gate is a valid outcome, not an HTTP error");
    assert.equal(res.json.evaluation.passed, false);
    assert.equal(res.json.evaluation.keyAwarded, null);
    assert.equal(res.json.evaluation.remediationMode, "MODE_1_CONCEPT_GAP");

    const progress = (
      await db.query("SELECT status, attempts_count FROM student_unit_progress WHERE student_id = $1 AND unit_id = $2", [studentId, "PK-M1"])
    ).rows[0];
    assert.ok(progress, "failed gate attempts must still persist");
    assert.equal(progress.status, "REMEDIATION_REQUIRED");
    assert.equal(progress.attempts_count, 1);
  });
});

describe("identity columns", () => {
  test("attempt_id auto-generates when omitted", async () => {
    const created = await registerStudent("identityprobe", "4343");
    await db.query(
      `INSERT INTO student_question_attempts (
        student_id, session_type, unit_id, topic_id, question_id,
        chosen_answer, is_correct, raw_time_sec, cognitive_time_sec,
        fluency_grade, misconception_tags_json, attempted_at
      ) VALUES ($1, 'TOPIC_PRACTICE', 'K-M1', 'K-M1-A', 'K-M1-A-Q1', '3', 1, 2.0, 1.6, 4, '[]', $2)`,
      [created.student.studentId, new Date().toISOString()]
    );
    const row = (
      await db.query("SELECT attempt_id FROM student_question_attempts WHERE student_id = $1", [
        created.student.studentId
      ])
    ).rows[0];
    // pg returns bigint (int8) columns as strings; the identity still
    // generated a positive value.
    assert.ok(Number(row.attempt_id) > 0, "attempt_id must be generated");
  });
});
