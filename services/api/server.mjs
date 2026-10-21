import http from "node:http";
import crypto from "node:crypto";
import pino from "pino";
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
  createDb,
  hashPinScrypt,
  verifyPin,
  isLegacyStoredPin,
  createSessionToken
} from "./db.mjs";

// --- Environment configuration -------------------------------------------
// PORT                        listen port                        (default 4000)
// DATABASE_URL                PostgreSQL connection string       (default postgres://balashikshana:balashikshana_dev@localhost:5432/balashikshana_db)
// ALLOWED_ORIGINS             CORS allowlist, comma-separated    (dev default: http://localhost:4200,http://127.0.0.1:4200;
//                                                                REQUIRED, non-empty, non-wildcard when NODE_ENV=production)
// NODE_ENV                    "production" enables strict config (default dev)
// BODY_LIMIT_BYTES            max request body bytes             (default 65536)
// RATE_LIMIT_PER_IP_MIN       general per-IP requests/minute     (default 120)
// RATE_LIMIT_PER_TOKEN_MIN    per-token requests/minute          (default 60)
// RATE_LIMIT_LOGIN_PER_IP_MIN login attempts/minute per IP       (default 10)
const IS_PRODUCTION = process.env.NODE_ENV === "production";

function parseAllowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS;
  if (IS_PRODUCTION) {
    if (!raw || !raw.trim()) {
      throw new Error("ALLOWED_ORIGINS must be set to an explicit origin list when NODE_ENV=production (wildcards are forbidden).");
    }
  }
  const list = String(raw || "http://localhost:4200,http://127.0.0.1:4200")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.includes("*")) {
    if (IS_PRODUCTION) {
      throw new Error("ALLOWED_ORIGINS must not contain a wildcard when NODE_ENV=production.");
    }
    // Dev convenience is still denied: wildcard CORS defeats the allowlist.
    throw new Error("ALLOWED_ORIGINS must not contain a wildcard; list explicit origins instead.");
  }
  return new Set(list);
}

const ALLOWED_ORIGINS = parseAllowedOrigins();
const BODY_LIMIT_BYTES = Number(process.env.BODY_LIMIT_BYTES || 65536);
const RATE_LIMIT_PER_IP_MIN = Number(process.env.RATE_LIMIT_PER_IP_MIN || 120);
const RATE_LIMIT_PER_TOKEN_MIN = Number(process.env.RATE_LIMIT_PER_TOKEN_MIN || 60);
const RATE_LIMIT_LOGIN_PER_IP_MIN = Number(process.env.RATE_LIMIT_LOGIN_PER_IP_MIN || 10);
const URL_LENGTH_LIMIT = 2048;

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  base: { service: "balashikshana-api" }
});

const db = await createDb(logger).catch((err) => {
  logger.fatal({ err: err.message }, "Database initialization failed");
  process.exit(1);
});

const SESSION_TTL_MS = 30 * 86400000;

// --- In-memory rate limiting (fixed window) --------------------------------
// Sufficient for a single-instance dev/staging API; Redis-backed limiting is
// deferred to M6 multi-instance work per the roadmap. Windows are pruned on
// each check sweep so the maps cannot grow unbounded.

const WINDOW_MS = 60000;
const rateBuckets = new Map(); // key -> { windowStart, count }

function pruneRateBuckets(now) {
  if (rateBuckets.size < 512) return;
  for (const [key, bucket] of rateBuckets) {
    if (now - bucket.windowStart >= WINDOW_MS) rateBuckets.delete(key);
  }
}

function checkRateLimit(key, limitPerMin, now = Date.now()) {
  pruneRateBuckets(now);
  const bucket = rateBuckets.get(key);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    rateBuckets.set(key, { windowStart: now, count: 1 });
    return { allowed: true, retryAfterSec: 0 };
  }
  bucket.count += 1;
  if (bucket.count > limitPerMin) {
    const resetAt = bucket.windowStart + WINDOW_MS;
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((resetAt - now) / 1000)) };
  }
  return { allowed: true, retryAfterSec: 0 };
}

