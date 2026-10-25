// Sync protocol routes (issue #48, roadmap D8) — delta upload of client
// attempts + authoritative progress snapshot.
//
//   POST /api/sync/attempts   batch delta upload; idempotent by
//                             (student, device, client_seq); returns the
//                             reconciled authoritative snapshot
//   GET  /api/sync/progress   authoritative snapshot + content-version
//                             handshake without an upload
//
// Doctrine:
// - CHILD-DEVICE TOKENS ONLY (#40 dual-token doctrine; the issue body:
//   "Sync runs under the child device token"). The student binding and
//   the device id both come from the TOKEN — never the body — so a
//   device session can only ever sync its own child's stream, and the
//   idempotency key's device component cannot be spoofed. Student PIN
//   sessions and parent tokens are a uniform 403 wrong-token-type.
// - Consent-gated like every child-data write (#41 doctrine): a student
//   without current-version consent gets 403 consent-required and
//   NOTHING is written.
// - Attempts are immutable FACTS (D8): they are inserted, never edited
//   or merged. Progress is recomputed server-side by replaying each
//   NEWLY-INSERTED session through the exact shared derivations the
//   online handlers use (derivations.mjs — reuse, not a fork).
// - Idempotency is enforced by the database: the partial unique index
//   uq_attempts_client_seq backs ON CONFLICT DO NOTHING, so a replayed
//   or duplicated batch inserts nothing, reconciles nothing (zero new
//   sessions), and returns the same snapshot — "same batch twice = same
//   server state, no progress drift".
// - Protocol contract: a batch carries WHOLE sessions (the client drains
//   at session boundaries; attempt ids are monotonic per device, so a
//   session's rows are contiguous). The mobile SyncEngine enforces the
//   boundary and tests pin it. DEFENSE-IN-DEPTH (#48 review finding 4):
//   if a client ever violates the contract and splits a session across
//   batches, the reconciler replays the session over the UNION of its
//   batch group and its previously persisted rows (idx_attempts_session
//   lookup) with exactly-once counting and transition-gated coin
//   awards, so the server CONVERGES on the true session instead of
//   double-counting the violation. Documented residual: SR stability
//   takes exactly one growth step per session (at first arrival); a
//   re-replay carries the stored value through rather than re-growing
//   (the growth function is clamped, not invertible).
// - CLOCK POLICY: server timestamps are authoritative. Client
//   answered_at values in the past are accepted as-is (an offline device
//   legitimately lags by hours or days). A client timestamp ahead of the
//   server beyond SYNC_FUTURE_CLOCK_TOLERANCE_MS (default 5 minutes —
//   NTP-level skew allowance) is a broken device clock: it is clamped
//   to the server receive time and counted in stats.clockSkewAdjusted.
//   The 14-hour Gold window is evaluated at the session's own adopted
//   timestamp, so sync latency never extends eligibility.
// - Structured sync stats (counts, latency — no child PII) are logged
//   per request as the observability seam for #66.

import path from "node:path";
import fs from "node:fs";
import fp from "fastify-plugin";
import { sendProblem, PROBLEM_BASE } from "./problem.mjs";
import { resolveBearerAuth } from "./parent-auth.mjs";
import { requireConsentForStudent } from "./consent.mjs";
import {
  evaluateMasteryGateAttempt,
  computeCognitiveTimeSec,
  computeFluencyGrade,
  updateTopicMemoryStability
} from "../../packages/core-engine/src/index.mjs";
import {
  buildGateUnitObject,
  deriveTopicSession,
  deriveTopicFluencyAndSr,
  computeKeyTransition,
  computeGoldVerificationTransition,
  TOPIC_PROGRESS_UPSERT_SQL,
  UNIT_PROGRESS_UPSERT_SQL,
  ATTEMPT_INSERT_SQL
} from "./derivations.mjs";
import {
  awardAttemptXp,
  awardTopicOutcomeRewards,
  awardGateOutcomeRewards,
  awardGoldUpgradeRewards,
  applyStreakForSession,
  updateBestBeatTargetPct,
  evaluateAndAwardBadges
} from "./rewards.mjs";
import { beatTargetSharePct } from "../../packages/core-engine/src/index.mjs";

/**
 * A topic's registry fluency-game speed target off its assets_json (the
 * same JSON path the mobile gamesAssets parser reads: assets.games.
 * fluencySprintGame.targetResponseSpeedSec — positive finite, else 0).
 * The beat-the-target share (the speed badge input) is computed from the
 * SAME registry value on both sides, so the badge can never fork.
 */
function fluencyTargetFromAssetsJson(assetsJson) {
  try {
    const parsed = JSON.parse(assetsJson || "{}");
    const target = parsed?.games?.fluencySprintGame?.targetResponseSpeedSec;
    return typeof target === "number" && Number.isFinite(target) && target > 0 ? target : 0;
  } catch {
    return 0;
  }
}

// --- Environment (documented at the top of server.mjs) -----------------------

export const RATE_LIMIT_SYNC_PER_TOKEN_MIN = Number(process.env.RATE_LIMIT_SYNC_PER_TOKEN_MIN || 30);
export const SYNC_MAX_ATTEMPTS_PER_BATCH = Number(process.env.SYNC_MAX_ATTEMPTS_PER_BATCH || 200);
export const SYNC_FUTURE_CLOCK_TOLERANCE_MS = Number(process.env.SYNC_FUTURE_CLOCK_TOLERANCE_MS || 300000);

