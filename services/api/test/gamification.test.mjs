// Gamification ledger integration tests (issue #55, roadmap D9) — the
// REAL server, REAL Postgres, REAL tokens:
//
// - ledger endpoint auth matrix (student PIN + child-device tokens read
//   their OWN student; parent 403 wrong-token-type; cross-student 403;
//   unknown 404; archived 403)
// - online topic complete / gate evaluate award engine XP + coins
//   (additive response fields) and the ledger reflects them
// - D9 offline/server agreement: the same attempt stream replayed
//   through the engine's own math offline and through the API produces
//   IDENTICAL ledger outcomes (XP total, level, coins, streak, badges)
// - idempotent exactly-once replay: same batch twice = same ledger (no
//   duplicate XP events, no double coins); split-session convergence
//   credits each attempt's XP exactly once
// - gate pass -> transition-gated XP + 50 coins; gold verification ->
//   gold-upgrade XP; badges award once (first-steps, crown-earner,
//   perfect-aim, gate-conqueror, gold-guardian)
// - streak accrual across consecutive UTC days (idempotent within a day)
// - the ledger/state invariant: SUM(xp_events) == gamification total_xp

import { test, describe, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDatabase, dropTestDatabase, startTestServer, waitForHealth, createVerifiedParentWithConsent } from "./helpers.mjs";
import {
  deriveSessionRewards,
  levelForXp,
  computeCognitiveTimeSec,
  computeFluencyGrade,
  evaluateBadges
} from "../../../packages/core-engine/src/index.mjs";

const API = "http://127.0.0.1:4808";
const P = "https://balashikshana.dev/problems";
const UNIT_ID = "K-M2";
const UNIT_TARGET_SPEED = 4.5; // K-M2 gate_max_speed_sec (seeded registry)
const MOTOR = 0.42;
// rawTimeSec 2.0 -> cognitive 1.58 -> ratio 0.351 -> fluency grade 4 -> 3 XP.
const ATTEMPT_XP = 3;

let serverProcess;
let testDatabase;
let packsDir;
let seq = 0;
let clock = 1_700_000_000_000; // 2023-11-14T22:13:20Z — deterministic client timestamps

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

async function consentedChild() {
  const parent = await createVerifiedParentWithConsent(API);
  const create = await api("/api/parent/children", {
    method: "POST",
    token: parent.token,
    body: {
      nickname: `RewardKid${++seq}`,
      pin: "5150",
      currentGrade: "kindergarten",
      clientDeviceId: `reward-device-${seq}-xy`,
      platform: "ios"
    }
  });
  assert.equal(create.status, 201, JSON.stringify(create.json));
  const mint = await api(`/api/parent/children/${create.json.studentId}/device-sessions`, {
    method: "POST",
    token: parent.token,
    body: { clientDeviceId: `reward-device-${seq}-xy2`, platform: "ios" }
  });
  assert.equal(mint.status, 201, JSON.stringify(mint.json));
  return {
    studentId: create.json.studentId,
    deviceToken: mint.json.token,
    parentToken: parent.token,
    deviceId: mint.json.deviceId
  };
}

function topicAttemptWire(n, sessionId, atMs, overrides = {}) {
  return {
    seq: n,
    unitId: UNIT_ID,
    topicId: "K-M2-G",
    questionId: `K-M2-G-Q${n}`,
    sessionType: "TOPIC_PRACTICE",
    sessionId,
    chosenAnswer: String(n),
    isCorrect: true,
    rawTimeSec: 2,
    audioDurationSec: 0,
    misconceptionTags: [],
    answeredAtMs: atMs,
    motorBaselineSec: MOTOR,
    ...overrides
  };
}

function gateAttemptWire(n, sessionId, topicCode, atMs, correct = true) {
  return {
    seq: n,
    unitId: UNIT_ID,
    topicId: `${UNIT_ID}-${topicCode}`,
    questionId: `${UNIT_ID}-${topicCode}-Q${n}`,
    sessionType: "GATE",
    sessionId,
    chosenAnswer: "1",
    isCorrect: correct,
    rawTimeSec: 2,
    audioDurationSec: 0,
    misconceptionTags: [],
    answeredAtMs: atMs,
    motorBaselineSec: MOTOR
  };
}

