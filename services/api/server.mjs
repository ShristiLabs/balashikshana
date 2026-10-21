import http from "node:http";
import {
  median,
  computeMotorBaselineSec,
  computeCognitiveTimeSec,
  evaluateMasteryGateAttempt,
  computeFluencyGrade,
  updateTopicMemoryStability,
  computeRetrievabilityPct
} from "../../packages/core-engine/src/index.mjs";
import {
  initDatabase,
  hashPinScrypt,
  verifyPin,
  isLegacyStoredPin,
  createSessionToken
} from "./db.mjs";

const db = initDatabase();

const SESSION_TTL_MS = 30 * 86400000;

// --- Session authentication ----------------------------------------------
// Every student-scoped route must pass requireStudentAccess, which binds
// the requested studentId to the session token from the Authorization
// header. Missing/unknown/expired tokens -> 401; a valid token for a
// DIFFERENT student -> 403. Expired rows are lazily deleted on lookup.

function getSessionFromRequest(req) {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token || /[^A-Za-z0-9_-]/.test(token)) {
    return { error: "Missing or malformed bearer token" };
  }
  const row = db.prepare("SELECT * FROM student_sessions WHERE token = ?").get(token);
  if (!row) {
    return { error: "Session token is invalid or has been revoked" };
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    db.prepare("DELETE FROM student_sessions WHERE token = ?").run(token);
    return { error: "Session token has expired" };
  }
  return { session: row };
}

function requireStudentAccess(req, res, studentId) {
  const auth = getSessionFromRequest(req);
  if (auth.error) {
    sendJson(res, 401, { error: auth.error });
    return null;
  }
  if (auth.session.student_id !== studentId) {
    sendJson(res, 403, { error: "Session does not grant access to this student" });
    return null;
  }
  return auth.session;
}

function mapQuestionRow(row) {
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
    visualObjects: row.visual_objects || undefined,
    targetCount: row.target_count ?? undefined,
    maxCounterCells: row.max_counter_cells ?? undefined,
    counterEmoji: row.counter_emoji ?? undefined,
    tileBank: row.tile_bank_json ? JSON.parse(row.tile_bank_json) : undefined,
    choices: JSON.parse(row.choices_json || "[]"),
    correctAnswer: row.correct_answer,
    misconceptionTags: JSON.parse(row.misconception_tags_json || "[]"),
    explanation: row.explanation
  };
}