// GAME (issue #52): game-framework sessions. Attempts carry the same
// facts as topic practice; the replay derives topic progress PER TOPIC
// (a game's 70/20/10 spiral stream mixes prerequisite/review items
// from other topics — crediting them all to one topic would corrupt
// mastery), so game play always counts toward the owning topics.
// Additive: older clients never send it; the OpenAPI baseline enum
// carries the same value (docs/openapi/baseline.yaml).
const SESSION_TYPES = ["TOPIC_PRACTICE", "GATE", "GOLD_VERIFICATION", "GAME"];

// --- Schemas -------------------------------------------------------------------

const syncAttemptSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "seq", "unitId", "topicId", "questionId", "sessionType", "sessionId",
    "chosenAnswer", "isCorrect", "rawTimeSec", "answeredAtMs", "motorBaselineSec"
  ],
  properties: {
    seq: { type: "integer", minimum: 1, maximum: 9007199254740991 },
    unitId: { type: "string", minLength: 1, maxLength: 64 },
    topicId: { type: "string", minLength: 1, maxLength: 160 },
    questionId: { type: "string", minLength: 1, maxLength: 160 },
    sessionType: { type: "string", enum: SESSION_TYPES },
    sessionId: { type: "string", minLength: 1, maxLength: 160 },
    chosenAnswer: { type: "string", maxLength: 64 },
    isCorrect: { type: "boolean" },
    rawTimeSec: { type: "number", minimum: 0, maximum: 600 },
    audioDurationSec: { type: "number", minimum: 0, maximum: 600, default: 0 },
    misconceptionTags: { type: "array", maxItems: 8, items: { type: "string", maxLength: 48 } },
    answeredAtMs: { type: "integer", minimum: 0, maximum: 9007199254740991 },
    motorBaselineSec: { type: "number", minimum: 0, maximum: 5 }
  }
};

const syncUploadSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["attempts"],
    properties: {
      attempts: { type: "array", minItems: 1, maxItems: SYNC_MAX_ATTEMPTS_PER_BATCH, items: syncAttemptSchema },
      clientPacks: {
        type: "array",
        maxItems: 10,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["gradeId", "contentVersion"],
          properties: {
            gradeId: { type: "string", minLength: 1, maxLength: 32 },
            contentVersion: { type: "string", minLength: 1, maxLength: 32 }
          }
        }
      }
    }
  }
};

// --- Helpers -------------------------------------------------------------------

const WINDOW_MS = 60000;

/** Dedicated per-token bucket for sync traffic (batch calls are chunky;
 * the default 30/min still drains a 200x30-attempt backlog fast). */
const syncTokenBuckets = new Map();

export function checkSyncTokenRateLimit(token, now = Date.now()) {
  if (syncTokenBuckets.size > 512) {
    for (const [key, bucket] of syncTokenBuckets) {
      if (now - bucket.windowStart >= WINDOW_MS) syncTokenBuckets.delete(key);
    }
  }
  const bucket = syncTokenBuckets.get(token);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    syncTokenBuckets.set(token, { windowStart: now, count: 1 });
    return { allowed: true, retryAfterSec: 0 };
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_SYNC_PER_TOKEN_MIN) {
    const resetAt = bucket.windowStart + WINDOW_MS;
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((resetAt - now) / 1000)) };
  }
  return { allowed: true, retryAfterSec: 0 };
}

/** Clock policy: past accepted, future beyond tolerance clamped. */
function adoptAttemptedAt(clientMs, serverNowMs) {
  if (clientMs > serverNowMs + SYNC_FUTURE_CLOCK_TOLERANCE_MS) {
    return { iso: new Date(serverNowMs).toISOString(), clamped: true };
  }
  return { iso: new Date(clientMs).toISOString(), clamped: false };
}

/** Content-version handshake: the published pack index vs the client's
 *  installed packs. No index (or unreadable) -> no signal (fail-open on
 *  the handshake only; pack refresh remains the client's #46 path). */
function packsOutdated(packsDir, clientPacks) {
  if (!Array.isArray(clientPacks) || clientPacks.length === 0) return [];
  const indexPath = path.join(packsDir, "index.json");
  if (!fs.existsSync(indexPath)) return [];
  let index;
  try {
    index = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  } catch {
    return [];
  }
  if (!index || !Array.isArray(index.packs)) return [];
  const current = new Map(
    index.packs.filter((p) => p && typeof p.gradeId === "string").map((p) => [p.gradeId, p.contentVersion])
  );
  const out = [];
  for (const cp of clientPacks) {
    const cur = current.get(cp.gradeId);
    if (typeof cur === "string" && cur !== cp.contentVersion) {
      out.push({ gradeId: cp.gradeId, installedVersion: cp.contentVersion, currentVersion: cur });
    }
  }
  return out;
}

// --- Snapshot ------------------------------------------------------------------