function upload(token, attempts) {
  return api("/api/sync/attempts", { method: "POST", token, body: { attempts } });
}

function ledger(token, studentId) {
  return api(`/api/students/${studentId}/gamification/ledger`, { token });
}

async function queryDb(sql, params = []) {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: testDatabase.url });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows;
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  packsDir = fs.mkdtempSync(path.join(os.tmpdir(), "balashi-gamification-packs-"));
  fs.writeFileSync(path.join(packsDir, "index.json"), JSON.stringify({ generatedAt: new Date(0).toISOString(), packs: [] }));
  serverProcess = await startTestServer({
    port: 4808,
    databaseUrl: testDatabase.url,
    env: {
      BALASHIKSHANA_CONTENT_PACKS_DIR: packsDir,
      RATE_LIMIT_PER_IP_MIN: "100000",
      RATE_LIMIT_PER_TOKEN_MIN: "100000",
      RATE_LIMIT_SYNC_PER_TOKEN_MIN: "100000",
      RATE_LIMIT_LOGIN_PER_IP_MIN: "100000",
      RATE_LIMIT_PARENT_SIGNUP_PER_IP_MIN: "100000",
      RATE_LIMIT_PARENT_LOGIN_PER_IP_MIN: "100000",
      RATE_LIMIT_PARENT_TOKEN_PER_IP_MIN: "100000",
      RATE_LIMIT_PARENT_RESET_PER_IP_MIN: "100000",
      RATE_LIMIT_PARENT_CLAIM_PER_IP_MIN: "100000"
    }
  });
  await waitForHealth(API);
}, 180000);

afterAll(async () => {
  if (serverProcess) serverProcess.kill("SIGTERM");
  if (testDatabase) await dropTestDatabase(testDatabase.name);
  if (packsDir) fs.rmSync(packsDir, { recursive: true, force: true });
});

// The engine-side expectation for one 8-correct topic session (the D9
// offline side of the agreement test — the exact rules the mobile
// projector runs).
function expectedTopicSessionRewards(correctCount) {
  const attempts = Array.from({ length: correctCount }, () => {
    const cSec = computeCognitiveTimeSec(2, MOTOR, 0);
    return { isCorrect: true, fluencyGrade: computeFluencyGrade(true, cSec, UNIT_TARGET_SPEED) };
  });
  const accPct = 100;
  const crowns = accPct >= 95 ? 3 : accPct >= 85 ? 2 : accPct >= 80 ? 1 : 0;
  return deriveSessionRewards({ sessionType: "TOPIC_PRACTICE", attempts, passed: accPct >= 80, crowns });
}

describe("ledger endpoint auth matrix", () => {
  test("no token -> 401 problem", async () => {
    const kid = await consentedChild();
    const res = await ledger(undefined, kid.studentId);
    assert.equal(res.status, 401);
    assert.equal(res.json.type, `${P}/unauthorized`);
  });

  test("parent token -> 403 wrong-token-type (parent reward views are a later milestone)", async () => {
    const kid = await consentedChild();
    const res = await ledger(kid.parentToken, kid.studentId);
    assert.equal(res.status, 403);
    assert.equal(res.json.type, `${P}/wrong-token-type`);
  });

  test("child-device token reads its own student; a fresh ledger is level 1 with zero XP", async () => {
    const kid = await consentedChild();
    const res = await ledger(kid.deviceToken, kid.studentId);
    assert.equal(res.status, 200);
    assert.equal(res.json.totalXp, 0);
    assert.equal(res.json.level.level, 1);
    assert.equal(res.json.level.maxed, false);
    assert.deepEqual(res.json.badges, []);
    assert.equal(res.json.starCoins, 50); // schema default
    assert.equal(res.json.crowns.totalCrowns, 0);
  });

  test("a device token cannot read another student's ledger", async () => {
    const a = await consentedChild();
    const b = await consentedChild();
    const res = await ledger(a.deviceToken, b.studentId);
    assert.equal(res.status, 403);
    assert.equal(res.json.type, `${P}/forbidden`);
  });

  test("a foreign student id is a scoped mismatch -> 403 forbidden (never a data oracle)", async () => {
    const kid = await consentedChild();
    const res = await ledger(kid.deviceToken, "stu-does-not-exist");
    assert.equal(res.status, 403);
    assert.equal(res.json.type, `${P}/forbidden`);
  });

  test("archiving the child revokes its device session -> the ledger is unreachable (401)", async () => {
    const kid = await consentedChild();
    const archive = await api(`/api/parent/children/${kid.studentId}/archive`, {
      method: "POST",
      token: kid.parentToken,
      body: { reason: "test" }
    });
    assert.equal(archive.status, 200, JSON.stringify(archive.json));
    // Archive soft-revokes every child-device session (#42 doctrine), so
    // the token itself is dead before the route runs — a stronger freeze
    // than the route-level 403 child-archived it backs up.
    const res = await ledger(kid.deviceToken, kid.studentId);
    assert.equal(res.status, 401);
  });
});