function clientIp(req) {
  // Single-instance deployment: the socket address is the client. Behind a
  // proxy, Dwara (M6) terminates TLS and forwards; trusted-proxy handling
  // lands with that work.
  return req.socket.remoteAddress || "unknown";
}

// --- Request body reading with size cap ------------------------------------

function readJsonBody(req, res, callback) {
  const chunks = [];
  let received = 0;
  let aborted = false;
  req.on("data", (chunk) => {
    if (aborted) return;
    received += chunk.length;
    if (received > BODY_LIMIT_BYTES) {
      aborted = true;
      callback(null, { tooLarge: true });
      // Cut the connection only after the 413 response has flushed, so the
      // client reliably sees the error instead of a connection reset race.
      res.on("finish", () => req.destroy());
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (aborted) return;
    let parsed = {};
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch (err) {
      return callback(null, { parseError: err.message });
    }
    callback(parsed, null);
  });
  req.on("error", () => {
    if (!aborted) callback(null, { parseError: "stream error" });
  });
}

// --- Session authentication ----------------------------------------------
// Every student-scoped route must pass requireStudentAccess, which binds
// the requested studentId to the session token from the Authorization
// header. Missing/unknown/expired tokens -> 401; a valid token for a
// DIFFERENT student -> 403. Expired rows are lazily deleted on lookup.

async function getSessionFromRequest(req) {
  const authHeader = req.headers.authorization || "";
  const [scheme, token] = authHeader.split(" ");
  if (scheme !== "Bearer" || !token || /[^A-Za-z0-9_-]/.test(token)) {
    return { error: "Missing or malformed bearer token" };
  }
  const row = await db.get("SELECT * FROM student_sessions WHERE token = $1", [token]);
  if (!row) {
    return { error: "Session token is invalid or has been revoked" };
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await db.run("DELETE FROM student_sessions WHERE token = $1", [token]);
    return { error: "Session token has expired" };
  }
  return { session: row };
}

async function requireStudentAccess(req, res, studentId) {
  const auth = await getSessionFromRequest(req);
  if (auth.error) {
    sendJson(res, 401, { error: auth.error });
    return null;
  }
  if (auth.session.student_id !== studentId) {
    sendJson(res, 403, { error: "Session does not grant access to this student" });
    return null;
  }
  res._balashiStudentId = auth.session.student_id;
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

async function getStudentFullState(studentId) {
  const stuRow = await db.get("SELECT * FROM students WHERE student_id = $1", [studentId]);
  if (!stuRow) return null;

  const unitRows = await db.all("SELECT * FROM student_unit_progress WHERE student_id = $1", [studentId]);
  const topicRows = await db.all("SELECT * FROM student_topic_progress WHERE student_id = $1", [studentId]);
  const attemptCountRow = await db.get("SELECT COUNT(*)::int AS cnt FROM student_question_attempts WHERE student_id = $1", [studentId]);

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
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "X-Request-Id": res._balashiRequestId || ""
  };
  if (res._balashiCorsAllowed) {
    headers["Access-Control-Allow-Origin"] = res._balashiCorsOrigin;
    headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization";
    headers.Vary = "Origin";
  }
  if (res._balashiRetryAfterSec) {
    headers["Retry-After"] = String(res._balashiRetryAfterSec);
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload));
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    logger.error({ err: err?.message, requestId: res._balashiRequestId }, "Unhandled request error");
    if (res.headersSent) {
      res.destroy();
      return;
    }
    sendJson(res, 500, { error: "Internal server error." });
  });
});

