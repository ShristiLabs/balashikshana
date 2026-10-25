import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import helmet from "@fastify/helmet";
import pino from "pino";
import {
  createDb,
  hashPinScrypt,
  verifyPin,
  isLegacyStoredPin,
  createSessionToken
} from "./db.mjs";
import { sendProblem, PROBLEM_BASE, STATUS_TITLES } from "./problem.mjs";
import { parentAuthPlugin, resolveBearerAuth } from "./parent-auth.mjs";
import {
  consentPlugin,
  requireConsentForStudent,
  requireParentWithCurrentConsent
} from "./consent.mjs";
import { childrenPlugin, insertStudentProfile, PolicyDriftError, sendPolicyDrift } from "./children.mjs";
import { contentPacksPlugin } from "./content-packs.mjs";
import { syncPlugin, RATE_LIMIT_SYNC_PER_TOKEN_MIN } from "./sync.mjs";
import { placementPlugin } from "./placement.mjs";
import { portalPlugin } from "./portal.mjs";
import {
  resolveOptionalStudentId,
  loadChildSettings,
  unitContentVerdict
} from "./enforcement.mjs";
import { gamificationPlugin } from "./gamification.mjs";
import {
  awardAttemptXp,
  awardTopicOutcomeRewards,
  awardGateOutcomeRewards,
  applyStreakForSession,
  evaluateAndAwardBadges
} from "./rewards.mjs";
import {
  deriveTopicSession,
  deriveTopicFluencyAndSr,
  perAttemptFluencyGrade,
  buildGateUnitObject,
  computeKeyTransition,
  TOPIC_PROGRESS_UPSERT_SQL,
  UNIT_PROGRESS_UPSERT_SQL
} from "./derivations.mjs";
import {
  computeMotorBaselineSec,
  computeCognitiveTimeSec,
  evaluateMasteryGateAttempt,
  computeFluencyGrade,
  updateTopicMemoryStability,
  computeRetrievabilityPct
} from "../../packages/core-engine/src/index.mjs";

// --- Environment configuration -------------------------------------------
// PORT                        listen port                        (default 4000)
// DATABASE_URL                PostgreSQL connection string       (default compose dev credentials)
// ALLOWED_ORIGINS             CORS allowlist, comma-separated    (dev default: http://localhost:4200,http://127.0.0.1:4200,
//                                                                http://localhost:4300,http://127.0.0.1:4300 — the last two are
//                                                                the #61 parent-portal dev origins;
//                                                                REQUIRED, non-empty, non-wildcard when NODE_ENV=production)
// NODE_ENV                    "production" enables strict config (case-insensitive; default dev)
// BODY_LIMIT_BYTES            max request body bytes             (default 65536)
// RATE_LIMIT_PER_IP_MIN       general per-IP requests/minute     (default 120)
// RATE_LIMIT_PER_TOKEN_MIN    per-token requests/minute          (default 60)
// RATE_LIMIT_LOGIN_PER_IP_MIN login attempts/minute per IP       (default 10)
// RATE_LIMIT_PARENT_SIGNUP_PER_IP_MIN parent signups/minute per IP  (default 5)
// RATE_LIMIT_PARENT_LOGIN_PER_IP_MIN  parent logins/minute per IP   (default 10)
// RATE_LIMIT_PARENT_TOKEN_PER_IP_MIN  parent token-presenting routes/minute per IP
//                                    (verify-email, reset confirm)  (default 10)
// RATE_LIMIT_PARENT_RESET_PER_IP_MIN  parent reset requests/minute per IP (default 5)
// RATE_LIMIT_PARENT_CLAIM_PER_IP_MIN  child-claim attempts/minute per IP (default 10; the
//                                     claim route verifies student PINs, so it gets the
//                                     M1 login-bucket doctrine)
// RATE_LIMIT_SYNC_PER_TOKEN_MIN       sync requests/minute per device token (default 30;
//                                     #48 — sized for batch traffic, env-tunable)
// SYNC_MAX_ATTEMPTS_PER_BATCH         max attempts per sync batch (default 200)
// SYNC_FUTURE_CLOCK_TOLERANCE_MS      client-clock future tolerance before clamping to
//                                     server time (default 300000 = 5 min; #48 clock policy)
// SEED_DEMO_STUDENTS          seed demo students on an empty DB ("0" disables;
//                             default 1). The consent-invariant suite boots
//                             with "0" so a pristine DB proves the #41 gate.
const IS_PRODUCTION = String(process.env.NODE_ENV || "").toLowerCase() === "production";

function parseAllowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS;
  if (IS_PRODUCTION && (!raw || !raw.trim())) {
    throw new Error("ALLOWED_ORIGINS must be set to an explicit origin list when NODE_ENV=production (wildcards are forbidden).");
  }
  const list = String(raw || "http://localhost:4200,http://127.0.0.1:4200,http://localhost:4300,http://127.0.0.1:4300")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.includes("*")) {
    throw new Error("ALLOWED_ORIGINS must not contain a wildcard; list explicit origins instead.");
  }
  return list;
}

const ALLOWED_ORIGINS = parseAllowedOrigins();
const BODY_LIMIT_BYTES = Number(process.env.BODY_LIMIT_BYTES || 65536);
const RATE_LIMIT_PER_IP_MIN = Number(process.env.RATE_LIMIT_PER_IP_MIN || 120);
const RATE_LIMIT_PER_TOKEN_MIN = Number(process.env.RATE_LIMIT_PER_TOKEN_MIN || 60);
const RATE_LIMIT_LOGIN_PER_IP_MIN = Number(process.env.RATE_LIMIT_LOGIN_PER_IP_MIN || 10);
const RATE_LIMIT_PARENT_SIGNUP_PER_IP_MIN = Number(process.env.RATE_LIMIT_PARENT_SIGNUP_PER_IP_MIN || 5);
const RATE_LIMIT_PARENT_LOGIN_PER_IP_MIN = Number(process.env.RATE_LIMIT_PARENT_LOGIN_PER_IP_MIN || 10);
const RATE_LIMIT_PARENT_TOKEN_PER_IP_MIN = Number(process.env.RATE_LIMIT_PARENT_TOKEN_PER_IP_MIN || 10);
const RATE_LIMIT_PARENT_RESET_PER_IP_MIN = Number(process.env.RATE_LIMIT_PARENT_RESET_PER_IP_MIN || 5);
const RATE_LIMIT_PARENT_CLAIM_PER_IP_MIN = Number(process.env.RATE_LIMIT_PARENT_CLAIM_PER_IP_MIN || 10);
const URL_LENGTH_LIMIT = 2048;
const SESSION_TTL_MS = 30 * 86400000;