describe("online handlers award engine rewards (additive fields)", () => {
  test("topic complete returns xpAwarded/coinsAwarded and the ledger reflects them", async () => {
    const parent = await createVerifiedParentWithConsent(API);
    const create = await api("/api/students", {
      method: "POST",
      token: parent.token,
      body: { nickname: `OnlineKid${++seq}`, currentGrade: "kindergarten", pin: "5533" }
    });
    assert.equal(create.status, 201, JSON.stringify(create.json));
    const studentId = create.json.student.studentId;
    const token = create.json.token;

    const responses = Array.from({ length: 8 }, (_, i) => ({
      questionId: `K-M2-G-Q${i + 1}`,
      chosenAnswer: "1",
      isCorrect: true,
      rawTimeSec: 2,
      misconceptionTags: []
    }));
    const complete = await api("/api/practice/topic/complete", {
      method: "POST",
      token,
      body: { studentId, unitId: UNIT_ID, topicCode: "G", motorBaselineSec: MOTOR, responses },
    });
    assert.equal(complete.status, 200, JSON.stringify(complete.json));
    const expected = expectedTopicSessionRewards(8);
    assert.equal(complete.json.xpAwarded, expected.totalXp);
    assert.equal(complete.json.coinsAwarded, expected.coins);
    assert.equal(complete.json.crownsAwarded, 3);

    const led = await ledger(token, studentId);
    assert.equal(led.status, 200);
    assert.equal(led.json.totalXp, expected.totalXp);
    assert.equal(led.json.level.level, levelForXp(expected.totalXp).level);
    assert.equal(led.json.starCoins, 50 + expected.coins);
    assert.equal(led.json.streakDays, 1);
    // Badges from one perfect 3-crown topic session + first session.
    const ids = led.json.badges.map((b) => b.id).sort();
    assert.deepEqual(ids, ["crown-earner", "first-steps", "perfect-aim"]);
    // Badge metadata comes from the engine catalog (kid-safe titles).
    const crown = led.json.badges.find((b) => b.id === "crown-earner");
    assert.equal(crown.title, "Crown Earner");
    assert.equal(crown.tier, "bronze");
    assert.ok(crown.awardedAt);
    // Crowns surfacing: the coherent crowns summary.
    assert.deepEqual(led.json.crowns, { topicsWithCrowns: 1, threeCrownTopics: 1, totalCrowns: 3 });
    // Recent events carry both the attempt XP rows and the outcome row.
    const reasons = led.json.recentXpEvents.map((e) => e.reason);
    assert.ok(reasons.includes("topic-pass"));
    assert.equal(reasons.filter((r) => r === "attempt").length, 8);
  });

  test("gate evaluate awards gate XP + 50 coins on pass", async () => {
    const parent = await createVerifiedParentWithConsent(API);
    const create = await api("/api/students", {
      method: "POST",
      token: parent.token,
      body: { nickname: `GateKid${++seq}`, currentGrade: "kindergarten", pin: "5533" }
    });
    assert.equal(create.status, 201, JSON.stringify(create.json));
    const studentId = create.json.student.studentId;
    const token = create.json.token;

    // All-correct fast gate responses across the unit's own topics.
    const gateTopics = ["G", "H", "I", "J", "K", "L"];
    const responses = Array.from({ length: 12 }, (_, i) => ({
      topicCode: gateTopics[i % gateTopics.length],
      isCorrect: true,
      rawTimeSec: 2,
      audioDurationSec: 0
    }));
    const evaluate = await api("/api/gate/evaluate", {
      method: "POST",
      token,
      body: { studentId, unitId: UNIT_ID, motorBaselineSec: MOTOR, responses }
    });
    assert.equal(evaluate.status, 200, JSON.stringify(evaluate.json));
    assert.equal(evaluate.json.evaluation.passed, true);
    // 12 grade-4 attempts (3 XP each) + 25 gate bonus.
    assert.equal(evaluate.json.xpAwarded, 12 * ATTEMPT_XP + 25);
    assert.equal(evaluate.json.coinsAwarded, 50);

    const led = await ledger(token, studentId);
    const ids = led.json.badges.map((b) => b.id).sort();
    assert.deepEqual(ids, ["first-steps", "gate-conqueror"]);
    assert.equal(led.json.starCoins, 50 + 50);
  });
});