export async function buildProgressSnapshot(db, studentId) {
  const unitRows = await db.all(
    `SELECT unit_id, status, key_state, best_accuracy_pct, best_median_speed_sec,
            attempts_count, stability_days, last_reviewed_at, cpa_stage,
            silver_awarded_at, gold_verified_at
     FROM student_unit_progress WHERE student_id = $1 ORDER BY unit_id ASC`,
    [studentId]
  );
  const topicRows = await db.all(
    `SELECT topic_id, unit_id, topic_code, completed, crowns, mastery_score,
            best_accuracy_pct, best_median_speed_sec, attempts_count, fluency_grade,
            stability_days, next_review_at, last_reviewed_at
     FROM student_topic_progress WHERE student_id = $1 ORDER BY topic_id ASC`,
    [studentId]
  );
  return {
    units: unitRows.map((u) => ({
      unitId: u.unit_id,
      status: u.status,
      keyState: u.key_state,
      bestAccuracyPct: u.best_accuracy_pct,
      bestMedianSpeedSec: u.best_median_speed_sec,
      attemptsCount: u.attempts_count,
      stabilityDays: u.stability_days,
      lastReviewedAt: u.last_reviewed_at,
      cpaStage: u.cpa_stage,
      silverAwardedAt: u.silver_awarded_at,
      goldVerifiedAt: u.gold_verified_at
    })),
    topics: topicRows.map((t) => ({
      topicId: t.topic_id,
      unitId: t.unit_id,
      topicCode: t.topic_code,
      completed: t.completed,
      crowns: t.crowns,
      masteryScore: t.mastery_score,
      bestAccuracyPct: t.best_accuracy_pct,
      bestMedianSpeedSec: t.best_median_speed_sec,
      attemptsCount: t.attempts_count,
      fluencyGrade: t.fluency_grade,
      stabilityDays: t.stability_days,
      nextReviewAt: t.next_review_at,
      lastReviewedAt: t.last_reviewed_at
    }))
  };
}

// --- Reconciler ------------------------------------------------------------------

/**
 * Idempotent batch reconciliation, ATOMIC: the attempt inserts AND the
 * progress replays run in ONE transaction, so a failure at any point
 * rolls back everything — attempts and their derived progress commit
 * together or not at all. (Without this, a crash between the insert
 * phase and the replay phase would strand attempts whose sessions a
 * retry could never reconcile: the retry would see only duplicates.)
 *
 * Per attempt: adopt the clock, derive the server-side attempt values
 * (facts in, engine math out — client-computed derivations are never
 * trusted), insert with ON CONFLICT DO NOTHING on the client-seq unique
 * key. Newly inserted rows are grouped by session; every session that
 * gained a row is replayed through the SAME derivations the online
 * handlers run, over the UNION of its batch group and any rows already
 * persisted for that session (exactly-once counting per session — see
 * the convergence note in the file header). Whole-batch referential
 * validation happens BEFORE any write: one unknown unit/topic fails the
 * entire batch (nothing partial is stored — the client retries or
 * refreshes its pack).
 */