const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  base: { service: "balashikshana-api" }
});

const db = await createDb(logger).catch((err) => {
  logger.fatal({ err: err.message }, "Database initialization failed");
  process.exit(1);
});

// Equalizes login timing between unknown-user and wrong-PIN paths so the
// uniform 401 cannot be turned into a username oracle by response time.
const DUMMY_PIN_HASH = hashPinScrypt("timing-equalizer");

// Last-resort nets: any future unawaited rejection or stray 'error' event
// logs instead of terminating the process (Node's default). Proper
// lifecycle shutdown arrives with the M6 ops work.
process.on("unhandledRejection", (err) => {
  logger.error({ err: err?.message }, "Unhandled rejection");
});
process.on("uncaughtException", (err) => {
  logger.error({ err: err?.message }, "Uncaught exception");
});

// --- RFC 9457 problem+json -------------------------------------------------
// Envelope lives in problem.mjs (shared with parent-auth.mjs); re-exported
// here for any existing importer of the server module.

export { sendProblem };

// --- Session authentication ----------------------------------------------
// Every student-scoped route must pass requireStudentAccess, which binds
// the requested studentId to the session token from the Authorization
// header. Missing/unknown/expired/revoked tokens -> 401; a valid token for
// a DIFFERENT student -> 403. Expired rows are lazily deleted on lookup.
//
// Token-kind awareness (issues #40/#42): resolveBearerAuth (parent-auth.mjs)
// resolves the bearer token to a kind — 'student', 'child-device', or
// 'parent'. Student sessions (M1) and child device sessions (#42, minted by
// a parent, scoped to exactly one student + one device) both authenticate
// student-scoped routes for THEIR bound student only; a parent token on a
// student-scoped route is a 403 wrong-token-type problem. Archived child
// profiles fail every student-scoped route (403 child-archived) — the
// archive path must freeze the child's access, not just future mints. The
// public /api/students listing stays lenient: a parent (or unknown) token
// simply yields the public list without an ownSummary, preserving the M1
// contract; student and child-device tokens receive their own summary.

async function getSessionFromRequest(req) {
  const auth = await resolveBearerAuth(db, req.headers.authorization);
  if (auth.error) {
    return { error: auth.error };
  }
  if (auth.kind === "parent") {
    return { wrongType: auth.kind };
  }
  if (auth.kind === "child-device") {
    return { childSession: auth.childSession };
  }
  return { session: auth.session };
}

async function requireStudentAccess(req, reply, studentId) {
  const auth = await getSessionFromRequest(req);
  if (auth.error) {
    sendProblem(reply, 401, { type: `${PROBLEM_BASE}/unauthorized`, detail: auth.error });
    return null;
  }
  if (auth.wrongType) {
    sendProblem(reply, 403, {
      type: `${PROBLEM_BASE}/wrong-token-type`,
      detail: "Parent session tokens cannot access student routes."
    });
    return null;
  }
  const scoped = auth.session || auth.childSession;
  if (scoped.student_id !== studentId) {
    sendProblem(reply, 403, { type: `${PROBLEM_BASE}/forbidden`, detail: "Session does not grant access to this student" });
    return null;
  }
  const stuRow = await db.get("SELECT status FROM students WHERE student_id = $1", [studentId]);
  if (!stuRow || stuRow.status === "archived") {
    sendProblem(reply, 403, {
      type: `${PROBLEM_BASE}/child-archived`,
      detail: "This child profile has been archived by its parent."
    });
    return null;
  }
  req._balashiStudentId = scoped.student_id;
  return scoped;
}

// --- Per-token rate limiting (in-memory fixed window) ------------------------
// @fastify/rate-limit covers the per-IP and login buckets; session tokens
// get their own bucket here because the plugin keys one dimension per route.

const WINDOW_MS = 60000;
const tokenBuckets = new Map();

function checkTokenRateLimit(token, now = Date.now()) {
  if (tokenBuckets.size > 512) {
    for (const [key, bucket] of tokenBuckets) {
      if (now - bucket.windowStart >= WINDOW_MS) tokenBuckets.delete(key);
    }
  }
  const bucket = tokenBuckets.get(token);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    tokenBuckets.set(token, { windowStart: now, count: 1 });
    return { allowed: true, retryAfterSec: 0 };
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_PER_TOKEN_MIN) {
    const resetAt = bucket.windowStart + WINDOW_MS;
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((resetAt - now) / 1000)) };
  }
  return { allowed: true, retryAfterSec: 0 };
}

// --- Helpers ----------------------------------------------------------------

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
      cpaStage: u.cpa_stage,
      // #48 two-key timestamps (authoritative; null = never awarded).
      silverAwardedAt: u.silver_awarded_at ?? null,
      goldVerifiedAt: u.gold_verified_at ?? null
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

// The pre-#31 server trimmed PIN strings before validating them; keep that
// contract so a PIN typed with stray whitespace still authenticates.
function trimPinPreValidation(req, _reply, done) {
  if (req.body && typeof req.body === "object" && typeof req.body.pin === "string") {
    req.body.pin = req.body.pin.trim();
  }
  done();
}

// --- Schemas ----------------------------------------------------------------

const loginSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    anyOf: [{ required: ["username"] }, { required: ["studentId"] }],
    properties: {
      username: { type: "string", minLength: 1, maxLength: 64 },
      studentId: { type: "string", minLength: 1, maxLength: 64 },
      pin: { type: "string", pattern: "^[0-9]{4}$" }
    }
  }
};

const registerSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["pin"],
    properties: {
      nickname: { type: "string", maxLength: 32 },
      username: { type: "string", maxLength: 32 },
      pin: { type: "string", pattern: "^[0-9]{4}$" },
      currentGrade: { type: "string", enum: ["pre-k", "kindergarten", "grade-1", "grade-2", "grade-3"] },
      ageYears: { type: "number", minimum: 3, maximum: 10 },
      avatar: { type: "string", maxLength: 8 }
    }
  }
};