describe("D9 offline/server agreement over the #48 sync replay", () => {
  test("same attempt stream -> engine math offline == API ledger (XP, level, coins, streak, badges)", async () => {
    const kid = await consentedChild();
    const t0 = clock;

    // One 8-correct topic session, then a passing 12-answer gate session
    // an hour later, then a 4-of-5 gold verification 15h after silver.
    const topicAttempts = Array.from({ length: 8 }, (_, i) => topicAttemptWire(i + 1, "sess-agree-topic", t0 + i * 60_000));
    const gateTopics = ["G", "H", "I", "J", "K", "L"];
    const gateAttempts = Array.from({ length: 12 }, (_, i) =>
      gateAttemptWire(9 + i, "sess-agree-gate", gateTopics[i % gateTopics.length], t0 + 3_600_000 + i * 60_000)
    );
    const goldAttempts = Array.from({ length: 5 }, (_, i) => ({
      seq: 21 + i,
      unitId: UNIT_ID,
      topicId: `${UNIT_ID}-${gateTopics[i]}`,
      questionId: `${UNIT_ID}-${gateTopics[i]}-V${i}`,
      sessionType: "GOLD_VERIFICATION",
      sessionId: "sess-agree-gold",
      chosenAnswer: "1",
      isCorrect: i < 4,
      rawTimeSec: 2,
      audioDurationSec: 0,
      misconceptionTags: [],
      // Silver froze at the gate session's last attempt (t0 + 71 min);
      // +16h from t0 is safely past the 14-hour consolidation window.
      answeredAtMs: t0 + 16 * 3_600_000 + i * 60_000,
      motorBaselineSec: MOTOR
    }));

    const uploadRes = await upload(kid.deviceToken, [...topicAttempts, ...gateAttempts, ...goldAttempts]);
    assert.equal(uploadRes.status, 200, JSON.stringify(uploadRes.json));
    assert.ok(uploadRes.json.stats.xpCredited > 0);

    // ---- The OFFLINE side: the same engine rules, computed here from
    // ---- the same facts (what rewardsProjector.ts does on-device).
    const topicRewards = expectedTopicSessionRewards(8);
    const gateAttemptXp = 12 * ATTEMPT_XP;
    const goldXp = 20;
    const expectedXp = topicRewards.totalXp + gateAttemptXp + 25 + goldXp;
    const expectedCoins = topicRewards.coins + 50;
    // t0 = 2023-11-14T22:13:20Z; topic+gate land on Nov 14 UTC, the gold
    // verification 15h later lands on Nov 15 UTC -> the streak touched a
    // SECOND consecutive day -> 2 (the engine's UTC day-key rule).
    const expectedStreak = 2;
    const expectedBadges = evaluateBadges({
      sessionsCompleted: 3,
      topicsCompleted: 1,
      threeCrownTopics: 1,
      perfectTopics: 1,
      silverKeys: 1,
      goldKeys: 1,
      bestBeatTargetPct: 0,
      starCoins: 50 + expectedCoins,
      streakDays: expectedStreak
    });

    const led = await ledger(kid.deviceToken, kid.studentId);
    assert.equal(led.status, 200);
    assert.equal(led.json.totalXp, expectedXp, JSON.stringify(led.json.recentXpEvents));
    assert.deepEqual(led.json.level, levelForXp(expectedXp));
    assert.equal(led.json.starCoins, 50 + expectedCoins);
    assert.equal(led.json.streakDays, expectedStreak);
    assert.deepEqual(
      led.json.badges.map((b) => b.id).sort(),
      [...expectedBadges].sort()
    );

    // The ledger/state invariant: SUM(events) == state.total_xp.
    const sums = await queryDb(
      `SELECT COALESCE(SUM(xp_amount), 0)::int AS ledger_sum FROM student_xp_events WHERE student_id = $1`,
      [kid.studentId]
    );
    const state = await queryDb(`SELECT total_xp FROM student_gamification_state WHERE student_id = $1`, [kid.studentId]);
    assert.equal(sums[0].ledger_sum, expectedXp);
    assert.equal(state[0].total_xp, sums[0].ledger_sum);

    // Gold-upgrade event exists with the engine amount.
    const goldEvents = await queryDb(
      `SELECT xp_amount, reason FROM student_xp_events WHERE student_id = $1 AND reason = 'gold-upgrade'`,
      [kid.studentId]
    );
    assert.equal(goldEvents.length, 1);
    assert.equal(goldEvents[0].xp_amount, 20);
  });
});