export async function reconcileSyncBatch({ db, studentId, deviceId, attempts, logger }) {
  const serverNowMs = Date.now();

  // Whole-batch referential validation (fail before writing anything).
  const unitIds = [...new Set(attempts.map((a) => a.unitId))];
  const topicIds = [...new Set(attempts.map((a) => a.topicId))];
  const unitRows = await db.all(`SELECT unit_id, grade_id, gate_max_speed_sec FROM units WHERE unit_id = ANY($1)`, [unitIds]);
  const unitById = new Map(unitRows.map((u) => [u.unit_id, u]));
  const unknownUnits = unitIds.filter((id) => !unitById.has(id));
  if (unknownUnits.length > 0) {
    return { validationError: { units: unknownUnits } };
  }
  const topicRows = await db.all(`SELECT topic_id FROM skill_topics WHERE topic_id = ANY($1)`, [topicIds]);
  const knownTopics = new Set(topicRows.map((t) => t.topic_id));
  const unknownTopics = topicIds.filter((id) => !knownTopics.has(id));
  if (unknownTopics.length > 0) {
    return { validationError: { topics: unknownTopics } };
  }
  const gradeIds = [...new Set(unitRows.map((u) => u.grade_id))];
  const gradeRows = await db.all(`SELECT grade_id, sr_growth_factor, sr_max_interval_days FROM grades WHERE grade_id = ANY($1)`, [gradeIds]);
  const gradeById = new Map(gradeRows.map((g) => [g.grade_id, g]));

  let inserted = 0;
  let clockAdjusted = 0;
  let sessionsReplayed = 0;
  let xpCredited = 0;
  let badgesAwarded = 0;
  const groups = new Map(); // `${sessionType}\u0000${sessionId}` -> { minSeq, items: [{a, iso}] }

  await db.withTransaction(async (client) => {
    // Prior-session state (BEFORE any insert, so it contains only rows
    // persisted by EARLIER batches): the union-replay convergence seam
    // (#48 review finding 4) that makes idx_attempts_session earn its
    // keep. The protocol contract says a batch carries whole sessions;
    // if a client ever violates it and splits one session across
    // batches, each replay below runs over the UNION of the batch group
    // and the session's previously persisted rows, with exactly-once
    // counting — the server converges on the true session instead of
    // double-counting the violation.
    const batchKeys = [...new Set(attempts.map((a) => `${a.sessionType}\u0000${a.sessionId}`))];
    const priorByKey = new Map();
    for (const key of batchKeys) {
      const [sessionType, sessionId] = key.split("\u0000");
      const rows = await clientAll(
        client,
        `SELECT unit_id, topic_id, question_id, is_correct, raw_time_sec, audio_duration_sec,
                misconception_tags_json, attempted_at, client_seq
         FROM student_question_attempts
         WHERE student_id = $1 AND session_id = $2 AND session_type = $3
         ORDER BY attempted_at ASC, client_seq ASC`,
        [studentId, sessionId, sessionType]
      );
      if (rows.length > 0) priorByKey.set(key, rows.map(priorRowToItem));
    }

    // Insert phase (idempotent by construction).
    for (const a of attempts) {
      const adopted = adoptAttemptedAt(a.answeredAtMs, serverNowMs);
      if (adopted.clamped) clockAdjusted += 1;
      const unit = unitById.get(a.unitId);
      const isTopic = a.sessionType === "TOPIC_PRACTICE";
      // Per-attempt derivation rules mirror the mobile recorder exactly:
      // topic attempts use audio 0 (the online topic path's rule); gate
      // and verification attempts are audio-aware (the engine's rule).
      const audio = isTopic ? 0 : a.audioDurationSec || 0;
      const motor = a.motorBaselineSec || 0.42;
      const cSec = computeCognitiveTimeSec(a.rawTimeSec || 3.0, motor, audio);
      const fluency = computeFluencyGrade(a.isCorrect, cSec, unit.gate_max_speed_sec);
      const result = await client.query(ATTEMPT_INSERT_SQL, [
        studentId,
        a.sessionType,
        a.unitId,
        a.topicId,
        a.questionId,
        String(a.chosenAnswer ?? "").slice(0, 64),
        a.isCorrect ? 1 : 0,
        a.rawTimeSec || 3.0,
        cSec,
        fluency,
        JSON.stringify(a.misconceptionTags || []),
        adopted.iso,
        audio,
        a.sessionId,
        deviceId,
        a.seq
      ]);
      const rowCount = result.rowCount ?? 0;
      inserted += rowCount;
      if (rowCount > 0) {
        const key = `${a.sessionType}\u0000${a.sessionId}`;
        let group = groups.get(key);
        if (!group) {
          group = { minSeq: a.seq, items: [] };
          groups.set(key, group);
        }
        if (a.seq < group.minSeq) group.minSeq = a.seq;
        group.items.push({ a, iso: adopted.iso });
      }
    }

    // Replay phase (SAME transaction): only sessions that gained rows,
    // in client sequence order (device-chronological). Each replay
    // derives over the session's FULL persisted state (prior rows +
    // this batch's new rows) and applies exactly-once counting.
    const orderedKeys = [...groups.entries()].sort((x, y) => x[1].minSeq - y[1].minSeq).map(([k]) => k);

    for (const key of orderedKeys) {
      const [sessionType, sessionId] = key.split("\u0000");
      const group = groups.get(key);
      const priorItems = priorByKey.get(key) ?? [];
      const items = [...priorItems, ...group.items].sort((x, y) => {
        const byTime = Date.parse(x.iso) - Date.parse(y.iso);
        return byTime !== 0 ? byTime : (x.a.seq ?? 0) - (y.a.seq ?? 0);
      });
      // Motor baseline is per-session and only the wire carries it
      // (attempt rows do not persist it); the batch's own first row is
      // authoritative for the session.
      const motorSec = group.items[0].a.motorBaselineSec || 0.42;
      const first = items[0].a;
      const unit = unitById.get(first.unitId);
      const gradeRow = gradeById.get(unit.grade_id) ?? null;
      const targetSpeed = unit.gate_max_speed_sec;
      const sessionMs = Date.parse(items[items.length - 1].iso);

      let rewardXp = 0;
      if (sessionType === "TOPIC_PRACTICE") {
        rewardXp = await replayTopicSession({ client, studentId, deviceId, sessionId, unitId: first.unitId, gradeRow, targetSpeed, motorSec, sessionMs, items, priorItems });
      } else if (sessionType === "GATE") {
        rewardXp = await replayGateSession({ client, studentId, deviceId, sessionId, unitId: first.unitId, gradeRow, targetSpeed, motorSec, sessionMs, items, priorItems });
      } else if (sessionType === "GAME") {
        rewardXp = await replayGameSession({ client, studentId, deviceId, sessionId, unitId: first.unitId, gradeRow, targetSpeed, motorSec, sessionMs, items, priorItems });
      } else {
        rewardXp = await replayGoldVerificationSession({ client, studentId, deviceId, sessionId, unitId: first.unitId, sessionMs, items });
      }
      // #55: the streak transition rides every replayed session, at the
      // session's OWN adopted timestamp (UTC day keys; idempotent per
      // day by the engine rule).
      await applyStreakForSession(client, { studentId, sessionMs });
      xpCredited += rewardXp;
      sessionsReplayed += 1;
    }

    // #55: badge evaluation once per batch, inside the same transaction,
    // over the aggregates the replays above just updated.
    const badges = await evaluateAndAwardBadges(client, { studentId });
    badgesAwarded = badges.newlyAwarded.length;
  });

  if (logger) {
    logger.info(
      {
        studentId,
        deviceId,
        batchSize: attempts.length,
        inserted,
        duplicates: attempts.length - inserted,
        sessionsReplayed,
        clockAdjusted,
        xpCredited,
        badgesAwarded
      },
      "sync batch reconciled"
    );
  }

  return { inserted, duplicates: attempts.length - inserted, sessionsReplayed, clockAdjusted, xpCredited, badgesAwarded };
}

async function clientGet(client, sql, params) {
  const result = await client.query(sql, params);
  return result.rows[0] ?? null;
}

async function clientAll(client, sql, params) {
  const result = await client.query(sql, params);
  return result.rows;
}

/** A previously persisted attempt row, back in replay-item shape. */
function priorRowToItem(row) {
  let tags = [];
  try {
    const parsed = JSON.parse(row.misconception_tags_json || "[]");
    if (Array.isArray(parsed)) tags = parsed;
  } catch {
    tags = [];
  }
  return {
    a: {
      unitId: row.unit_id,
      topicId: row.topic_id,
      questionId: row.question_id,
      isCorrect: row.is_correct === 1,
      rawTimeSec: row.raw_time_sec,
      audioDurationSec: row.audio_duration_sec,
      misconceptionTags: tags,
      motorBaselineSec: 0.42,
      seq: Number(row.client_seq ?? 0)
    },
    iso: row.attempted_at
  };
}