const calibrateSchema = {
  params: {
    type: "object",
    required: ["studentId"],
    properties: { studentId: { type: "string", minLength: 1 } }
  },
  body: {
    type: "object",
    properties: {
      warmupTapTimesSec: { type: "array", items: { type: "number" } },
      motorBaselineSec: { type: "number", minimum: 0, maximum: 5 }
    }
  }
};

const practiceCompleteSchema = {
  body: {
    type: "object",
    required: ["studentId", "unitId", "topicCode"],
    properties: {
      studentId: { type: "string", minLength: 1 },
      unitId: { type: "string", minLength: 1 },
      topicCode: { type: "string", minLength: 1 },
      motorBaselineSec: { type: "number" },
      responses: {
        type: "array",
        items: {
          type: "object",
          properties: {
            questionId: { type: "string" },
            chosenAnswer: { type: ["string", "number"] },
            isCorrect: { type: "boolean" },
            rawTimeSec: { type: "number" },
            misconceptionTags: { type: "array", items: { type: "string" } }
          }
        }
      }
    }
  }
};

const gateEvaluateSchema = {
  body: {
    type: "object",
    required: ["studentId", "unitId"],
    properties: {
      studentId: { type: "string", minLength: 1 },
      unitId: { type: "string", minLength: 1 },
      motorBaselineSec: { type: "number" },
      responses: {
        type: "array",
        items: {
          type: "object",
          properties: {
            topicCode: { type: "string" },
            isCorrect: { type: "boolean" },
            rawTimeSec: { type: "number" }
          }
        }
      }
    }
  }
};

const topicQuerySchema = {
  querystring: {
    type: "object",
    properties: {
      count: { type: "integer", minimum: 1, maximum: 50, default: 8 }
    }
  }
};

// --- Fastify app ---------------------------------------------------------------

const app = Fastify({
  logger: false,
  disableRequestLogging: true,
  genReqId: () => crypto.randomUUID(),
  bodyLimit: BODY_LIMIT_BYTES,
  // Keep the schemas closed: unknown body fields are a 400 validation
  // error (the additionalProperties: false declarations), not silently
  // stripped by Ajv's default removeAdditional behavior.
  ajv: { customOptions: { removeAdditional: false } }
});

await app.register(helmet, { contentSecurityPolicy: false });

// OPTIONS parity with the raw-http server this replaces: preflights from a
// disallowed origin are rejected outright (tested behavior), and OPTIONS
// requests without an Origin header (curl probes) short-circuit to 204.
// This hook runs before @fastify/cors registers its own OPTIONS handling.
app.addHook("onRequest", async (req, reply) => {
  const origin = req.headers.origin;
  if (req.method !== "OPTIONS") return;
  // Preflight short-circuits below never reach the second hook, so the
  // request id must be stamped here as well (every reply carries one).
  reply.header("X-Request-Id", req.id);
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return sendProblem(reply, 403, { type: `${PROBLEM_BASE}/origin-not-allowed`, detail: "Origin is not allowed." });
  }
  if (!origin) {
    return reply.code(204).send();
  }
});