describe("exactly-once reward replay (no reward lost, none double-credited)", () => {
  test("same batch twice = identical ledger (DB-enforced dedupe + transition gates)", async () => {
    const kid = await consentedChild();
    const attempts = Array.from({ length: 8 }, (_, i) => topicAttemptWire(i + 1, "sess-idem", clock + i * 60_000));

    const first = await upload(kid.deviceToken, attempts);
    assert.equal(first.status, 200, JSON.stringify(first.json));
    assert.ok(first.json.stats.xpCredited > 0);
    const afterFirst = await ledger(kid.deviceToken, kid.studentId);

    const second = await upload(kid.deviceToken, attempts);
    assert.equal(second.status, 200);
    assert.equal(second.json.stats.inserted, 0);
    assert.equal(second.json.stats.xpCredited, 0);
    const afterSecond = await ledger(kid.deviceToken, kid.studentId);

    assert.equal(afterSecond.json.totalXp, afterFirst.json.totalXp);
    assert.equal(afterSecond.json.starCoins, afterFirst.json.starCoins);
    assert.equal(afterSecond.json.badges.length, afterFirst.json.badges.length);
    const events = await queryDb(`SELECT COUNT(*)::int AS n FROM student_xp_events WHERE student_id = $1`, [kid.studentId]);
    // 8 attempt rows + exactly one topic-pass outcome row.
    assert.equal(events[0].n, 9);
  });

  test("a session split across batches converges: every attempt's XP exactly once, outcome exactly once", async () => {
    const kid = await consentedChild();
    const t0 = clock + 10 * 3_600_000;
    const part1 = Array.from({ length: 4 }, (_, i) => topicAttemptWire(i + 1, "sess-split", t0 + i * 60_000));
    const part2 = Array.from({ length: 4 }, (_, i) => topicAttemptWire(5 + i, "sess-split", t0 + 240_000 + i * 60_000));

    const r1 = await upload(kid.deviceToken, part1);
    assert.equal(r1.status, 200, JSON.stringify(r1.json));
    const r2 = await upload(kid.deviceToken, part2);
    assert.equal(r2.status, 200, JSON.stringify(r2.json));

    // 8 attempts x 3 XP + one 3-crown pass bonus (25). The 4-correct
    // partial ALSO passed (100%), so the outcome fired at first arrival;
    // the union replay re-derives but does not re-award.
    const led = await ledger(kid.deviceToken, kid.studentId);
    assert.equal(led.json.totalXp, 8 * ATTEMPT_XP + 25);
    assert.equal(led.json.starCoins, 50 + 30);
    const outcomes = await queryDb(
      `SELECT COUNT(*)::int AS n FROM student_xp_events WHERE student_id = $1 AND reason = 'topic-pass'`,
      [kid.studentId]
    );
    assert.equal(outcomes[0].n, 1);
  });

  test("a failed session earns attempt XP only (no bonus, no coins)", async () => {
    const kid = await consentedChild();
    const attempts = Array.from({ length: 8 }, (_, i) =>
      topicAttemptWire(i + 1, "sess-fail", clock + 20 * 3_600_000 + i * 60_000, { isCorrect: i < 5 })
    );
    const res = await upload(kid.deviceToken, attempts);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const led = await ledger(kid.deviceToken, kid.studentId);
    // 5 correct grade-4 attempts -> 15 XP; accPct 62.5 -> no pass.
    assert.equal(led.json.totalXp, 5 * ATTEMPT_XP);
    assert.equal(led.json.starCoins, 50);
    assert.equal(led.json.crowns.totalCrowns, 0);
    // first-steps only.
    assert.deepEqual(led.json.badges.map((b) => b.id), ["first-steps"]);
  });
});