async function replayTopicSession({ client, studentId, deviceId, sessionId, unitId, gradeRow, targetSpeed, motorSec, sessionMs, items, priorItems }) {
  const toResponses = (list) =>
    list.map(({ a }) => ({
      isCorrect: a.isCorrect,
      rawTimeSec: a.rawTimeSec,
      misconceptionTags: a.misconceptionTags || []
    }));
  const derivation = deriveTopicSession({ responses: toResponses(items), motorBaselineSec: motorSec, targetSpeed });

  // Exactly-once counting for split sessions (union convergence): a
  // session that already persisted rows has already been counted and,
  // if it passed THEN, already been rewarded. The re-replay re-derives
  // every state field over the full union but adds no count, and coins
  // flow only on the pass TRANSITION (a failed partial that passes as
  // a whole still rewards exactly once).
  const reReplay = priorItems.length > 0;
  const priorPassed = reReplay
    ? deriveTopicSession({ responses: toResponses(priorItems), motorBaselineSec: motorSec, targetSpeed }).passedTopic
    : false;

  const topicId = items[0].a.topicId;
  const topicCode = topicId.startsWith(`${unitId}-`) ? topicId.slice(unitId.length + 1) : topicId;
  const prevTopic = await clientGet(
    client,
    "SELECT stability_days FROM student_topic_progress WHERE student_id = $1 AND topic_id = $2",
    [studentId, topicId]
  );
  const prevStabilityDays = prevTopic ? prevTopic.stability_days : 1.0;
  const { fg, srUpdate } = deriveTopicFluencyAndSr({
    passedTopic: derivation.passedTopic,
    medSpeed: derivation.medSpeed,
    targetSpeed,
    prevStabilityDays,
    gradeRow
  });
  // One SR growth step per session: a re-replay carries the stored
  // stability through (growth is clamped, not invertible, so the ideal
  // re-grow-from-base is not recoverable — the split keeps the first
  // arrival's step; bounded and documented).
  const stabilityDays = reReplay ? prevStabilityDays : srUpdate.stabilityDays;

  const now = new Date(sessionMs).toISOString();
  const nextReview = new Date(sessionMs + stabilityDays * 86400000).toISOString();

  await client.query(TOPIC_PROGRESS_UPSERT_SQL, [
    studentId,
    topicId,
    unitId,
    topicCode,
    derivation.passedTopic ? 1 : 0,
    derivation.crowns,
    Math.round(derivation.accPct),
    derivation.accPct,
    derivation.medSpeed,
    1,
    fg,
    stabilityDays,
    nextReview,
    now,
    reReplay ? 0 : 1
  ]);

  // #55 (D9) reward derivation — the same engine rules the online
  // handler and the mobile projector run, keyed idempotently:
  // - per-attempt XP only over THIS batch's newly inserted rows (prior
  //   rows were credited at their own first arrival; the dedupe key
  //   `att:<deviceId>:<seq>` makes a duplicate delivery a no-op);
  // - outcome XP + coins only on the pass TRANSITION (the pre-#55 coin
  //   rule, now engine-owned), keyed by the session identity.
  let creditedXp = 0;
  for (const { a, iso } of groupNewItems(items, priorItems)) {
    const fluency = computeFluencyGrade(
      a.isCorrect,
      computeCognitiveTimeSec(a.rawTimeSec || 3.0, motorSec, 0),
      targetSpeed
    );
    creditedXp += await awardAttemptXp(client, {
      studentId,
      sessionType: "TOPIC_PRACTICE",
      sessionId,
      unitId,
      topicId,
      isCorrect: Boolean(a.isCorrect),
      fluencyGrade: fluency,
      awardedAtIso: iso,
      dedupeKey: `att:${deviceId}:${a.seq}`
    });
  }
  if (derivation.passedTopic && !priorPassed) {
    const outcome = await awardTopicOutcomeRewards(client, {
      studentId,
      sessionType: "TOPIC_PRACTICE",
      sessionId,
      unitId,
      topicId,
      passed: true,
      crowns: derivation.crowns,
      awardedAtIso: now,
      dedupeKey: `out:TOPIC_PRACTICE:${sessionId}:${topicId}`
    });
    creditedXp += outcome.xp;
  }
  return creditedXp;
}

/**
 * The newly-inserted subset of a union replay: the batch's own rows
 * (group.items), i.e. every item whose seq is NOT among the prior rows'
 * seqs. The reconciler calls this for per-attempt XP so a re-replay
 * never re-credits attempts that already arrived.
 */
function groupNewItems(items, priorItems) {
  const priorSeqs = new Set(priorItems.map(({ a }) => a.seq));
  return items.filter(({ a }) => !priorSeqs.has(a.seq));
}

/**
 * GAME session replay (issue #52). A game session's spiral stream mixes
 * items from the current topic, prerequisite units, and due spaced
 * review — each attempt row carries its OWN topic/unit. The replay
 * groups the session's items BY TOPIC and runs the exact
 * replayTopicSession derivation per group (same deriveTopicSession
 * call, same upsert SQL, same exactly-once counting and
 * transition-gated coins), so a game credits every topic it served —
 * never just the first item's topic.
 *
 * Mobile parity: apps/mobile PracticeSessionEngine.completeGameSession
 * groups identically and calls the mirrored deriveTopicSession per
 * topic group (tests pin both sides). targetSpeed is the session
 * unit's gate_max_speed_sec exactly like topic sessions — the
 * registry's per-game targetResponseSpeedSec is pacing/telemetry on
 * the client and deliberately never reaches a derivation.
 */