async function handleRequest(req, res) {
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  res._balashiRequestId = requestId;

  // CORS: requests without an Origin header are not cross-origin and pass
  // through without CORS headers; cross-origin requests must match the
  // allowlist or receive no CORS headers (browsers block the response).
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res._balashiCorsAllowed = true;
    res._balashiCorsOrigin = origin;
  }

  res.on("finish", () => {
    logger.info(
      {
        requestId,
        method: req.method,
        url: req.url,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
        ip: clientIp(req),
        studentId: res._balashiStudentId || undefined
      },
      "request"
    );
  });

  if (req.method === "OPTIONS") {
    if (origin && !res._balashiCorsAllowed) {
      return sendJson(res, 403, { error: "Origin is not allowed." });
    }
    return sendJson(res, 204, {});
  }

  if ((req.url || "").length > URL_LENGTH_LIMIT) {
    return sendJson(res, 414, { error: "Request URL exceeds the length limit." });
  }

  const ip = clientIp(req);
  const ipLimit = checkRateLimit(`ip:${ip}`, RATE_LIMIT_PER_IP_MIN);
  if (!ipLimit.allowed) {
    res._balashiRetryAfterSec = ipLimit.retryAfterSec;
    return sendJson(res, 429, { error: "Too many requests. Please slow down." });
  }

  const isBearerRequest = /^Bearer [A-Za-z0-9_-]+$/.test(req.headers.authorization || "");
  if (isBearerRequest) {
    const token = req.headers.authorization.split(" ")[1];
    const tokenLimit = checkRateLimit(`token:${token}`, RATE_LIMIT_PER_TOKEN_MIN);
    if (!tokenLimit.allowed) {
      res._balashiRetryAfterSec = tokenLimit.retryAfterSec;
      return sendJson(res, 429, { error: "Too many requests for this session. Please slow down." });
    }
  }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (req.method === "POST" && pathname === "/api/auth/login") {
    const loginLimit = checkRateLimit(`login:${ip}`, RATE_LIMIT_LOGIN_PER_IP_MIN);
    if (!loginLimit.allowed) {
      res._balashiRetryAfterSec = loginLimit.retryAfterSec;
      return sendJson(res, 429, { error: "Too many sign-in attempts. Try again shortly." });
    }
  }

  // GET /api/health -> Database & Table counts
  if (pathname === "/api/health") {
    const gradesCnt = (await db.get("SELECT COUNT(*)::int AS c FROM grades")).c;
    const unitsCnt = (await db.get("SELECT COUNT(*)::int AS c FROM units")).c;
    const topicsCnt = (await db.get("SELECT COUNT(*)::int AS c FROM skill_topics")).c;
    const questionsCnt = (await db.get("SELECT COUNT(*)::int AS c FROM practice_questions")).c;
    const studentsCnt = (await db.get("SELECT COUNT(*)::int AS c FROM students")).c;
    const attemptsCnt = (await db.get("SELECT COUNT(*)::int AS c FROM student_question_attempts")).c;
    const versionRow = await db.get("SELECT version() AS version");

    return sendJson(res, 200, {
      status: "ok",
      databaseEngine: `PostgreSQL (${versionRow?.version?.split(" ").slice(0, 2).join(" ") || "unknown"})`,
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
    const rows = await db.all(
      "SELECT student_id, username, nickname, avatar, age_years, current_grade, created_at FROM students ORDER BY created_at ASC"
    );
    const students = rows.map((r) => ({
      studentId: r.student_id,
      username: r.username,
      nickname: r.nickname,
      avatar: r.avatar,
      ageYears: r.age_years,
      currentGrade: r.current_grade
    }));
    const auth = await getSessionFromRequest(req);
    const ownSummary = auth.session
      ? (await getStudentFullState(auth.session.student_id)).summary
      : undefined;
    return sendJson(res, 200, ownSummary ? { students, ownSummary } : { students });
  }

  // POST /api/auth/login -> Authenticate student by username/PIN (PIN is
  // always required) and issue a session token. Unknown student and wrong
  // PIN return the same 401 to prevent account enumeration.
  if (req.method === "POST" && pathname === "/api/auth/login") {
    readJsonBody(req, res, async (payload, failure) => {
      if (failure?.tooLarge) return sendJson(res, 413, { error: "Request body exceeds the size limit." });
      if (failure?.parseError) return sendJson(res, 400, { error: `Invalid JSON body: ${failure.parseError}` });
      try {
        const pin = String(payload.pin ?? "").trim();
        if (!/^\d{4}$/.test(pin)) {
          return sendJson(res, 401, { error: "Incorrect username or PIN." });
        }

        let stuRow = null;
        if (payload.studentId) {
          stuRow = await db.get("SELECT * FROM students WHERE student_id = $1", [payload.studentId]);
        } else if (payload.username) {
          const uname = String(payload.username).trim().toLowerCase();
          stuRow = await db.get("SELECT * FROM students WHERE LOWER(username) = $1 OR LOWER(nickname) = $2", [uname, uname]);
        }

        if (!stuRow || !verifyPin(pin, stuRow.pin_hash)) {
          return sendJson(res, 401, { error: "Incorrect username or PIN." });
        }

        // Rehash-on-login migration: rows still stored with the legacy
        // unsalted SHA-256 scheme are upgraded to salted scrypt.
        if (isLegacyStoredPin(stuRow.pin_hash)) {
          await db.run("UPDATE students SET pin_hash = $1 WHERE student_id = $2", [hashPinScrypt(pin),
            stuRow.student_id]);
        }

        const now = new Date().toISOString();
        const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
        const token = createSessionToken();

        await db.run("INSERT INTO student_sessions (token, student_id, created_at, expires_at) VALUES ($1, $2, $3, $4)", [token,
          stuRow.student_id,
          now,
          expires]);
        await db.run("UPDATE students SET last_active_at = $1 WHERE student_id = $2", [now, stuRow.student_id]);

        const state = await getStudentFullState(stuRow.student_id);
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
    const auth = await getSessionFromRequest(req);
    if (auth.error) {
      return sendJson(res, 401, { error: auth.error });
    }
    await db.run("DELETE FROM student_sessions WHERE token = $1", [auth.session.token]);
    return sendJson(res, 200, { ok: true });
  }

  // POST /api/students -> Register a new student account in SQLite
  if (req.method === "POST" && pathname === "/api/students") {
    readJsonBody(req, res, async (payload, failure) => {
      if (failure?.tooLarge) return sendJson(res, 413, { error: "Request body exceeds the size limit." });
      if (failure?.parseError) return sendJson(res, 400, { error: `Invalid JSON body: ${failure.parseError}` });
      try {
        const pin = String(payload.pin ?? "").trim();
        if (!/^\d{4}$/.test(pin)) {
          return sendJson(res, 400, { error: "A 4-digit PIN is required to create a student account." });
        }
        const nickname = String(payload.nickname || "Explorer").trim();
        const baseUsername = String(payload.username || nickname).toLowerCase().replace(/[^a-z0-9]/g, "") || "student";
        const existing = await db.get("SELECT student_id FROM students WHERE username = $1", [baseUsername]);
        const username = existing ? `${baseUsername}${Math.floor(100 + Math.random() * 900)}` : baseUsername;
        const gradeId = payload.currentGrade || "kindergarten";
        const ageYears = Number(payload.ageYears) || (gradeId === "pre-k" ? 4 : gradeId === "kindergarten" ? 5 : gradeId === "grade-1" ? 6 : gradeId === "grade-2" ? 7 : 8);
        const avatar = payload.avatar || "🐼";
        const studentId = `stu-${username}-${Date.now().toString().slice(-4)}`;
        const now = new Date().toISOString();

        await db.withTransaction(async (client) => {
          await client.query(`
            INSERT INTO students (
              student_id, username, pin_hash, nickname, avatar, age_years,
              current_grade, motor_baseline_sec, streak_days, star_coins, hearts,
              last_active_at, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 50, 5, $9, $10)
          `, [
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
          ]);

          // Unlock prerequisite grade final units so the chosen grade's Unit 1 is unlocked
          const prereqSeeds = {
            "kindergarten": ["PK-M7", "PK-E7"],
            "grade-1": ["K-M10", "K-E9", "K-S5", "K-SS4"],
            "grade-2": ["G1-M9", "G1-E10", "G1-S5", "G1-SS4"],
            "grade-3": ["G2-M9", "G2-E10", "G2-S6", "G2-SS4"]
          };
          for (const pid of prereqSeeds[gradeId] || []) {
            await client.query(`
              INSERT INTO student_unit_progress (
                student_id, unit_id, status, key_state, best_accuracy_pct,
                best_median_speed_sec, attempts_count, stability_days,
                last_reviewed_at, cpa_stage, updated_at
              ) VALUES ($1, $2, 'MASTERED', 'GOLD_KEY', 90.0, 4.5, 1, 21.0, $3, 'PURE_ABSTRACT_SYMBOLIC', $4)
              ON CONFLICT (student_id, unit_id) DO UPDATE SET
                status = 'MASTERED', key_state = 'GOLD_KEY'
            `, [studentId, pid, now, now]);
          }
        });

        const token = createSessionToken();
        await db.run("INSERT INTO student_sessions (token, student_id, created_at, expires_at) VALUES ($1, $2, $3, $4)", [
          token,
          studentId,
          now,
          new Date(Date.now() + SESSION_TTL_MS).toISOString()
        ]);

        const state = await getStudentFullState(studentId);
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
    if (!(await requireStudentAccess(req, res, studentId))) return;
    const state = await getStudentFullState(studentId);
    if (!state) return sendJson(res, 404, { error: "Student not found" });
    return sendJson(res, 200, state);
  }

  // POST /api/students/:studentId/calibrate -> Update motor baseline in SQLite
  // (session must belong to this student)
  if (req.method === "POST" && pathname.endsWith("/calibrate") && pathname.startsWith("/api/students/")) {
    const studentId = pathname.replace("/api/students/", "").replace("/calibrate", "");
    if (!(await requireStudentAccess(req, res, studentId))) return;
    readJsonBody(req, res, async (payload, failure) => {
      if (failure?.tooLarge) return sendJson(res, 413, { error: "Request body exceeds the size limit." });
      if (failure?.parseError) return sendJson(res, 400, { error: `Invalid JSON body: ${failure.parseError}` });
      try {
        const motorSec = Array.isArray(payload.warmupTapTimesSec)
          ? computeMotorBaselineSec(payload.warmupTapTimesSec)
          : Number(payload.motorBaselineSec || 0.42);
        await db.run("UPDATE students SET motor_baseline_sec = $1 WHERE student_id = $2", [motorSec, studentId]);
        return sendJson(res, 200, await getStudentFullState(studentId));
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    });
    return;
  }

  // GET /api/curriculum/summary -> Query grades, units, and skill_topics from SQLite
  if (pathname === "/api/curriculum/summary") {
    const gradesRows = await db.all("SELECT * FROM grades ORDER BY sequence_order ASC");
    const unitsRows = await db.all("SELECT * FROM units ORDER BY sequence_order ASC");
    const topicsRows = await db.all("SELECT topic_id, unit_id, grade_id, subject, topic_code, topic_name, sequence_order FROM skill_topics ORDER BY sequence_order ASC");
    const questionsCount = (await db.get("SELECT COUNT(*)::int AS c FROM practice_questions")).c;

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

    const unitRow = await db.get("SELECT * FROM units WHERE unit_id = $1", [unitId]);
    const topicRow = await db.get("SELECT * FROM skill_topics WHERE topic_id = $1", [topicId]);
    if (!unitRow || !topicRow) return sendJson(res, 404, { error: `Topic ${topicId} not found in database` });

    const count = Number(url.searchParams.get("count") || 8);
    const qRows = await db.all("SELECT * FROM practice_questions WHERE topic_id = $1 ORDER BY difficulty_level ASC, question_id ASC LIMIT $2", [topicId, count]);

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
    const unitRow = await db.get("SELECT * FROM units WHERE unit_id = $1", [unitId]);
    if (!unitRow) return sendJson(res, 404, { error: `Unit ${unitId} not found in database` });

    const topicRows = await db.all("SELECT * FROM skill_topics WHERE unit_id = $1 ORDER BY sequence_order ASC", [unitId]);
    const count = Number(url.searchParams.get("count") || unitRow.gate_question_count || 12);

    // Stratified selection from SQLite practice_questions across all topics in this unit
    const allUnitQuestions = await db.all("SELECT * FROM practice_questions WHERE unit_id = $1 ORDER BY question_id ASC", [unitId]).map(mapQuestionRow);
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
    readJsonBody(req, res, async (payload, failure) => {
      if (failure?.tooLarge) return sendJson(res, 413, { error: "Request body exceeds the size limit." });
      if (failure?.parseError) return sendJson(res, 400, { error: `Invalid JSON body: ${failure.parseError}` });
      try {
        const studentId = payload.studentId;
        const unitId = payload.unitId;
        const topicCode = payload.topicCode;
        const topicId = `${unitId}-${topicCode}`;

        if (!(await requireStudentAccess(req, res, studentId))) return;

        const stuRow = await db.get("SELECT * FROM students WHERE student_id = $1", [studentId]);
        const unitRow = await db.get("SELECT * FROM units WHERE unit_id = $1", [unitId]);
        const gradeRow = unitRow ? await db.get("SELECT * FROM grades WHERE grade_id = $1", [unitRow.grade_id]) : null;
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

        const prevTopic = await db.get("SELECT * FROM student_topic_progress WHERE student_id = $1 AND topic_id = $2", [studentId, topicId]);
        const fg = computeFluencyGrade(passedTopic, medSpeed, targetSpeed);
        const srUpdate = updateTopicMemoryStability({
          currentStabilityDays: prevTopic ? prevTopic.stability_days : 1.0,
          fluencyGrade: fg,
          gradeGrowthFactor: gradeRow ? gradeRow.sr_growth_factor : 2.0,
          maxIntervalCapDays: gradeRow ? gradeRow.sr_max_interval_days : 45
        });

        const now = new Date().toISOString();
        const nextReview = new Date(Date.now() + srUpdate.stabilityDays * 86400000).toISOString();

        await db.withTransaction(async (client) => {
          // 1. Log every individual question attempt into student_question_attempts
          for (const r of responses) {
            const cSec = computeCognitiveTimeSec(r.rawTimeSec || 3.0, motorSec, 0);
            await client.query(`
              INSERT INTO student_question_attempts (
                student_id, session_type, unit_id, topic_id, question_id,
                chosen_answer, is_correct, raw_time_sec, cognitive_time_sec,
                fluency_grade, misconception_tags_json, attempted_at
              ) VALUES ($1, 'TOPIC_PRACTICE', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            `, [
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
            ]);
          }

          // 2. Upsert student_topic_progress
          await client.query(`
            INSERT INTO student_topic_progress (
              student_id, topic_id, unit_id, topic_code, completed, crowns,
              mastery_score, best_accuracy_pct, best_median_speed_sec,
              attempts_count, fluency_grade, stability_days, next_review_at, last_reviewed_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            ON CONFLICT(student_id, topic_id) DO UPDATE SET
              completed = GREATEST(student_topic_progress.completed, excluded.completed),
              crowns = GREATEST(student_topic_progress.crowns, excluded.crowns),
              mastery_score = GREATEST(student_topic_progress.mastery_score, excluded.mastery_score),
              best_accuracy_pct = GREATEST(student_topic_progress.best_accuracy_pct, excluded.best_accuracy_pct),
              best_median_speed_sec = CASE
                WHEN student_topic_progress.best_median_speed_sec > 0
                THEN LEAST(student_topic_progress.best_median_speed_sec, excluded.best_median_speed_sec)
                ELSE excluded.best_median_speed_sec
              END,
              attempts_count = student_topic_progress.attempts_count + 1,
              fluency_grade = excluded.fluency_grade,
              stability_days = excluded.stability_days,
              next_review_at = excluded.next_review_at,
              last_reviewed_at = excluded.last_reviewed_at
          `, [
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
          ]);

          if (passedTopic) {
            const rewardCoins = 15 + crowns * 5;
            await client.query("UPDATE students SET star_coins = star_coins + $1, last_active_at = $2 WHERE student_id = $3", [rewardCoins, now, studentId]);
          }
        });

        const totalTopicsInUnit = (await db.get("SELECT COUNT(*)::int AS c FROM skill_topics WHERE unit_id = $1", [unitId])).c;
        const completedInUnit = (await db.get("SELECT COUNT(*)::int AS c FROM student_topic_progress WHERE student_id = $1 AND unit_id = $2 AND completed = 1", [studentId, unitId])).c;
        const allTopicsDone = completedInUnit >= totalTopicsInUnit;

        const state = await getStudentFullState(studentId);
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
    readJsonBody(req, res, async (payload, failure) => {
      if (failure?.tooLarge) return sendJson(res, 413, { error: "Request body exceeds the size limit." });
      if (failure?.parseError) return sendJson(res, 400, { error: `Invalid JSON body: ${failure.parseError}` });
      try {
        const studentId = payload.studentId;
        const unitId = payload.unitId;

        if (!(await requireStudentAccess(req, res, studentId))) return;

        const stuRow = await db.get("SELECT * FROM students WHERE student_id = $1", [studentId]);
        const unitRow = await db.get("SELECT * FROM units WHERE unit_id = $1", [unitId]);
        const gradeRow = unitRow ? await db.get("SELECT * FROM grades WHERE grade_id = $1", [unitRow.grade_id]) : null;
        if (!stuRow || !unitRow) return sendJson(res, 404, { error: "Student or Unit not found" });

        const topicRows = await db.all("SELECT * FROM skill_topics WHERE unit_id = $1 ORDER BY sequence_order ASC", [unitId]);
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

        const prevProg = await db.get("SELECT * FROM student_unit_progress WHERE student_id = $1 AND unit_id = $2", [studentId, unitId]);
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

        await db.withTransaction(async (client) => {
          await client.query(`
            INSERT INTO student_unit_progress (
              student_id, unit_id, status, key_state, best_accuracy_pct,
              best_median_speed_sec, attempts_count, stability_days,
              last_reviewed_at, cpa_stage, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $9, $10)
            ON CONFLICT(student_id, unit_id) DO UPDATE SET
              status = CASE WHEN student_unit_progress.status = 'MASTERED' THEN 'MASTERED' ELSE excluded.status END,
              key_state = COALESCE(excluded.key_state, student_unit_progress.key_state),
              best_accuracy_pct = GREATEST(student_unit_progress.best_accuracy_pct, excluded.best_accuracy_pct),
              best_median_speed_sec = CASE
                WHEN student_unit_progress.best_median_speed_sec > 0
                THEN LEAST(student_unit_progress.best_median_speed_sec, excluded.best_median_speed_sec)
                ELSE excluded.best_median_speed_sec
              END,
              attempts_count = student_unit_progress.attempts_count + 1,
              stability_days = excluded.stability_days,
              last_reviewed_at = excluded.last_reviewed_at,
              cpa_stage = excluded.cpa_stage,
              updated_at = excluded.updated_at
          `, [
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
          ]);

          if (evalResult.passed) {
            await client.query("UPDATE students SET star_coins = star_coins + 50, last_active_at = $1 WHERE student_id = $2", [now, studentId]);
          }
        });

        const state = await getStudentFullState(studentId);
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
}

// Last-resort nets: any future unawaited rejection or stray 'error' event
// logs instead of terminating the process (Node's default). Proper
// lifecycle shutdown arrives with the M6 ops work.
process.on("unhandledRejection", (err) => {
  logger.error({ err: err?.message }, "Unhandled rejection");
});
process.on("uncaughtException", (err) => {
  logger.error({ err: err?.message }, "Uncaught exception");
});

const PORT = Number(process.env.PORT || 4000);
server.listen(PORT, "0.0.0.0", () => {
  logger.info(
    {
      port: PORT,
      allowedOrigins: [...ALLOWED_ORIGINS],
      bodyLimitBytes: BODY_LIMIT_BYTES,
      rateLimits: { perIpMin: RATE_LIMIT_PER_IP_MIN, perTokenMin: RATE_LIMIT_PER_TOKEN_MIN, loginPerIpMin: RATE_LIMIT_LOGIN_PER_IP_MIN }
    },
    "Balashikshana API listening"
  );
});