function getStudentFullState(studentId) {
  const stuRow = db.prepare("SELECT * FROM students WHERE student_id = ?").get(studentId);
  if (!stuRow) return null;

  const unitRows = db.prepare("SELECT * FROM student_unit_progress WHERE student_id = ?").all(studentId);
  const topicRows = db.prepare("SELECT * FROM student_topic_progress WHERE student_id = ?").all(studentId);
  const attemptCountRow = db.prepare("SELECT COUNT(*) AS cnt FROM student_question_attempts WHERE student_id = ?").get(studentId);

  const unitProgress = {};
  for (const u of unitRows) {
    unitProgress[u.unit_id] = {
      status: u.status,
      keyState: u.key_state,
      bestAccuracyPct: u.best_accuracy_pct,
      bestMedianSpeedSec: u.best_median_speed_sec,
      attemptsCount: u.attempts_count,
      stabilityDays: u.stability_days,
      lastReviewedAt: u.last_reviewed_at,
      cpaStage: u.cpa_stage
    };
  }

  const topicMastery = {};
  let dueReviews = 0;
  let totalRetrievability = 0;
  const nowMs = Date.now();

  for (const t of topicRows) {
    const elapsedDays = Math.max(0, (nowMs - new Date(t.last_reviewed_at).getTime()) / 86400000);
    const r = computeRetrievabilityPct(elapsedDays, t.stability_days || 2.0);
    totalRetrievability += r;
    if (r < 80) dueReviews += 1;

    topicMastery[t.topic_id] = {
      completed: Boolean(t.completed),
      crowns: t.crowns,
      masteryScore: t.mastery_score,
      accuracyPct: t.best_accuracy_pct,
      medianSpeedSec: t.best_median_speed_sec,
      attemptsCount: t.attempts_count,
      fluencyGrade: t.fluency_grade,
      stabilityDays: t.stability_days,
      retrievabilityPct: r,
      lastReviewedAt: t.last_reviewed_at
    };
  }

  const completedTopicsCount = topicRows.filter((t) => t.completed === 1).length;
  const masteredUnitsCount = unitRows.filter((u) => u.status === "MASTERED").length;
  const goldKeysCount = unitRows.filter((u) => u.key_state === "GOLD_KEY").length;
  const silverKeysCount = unitRows.filter((u) => u.key_state === "SILVER_KEY").length;
  const gardenHealthPct = topicRows.length > 0 ? Math.round(totalRetrievability / topicRows.length) : 100;

  const student = {
    studentId: stuRow.student_id,
    username: stuRow.username,
    nickname: stuRow.nickname,
    avatar: stuRow.avatar,
    ageYears: stuRow.age_years,
    currentGrade: stuRow.current_grade,
    motorBaselineSec: stuRow.motor_baseline_sec,
    streakDays: stuRow.streak_days,
    starCoins: stuRow.star_coins,
    hearts: stuRow.hearts,
    unitProgress,
    topicMastery
  };

  const summary = {
    studentId: stuRow.student_id,
    username: stuRow.username,
    nickname: stuRow.nickname,
    avatar: stuRow.avatar,
    ageYears: stuRow.age_years,
    currentGrade: stuRow.current_grade,
    motorBaselineSec: stuRow.motor_baseline_sec,
    streakDays: stuRow.streak_days,
    starCoins: stuRow.star_coins,
    hearts: stuRow.hearts,
    completedTopicsCount,
    masteredUnitsCount,
    goldKeysCount,
    silverKeysCount,
    dueSpacedReviewsCount: dueReviews,
    gardenHealthPct,
    totalQuestionAttemptsLogged: attemptCountRow ? attemptCountRow.cnt : 0
  };

  return { student, summary };
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  });
  res.end(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // GET /api/health -> Database & Table counts
  if (pathname === "/api/health") {
    const gradesCnt = db.prepare("SELECT COUNT(*) AS c FROM grades").get().c;
    const unitsCnt = db.prepare("SELECT COUNT(*) AS c FROM units").get().c;
    const topicsCnt = db.prepare("SELECT COUNT(*) AS c FROM skill_topics").get().c;
    const questionsCnt = db.prepare("SELECT COUNT(*) AS c FROM practice_questions").get().c;
    const studentsCnt = db.prepare("SELECT COUNT(*) AS c FROM students").get().c;
    const attemptsCnt = db.prepare("SELECT COUNT(*) AS c FROM student_question_attempts").get().c;

    return sendJson(res, 200, {
      status: "ok",
      databaseEngine: "SQLite3 (WAL Mode)",
      totalGrades: gradesCnt,
      totalUnits: unitsCnt,
      totalSkillTopics: topicsCnt,
      totalPracticeQuestionsInDb: questionsCnt,
      totalStudentsInDb: studentsCnt,
      totalQuestionAttemptsInDb: attemptsCnt
    });
  }

  // GET /api/students -> Profile cards for the login screen. Without a
  // valid session only public profile fields are returned (no progress
  // data); with a valid session the caller also receives its own full
  // summary via `ownSummary`.
  if (req.method === "GET" && pathname === "/api/students") {
    const rows = db.prepare(
      "SELECT student_id, username, nickname, avatar, age_years, current_grade, created_at FROM students ORDER BY created_at ASC"
    ).all();
    const students = rows.map((r) => ({
      studentId: r.student_id,
      username: r.username,
      nickname: r.nickname,
      avatar: r.avatar,
      ageYears: r.age_years,
      currentGrade: r.current_grade
    }));
    const auth = getSessionFromRequest(req);
    const ownSummary = auth.session
      ? getStudentFullState(auth.session.student_id).summary
      : undefined;
    return sendJson(res, 200, ownSummary ? { students, ownSummary } : { students });
  }

  // POST /api/auth/login -> Authenticate student by username/PIN (PIN is
  // always required) and issue a session token. Unknown student and wrong
  // PIN return the same 401 to prevent account enumeration.
  if (req.method === "POST" && pathname === "/api/auth/login") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const pin = String(payload.pin ?? "").trim();
        if (!/^\d{4}$/.test(pin)) {
          return sendJson(res, 401, { error: "Incorrect username or PIN." });
        }

        let stuRow = null;
        if (payload.studentId) {
          stuRow = db.prepare("SELECT * FROM students WHERE student_id = ?").get(payload.studentId);
        } else if (payload.username) {
          const uname = String(payload.username).trim().toLowerCase();
          stuRow = db.prepare("SELECT * FROM students WHERE LOWER(username) = ? OR LOWER(nickname) = ?").get(uname, uname);
        }

        if (!stuRow || !verifyPin(pin, stuRow.pin_hash)) {
          return sendJson(res, 401, { error: "Incorrect username or PIN." });
        }

        // Rehash-on-login migration: rows still stored with the legacy
        // unsalted SHA-256 scheme are upgraded to salted scrypt.
        if (isLegacyStoredPin(stuRow.pin_hash)) {
          db.prepare("UPDATE students SET pin_hash = ? WHERE student_id = ?").run(
            hashPinScrypt(pin),
            stuRow.student_id
          );
        }

        const now = new Date().toISOString();
        const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
        const token = createSessionToken();

        db.prepare("INSERT INTO student_sessions (token, student_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
          token,
          stuRow.student_id,
          now,
          expires
        );
        db.prepare("UPDATE students SET last_active_at = ? WHERE student_id = ?").run(now, stuRow.student_id);

        const state = getStudentFullState(stuRow.student_id);
        return sendJson(res, 200, {
          token,
          student: state.student,
          summary: state.summary
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    });
    return;
  }

  // POST /api/auth/logout -> Revoke the caller's session token
  if (req.method === "POST" && pathname === "/api/auth/logout") {
    const auth = getSessionFromRequest(req);
    if (auth.error) {
      return sendJson(res, 401, { error: auth.error });
    }
    db.prepare("DELETE FROM student_sessions WHERE token = ?").run(auth.session.token);
    return sendJson(res, 200, { ok: true });
  }

  // POST /api/students -> Register a new student account in SQLite
  if (req.method === "POST" && pathname === "/api/students") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const pin = String(payload.pin ?? "").trim();
        if (!/^\d{4}$/.test(pin)) {
          return sendJson(res, 400, { error: "A 4-digit PIN is required to create a student account." });
        }
        const nickname = String(payload.nickname || "Explorer").trim();
        const baseUsername = String(payload.username || nickname).toLowerCase().replace(/[^a-z0-9]/g, "") || "student";
        const existing = db.prepare("SELECT student_id FROM students WHERE username = ?").get(baseUsername);
        const username = existing ? `${baseUsername}${Math.floor(100 + Math.random() * 900)}` : baseUsername;
        const gradeId = payload.currentGrade || "kindergarten";
        const ageYears = Number(payload.ageYears) || (gradeId === "pre-k" ? 4 : gradeId === "kindergarten" ? 5 : gradeId === "grade-1" ? 6 : gradeId === "grade-2" ? 7 : 8);
        const avatar = payload.avatar || "🐼";
        const studentId = `stu-${username}-${Date.now().toString().slice(-4)}`;
        const now = new Date().toISOString();

        db.exec("BEGIN TRANSACTION;");
        try {
          db.prepare(`
            INSERT INTO students (
              student_id, username, pin_hash, nickname, avatar, age_years,
              current_grade, motor_baseline_sec, streak_days, star_coins, hearts,
              last_active_at, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 50, 5, ?, ?)
          `).run(
            studentId,
            username,
            hashPinScrypt(pin),
            nickname,
            avatar,
            ageYears,
            gradeId,
            ageYears <= 4 ? 0.55 : ageYears <= 6 ? 0.44 : 0.34,
            now,
            now
          );

          // Unlock prerequisite grade final units so the chosen grade's Unit 1 is unlocked
          const prereqSeeds = {
            "kindergarten": ["PK-M7", "PK-E7"],
            "grade-1": ["K-M10", "K-E9", "K-S5", "K-SS4"],
            "grade-2": ["G1-M9", "G1-E10", "G1-S5", "G1-SS4"],
            "grade-3": ["G2-M9", "G2-E10", "G2-S6", "G2-SS4"]
          };
          const insertUnitProg = db.prepare(`
            INSERT OR REPLACE INTO student_unit_progress (
              student_id, unit_id, status, key_state, best_accuracy_pct,
              best_median_speed_sec, attempts_count, stability_days,
              last_reviewed_at, cpa_stage, updated_at
            ) VALUES (?, ?, 'MASTERED', 'GOLD_KEY', 90.0, 4.5, 1, 21.0, ?, 'PURE_ABSTRACT_SYMBOLIC', ?)
          `);
          for (const pid of prereqSeeds[gradeId] || []) {
            insertUnitProg.run(studentId, pid, now, now);
          }
          db.exec("COMMIT;");
        } catch (txErr) {
          db.exec("ROLLBACK;");
          throw txErr;
        }

        const token = createSessionToken();
        db.prepare("INSERT INTO student_sessions (token, student_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
          token,
          studentId,
          now,
          new Date(Date.now() + SESSION_TTL_MS).toISOString()
        );

        const state = getStudentFullState(studentId);
        return sendJson(res, 201, {
          token,
          student: state.student,
          summary: state.summary
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    });
    return;
  }

  // GET /api/students/:studentId -> Get student state from SQLite (session
  // must belong to this student)
  if (req.method === "GET" && pathname.startsWith("/api/students/")) {
    const studentId = pathname.replace("/api/students/", "");
    if (!requireStudentAccess(req, res, studentId)) return;
    const state = getStudentFullState(studentId);
    if (!state) return sendJson(res, 404, { error: "Student not found" });
    return sendJson(res, 200, state);
  }

  // POST /api/students/:studentId/calibrate -> Update motor baseline in SQLite
  // (session must belong to this student)
  if (req.method === "POST" && pathname.endsWith("/calibrate") && pathname.startsWith("/api/students/")) {
    const studentId = pathname.replace("/api/students/", "").replace("/calibrate", "");
    if (!requireStudentAccess(req, res, studentId)) return;
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const motorSec = Array.isArray(payload.warmupTapTimesSec)
          ? computeMotorBaselineSec(payload.warmupTapTimesSec)
          : Number(payload.motorBaselineSec || 0.42);
        db.prepare("UPDATE students SET motor_baseline_sec = ? WHERE student_id = ?").run(motorSec, studentId);
        return sendJson(res, 200, getStudentFullState(studentId));
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    });
    return;
  }

  // GET /api/curriculum/summary -> Query grades, units, and skill_topics from SQLite
  if (pathname === "/api/curriculum/summary") {
    const gradesRows = db.prepare("SELECT * FROM grades ORDER BY sequence_order ASC").all();
    const unitsRows = db.prepare("SELECT * FROM units ORDER BY sequence_order ASC").all();
    const topicsRows = db.prepare("SELECT topic_id, unit_id, grade_id, subject, topic_code, topic_name, sequence_order FROM skill_topics ORDER BY sequence_order ASC").all();
    const questionsCount = db.prepare("SELECT COUNT(*) AS c FROM practice_questions").get().c;

    const topicsByUnit = {};
    for (const t of topicsRows) {
      if (!topicsByUnit[t.unit_id]) topicsByUnit[t.unit_id] = [];
      topicsByUnit[t.unit_id].push({ code: t.topic_code, name: t.topic_name, topicId: t.topic_id });
    }

    const grades = gradesRows.map((g) => {
      const gUnits = unitsRows.filter((u) => u.grade_id === g.grade_id);
      const subjects = {};
      for (const u of gUnits) {
        if (!subjects[u.subject]) {
          subjects[u.subject] = { totalUnits: 0, totalSkillTopics: 0, units: [] };
        }
        const uTopics = topicsByUnit[u.unit_id] || [];
        subjects[u.subject].totalUnits += 1;
        subjects[u.subject].totalSkillTopics += uTopics.length;
        subjects[u.subject].units.push({
          unitId: u.unit_id,
          sequenceOrder: u.sequence_order,
          title: u.title,
          prerequisiteUnitIds: JSON.parse(u.prerequisite_unit_ids_json || "[]"),
          masteryGate: {
            questionCount: u.gate_question_count,
            minAccuracyPercent: u.gate_min_accuracy_pct,
            maxMedianResponseTimeSec: u.gate_max_speed_sec,
            challengeZoneStreak: u.gate_streak_req
          },
          skillTopics: uTopics
        });
      }
      return {
        gradeId: g.grade_id,
        gradeName: g.grade_name,
        targetAgeYears: g.target_age_years,
        spacedRepetitionPolicy: {
          stabilityGrowthFactor: g.sr_growth_factor,
          maxIntervalCapDays: g.sr_max_interval_days,
          baseScheduleDays: JSON.parse(g.sr_schedule_json || "[]")
        },
        subjects
      };
    });

    return sendJson(res, 200, {
      summary: {
        totalGrades: gradesRows.length,
        totalUnits: unitsRows.length,
        totalSkillTopics: topicsRows.length,
        totalPracticeQuestionsInDb: questionsCount
      },
      grades
    });
  }

  // GET /api/practice/topic/:unitId/:topicCode -> Fetch stored practice questions from SQLite practice_questions table
  if (req.method === "GET" && pathname.startsWith("/api/practice/topic/")) {
    const parts = pathname.replace("/api/practice/topic/", "").split("/");
    const unitId = parts[0];
    const topicCode = parts[1];
    const topicId = `${unitId}-${topicCode}`;

    const unitRow = db.prepare("SELECT * FROM units WHERE unit_id = ?").get(unitId);
    const topicRow = db.prepare("SELECT * FROM skill_topics WHERE topic_id = ?").get(topicId);
    if (!unitRow || !topicRow) return sendJson(res, 404, { error: `Topic ${topicId} not found in database` });

    const count = Number(url.searchParams.get("count") || 8);
    const qRows = db.prepare("SELECT * FROM practice_questions WHERE topic_id = ? ORDER BY difficulty_level ASC, question_id ASC LIMIT ?").all(topicId, count);

    return sendJson(res, 200, {
      unitId: unitRow.unit_id,
      unitTitle: unitRow.title,
      targetSpeedSec: unitRow.gate_max_speed_sec,
      minAccuracyPercent: 80,
      topic: {
        topicId: topicRow.topic_id,
        code: topicRow.topic_code,
        name: topicRow.topic_name,
        assets: JSON.parse(topicRow.assets_json || "{}")
      },
      practiceProblems: qRows.map(mapQuestionRow)
    });
  }

  // GET /api/curriculum/unit/:unitId -> Fetch unit + stratified Boss Gate questions from SQLite practice_questions table
  if (req.method === "GET" && pathname.startsWith("/api/curriculum/unit/")) {
    const unitId = pathname.replace("/api/curriculum/unit/", "");
    const unitRow = db.prepare("SELECT * FROM units WHERE unit_id = ?").get(unitId);
    if (!unitRow) return sendJson(res, 404, { error: `Unit ${unitId} not found in database` });

    const topicRows = db.prepare("SELECT * FROM skill_topics WHERE unit_id = ? ORDER BY sequence_order ASC").all(unitId);
    const count = Number(url.searchParams.get("count") || unitRow.gate_question_count || 12);

    // Stratified selection from SQLite practice_questions across all topics in this unit
    const allUnitQuestions = db.prepare("SELECT * FROM practice_questions WHERE unit_id = ? ORDER BY question_id ASC").all(unitId).map(mapQuestionRow);
    const byTopic = {};
    for (const q of allUnitQuestions) {
      if (!byTopic[q.topicCode]) byTopic[q.topicCode] = [];
      byTopic[q.topicCode].push(q);
    }

    const selectedQuestions = [];
    const topicCodes = topicRows.map((t) => t.topic_code);
    for (let i = 0; i < count; i++) {
      const tCode = topicCodes[i % topicCodes.length];
      const pool = byTopic[tCode] || allUnitQuestions;
      const picked = pool[Math.floor(i / topicCodes.length) % pool.length];
      if (picked) selectedQuestions.push(picked);
    }

    return sendJson(res, 200, {
      unit: {
        unitId: unitRow.unit_id,
        gradeId: unitRow.grade_id,
        subject: unitRow.subject,
        sequenceOrder: unitRow.sequence_order,
        title: unitRow.title,
        prerequisiteUnitIds: JSON.parse(unitRow.prerequisite_unit_ids_json || "[]"),
        masteryGate: {
          questionCount: unitRow.gate_question_count,
          minAccuracyPercent: unitRow.gate_min_accuracy_pct,
          maxMedianResponseTimeSec: unitRow.gate_max_speed_sec,
          challengeZoneStreak: unitRow.gate_streak_req
        },
        skillTopics: topicRows.map((t) => ({
          topicId: t.topic_id,
          code: t.topic_code,
          name: t.topic_name,
          assets: JSON.parse(t.assets_json || "{}")
        }))
      },
      generatedQuestions: selectedQuestions
    });
  }

  // POST /api/practice/topic/complete -> Persist topic completion & question attempts in SQLite
  if (req.method === "POST" && pathname === "/api/practice/topic/complete") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const studentId = payload.studentId;
        const unitId = payload.unitId;
        const topicCode = payload.topicCode;
        const topicId = `${unitId}-${topicCode}`;

        if (!requireStudentAccess(req, res, studentId)) return;

        const stuRow = db.prepare("SELECT * FROM students WHERE student_id = ?").get(studentId);
        const unitRow = db.prepare("SELECT * FROM units WHERE unit_id = ?").get(unitId);
        const gradeRow = unitRow ? db.prepare("SELECT * FROM grades WHERE grade_id = ?").get(unitRow.grade_id) : null;
        if (!stuRow || !unitRow) return sendJson(res, 404, { error: "Student or Unit not found" });

        const responses = payload.responses || [];
        const motorSec = payload.motorBaselineSec || stuRow.motor_baseline_sec || 0.42;
        const total = Math.max(1, responses.length);
        const correct = responses.filter((r) => r.isCorrect).length;
        const accPct = Number(((correct / total) * 100).toFixed(1));
        const cogTimes = responses.map((r) => computeCognitiveTimeSec(r.rawTimeSec || 3.0, motorSec, 0));
        const medSpeed = Number(median(cogTimes).toFixed(2));
        const targetSpeed = unitRow.gate_max_speed_sec;

        const passedTopic = accPct >= 80;
        const crowns = accPct >= 95 && medSpeed <= targetSpeed ? 3 : accPct >= 85 ? 2 : passedTopic ? 1 : 0;

        const prevTopic = db.prepare("SELECT * FROM student_topic_progress WHERE student_id = ? AND topic_id = ?").get(studentId, topicId);
        const fg = computeFluencyGrade(passedTopic, medSpeed, targetSpeed);
        const srUpdate = updateTopicMemoryStability({
          currentStabilityDays: prevTopic ? prevTopic.stability_days : 1.0,
          fluencyGrade: fg,
          gradeGrowthFactor: gradeRow ? gradeRow.sr_growth_factor : 2.0,
          maxIntervalCapDays: gradeRow ? gradeRow.sr_max_interval_days : 45
        });

        const now = new Date().toISOString();
        const nextReview = new Date(Date.now() + srUpdate.stabilityDays * 86400000).toISOString();

        db.exec("BEGIN TRANSACTION;");
        try {
          // 1. Log every individual question attempt into student_question_attempts
          const insertAttempt = db.prepare(`
            INSERT INTO student_question_attempts (
              student_id, session_type, unit_id, topic_id, question_id,
              chosen_answer, is_correct, raw_time_sec, cognitive_time_sec,
              fluency_grade, misconception_tags_json, attempted_at
            ) VALUES (?, 'TOPIC_PRACTICE', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const r of responses) {
            const cSec = computeCognitiveTimeSec(r.rawTimeSec || 3.0, motorSec, 0);
            insertAttempt.run(
              studentId,
              unitId,
              topicId,
              r.questionId || `${topicId}-Q1`,
              String(r.chosenAnswer || ""),
              r.isCorrect ? 1 : 0,
              r.rawTimeSec || 3.0,
              cSec,
              computeFluencyGrade(Boolean(r.isCorrect), cSec, targetSpeed),
              JSON.stringify(r.misconceptionTags || []),
              now
            );
          }

          // 2. Upsert student_topic_progress
          db.prepare(`
            INSERT INTO student_topic_progress (
              student_id, topic_id, unit_id, topic_code, completed, crowns,
              mastery_score, best_accuracy_pct, best_median_speed_sec,
              attempts_count, fluency_grade, stability_days, next_review_at, last_reviewed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(student_id, topic_id) DO UPDATE SET
              completed = MAX(student_topic_progress.completed, excluded.completed),
              crowns = MAX(student_topic_progress.crowns, excluded.crowns),
              mastery_score = MAX(student_topic_progress.mastery_score, excluded.mastery_score),
              best_accuracy_pct = MAX(student_topic_progress.best_accuracy_pct, excluded.best_accuracy_pct),
              best_median_speed_sec = CASE
                WHEN student_topic_progress.best_median_speed_sec > 0
                THEN MIN(student_topic_progress.best_median_speed_sec, excluded.best_median_speed_sec)
                ELSE excluded.best_median_speed_sec
              END,
              attempts_count = student_topic_progress.attempts_count + 1,
              fluency_grade = excluded.fluency_grade,
              stability_days = excluded.stability_days,
              next_review_at = excluded.next_review_at,
              last_reviewed_at = excluded.last_reviewed_at
          `).run(
            studentId,
            topicId,
            unitId,
            topicCode,
            passedTopic ? 1 : 0,
            crowns,
            Math.round(accPct),
            accPct,
            medSpeed,
            1,
            fg,
            srUpdate.stabilityDays,
            nextReview,
            now
          );

          if (passedTopic) {
            const rewardCoins = 15 + crowns * 5;
            db.prepare("UPDATE students SET star_coins = star_coins + ?, last_active_at = ? WHERE student_id = ?").run(rewardCoins, now, studentId);
          }

          db.exec("COMMIT;");
        } catch (txErr) {
          db.exec("ROLLBACK;");
          throw txErr;
        }

        const totalTopicsInUnit = db.prepare("SELECT COUNT(*) AS c FROM skill_topics WHERE unit_id = ?").get(unitId).c;
        const completedInUnit = db.prepare("SELECT COUNT(*) AS c FROM student_topic_progress WHERE student_id = ? AND unit_id = ? AND completed = 1").get(studentId, unitId).c;
        const allTopicsDone = completedInUnit >= totalTopicsInUnit;

        const state = getStudentFullState(studentId);
        return sendJson(res, 200, {
          passedTopic,
          crownsAwarded: crowns,
          accuracyPct: accPct,
          medianCogSpeedSec: medSpeed,
          targetSpeedSec: targetSpeed,
          bossGateUnlocked: allTopicsDone,
          spacedRepetition: srUpdate,
          student: state.student,
          summary: state.summary
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    });
    return;
  }

  // POST /api/gate/evaluate -> Evaluate Unit Boss Gate & persist unit mastery in SQLite
  if (req.method === "POST" && pathname === "/api/gate/evaluate") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const payload = JSON.parse(body || "{}");
        const studentId = payload.studentId;
        const unitId = payload.unitId;

        if (!requireStudentAccess(req, res, studentId)) return;

        const stuRow = db.prepare("SELECT * FROM students WHERE student_id = ?").get(studentId);
        const unitRow = db.prepare("SELECT * FROM units WHERE unit_id = ?").get(unitId);
        const gradeRow = unitRow ? db.prepare("SELECT * FROM grades WHERE grade_id = ?").get(unitRow.grade_id) : null;
        if (!stuRow || !unitRow) return sendJson(res, 404, { error: "Student or Unit not found" });

        const topicRows = db.prepare("SELECT * FROM skill_topics WHERE unit_id = ? ORDER BY sequence_order ASC").all(unitId);
        const unitObj = {
          unitId: unitRow.unit_id,
          title: unitRow.title,
          masteryGate: {
            questionCount: unitRow.gate_question_count,
            minAccuracyPercent: unitRow.gate_min_accuracy_pct,
            maxMedianResponseTimeSec: unitRow.gate_max_speed_sec,
            challengeZoneStreak: unitRow.gate_streak_req
          },
          skillTopics: topicRows.map((t) => ({ code: t.topic_code, name: t.topic_name }))
        };

        const motorSec = payload.motorBaselineSec || stuRow.motor_baseline_sec || 0.42;
        const evalResult = evaluateMasteryGateAttempt({
          unit: unitObj,
          responses: payload.responses || [],
          motorBaselineSec: motorSec
        });

        const prevProg = db.prepare("SELECT * FROM student_unit_progress WHERE student_id = ? AND unit_id = ?").get(studentId, unitId);
        const fg = computeFluencyGrade(evalResult.passed, evalResult.medianCogSpeedSec, unitRow.gate_max_speed_sec);
        const srUpdate = updateTopicMemoryStability({
          currentStabilityDays: prevProg ? prevProg.stability_days : 1.0,
          fluencyGrade: fg,
          gradeGrowthFactor: gradeRow ? gradeRow.sr_growth_factor : 2.0,
          maxIntervalCapDays: gradeRow ? gradeRow.sr_max_interval_days : 45
        });

        const nextKeyState = evalResult.passed
          ? (prevProg && (prevProg.key_state === "SILVER_KEY" || prevProg.key_state === "GOLD_KEY") ? "GOLD_KEY" : "SILVER_KEY")
          : (prevProg ? prevProg.key_state : null);

        const now = new Date().toISOString();

        db.exec("BEGIN TRANSACTION;");
        try {
          db.prepare(`
            INSERT INTO student_unit_progress (
              student_id, unit_id, status, key_state, best_accuracy_pct,
              best_median_speed_sec, attempts_count, stability_days,
              last_reviewed_at, cpa_stage, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
            ON CONFLICT(student_id, unit_id) DO UPDATE SET
              status = CASE WHEN student_unit_progress.status = 'MASTERED' THEN 'MASTERED' ELSE excluded.status END,
              key_state = COALESCE(excluded.key_state, student_unit_progress.key_state),
              best_accuracy_pct = MAX(student_unit_progress.best_accuracy_pct, excluded.best_accuracy_pct),
              best_median_speed_sec = CASE
                WHEN student_unit_progress.best_median_speed_sec > 0
                THEN MIN(student_unit_progress.best_median_speed_sec, excluded.best_median_speed_sec)
                ELSE excluded.best_median_speed_sec
              END,
              attempts_count = student_unit_progress.attempts_count + 1,
              stability_days = excluded.stability_days,
              last_reviewed_at = excluded.last_reviewed_at,
              cpa_stage = excluded.cpa_stage,
              updated_at = excluded.updated_at
          `).run(
            studentId,
            unitId,
            evalResult.passed ? "MASTERED" : "REMEDIATION_REQUIRED",
            nextKeyState,
            evalResult.overallAccuracyPct,
            evalResult.medianCogSpeedSec,
            srUpdate.stabilityDays,
            now,
            srUpdate.cpaStage,
            now
          );

          if (evalResult.passed) {
            db.prepare("UPDATE students SET star_coins = star_coins + 50, last_active_at = ? WHERE student_id = ?").run(now, studentId);
          }

          db.exec("COMMIT;");
        } catch (txErr) {
          db.exec("ROLLBACK;");
          throw txErr;
        }

        const state = getStudentFullState(studentId);
        return sendJson(res, 200, {
          student: state.student,
          summary: state.summary,
          evaluation: { ...evalResult, keyAwarded: nextKeyState },
          spacedRepetition: srUpdate
        });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    });
    return;
  }

  return sendJson(res, 404, { error: "Route not found" });
});

const PORT = Number(process.env.PORT || 4000);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[Balashikshana SQLite-Backed API] Listening on http://localhost:${PORT}`);
});