async function replayGameSession({ client, studentId, deviceId, sessionId, unitId, gradeRow, targetSpeed, motorSec, sessionMs, items, priorItems }) {
  const toResponses = (list) =>
    list.map(({ a }) => ({
      isCorrect: a.isCorrect,
      rawTimeSec: a.rawTimeSec,
      misconceptionTags: a.misconceptionTags || []
    }));

  // Group by each item's OWN topic (first-appearance order).
  const groups = new Map(); // topicId -> { items: [], priorItems: [], unitId }
  const groupOf = (topicId) => {
    let group = groups.get(topicId);
    if (!group) {
      group = { items: [], priorItems: [], unitId };
      groups.set(topicId, group);
    }
    return group;
  };
  for (const item of items) groupOf(item.a.topicId).items.push(item);
  for (const prior of priorItems) groupOf(prior.a.topicId).priorItems.push(prior);

  // The beat-the-target inputs (speed badge): each group's OWN registry
  // fluency target off the topic's assets (the same JSON path the mobile
  // parser reads). Fetched once per session, not per group loop.
  const topicAssets = await clientAll(
    client,
    "SELECT topic_id, assets_json FROM skill_topics WHERE topic_id = ANY($1)",
    [[...groups.keys()]]
  );
  const fluencyTargetByTopic = new Map(
    topicAssets.map((row) => [row.topic_id, fluencyTargetFromAssetsJson(row.assets_json)])
  );

  let creditedXp = 0;
  for (const [topicId, group] of groups) {
    // Foreign-topic items carry their own unit id on the row; the
    // upsert's unit attribution follows the topic's owning unit.
    group.unitId = group.items[0]?.a.unitId ?? group.priorItems[0]?.a.unitId ?? unitId;
    const topicCode = topicId.startsWith(`${group.unitId}-`)
      ? topicId.slice(group.unitId.length + 1)
      : topicId;

    const derivation = deriveTopicSession({ responses: toResponses(group.items), motorBaselineSec: motorSec, targetSpeed });

    // Exactly-once counting per topic group (same union-replay seam as
    // replayTopicSession): a re-replay re-derives over the full union
    // but adds no count; coins flow only on the pass TRANSITION.
    const reReplay = group.priorItems.length > 0;
    const priorPassed = reReplay
      ? deriveTopicSession({ responses: toResponses(group.priorItems), motorBaselineSec: motorSec, targetSpeed }).passedTopic
      : false;

    const prevTopic = await clientGet(
      client,
      "SELECT stability_days FROM student_topic_progress WHERE student_id = $1 AND topic_id = $2",
      [studentId, topicId]
    );
    const prevStabilityDays = prevTopic ? prevTopic.stability_days : 1.0;
    const { fg, srUpdate } = deriveTopicFluencyAndSr({
      passedTopic: derivation.passedTopic,
      medSpeed: derivation.medSpeed,
      targetSpeed,
      prevStabilityDays,
      gradeRow
    });
    // One SR growth step per topic group per session arrival (same
    // documented split-session rule as replayTopicSession).
    const stabilityDays = reReplay ? prevStabilityDays : srUpdate.stabilityDays;

    const now = new Date(sessionMs).toISOString();
    const nextReview = new Date(sessionMs + stabilityDays * 86400000).toISOString();

    await client.query(TOPIC_PROGRESS_UPSERT_SQL, [
      studentId,
      topicId,
      group.unitId,
      topicCode,
      derivation.passedTopic ? 1 : 0,
      derivation.crowns,
      Math.round(derivation.accPct),
      derivation.accPct,
      derivation.medSpeed,
      1,
      fg,
      stabilityDays,
      nextReview,
      now,
      reReplay ? 0 : 1
    ]);

    // #55 (D9) per-group rewards: attempt XP over the NEW rows (the
    // GAME audio rule — audio-aware, exactly like the rows the mobile
    // recorder derives), outcome XP + coins on the group's pass
    // TRANSITION, and the beat-the-target share against the topic's OWN
    // registry fluency target (the speed badge input, engine-computed).
    for (const { a, iso } of groupNewItems(group.items, group.priorItems)) {
      const audio = a.audioDurationSec || 0;
      const fluency = computeFluencyGrade(
        a.isCorrect,
        computeCognitiveTimeSec(a.rawTimeSec || 3.0, motorSec, audio),
        targetSpeed
      );
      creditedXp += await awardAttemptXp(client, {
        studentId,
        sessionType: "GAME",
        sessionId,
        unitId: group.unitId,
        topicId,
        isCorrect: Boolean(a.isCorrect),
        fluencyGrade: fluency,
        awardedAtIso: iso,
        dedupeKey: `att:${deviceId}:${a.seq}`
      });
    }
    if (derivation.passedTopic && !priorPassed) {
      const outcome = await awardTopicOutcomeRewards(client, {
        studentId,
        sessionType: "GAME",
        sessionId,
        unitId: group.unitId,
        topicId,
        passed: true,
        crowns: derivation.crowns,
        awardedAtIso: now,
        dedupeKey: `out:GAME:${sessionId}:${topicId}`
      });
      creditedXp += outcome.xp;
    }
    // The speed-badge input: only a PASSING topic group updates the best
    // share, and only CORRECT answers carry speed credit (fast-wrong
    // answers are grade 1 everywhere else in the engine — rushing is
    // never lightning learning). Same rule on the mobile side.
    const fluencyTarget = fluencyTargetByTopic.get(topicId) ?? 0;
    if (derivation.passedTopic && fluencyTarget > 0) {
      const share = beatTargetSharePct(
        group.items.filter(({ a }) => a.isCorrect).map(({ a }) => a.rawTimeSec || 3.0),
        fluencyTarget
      );
      await updateBestBeatTargetPct(client, { studentId, pct: share, awardedAtIso: now });
    }
  }
  return creditedXp;
}