describe("multi-session accumulation and level progression", () => {
  test("a second passing session on the next day accumulates XP and crosses a level boundary", async () => {
    const kid = await consentedChild();
    const day0 = Date.UTC(2023, 10, 14, 10, 0, 0);
    const day1 = day0 + 86_400_000;

    // Session 1: topic G (8 correct) -> 49 XP.
    const s1 = Array.from({ length: 8 }, (_, i) => topicAttemptWire(i + 1, "acc-t1", day0 + i * 60_000));
    await upload(kid.deviceToken, s1);
    // Session 2: topic H on the next day (fresh session id + seq space) -> 49 XP.
    const s2 = Array.from({ length: 8 }, (_, i) =>
      topicAttemptWire(9 + i, "acc-t2", day1 + i * 60_000, { topicId: "K-M2-H", questionId: `K-M2-H-Q${i + 1}` })
    );
    await upload(kid.deviceToken, s2);

    const led = await ledger(kid.deviceToken, kid.studentId);
    // 49 + 49 = 98 XP; level 2 crossed at 50; streak on 2 days.
    assert.equal(led.json.totalXp, 98);
    assert.equal(led.json.level.level, 2);
    assert.deepEqual(led.json.level, levelForXp(98));
    assert.equal(led.json.streakDays, 2);
    assert.equal(led.json.starCoins, 50 + 30 + 30);
    // Both outcomes fired exactly once each.
    const outcomes = await queryDb(
      `SELECT COUNT(*)::int AS n FROM student_xp_events WHERE student_id = $1 AND reason = 'topic-pass'`,
      [kid.studentId]
    );
    assert.equal(outcomes[0].n, 2);
    // Crowns summary covers both topics.
    assert.deepEqual(led.json.crowns, { topicsWithCrowns: 2, threeCrownTopics: 2, totalCrowns: 6 });
  });
});