await app.register(cors, {
  origin: (origin, cb) => cb(null, ALLOWED_ORIGINS.includes(origin || "")),
  credentials: false,
  methods: ["GET", "POST", "PUT", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
});

await app.register(rateLimit, {
  global: true,
  max: RATE_LIMIT_PER_IP_MIN,
  timeWindow: "1 minute",
  keyGenerator: (req) => req.ip,
  addHeaders: {
    "x-ratelimit-limit": false,
    "x-ratelimit-remaining": false,
    "x-ratelimit-reset": false,
    "retry-after": true
  }
});

app.addHook("onRequest", async (req, reply) => {
  req._balashiStartedAt = Date.now();
  reply.header("X-Request-Id", req.id);

  if ((req.raw.url || "").length > URL_LENGTH_LIMIT) {
    return sendProblem(reply, 414, { type: `${PROBLEM_BASE}/uri-too-long`, detail: "Request URL exceeds the length limit." });
  }

  const authHeader = req.headers.authorization || "";
  if (/^Bearer [A-Za-z0-9_-]+$/.test(authHeader)) {
    const tokenLimit = checkTokenRateLimit(authHeader.split(" ")[1]);
    if (!tokenLimit.allowed) {
      return sendProblem(reply, 429, {
        type: `${PROBLEM_BASE}/rate-limited`,
        detail: "Too many requests for this session. Please slow down.",
        retryAfterSec: tokenLimit.retryAfterSec
      });
    }
  }
});

app.addHook("onResponse", (req, reply, done) => {
  logger.info(
    {
      requestId: req.id,
      method: req.method,
      url: req.raw.url,
      statusCode: reply.statusCode,
      durationMs: Date.now() - (req._balashiStartedAt || Date.now()),
      ip: req.ip,
      studentId: req._balashiStudentId || undefined,
      parentId: req._balashiParentId || undefined
    },
    "request"
  );
  done();
});

app.setErrorHandler((err, req, reply) => {
  if (err.validation) {
    return sendProblem(reply, 400, {
      type: `${PROBLEM_BASE}/validation`,
      title: "Validation failed",
      detail: "The request did not match the required schema.",
      errors: err.validation
    });
  }
  if (err.code === "FST_ERR_CTP_BODY_TOO_LARGE" || err.statusCode === 413) {
    return sendProblem(reply, 413, { type: `${PROBLEM_BASE}/payload-too-large`, detail: "Request body exceeds the size limit." });
  }
  if (err.statusCode === 429) {
    return sendProblem(reply, 429, {
      type: `${PROBLEM_BASE}/rate-limited`,
      detail: err.message || "Too many requests. Please slow down."
    });
  }
  if (err.statusCode >= 400 && err.statusCode < 500 && err.statusCode !== 401) {
    return sendProblem(reply, err.statusCode, { detail: err.message });
  }
  if (err.statusCode === 401) {
    return sendProblem(reply, 401, { type: `${PROBLEM_BASE}/unauthorized`, detail: err.message || STATUS_TITLES[401] });
  }
  logger.error({ err: err.message, requestId: req.id }, "Unhandled request error");
  return sendProblem(reply, 500, { type: `${PROBLEM_BASE}/internal`, detail: "Internal server error." });
});

app.setNotFoundHandler((req, reply) => {
  sendProblem(reply, 404, { type: `${PROBLEM_BASE}/not-found`, detail: "Route not found" });
});

// Parent auth routes (issue #40): signup/verify-email/login/refresh/
// logout/logout-all/password-reset. Registered after the global plugins so
// helmet, CORS, and the rate-limit buckets apply. refresh/logout/logout-all
// carry bearer tokens and sit behind the global per-IP + per-token buckets;
// the token-guessing and email-harvesting routes get dedicated route-level
// buckets (M1 login-bucket pattern).
await app.register(parentAuthPlugin, {
  db,
  isProduction: IS_PRODUCTION,
  logger,
  rateLimits: {
    signup: { max: RATE_LIMIT_PARENT_SIGNUP_PER_IP_MIN, timeWindow: "1 minute" },
    login: { max: RATE_LIMIT_PARENT_LOGIN_PER_IP_MIN, timeWindow: "1 minute" },
    token: { max: RATE_LIMIT_PARENT_TOKEN_PER_IP_MIN, timeWindow: "1 minute" },
    reset: { max: RATE_LIMIT_PARENT_RESET_PER_IP_MIN, timeWindow: "1 minute" }
  }
});

// Consent routes (issue #41): policy/latest (public), records capture, and
// status. Same bucket posture as the parent-auth bearer routes (global
// per-IP + per-token); none is a token-guessing surface.
await app.register(consentPlugin, { db, isProduction: IS_PRODUCTION, logger });

// Child-profile routes (issue #42): parent-scoped children list/create,
// legacy claim-or-archive, and child device-session mint/revoke. All sit
// behind the global per-IP + per-token buckets except claim, which
// verifies student PINs and gets the M1 login-bucket doctrine.
await app.register(childrenPlugin, {
  db,
  rateLimits: {
    claim: { max: RATE_LIMIT_PARENT_CLAIM_PER_IP_MIN, timeWindow: "1 minute" }
  }
});

// Content-pack hosting (issue #46): serves the compiled, signed per-grade
// pack manifest + artifacts from the content-pipeline output directory.
// Read-only; the global per-IP bucket is sufficient (pack downloads are
// rare, large responses — a dedicated bucket would only add config).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
await app.register(contentPacksPlugin, {
  packsDir: process.env.BALASHIKSHANA_CONTENT_PACKS_DIR || path.join(__dirname, "content-packs"),
  problemTypeBase: PROBLEM_BASE,
  logger,
  db
});

// Sync protocol routes (issue #48, D8): child-device-token batch upload
// + authoritative snapshot. Behind the global per-IP + per-token buckets
// plus the dedicated sync per-token bucket (batch traffic sizing).
await app.register(syncPlugin, {
  db,
  logger,
  packsDir: process.env.BALASHIKSHANA_CONTENT_PACKS_DIR || path.join(__dirname, "content-packs")
});

// Gamification ledger read (issue #55, D9): the kid-facing reward view.
// Student-scoped read auth (like GET /api/students/:id); everything
// displayed is engine-derived.
await app.register(gamificationPlugin, { db });

// Placement record read (issue #60, E10): the authoritative placement
// outcome per (student, grade), derived by the sync reconciler from the
// PLACEMENT attempt stream. Child-device tokens only (sync doctrine).
await app.register(placementPlugin, { db });

// Parent portal API (issue #61, M5): children overview, quadrant +
// weekly analytics, and per-child settings (time limits, content
// controls, notification defaults). Parent session tokens only; the
// ownership guard resolves children through parent_children. Behind the
// global per-IP + per-token buckets (every route presents a bearer).
await app.register(portalPlugin, { db });

// --- Routes --------------------------------------------------------------------

app.get("/api/health", async () => {
  const counts = (
    await db.get(`
      SELECT
        (SELECT COUNT(*)::int FROM grades) AS grades,
        (SELECT COUNT(*)::int FROM units) AS units,
        (SELECT COUNT(*)::int FROM skill_topics) AS topics,
        (SELECT COUNT(*)::int FROM practice_questions) AS questions,
        (SELECT COUNT(*)::int FROM students) AS students,
        (SELECT COUNT(*)::int FROM student_question_attempts) AS attempts
    `)
  );
  const versionRow = await db.get("SELECT version() AS version");

  return {
    status: "ok",
    databaseEngine: `PostgreSQL (${versionRow?.version?.split(" ").slice(0, 2).join(" ") || "unknown"})`,
    totalGrades: counts.grades,
    totalUnits: counts.units,
    totalSkillTopics: counts.topics,
    totalPracticeQuestionsInDb: counts.questions,
    totalStudentsInDb: counts.students,
    totalQuestionAttemptsInDb: counts.attempts
  };
});

// GET /api/students -> Profile cards for the login screen. Without a valid
// session only public profile fields are returned (no progress data); with
// a valid student or child-device session the caller also receives its own
// full summary. Archived child profiles are excluded (#42: archived
// students disappear from the login-screen listing).
app.get("/api/students", async (req, reply) => {
  const rows = await db.all(
    "SELECT student_id, username, nickname, avatar, age_years, current_grade FROM students WHERE status <> 'archived' ORDER BY created_at ASC"
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
  if (auth.session || auth.childSession) {
    const ownId = (auth.session || auth.childSession).student_id;
    const own = await getStudentFullState(ownId);
    req._balashiStudentId = ownId;
    return { students, ownSummary: own.summary };
  }
  return { students };
});

// POST /api/auth/login -> PIN is always required; unknown student and wrong
// PIN return the same 401 problem to prevent account enumeration (including
// timing, via the dummy scrypt verification on the unknown-user path).
app.post(
  "/api/auth/login",
  {
    schema: loginSchema,
    preValidation: trimPinPreValidation,
    config: { rateLimit: { max: RATE_LIMIT_LOGIN_PER_IP_MIN, timeWindow: "1 minute" } }
  },
  async (req, reply) => {
    const payload = req.body;
    let stuRow = null;
    if (payload.studentId) {
      stuRow = await db.get("SELECT * FROM students WHERE student_id = $1", [payload.studentId]);
    } else if (payload.username) {
      const uname = String(payload.username).trim().toLowerCase();
      stuRow = await db.get("SELECT * FROM students WHERE LOWER(username) = $1 OR LOWER(nickname) = $2", [uname, uname]);
    }

    // Archived child profiles (#42) log in exactly like unknown students —
    // same 401 body, same dummy-verify timing — so archive state is not an
    // enumeration oracle.
    if (!stuRow || stuRow.status === "archived") {
      verifyPin(String(payload.pin ?? ""), DUMMY_PIN_HASH);
      return sendProblem(reply, 401, { type: `${PROBLEM_BASE}/unauthorized`, detail: "Incorrect username or PIN." });
    }
    if (!verifyPin(String(payload.pin ?? ""), stuRow.pin_hash)) {
      return sendProblem(reply, 401, { type: `${PROBLEM_BASE}/unauthorized`, detail: "Incorrect username or PIN." });
    }

    // Rehash-on-login migration: rows still stored with the legacy
    // unsalted SHA-256 scheme are upgraded to salted scrypt.
    if (isLegacyStoredPin(stuRow.pin_hash)) {
      await db.run("UPDATE students SET pin_hash = $1 WHERE student_id = $2", [hashPinScrypt(payload.pin), stuRow.student_id]);
    }

    const now = new Date().toISOString();
    const token = createSessionToken();
    await db.run("INSERT INTO student_sessions (token, student_id, created_at, expires_at) VALUES ($1, $2, $3, $4)", [
      token,
      stuRow.student_id,
      now,
      new Date(Date.now() + SESSION_TTL_MS).toISOString()
    ]);
    await db.run("UPDATE students SET last_active_at = $1 WHERE student_id = $2", [now, stuRow.student_id]);
    req._balashiStudentId = stuRow.student_id;

    const state = await getStudentFullState(stuRow.student_id);
    return reply.code(200).send({ token, student: state.student, summary: state.summary });
  }
);

// POST /api/auth/logout -> Revoke the caller's session token. Parent and
// child-device tokens cannot be revoked here (they are not student_sessions
// rows; their own logout/revoke surfaces are /api/parents/logout and the
// parent-side device-session DELETE). Before the #44 guard, a parent token
// fell through to auth.session.token and crashed with a 500 (fail closed,
// but as an unstructured error); the 403 mirrors requireStudentAccess's
// wrong-type doctrine.
app.post("/api/auth/logout", async (req, reply) => {
  const auth = await getSessionFromRequest(req);
  if (auth.error) {
    return sendProblem(reply, 401, { type: `${PROBLEM_BASE}/unauthorized`, detail: auth.error });
  }
  if (auth.wrongType || auth.childSession) {
    return sendProblem(reply, 403, {
      type: `${PROBLEM_BASE}/wrong-token-type`,
      detail: "Parent and child device tokens cannot be revoked at this route; use /api/parents/logout or the parent device-session revoke."
    });
  }
  await db.run("DELETE FROM student_sessions WHERE token = $1", [auth.session.token]);
  return { ok: true };
});

// POST /api/students -> Register a new student account.
//
// Consent-required middleware (issue #41, the M2 hard gate): child-data
// creation now requires a VERIFIED parent session whose latest consent
// record matches the active policy version. Since #42 the creation
// transaction also inserts the parent_children binding (every new student
// is claimed by its creating parent — no new standalone students can appear
// post-migration-005) and re-checks the active policy version INSIDE the
// transaction (the #41 TOCTOU advisory). The student row, unlock seeds,
// binding, and consent binding row all live in children.mjs's shared
// insertStudentProfile — the same core POST /api/parent/children uses. The
// 201 response contract is unchanged.
//
// Note: /api/students/:studentId/calibrate is deliberately NOT gated — it
// creates no rows (UPDATE only, on a student already scoped by
// requireStudentAccess); the invariant guards row CREATION.
app.post("/api/students", { schema: registerSchema, preValidation: trimPinPreValidation }, async (req, reply) => {
  const gate = await requireParentWithCurrentConsent(db, req, reply);
  if (!gate) return reply;

  const payload = req.body;
  const nickname = String(payload.nickname || "Explorer").trim();
  const baseUsername = String(payload.username || nickname).toLowerCase().replace(/[^a-z0-9]/g, "") || "student";
  // Bounded retry: if the base name (or a randomly drawn suffix) is already
  // taken, draw again instead of letting the insert blow up as a 500.
  let username = baseUsername;
  let existing = await db.get("SELECT student_id FROM students WHERE username = $1", [username]);
  for (let attempt = 0; existing && attempt < 8; attempt += 1) {
    username = `${baseUsername}${Math.floor(100 + Math.random() * 900)}`;
    existing = await db.get("SELECT student_id FROM students WHERE username = $1", [username]);
  }
  const gradeId = payload.currentGrade || "kindergarten";
  const ageYears = Number(payload.ageYears) || (gradeId === "pre-k" ? 4 : gradeId === "kindergarten" ? 5 : gradeId === "grade-1" ? 6 : gradeId === "grade-2" ? 7 : 8);
  const avatar = payload.avatar || "\u{1F43C}";
  const studentId = `stu-${username}-${Date.now().toString().slice(-4)}`;
  const now = new Date().toISOString();

  try {
    await db.withTransaction(async (client) => {
      await insertStudentProfile(client, {
        studentId,
        username,
        pin: payload.pin,
        nickname,
        avatar,
        ageYears,
        gradeId,
        motorBaselineSec: ageYears <= 4 ? 0.55 : ageYears <= 6 ? 0.44 : 0.34,
        nowIso: now,
        parentId: gate.parentSession.parent_id,
        relation: "guardian",
        policyVersion: gate.policy.version,
        standingMethod: gate.standing.method
      });
    });
  } catch (err) {
    if (err instanceof PolicyDriftError) return sendPolicyDrift(reply, err);
    throw err;
  }

  const token = createSessionToken();
  await db.run("INSERT INTO student_sessions (token, student_id, created_at, expires_at) VALUES ($1, $2, $3, $4)", [
    token,
    studentId,
    now,
    new Date(Date.now() + SESSION_TTL_MS).toISOString()
  ]);
  req._balashiStudentId = studentId;

  const state = await getStudentFullState(studentId);
  return reply.code(201).send({ token, student: state.student, summary: state.summary });
});

// GET /api/students/:studentId -> Full state (session must own this student)
app.get(
  "/api/students/:studentId",
  {
    schema: {
      params: { type: "object", required: ["studentId"], properties: { studentId: { type: "string", minLength: 1 } } }
    }
  },
  async (req, reply) => {
    if (!(await requireStudentAccess(req, reply, req.params.studentId))) return reply;
    const state = await getStudentFullState(req.params.studentId);
    if (!state) {
      return sendProblem(reply, 404, { type: `${PROBLEM_BASE}/not-found`, detail: "Student not found" });
    }
    return state;
  }
);

// POST /api/students/:studentId/calibrate -> Update motor baseline
app.post("/api/students/:studentId/calibrate", { schema: calibrateSchema }, async (req, reply) => {
  if (!(await requireStudentAccess(req, reply, req.params.studentId))) return reply;
  const payload = req.body;
  const motorSec = Array.isArray(payload.warmupTapTimesSec)
    ? computeMotorBaselineSec(payload.warmupTapTimesSec)
    : Number(payload.motorBaselineSec || 0.42);
  await db.run("UPDATE students SET motor_baseline_sec = $1 WHERE student_id = $2", [motorSec, req.params.studentId]);
  return getStudentFullState(req.params.studentId);
});

// GET /api/curriculum/summary -> Grades, units, topics overview
app.get("/api/curriculum/summary", async () => {
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

  return {
    summary: {
      totalGrades: gradesRows.length,
      totalUnits: unitsRows.length,
      totalSkillTopics: topicsRows.length,
      totalPracticeQuestionsInDb: questionsCount
    },
    grades
  };
});

// GET /api/practice/topic/:unitId/:topicCode -> Stored practice questions
app.get(
  "/api/practice/topic/:unitId/:topicCode",
  {
    schema: {
      params: {
        type: "object",
        required: ["unitId", "topicCode"],
        properties: { unitId: { type: "string", minLength: 1 }, topicCode: { type: "string", minLength: 1 } }
      },
      ...topicQuerySchema
    }
  },
  async (req, reply) => {
    const { unitId, topicCode } = req.params;
    const topicId = `${unitId}-${topicCode}`;

    const unitRow = await db.get("SELECT * FROM units WHERE unit_id = $1", [unitId]);
    const topicRow = await db.get("SELECT * FROM skill_topics WHERE topic_id = $1", [topicId]);
    if (!unitRow || !topicRow) {
      return sendProblem(reply, 404, { type: `${PROBLEM_BASE}/not-found`, detail: `Topic ${topicId} not found in database` });
    }

    // #61 parent content controls — enforced server-side when the caller
    // is a known child (student PIN session or child-device token): a
    // gated subject or an above-ceiling grade returns the SAME response
    // shape with ZERO questions plus the restriction reason (the issue
    // AC: "a gated subject returns no questions"). Anonymous dev-harness
    // callers are unchanged; controls gate the child's authenticated
    // experience, not curriculum secrecy (packs are public artifacts).
    const optionalStudentId = await resolveOptionalStudentId(db, req.headers.authorization);
    if (optionalStudentId) {
      const controls = await loadChildSettings(db, optionalStudentId);
      const verdict = unitContentVerdict(controls, { subject: unitRow.subject, gradeId: unitRow.grade_id });
      if (verdict.restricted) {
        return {
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
          practiceProblems: [],
          contentRestricted: true,
          contentRestrictedReason: verdict.reason
        };
      }
    }

    const count = Number(req.query.count || 8);
    const qRows = await db.all(
      "SELECT * FROM practice_questions WHERE topic_id = $1 ORDER BY difficulty_level ASC, question_id ASC LIMIT $2",
      [topicId, count]
    );

    return {
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
    };
  }
);

// GET /api/curriculum/unit/:unitId -> Unit + stratified Boss Gate questions
app.get(
  "/api/curriculum/unit/:unitId",
  {
    schema: {
      params: { type: "object", required: ["unitId"], properties: { unitId: { type: "string", minLength: 1 } } },
      querystring: { type: "object", properties: { count: { type: "integer", minimum: 1, maximum: 50 } } }
    }
  },
  async (req, reply) => {
    const unitId = req.params.unitId;
    const unitRow = await db.get("SELECT * FROM units WHERE unit_id = $1", [unitId]);
    if (!unitRow) {
      return sendProblem(reply, 404, { type: `${PROBLEM_BASE}/not-found`, detail: `Unit ${unitId} not found` });
    }

    // #61 parent content controls — same doctrine as the topic route:
    // a gated child caller gets the unit view with ZERO questions.
    const optionalStudentId = await resolveOptionalStudentId(db, req.headers.authorization);
    if (optionalStudentId) {
      const controls = await loadChildSettings(db, optionalStudentId);
      const verdict = unitContentVerdict(controls, { subject: unitRow.subject, gradeId: unitRow.grade_id });
      if (verdict.restricted) {
        return {
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
            skillTopics: []
          },
          generatedQuestions: [],
          contentRestricted: true,
          contentRestrictedReason: verdict.reason
        };
      }
    }

    const topicRows = await db.all("SELECT * FROM skill_topics WHERE unit_id = $1 ORDER BY sequence_order ASC", [unitId]);
    const count = Number(req.query.count || unitRow.gate_question_count || 12);

    const allUnitQuestions = (
      await db.all("SELECT * FROM practice_questions WHERE unit_id = $1 ORDER BY question_id ASC", [unitId])
    ).map(mapQuestionRow);
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

    return {
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
    };
  }
);

// POST /api/practice/topic/complete -> Persist completion & attempts
app.post("/api/practice/topic/complete", { schema: practiceCompleteSchema }, async (req, reply) => {
  const payload = req.body;
  const studentId = payload.studentId;
  const unitId = payload.unitId;
  const topicCode = payload.topicCode;
  const topicId = `${unitId}-${topicCode}`;

  if (!(await requireStudentAccess(req, reply, studentId))) return reply;

  const stuRow = await db.get("SELECT * FROM students WHERE student_id = $1", [studentId]);
  const unitRow = await db.get("SELECT * FROM units WHERE unit_id = $1", [unitId]);
  const gradeRow = unitRow ? await db.get("SELECT * FROM grades WHERE grade_id = $1", [unitRow.grade_id]) : null;
  if (!stuRow || !unitRow) {
    return sendProblem(reply, 404, { type: `${PROBLEM_BASE}/not-found`, detail: "Student or Unit not found" });
  }

  // Consent-required middleware (#41): refuse progress writes for a student
  // without current-version consent — nothing is written (legacy standalone
  // students hit this until #42's claim-or-archive).
  if (!(await requireConsentForStudent(db, req, reply, studentId))) return reply;

  const responses = payload.responses || [];
  const motorSec = payload.motorBaselineSec || stuRow.motor_baseline_sec || 0.42;
  const targetSpeed = unitRow.gate_max_speed_sec;

  // Shared derivation (derivations.mjs — the single source of truth the
  // #48 sync reconciler reuses; the mobile projector mirrors it).
  const derivation = deriveTopicSession({ responses, motorBaselineSec: motorSec, targetSpeed });
  const { accPct, medSpeed, passedTopic, crowns } = derivation;

  const prevTopic = await db.get("SELECT * FROM student_topic_progress WHERE student_id = $1 AND topic_id = $2", [studentId, topicId]);
  const { fg, srUpdate } = deriveTopicFluencyAndSr({
    passedTopic,
    medSpeed,
    targetSpeed,
    prevStabilityDays: prevTopic ? prevTopic.stability_days : 1.0,
    gradeRow
  });

  const now = new Date().toISOString();
  const nextReview = new Date(Date.now() + srUpdate.stabilityDays * 86400000).toISOString();
  // Every online completion gets a session id so all its attempt rows
  // belong to exactly one session (#48 session-granular ledger).
  const onlineSessionId = `online-${crypto.randomUUID()}`;
  // #55: engine-derived reward totals for the response (additive fields).
  const rewardTotals = { xp: 0, coins: 0 };

  await db.withTransaction(async (client) => {
    let attemptIndex = 0;
    for (const r of responses) {
      const cSec = computeCognitiveTimeSec(r.rawTimeSec || 3.0, motorSec, 0);
      const attemptGrade = perAttemptFluencyGrade(r.isCorrect, cSec, targetSpeed);
      await client.query(`
        INSERT INTO student_question_attempts (
          student_id, session_type, unit_id, topic_id, question_id,
          chosen_answer, is_correct, raw_time_sec, cognitive_time_sec,
          fluency_grade, misconception_tags_json, attempted_at,
          audio_duration_sec, session_id
        ) VALUES ($1, 'TOPIC_PRACTICE', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 0, $12)
      `, [
        studentId,
        unitId,
        topicId,
        r.questionId || `${topicId}-Q1`,
        String(r.chosenAnswer ?? ""),
        r.isCorrect ? 1 : 0,
        r.rawTimeSec || 3.0,
        cSec,
        attemptGrade,
        JSON.stringify(r.misconceptionTags || []),
        now,
        onlineSessionId
      ]);
      // #55: per-attempt XP from the shared engine rules (online path —
      // every call is a fresh session, so no dedupe collisions).
      rewardTotals.xp += await awardAttemptXp(client, {
        studentId,
        sessionType: "TOPIC_PRACTICE",
        sessionId: onlineSessionId,
        unitId,
        topicId,
        isCorrect: Boolean(r.isCorrect),
        fluencyGrade: attemptGrade,
        awardedAtIso: now,
        dedupeKey: `att:${onlineSessionId}:${attemptIndex}`
      });
      attemptIndex += 1;
    }

    await client.query(TOPIC_PROGRESS_UPSERT_SQL, [
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
      now,
      1
    ]);

    // #55 (D9): outcome XP + coins via the shared engine formulas (the
    // pre-#55 inline topic coin award is now engine-owned in
    // rewards.mjs — identical amounts, one source), the streak day
    // transition, and badge evaluation — all inside the same transaction
    // (attempts, progress, and rewards commit atomically).
    const outcome = await awardTopicOutcomeRewards(client, {
      studentId,
      sessionType: "TOPIC_PRACTICE",
      sessionId: onlineSessionId,
      unitId,
      topicId,
      passed: passedTopic,
      crowns,
      awardedAtIso: now,
      dedupeKey: `out:${onlineSessionId}:${topicId}`
    });
    await applyStreakForSession(client, { studentId, sessionMs: Date.now() });
    await evaluateAndAwardBadges(client, { studentId });
    rewardTotals.xp += outcome.xp;
    rewardTotals.coins += outcome.coins;
  });

  const totalTopicsInUnit = (await db.get("SELECT COUNT(*)::int AS c FROM skill_topics WHERE unit_id = $1", [unitId])).c;
  const completedInUnit = (
    await db.get("SELECT COUNT(*)::int AS c FROM student_topic_progress WHERE student_id = $1 AND unit_id = $2 AND completed = 1", [studentId, unitId])
  ).c;
  const allTopicsDone = completedInUnit >= totalTopicsInUnit;

  const state = await getStudentFullState(studentId);
  return {
    passedTopic,
    crownsAwarded: crowns,
    accuracyPct: accPct,
    medianCogSpeedSec: medSpeed,
    targetSpeedSec: targetSpeed,
    bossGateUnlocked: allTopicsDone,
    spacedRepetition: srUpdate,
    student: state.student,
    summary: state.summary,
    xpAwarded: rewardTotals.xp,
    coinsAwarded: rewardTotals.coins
  };
});

// POST /api/gate/evaluate -> Evaluate Unit Boss Gate & persist mastery
app.post("/api/gate/evaluate", { schema: gateEvaluateSchema }, async (req, reply) => {
  const payload = req.body;
  const studentId = payload.studentId;
  const unitId = payload.unitId;

  if (!(await requireStudentAccess(req, reply, studentId))) return reply;

  const stuRow = await db.get("SELECT * FROM students WHERE student_id = $1", [studentId]);
  const unitRow = await db.get("SELECT * FROM units WHERE unit_id = $1", [unitId]);
  const gradeRow = unitRow ? await db.get("SELECT * FROM grades WHERE grade_id = $1", [unitRow.grade_id]) : null;
  if (!stuRow || !unitRow) {
    return sendProblem(reply, 404, { type: `${PROBLEM_BASE}/not-found`, detail: "Student or Unit not found" });
  }

  // Consent-required middleware (#41): refuse unit-progress writes for a
  // student without current-version consent — nothing is written.
  if (!(await requireConsentForStudent(db, req, reply, studentId))) return reply;

  const topicRows = await db.all("SELECT * FROM skill_topics WHERE unit_id = $1 ORDER BY sequence_order ASC", [unitId]);
  const unitObj = buildGateUnitObject({ unitRow: unitRow, topicRows });

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

  // TWO-KEY MACHINE (#48 port of the #47 registry contract): a pass
  // awards (re-affirms) Silver; Gold is ONLY reachable through a Gold
  // verification session (see the sync reconciler). The pre-#48
  // second-pass GOLD promotion is retired — the window freezes at the
  // FIRST Silver award and never resets.
  const keyTransition = computeKeyTransition({
    prev: prevProg,
    passed: evalResult.passed,
    sessionMs: Date.now()
  });
  const nextKeyState = keyTransition.keyState;

  const now = new Date().toISOString();
  // Session id for the gate attempts this evaluation logs (#48: the
  // online path now feeds the same session-granular attempt ledger the
  // offline sync uploads into).
  const onlineSessionId = `online-${crypto.randomUUID()}`;
  // #55: engine-derived reward totals for the response (additive fields).
  const rewardTotals = { xp: 0, coins: 0 };

  await db.withTransaction(async (client) => {
    let attemptIndex = 0;
    for (const r of payload.responses || []) {
      const cSec = computeCognitiveTimeSec(r.rawTimeSec || 3.0, motorSec, r.audioDurationSec || 0);
      const attemptGrade = perAttemptFluencyGrade(r.isCorrect, cSec, unitRow.gate_max_speed_sec);
      await client.query(`
        INSERT INTO student_question_attempts (
          student_id, session_type, unit_id, topic_id, question_id,
          chosen_answer, is_correct, raw_time_sec, cognitive_time_sec,
          fluency_grade, misconception_tags_json, attempted_at,
          audio_duration_sec, session_id
        ) VALUES ($1, 'GATE', $2, $3, $4, '', $5, $6, $7, $8, '[]', $9, $10, $11)
      `, [
        studentId,
        unitId,
        `${unitId}-${r.topicCode}`,
        `${unitId}-${r.topicCode}-GATE`,
        r.isCorrect ? 1 : 0,
        r.rawTimeSec || 3.0,
        cSec,
        attemptGrade,
        now,
        r.audioDurationSec || 0,
        onlineSessionId
      ]);
      // #55: per-attempt XP from the shared engine rules (online path).
      rewardTotals.xp += await awardAttemptXp(client, {
        studentId,
        sessionType: "GATE",
        sessionId: onlineSessionId,
        unitId,
        topicId: `${unitId}-${r.topicCode}`,
        isCorrect: Boolean(r.isCorrect),
        fluencyGrade: attemptGrade,
        awardedAtIso: now,
        dedupeKey: `att:${onlineSessionId}:${attemptIndex}`
      });
      attemptIndex += 1;
    }

    await client.query(UNIT_PROGRESS_UPSERT_SQL, [
      studentId,
      unitId,
      evalResult.passed ? "MASTERED" : "REMEDIATION_REQUIRED",
      nextKeyState,
      // Empty-attempt evaluations omit these fields; Postgres rejects
      // undefined parameters and the columns are NOT NULL — coerce to the
      // schema default 0 (found by issue #32 tests).
      evalResult.overallAccuracyPct ?? 0,
      evalResult.medianCogSpeedSec ?? 0,
      srUpdate.stabilityDays,
      now,
      srUpdate.cpaStage,
      now,
      keyTransition.silverAwardedAtMs > 0 ? new Date(keyTransition.silverAwardedAtMs).toISOString() : null,
      keyTransition.goldVerifiedAtMs > 0 ? new Date(keyTransition.goldVerifiedAtMs).toISOString() : null,
      1
    ]);

    // #55 (D9): gate outcome XP + the historical 50-coin award via the
    // shared engine formulas (the pre-#55 literal is now engine-owned in
    // rewards.mjs — identical amounts, one source), the streak day
    // transition, and badge evaluation — same transaction as the
    // attempts and the unit progress.
    const outcome = await awardGateOutcomeRewards(client, {
      studentId,
      sessionId: onlineSessionId,
      unitId,
      passed: evalResult.passed,
      awardedAtIso: now,
      dedupeKey: `out:${onlineSessionId}:${unitId}`
    });
    await applyStreakForSession(client, { studentId, sessionMs: Date.now() });
    await evaluateAndAwardBadges(client, { studentId });
    rewardTotals.xp += outcome.xp;
    rewardTotals.coins += outcome.coins;
  });

  const state = await getStudentFullState(studentId);
  return {
    student: state.student,
    summary: state.summary,
    evaluation: { ...evalResult, keyAwarded: nextKeyState },
    spacedRepetition: srUpdate,
    xpAwarded: rewardTotals.xp,
    coinsAwarded: rewardTotals.coins
  };
});

// --- Start ------------------------------------------------------------------------

const PORT = Number(process.env.PORT || 4000);
app
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => {
    logger.info(
      {
        port: PORT,
        allowedOrigins: ALLOWED_ORIGINS,
        bodyLimitBytes: BODY_LIMIT_BYTES,
        rateLimits: {
          perIpMin: RATE_LIMIT_PER_IP_MIN,
          perTokenMin: RATE_LIMIT_PER_TOKEN_MIN,
          loginPerIpMin: RATE_LIMIT_LOGIN_PER_IP_MIN,
          parentSignupPerIpMin: RATE_LIMIT_PARENT_SIGNUP_PER_IP_MIN,
          parentLoginPerIpMin: RATE_LIMIT_PARENT_LOGIN_PER_IP_MIN,
          parentTokenPerIpMin: RATE_LIMIT_PARENT_TOKEN_PER_IP_MIN,
          parentResetPerIpMin: RATE_LIMIT_PARENT_RESET_PER_IP_MIN,
          parentClaimPerIpMin: RATE_LIMIT_PARENT_CLAIM_PER_IP_MIN,
          syncPerTokenMin: RATE_LIMIT_SYNC_PER_TOKEN_MIN
        }
      },
      "Balashikshana API listening"
    );
  })
  .catch((err) => {
    logger.fatal({ err: err.message }, "API failed to start");
    process.exit(1);
  });