async function replayGateSession({ client, studentId, deviceId, sessionId, unitId, gradeRow, targetSpeed, motorSec, sessionMs, items, priorItems }) {
  const fullUnit = await clientGet(client, "SELECT * FROM units WHERE unit_id = $1", [unitId]);
  const topicRows = await clientAll(
    client,
    "SELECT topic_code, topic_name FROM skill_topics WHERE unit_id = $1 ORDER BY sequence_order ASC",
    [unitId]
  );
  const unitObj = buildGateUnitObject({ unitRow: fullUnit, topicRows });

  const toResponses = (list) =>
    list.map(({ a }) => ({
      topicCode: a.topicId.startsWith(`${unitId}-`) ? a.topicId.slice(unitId.length + 1) : a.topicId,
      isCorrect: a.isCorrect,
      rawTimeSec: a.rawTimeSec,
      audioDurationSec: a.audioDurationSec || 0
    }));
  const evalResult = evaluateMasteryGateAttempt({ unit: unitObj, responses: toResponses(items), motorBaselineSec: motorSec });

  // Exactly-once counting for split sessions (same convergence rule as
  // topic replays): coins on the pass TRANSITION only.
  const reReplay = priorItems.length > 0;
  const priorPassed = reReplay
    ? evaluateMasteryGateAttempt({ unit: unitObj, responses: toResponses(priorItems), motorBaselineSec: motorSec }).passed
    : false;

  const prevProg = await clientGet(
    client,
    "SELECT * FROM student_unit_progress WHERE student_id = $1 AND unit_id = $2",
    [studentId, unitId]
  );
  const fg = computeFluencyGrade(evalResult.passed, evalResult.medianCogSpeedSec ?? 0, targetSpeed);
  const srUpdate = updateTopicMemoryStability({
    currentStabilityDays: prevProg ? prevProg.stability_days : 1.0,
    fluencyGrade: fg,
    gradeGrowthFactor: gradeRow ? gradeRow.sr_growth_factor : 2.0,
    maxIntervalCapDays: gradeRow ? gradeRow.sr_max_interval_days : 45
  });
  // One SR growth step per session (see the topic replay's note); a
  // re-replay carries the stored stability and CPA stage through.
  const stabilityDays = reReplay && prevProg ? prevProg.stability_days : srUpdate.stabilityDays;
  const cpaStage = reReplay && prevProg ? prevProg.cpa_stage : srUpdate.cpaStage;

  const keyTransition = computeKeyTransition({ prev: prevProg, passed: evalResult.passed, sessionMs });

  const now = new Date(sessionMs).toISOString();
  await client.query(UNIT_PROGRESS_UPSERT_SQL, [
    studentId,
    unitId,
    evalResult.passed ? "MASTERED" : "REMEDIATION_REQUIRED",
    keyTransition.keyState,
    // Empty-attempt evaluations omit these fields engine-side; the
    // columns are NOT NULL — coerce to the schema default 0 (#32).
    evalResult.overallAccuracyPct ?? 0,
    evalResult.medianCogSpeedSec ?? 0,
    stabilityDays,
    now,
    cpaStage,
    now,
    keyTransition.silverAwardedAtMs > 0 ? new Date(keyTransition.silverAwardedAtMs).toISOString() : null,
    keyTransition.goldVerifiedAtMs > 0 ? new Date(keyTransition.goldVerifiedAtMs).toISOString() : null,
    reReplay ? 0 : 1
  ]);

  // #55 (D9): attempt XP over the NEW rows (gate items are audio-aware)
  // + the engine's gate outcome (XP + the historical 50 coins) on the
  // pass TRANSITION — the pre-#55 inline award, now engine-owned.
  let creditedXp = 0;
  for (const { a, iso } of groupNewItems(items, priorItems)) {
    const fluency = computeFluencyGrade(
      a.isCorrect,
      computeCognitiveTimeSec(a.rawTimeSec || 3.0, motorSec, a.audioDurationSec || 0),
      targetSpeed
    );
    creditedXp += await awardAttemptXp(client, {
      studentId,
      sessionType: "GATE",
      sessionId,
      unitId,
      topicId: a.topicId,
      isCorrect: Boolean(a.isCorrect),
      fluencyGrade: fluency,
      awardedAtIso: iso,
      dedupeKey: `att:${deviceId}:${a.seq}`
    });
  }
  if (evalResult.passed && !priorPassed) {
    const outcome = await awardGateOutcomeRewards(client, {
      studentId,
      sessionId,
      unitId,
      passed: true,
      awardedAtIso: now,
      dedupeKey: `out:GATE:${sessionId}:${unitId}`
    });
    creditedXp += outcome.xp;
  }
  return creditedXp;
}