describe("game-session speed badge input (beat-the-target, D9 parity)", () => {
  // K-M2-G's registry fluency game target is 4.5s; raw 2s answers beat it.
  const GAME_TARGET = 4.5;

  function gameAttemptWire(n, sessionId, atMs, overrides = {}) {
    return topicAttemptWire(n, sessionId, atMs, { sessionType: "GAME", ...overrides });
  }

  test("a passing game session records the beat share and awards the speed badge", async () => {
    const kid = await consentedChild();
    const t0 = Date.UTC(2023, 10, 14, 12, 0, 0);
    const attempts = Array.from({ length: 8 }, (_, i) => gameAttemptWire(i + 1, "sess-game-1", t0 + i * 60_000));
    const res = await upload(kid.deviceToken, attempts);
    assert.equal(res.status, 200, JSON.stringify(res.json));

    const led = await ledger(kid.deviceToken, kid.studentId);
    // 8 correct grade-4 attempts + the 3-crown pass bonus (game credits
    // the topic exactly like topic practice).
    assert.equal(led.json.totalXp, 8 * ATTEMPT_XP + 25);
    assert.equal(led.json.starCoins, 50 + 30);
    // The speed-badge input: all 8 correct answers beat the 4.5s target.
    assert.equal(led.json.bestBeatTargetPct, 100);
    const ids = led.json.badges.map((b) => b.id);
    assert.ok(ids.includes("lightning-learner"), JSON.stringify(ids));
  });

  test("a FAILED game session never updates the beat share (rushing is not lightning learning)", async () => {
    const kid = await consentedChild();
    const t0 = Date.UTC(2023, 10, 15, 12, 0, 0);
    const attempts = Array.from({ length: 8 }, (_, i) =>
      gameAttemptWire(i + 1, "sess-game-fail", t0 + i * 60_000, { isCorrect: i < 5 })
    );
    const res = await upload(kid.deviceToken, attempts);
    assert.equal(res.status, 200, JSON.stringify(res.json));

    const led = await ledger(kid.deviceToken, kid.studentId);
    // Attempt XP only; the beat metric stays untouched and no speed badge.
    assert.equal(led.json.totalXp, 5 * ATTEMPT_XP);
    assert.equal(led.json.bestBeatTargetPct, 0);
    assert.ok(!led.json.badges.map((b) => b.id).includes("lightning-learner"));
  });
});

describe("streak accrual (UTC day keys, idempotent per day)", () => {
  test("sessions on consecutive UTC days grow the streak; same-day sessions do not", async () => {
    const kid = await consentedChild();
    const day0 = Date.UTC(2023, 10, 14, 10, 0, 0);
    const day1 = day0 + 86_400_000;

    const s1 = Array.from({ length: 8 }, (_, i) => topicAttemptWire(i + 1, "sess-d0", day0 + i * 60_000));
    const up1 = await upload(kid.deviceToken, s1);
    assert.equal(up1.status, 200, JSON.stringify(up1.json));
    let led = await ledger(kid.deviceToken, kid.studentId);
    assert.equal(led.json.streakDays, 1);

    // A second session on the SAME UTC day: streak stays 1.
    const s1b = Array.from({ length: 8 }, (_, i) => topicAttemptWire(9 + i, "sess-d0b", day0 + 3_600_000 + i * 60_000));
    await upload(kid.deviceToken, s1b);
    led = await ledger(kid.deviceToken, kid.studentId);
    assert.equal(led.json.streakDays, 1);

    // Next UTC day: streak 2 (no streak badge yet — spark needs 3).
    const s2 = Array.from({ length: 8 }, (_, i) => topicAttemptWire(17 + i, "sess-d1", day1 + i * 60_000));
    await upload(kid.deviceToken, s2);
    led = await ledger(kid.deviceToken, kid.studentId);
    assert.equal(led.json.streakDays, 2);
    assert.ok(!led.json.badges.map((b) => b.id).includes("streak-spark"));

    // Third consecutive UTC day: streak 3 -> the streak badge awards
    // (exactly the engine's streak-days rule, integration end-to-end).
    const day2 = day1 + 86_400_000;
    const s3 = Array.from({ length: 8 }, (_, i) =>
      topicAttemptWire(25 + i, "sess-d2", day2 + i * 60_000, { topicId: "K-M2-H", questionId: `K-M2-H-Q${i + 1}` })
    );
    await upload(kid.deviceToken, s3);
    led = await ledger(kid.deviceToken, kid.studentId);
    assert.equal(led.json.streakDays, 3);
    assert.ok(led.json.badges.map((b) => b.id).includes("streak-spark"));
  });
});