async function replayGoldVerificationSession({ client, studentId, deviceId, sessionId, unitId, sessionMs, items }) {
  // `items` is the FULL union (prior + new rows): the 4-of-5 verdict is
  // evaluated over the session's whole persisted evidence, and the
  // transition itself is forward-only idempotent (a replayed upgrade
  // finds a GOLD holder and no-ops) — split sessions converge here by
  // construction.
  const correctCount = items.filter(({ a }) => a.isCorrect).length;
  const prev = await clientGet(
    client,
    "SELECT * FROM student_unit_progress WHERE student_id = $1 AND unit_id = $2",
    [studentId, unitId]
  );
  const transition = computeGoldVerificationTransition({ prev, correctCount, sessionMs });
  if (!transition.upgraded) return 0;

  const now = new Date(sessionMs).toISOString();
  await client.query(
    `UPDATE student_unit_progress
     SET key_state = 'GOLD_KEY',
         gold_verified_at = $3,
         updated_at = $4
     WHERE student_id = $1 AND unit_id = $2`,
    [studentId, unitId, new Date(transition.goldVerifiedAtMs).toISOString(), now]
  );

  // #55: the Gold-upgrade XP event — engine amount, dedupe-keyed by the
  // session (a replayed upgrade is already a no-op above; the key is
  // belt-and-braces under concurrent batches).
  const outcome = await awardGoldUpgradeRewards(client, {
    studentId,
    sessionId,
    unitId,
    awardedAtIso: now,
    dedupeKey: `out:GOLD_VERIFICATION:${sessionId}:${unitId}`
  });
  return outcome.xp;
}

// --- Plugin ---------------------------------------------------------------------

export const syncPlugin = fp(async (app, options) => {
  const db = options.db;
  const logger = options.logger ?? app.log;
  const packsDir = path.resolve(String(options.packsDir));

  async function requireChildDeviceSession(req, reply) {
    const auth = await resolveBearerAuth(db, req.headers.authorization);
    if (auth.error) {
      sendProblem(reply, 401, { type: `${PROBLEM_BASE}/unauthorized`, detail: auth.error });
      return null;
    }
    if (auth.kind !== "child-device") {
      sendProblem(reply, 403, {
        type: `${PROBLEM_BASE}/wrong-token-type`,
        detail: "Sync runs under child device session tokens (issue #48); parent and student PIN sessions cannot upload attempt batches."
      });
      return null;
    }
    const scoped = auth.childSession;
    const stuRow = await db.get("SELECT status FROM students WHERE student_id = $1", [scoped.student_id]);
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

  function checkSyncBucket(req, reply) {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    const bucket = checkSyncTokenRateLimit(token);
    if (!bucket.allowed) {
      sendProblem(reply, 429, {
        type: `${PROBLEM_BASE}/rate-limited`,
        detail: "Too many sync requests for this device session. Please slow down.",
        retryAfterSec: bucket.retryAfterSec
      });
      return false;
    }
    return true;
  }

  app.post("/api/sync/attempts", { schema: syncUploadSchema }, async (req, reply) => {
    const startedAt = Date.now();
    const scoped = await requireChildDeviceSession(req, reply);
    if (!scoped) return reply;
    if (!checkSyncBucket(req, reply)) return reply;
    if (!(await requireConsentForStudent(db, req, reply, scoped.student_id))) return reply;

    const attempts = req.body.attempts;
    const uniqueSeqs = new Set(attempts.map((a) => a.seq));
    if (uniqueSeqs.size !== attempts.length) {
      return sendProblem(reply, 400, {
        type: `${PROBLEM_BASE}/validation`,
        title: "Validation failed",
        detail: "Batch contains duplicate client sequence numbers."
      });
    }

    const outcome = await reconcileSyncBatch({
      db,
      studentId: scoped.student_id,
      deviceId: scoped.device_id,
      attempts,
      logger
    });

    if (outcome.validationError) {
      return sendProblem(reply, 400, {
        type: `${PROBLEM_BASE}/sync-unknown-content`,
        title: "Unknown curriculum content",
        detail: "Batch references units or topics that do not exist; refresh the content pack and retry.",
        extensions: {
          unknownUnits: outcome.validationError.units,
          unknownTopics: outcome.validationError.topics
        }
      });
    }

    const progress = await buildProgressSnapshot(db, scoped.student_id);
    logger.info(
      {
        requestId: req.id,
        studentId: scoped.student_id,
        latencyMs: Date.now() - startedAt,
        inserted: outcome.inserted,
        duplicates: outcome.duplicates,
        sessionsReplayed: outcome.sessionsReplayed,
        clockAdjusted: outcome.clockAdjusted,
        xpCredited: outcome.xpCredited,
        badgesAwarded: outcome.badgesAwarded
      },
      "sync upload complete"
    );

    return {
      ackedSeqs: attempts.map((a) => a.seq),
      serverTime: new Date().toISOString(),
      stats: {
        inserted: outcome.inserted,
        duplicates: outcome.duplicates,
        sessionsReplayed: outcome.sessionsReplayed,
        clockSkewAdjusted: outcome.clockAdjusted,
        xpCredited: outcome.xpCredited,
        badgesAwarded: outcome.badgesAwarded
      },
      packsOutdated: packsOutdated(packsDir, req.body.clientPacks),
      progress
    };
  });

  app.get(
    "/api/sync/progress",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            packs: { type: "string", maxLength: 512 }
          }
        }
      }
    },
    async (req, reply) => {
      const scoped = await requireChildDeviceSession(req, reply);
      if (!scoped) return reply;
      if (!checkSyncBucket(req, reply)) return reply;
      if (!(await requireConsentForStudent(db, req, reply, scoped.student_id))) return reply;

      let clientPacks = [];
      const raw = req.query.packs;
      if (typeof raw === "string" && raw.length > 0) {
        for (const part of raw.split(",").slice(0, 10)) {
          const [gradeId, contentVersion] = part.split(":");
          if (gradeId && contentVersion) {
            clientPacks.push({ gradeId: gradeId.slice(0, 32), contentVersion: contentVersion.slice(0, 32) });
          }
        }
      }

      const progress = await buildProgressSnapshot(db, scoped.student_id);
      return {
        serverTime: new Date().toISOString(),
        packsOutdated: packsOutdated(packsDir, clientPacks),
        progress
      };
    }
  );
});
