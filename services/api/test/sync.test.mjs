// Sync protocol integration tests (issue #48) — the full D8 matrix
// against the REAL server, REAL Postgres, REAL child-device tokens:
//
// - auth scope: child-device tokens ONLY (no token / parent / student
//   PIN / revoked device -> 401/403), and a device token can only ever
//   sync its OWN bound child (student identity comes from the token)
// - consent gate: stale consent -> 403 consent-required, NOTHING written
// - idempotent replay: same batch twice = same server state (no
//   duplicate attempts, no progress drift, duplicates counted)
// - whole-batch validation: unknown unit/topic -> 400, zero rows
// - clock policy: future skew clamped + counted; past accepted as-is
// - two-key machine end-to-end: gate pass -> SILVER (never GOLD on a
//   second pass — the #47 divergence is ported away), verification
//   4/5 past the frozen 14 h window -> GOLD, before the window or 3/5
//   -> stays SILVER
// - deterministic convergence (Risk-3 mitigation): one seeded random
//   session stream delivered as 1 batch / 2 batches / per-session
//   batches to three identical students -> identical authoritative
//   snapshots, equal to the engine's own math
// - content handshake + GET snapshot, batch caps, sync rate bucket

import { test, describe, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDatabase, dropTestDatabase, startTestServer, waitForHealth, createVerifiedParentWithConsent } from "./helpers.mjs";
import {
  median,
  computeCognitiveTimeSec,
  computeFluencyGrade,
  updateTopicMemoryStability
} from "../../../packages/core-engine/src/index.mjs";

const API = "http://127.0.0.1:4807";
const P = "https://balashikshana.dev/problems";

let serverProcess;
let testDatabase;
let packsDir;
let seq = 0;
let clock = 1_700_000_000_000; // deterministic client timestamps

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
      nickname: `SyncKid${++seq}`,
      pin: "5150",
      currentGrade: "kindergarten",
      clientDeviceId: `sync-device-${seq}-xy`,
      platform: "ios"
    }
  });
  assert.equal(create.status, 201, JSON.stringify(create.json));
  const mint = await api(`/api/parent/children/${create.json.studentId}/device-sessions`, {
    method: "POST",
    token: parent.token,
    body: { clientDeviceId: `sync-device-${seq}-xy2`, platform: "ios" }
  });
  assert.equal(mint.status, 201, JSON.stringify(mint.json));
  return {
    studentId: create.json.studentId,
    deviceToken: mint.json.token,
    parentToken: parent.token,
    deviceId: mint.json.deviceId,
    sessionId: mint.json.sessionId
  };
}

function attemptWire(n, overrides = {}) {
  clock += 60_000; // one minute apart, deterministic
  return {
    seq: n,
    unitId: "K-M2",
    topicId: "K-M2-G",
    questionId: `K-M2-G-Q${n}`,
    sessionType: "TOPIC_PRACTICE",
    sessionId: "sess-topic-1",
    chosenAnswer: String(n),
    isCorrect: true,
    rawTimeSec: 2,
    audioDurationSec: 0,
    misconceptionTags: [],
    answeredAtMs: clock,
    motorBaselineSec: 0.42,
    ...overrides
  };
}

function gateAttemptWire(n, sessionId, topicCode, correct, atMs) {
  return {
    seq: n,
    unitId: "K-M2",
    topicId: `K-M2-${topicCode}`,
    questionId: `K-M2-${topicCode}-Q${n}`,
    sessionType: "GATE",
    sessionId,
    chosenAnswer: "1",
    isCorrect: correct,
    rawTimeSec: 2,
    audioDurationSec: 0,
    misconceptionTags: [],
    answeredAtMs: atMs,
    motorBaselineSec: 0.42
  };
}

function upload(token, attempts, clientPacks) {
  const body = { attempts };
  if (clientPacks) body.clientPacks = clientPacks;
  return api("/api/sync/attempts", { method: "POST", token, body });
}

async function attemptsInDb(studentId) {
  const rows = await queryDb(
    "SELECT COUNT(*)::int AS n FROM student_question_attempts WHERE student_id = $1",
    [studentId]
  );
  return rows[0].n;
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
  // The content-handshake tests need a PUBLISHED pack index; the real
  // services/api/content-packs output is gitignored compiler state that
  // exists on dev machines but never in CI. The suite is therefore
  // self-contained: a throwaway packs dir with a minimal index (the
  // handshake reads only index.json, never artifact bytes), injected
  // via the same env the server documents.
  packsDir = fs.mkdtempSync(path.join(os.tmpdir(), "balashi-sync-packs-"));
  fs.writeFileSync(
    path.join(packsDir, "index.json"),
    JSON.stringify({
      generatedAt: new Date(0).toISOString(),
      packs: [{ gradeId: "kindergarten", contentVersion: "1.0.0", artifact: "pack-kindergarten-v1.0.0.sqlite" }]
    })
  );
  serverProcess = await startTestServer({
    port: 4807,
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

describe("auth scope: child-device tokens only", () => {
  test("no token -> 401 problem", async () => {
    const res = await upload(undefined, [attemptWire(1)]);
    assert.equal(res.status, 401);
    assert.equal(res.json.type, `${P}/unauthorized`);
  });

  test("parent token -> 403 wrong-token-type", async () => {
    const kid = await consentedChild();
    const res = await upload(kid.parentToken, [attemptWire(1)]);
    assert.equal(res.status, 403);
    assert.equal(res.json.type, `${P}/wrong-token-type`);
  });

  test("student PIN token -> 403 wrong-token-type", async () => {
    const kid = await consentedChild();
    // The child can log in with its PIN (student session token)...
    const login = await api("/api/auth/login", {
      method: "POST",
      body: { studentId: kid.studentId, pin: "5150" }
    });
    assert.equal(login.status, 200);
    // ...but sync is the device surface only.
    const res = await upload(login.json.token, [attemptWire(1)]);
    assert.equal(res.status, 403);
    assert.equal(res.json.type, `${P}/wrong-token-type`);
    assert.equal(await attemptsInDb(kid.studentId), 0);
  });

  test("revoked device token -> 401", async () => {
    const kid = await consentedChild();
    const del = await api(`/api/parent/children/${kid.studentId}/device-sessions/${kid.sessionId}`, {
      method: "DELETE",
      token: kid.parentToken
    });
    assert.equal(del.status, 200, JSON.stringify(del.json));
    const res = await upload(kid.deviceToken, [attemptWire(1)]);
    assert.equal(res.status, 401);
  });

  test("GET /api/sync/progress: no token -> 401, parent token -> 403 wrong-token-type", async () => {
    const kid = await consentedChild();
    const anon = await api("/api/sync/progress");
    assert.equal(anon.status, 401);
    assert.equal(anon.json.type, `${P}/unauthorized`);
    const parent = await api("/api/sync/progress", { token: kid.parentToken });
    assert.equal(parent.status, 403);
    assert.equal(parent.json.type, `${P}/wrong-token-type`);
  });

  test("the student identity cannot be smuggled in the body (additionalProperties: false)", async () => {
    const kid = await consentedChild();
    const res = await api("/api/sync/attempts", {
      method: "POST",
      token: kid.deviceToken,
      body: { attempts: [attemptWire(1)], studentId: "someone-elses-child" }
    });
    assert.equal(res.status, 400);
    assert.equal(await attemptsInDb(kid.studentId), 0);
  });
});

describe("consent gate", () => {
  test("stale consent -> 403 consent-required, nothing written; re-consent restores", async () => {
    const kid = await consentedChild();
    // Policy bump the same way the sibling suites do: deactivate the
    // current active row, insert a newer active version (the child's
    // consent record is now stale), then reverse.
    await queryDb("UPDATE consent_policy_versions SET active = false WHERE active");
    await queryDb(
      "INSERT INTO consent_policy_versions (version, locale, policy_text, active) VALUES ('99.0.0-sync-test', 'en-US', 'bumped policy for sync test', true)"
    );
    const res = await upload(kid.deviceToken, [attemptWire(1)]);
    assert.equal(res.status, 403);
    assert.equal(res.json.type, `${P}/consent-required`);
    assert.equal(res.json.currentPolicyVersion, "99.0.0-sync-test");
    assert.equal(await attemptsInDb(kid.studentId), 0);

    await queryDb("DELETE FROM consent_policy_versions WHERE version = '99.0.0-sync-test'");
    await queryDb(
      "UPDATE consent_policy_versions SET active = true WHERE active = false AND version <> '99.0.0-sync-test'"
    );
    const ok = await upload(kid.deviceToken, [attemptWire(1)]);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.stats.inserted, 1);
  });
});

describe("idempotency: same batch twice = same server state", () => {
  test("replay inserts nothing, drifts nothing, reports duplicates", async () => {
    const kid = await consentedChild();
    const batch = [1, 2, 3, 4].map((n) => attemptWire(n));

    const first = await upload(kid.deviceToken, batch);
    assert.equal(first.status, 200);
    assert.equal(first.json.stats.inserted, 4);
    assert.equal(first.json.stats.duplicates, 0);
    assert.equal(first.json.stats.sessionsReplayed, 1);

    const second = await upload(kid.deviceToken, batch);
    assert.equal(second.status, 200);
    assert.equal(second.json.stats.inserted, 0);
    assert.equal(second.json.stats.duplicates, 4);
    assert.equal(second.json.stats.sessionsReplayed, 0);

    assert.equal(await attemptsInDb(kid.studentId), 4);
    assert.deepEqual(second.json.progress, first.json.progress);
    const topic = first.json.progress.topics.find((t) => t.topicId === "K-M2-G");
    assert.equal(topic.attemptsCount, 1); // one session, counted once
  });

  test("CONCURRENT identical uploads race on the same client seqs: exactly one row each, identical snapshots", async () => {
    const kid = await consentedChild();
    const batch = [1, 2, 3, 4].map((n) => attemptWire(n));

    // Four racing uploads of the SAME batch (a device retry storm or a
    // double-fire of the sync trigger). The uq_attempts_client_seq
    // partial unique index + ON CONFLICT DO NOTHING must keep exactly
    // one row per seq; losers report pure duplicates and replay nothing.
    const results = await Promise.all([
      upload(kid.deviceToken, batch),
      upload(kid.deviceToken, batch),
      upload(kid.deviceToken, batch),
      upload(kid.deviceToken, batch)
    ]);
    for (const r of results) {
      assert.equal(r.status, 200, JSON.stringify(r.json));
    }
    const insertedTotal = results.reduce((sum, r) => sum + r.json.stats.inserted, 0);
    assert.equal(insertedTotal, 4, "the seq inserts exactly once across the race");
    assert.equal(await attemptsInDb(kid.studentId), 4);

    // Every racer observes the SAME authoritative snapshot.
    const first = results[0].json.progress;
    for (const r of results.slice(1)) {
      assert.deepEqual(r.json.progress, first);
    }
    // The reconciled session is counted exactly once.
    const topic = first.topics.find((t) => t.topicId === "K-M2-G");
    assert.equal(topic.attemptsCount, 1);
  });

  test("a partial replay (overlapping seqs) is fully idempotent", async () => {
    const kid = await consentedChild();
    const batch = [1, 2, 3, 4].map((n) => attemptWire(n));
    await upload(kid.deviceToken, batch);
    const overlap = await upload(kid.deviceToken, [batch[0], batch[1]]);
    assert.equal(overlap.json.stats.inserted, 0);
    assert.equal(await attemptsInDb(kid.studentId), 4);
  });

  test("duplicate seqs inside ONE batch are rejected (400)", async () => {
    const kid = await consentedChild();
    const a = attemptWire(1);
    const b = attemptWire(1, { questionId: "K-M2-G-Q2" });
    const res = await upload(kid.deviceToken, [a, b]);
    assert.equal(res.status, 400);
    assert.equal(await attemptsInDb(kid.studentId), 0);
  });
});

describe("split-session convergence (defense-in-depth, #48 review finding 4)", () => {
  test("ONE session split across batches (same sessionId) converges to exactly-once counting", async () => {
    // The protocol contract says batches carry whole sessions; this is
    // what the server does when a client violates it anyway (review
    // finding 1's corruption class, server side). One child gets the
    // 8-attempt session WHOLE; a second gets it as 4 + 4 + a duplicate
    // replay of the remainder, all under the SAME sessionId. Final
    // server state must be identical: count once, reward once, all
    // state derived over the union.
    const whole = await consentedChild();
    const split = await consentedChild();

    const session = (seqBase) =>
      Array.from({ length: 8 }, (_, i) =>
        attemptWire(seqBase + i, { sessionId: "sess-split-topic", questionId: `K-M2-G-Q${i + 1}` })
      );

    const w = await upload(whole.deviceToken, session(1));
    assert.equal(w.status, 200, JSON.stringify(w.json));
    const s1 = await upload(split.deviceToken, session(101).slice(0, 4));
    assert.equal(s1.status, 200, JSON.stringify(s1.json));
    const s2 = await upload(split.deviceToken, session(101).slice(4));
    assert.equal(s2.status, 200, JSON.stringify(s2.json));
    // A duplicate replay of the remainder changes nothing.
    const s3 = await upload(split.deviceToken, session(101).slice(4));
    assert.equal(s3.status, 200, JSON.stringify(s3.json));

    const wholeTopic = w.json.progress.topics.find((t) => t.topicId === "K-M2-G");
    const splitTopic = s3.json.progress.topics.find((t) => t.topicId === "K-M2-G");
    assert.ok(wholeTopic, "whole arrival produced a topic row");
    // Exactly-once counting: the session counts ONCE despite arriving
    // as two inserting batches plus a duplicate (pre-finding-4 this
    // tripled to attempts_count 3).
    assert.equal(splitTopic.attemptsCount, 1);
    assert.equal(splitTopic.attemptsCount, wholeTopic.attemptsCount);
    // Union-derived state converges on the whole arrival.
    assert.equal(splitTopic.crowns, wholeTopic.crowns);
    assert.equal(splitTopic.bestAccuracyPct, wholeTopic.bestAccuracyPct);
    assert.equal(splitTopic.masteryScore, wholeTopic.masteryScore);
    assert.equal(splitTopic.completed, wholeTopic.completed);

    // Star coins exactly-once: the whole arrival rewards once; the
    // split rewards the pass transition once (partial passed -> the
    // union pass re-awards nothing; a duplicate replays nothing).
    const coins = async (studentId) =>
      (await queryDb("SELECT star_coins FROM students WHERE student_id = $1", [studentId]))[0].star_coins;
    assert.equal(await coins(split.studentId), await coins(whole.studentId));

    // The ledger holds all 8 rows exactly once for the session.
    assert.equal(await attemptsInDb(split.studentId), 8);
    const sessionRows = await queryDb(
      "SELECT COUNT(*)::int AS n FROM student_question_attempts WHERE student_id = $1 AND session_id = $2",
      [split.studentId, "sess-split-topic"]
    );
    assert.equal(sessionRows[0].n, 8);
  });

  test("a split GATE session counts once and rewards the pass transition once", async () => {
    const whole = await consentedChild();
    const split = await consentedChild();
    const at = 1_700_100_000_000;

    const gateSession = (seqBase) =>
      ["G", "G", "H", "H", "I", "I"].map((code, i) =>
        gateAttemptWire(seqBase + i, "sess-split-gate", code, true, at + i * 60_000)
      );

    const w = await upload(whole.deviceToken, gateSession(1));
    assert.equal(w.status, 200, JSON.stringify(w.json));
    const s1 = await upload(split.deviceToken, gateSession(101).slice(0, 3));
    assert.equal(s1.status, 200, JSON.stringify(s1.json));
    const s2 = await upload(split.deviceToken, gateSession(101).slice(3));
    assert.equal(s2.status, 200, JSON.stringify(s2.json));

    const wholeUnit = s2.json.progress.units.find((u) => u.unitId === "K-M2");
    const splitUnit = s2.json.progress.units.find((u) => u.unitId === "K-M2");
    assert.ok(wholeUnit, "gate arrival produced a unit row");
    assert.equal(splitUnit.attemptsCount, 1);
    assert.equal(splitUnit.keyState, wholeUnit.keyState);
    assert.equal(splitUnit.status, wholeUnit.status);

    const coins = async (studentId) =>
      (await queryDb("SELECT star_coins FROM students WHERE student_id = $1", [studentId]))[0].star_coins;
    assert.equal(await coins(split.studentId), await coins(whole.studentId));
    assert.equal(await attemptsInDb(split.studentId), 6);
  });

  test("the SAME sessionId under two sessionTypes stays two independent sessions", async () => {
    // The prior-rows lookup keys on (student, session_id, session_type):
    // a topic session and a gate session sharing a sessionId must never
    // union into one replay (which would corrupt both derivations).
    const kid = await consentedChild();
    const shared = "sess-dual-use";
    const topic = Array.from({ length: 4 }, (_, i) =>
      attemptWire(10 + i, { sessionId: shared, questionId: `K-M2-G-Q${i + 1}` })
    );
    const at = 1_700_200_000_000;
    const gate = ["G", "G", "H", "H", "I", "I"].map((code, i) =>
      gateAttemptWire(20 + i, shared, code, true, at + i * 60_000)
    );

    const t1 = await upload(kid.deviceToken, topic);
    assert.equal(t1.status, 200, JSON.stringify(t1.json));
    const g1 = await upload(kid.deviceToken, gate);
    assert.equal(g1.status, 200, JSON.stringify(g1.json));

    const topicRow = g1.json.progress.topics.find((t) => t.topicId === "K-M2-G");
    const unitRow = g1.json.progress.units.find((u) => u.unitId === "K-M2");
    assert.ok(topicRow && unitRow, "both sessions replayed independently");
    // Each session counted exactly once in its own progress table.
    assert.equal(topicRow.attemptsCount, 1);
    assert.equal(unitRow.attemptsCount, 1);
    // Both rewards flowed once each: welcome seed (50) + topic pass +
    // gate pass — no cross-contamination between the shared-id sessions.
    const coins = (await queryDb("SELECT star_coins FROM students WHERE student_id = $1", [kid.studentId]))[0].star_coins;
    const topicCoins = 15 + topicRow.crowns * 5;
    assert.equal(coins, 50 + topicCoins + 50);
    // And the ledger keeps the two sessions distinct.
    const rows = await queryDb(
      "SELECT session_type, COUNT(*)::int AS n FROM student_question_attempts WHERE student_id = $1 AND session_id = $2 GROUP BY session_type",
      [kid.studentId, shared]
    );
    assert.deepEqual(rows.sort((a, b) => a.session_type.localeCompare(b.session_type)), [
      { session_type: "GATE", n: 6 },
      { session_type: "TOPIC_PRACTICE", n: 4 }
    ]);
  });
});

describe("whole-batch validation", () => {
  test("unknown unit -> 400 sync-unknown-content, nothing written", async () => {
    const kid = await consentedChild();
    const res = await upload(kid.deviceToken, [
      attemptWire(1),
      attemptWire(2, { unitId: "XX-99", topicId: "XX-99-A" })
    ]);
    assert.equal(res.status, 400);
    assert.equal(res.json.type, `${P}/sync-unknown-content`);
    assert.deepEqual(res.json.unknownUnits, ["XX-99"]);
    assert.equal(await attemptsInDb(kid.studentId), 0);
  });
});

describe("clock policy", () => {
  test("future skew beyond tolerance is clamped to server time and counted", async () => {
    const kid = await consentedChild();
    const before = Date.now();
    const res = await upload(kid.deviceToken, [
      attemptWire(1, { answeredAtMs: Date.now() + 20 * 60_000 })
    ]);
    assert.equal(res.status, 200);
    assert.equal(res.json.stats.clockSkewAdjusted, 1);
    const rows = await queryDb(
      "SELECT attempted_at FROM student_question_attempts WHERE student_id = $1",
      [kid.studentId]
    );
    const stored = Date.parse(rows[0].attempted_at);
    assert.ok(stored >= before && stored <= Date.now() + 1000, "clamped to server receive time");
  });

  test("past timestamps are accepted as-is (offline devices lag)", async () => {
    const kid = await consentedChild();
    const past = Date.now() - 3 * 86_400_000;
    await upload(kid.deviceToken, [attemptWire(1, { answeredAtMs: past })]);
    const rows = await queryDb(
      "SELECT attempted_at FROM student_question_attempts WHERE student_id = $1",
      [kid.studentId]
    );
    assert.equal(Date.parse(rows[0].attempted_at), past);
  });

  test("boundary: +299s is inside NTP tolerance (kept), +301s is clamped", async () => {
    const tolerant = await consentedChild();
    const within = Date.now() + 299_000; // < 5 min tolerance even with
    // request latency accounted on the server receive side
    const kept = await upload(tolerant.deviceToken, [attemptWire(1, { answeredAtMs: within })]);
    assert.equal(kept.status, 200);
    assert.equal(kept.json.stats.clockSkewAdjusted, 0);
    const keptRows = await queryDb(
      "SELECT attempted_at FROM student_question_attempts WHERE student_id = $1",
      [tolerant.studentId]
    );
    assert.equal(Date.parse(keptRows[0].attempted_at), within);

    const broken = await consentedChild();
    const before = Date.now();
    const clamped = await upload(broken.deviceToken, [
      attemptWire(1, { answeredAtMs: Date.now() + 301_000 })
    ]);
    assert.equal(clamped.status, 200);
    assert.equal(clamped.json.stats.clockSkewAdjusted, 1);
    const clampedRows = await queryDb(
      "SELECT attempted_at FROM student_question_attempts WHERE student_id = $1",
      [broken.studentId]
    );
    const stored = Date.parse(clampedRows[0].attempted_at);
    assert.ok(stored >= before && stored <= Date.now() + 1000, "clamped to server receive time");
  });
});

describe("two-key machine end-to-end (the #47 divergence, ported)", () => {
  const GATE_SESSION = "sess-gate-1";
  const GATE_SESSION_2 = "sess-gate-2";

  function passingGate(n0, sessionId, atMs) {
    const topics = ["G", "H", "I"];
    return Array.from({ length: 8 }, (_, i) =>
      gateAttemptWire(n0 + i, sessionId, topics[i % 3], true, atMs)
    );
  }

  test("gate pass -> MASTERED + SILVER with the frozen window start", async () => {
    const kid = await consentedChild();
    const at = Date.now() - 20 * 3_600_000; // 20 h ago
    const res = await upload(kid.deviceToken, passingGate(1, GATE_SESSION, at));
    assert.equal(res.status, 200);
    const unit = res.json.progress.units.find((u) => u.unitId === "K-M2");
    assert.equal(unit.status, "MASTERED");
    assert.equal(unit.keyState, "SILVER_KEY");
    assert.ok(unit.silverAwardedAt);
    // The window starts at the SESSION's adopted timestamp, not sync time.
    assert.equal(Date.parse(unit.silverAwardedAt), at);
    assert.equal(unit.goldVerifiedAt, null);
  });

  test("a second gate pass stays SILVER — Gold is verification-only now", async () => {
    const kid = await consentedChild();
    const at1 = Date.now() - 20 * 3_600_000;
    const at2 = Date.now() - 2 * 3_600_000;
    await upload(kid.deviceToken, passingGate(1, GATE_SESSION, at1));
    const second = await upload(kid.deviceToken, passingGate(9, GATE_SESSION_2, at2));
    const unit = second.json.progress.units.find((u) => u.unitId === "K-M2");
    assert.equal(unit.keyState, "SILVER_KEY");
    // Window frozen at the FIRST award.
    assert.equal(Date.parse(unit.silverAwardedAt), at1);
    assert.equal(unit.attemptsCount, 2);
  });

  test("verification 4/5 past the window -> GOLD", async () => {
    const kid = await consentedChild();
    const silverAt = Date.now() - 20 * 3_600_000;
    await upload(kid.deviceToken, passingGate(1, GATE_SESSION, silverAt));

    const verifyAt = Date.now() - 1 * 3_600_000; // ~19 h after Silver
    const verify = Array.from({ length: 5 }, (_, i) =>
      gateAttemptWire(9 + i, "sess-gold-verify-1", ["G", "H", "I", "G", "H"][i], i < 4, verifyAt)
    ).map((a) => ({ ...a, sessionType: "GOLD_VERIFICATION", sessionId: "sess-gold-verify-1" }));

    const res = await upload(kid.deviceToken, verify);
    const unit = res.json.progress.units.find((u) => u.unitId === "K-M2");
    assert.equal(unit.keyState, "GOLD_KEY");
    assert.equal(Date.parse(unit.goldVerifiedAt), verifyAt);
    assert.equal(Date.parse(unit.silverAwardedAt), silverAt);
  });

  test("verification before the 14 h window or with 3/5 stays SILVER", async () => {
    const earlyKid = await consentedChild();
    const silverAt = Date.now() - 20 * 3_600_000;
    await upload(earlyKid.deviceToken, passingGate(1, GATE_SESSION, silverAt));
    const tooEarly = Date.now() - 18 * 3_600_000; // only 2 h after Silver
    const early = Array.from({ length: 5 }, (_, i) => ({
      ...gateAttemptWire(9 + i, "sess-verify-early", ["G", "H", "I", "G", "H"][i], i < 4, tooEarly),
      sessionType: "GOLD_VERIFICATION",
      sessionId: "sess-verify-early"
    }));
    const earlyRes = await upload(earlyKid.deviceToken, early);
    assert.equal(earlyRes.json.progress.units.find((u) => u.unitId === "K-M2").keyState, "SILVER_KEY");

    const weakKid = await consentedChild();
    await upload(weakKid.deviceToken, passingGate(1, GATE_SESSION, silverAt));
    const late = Date.now() - 1 * 3_600_000;
    const weak = Array.from({ length: 5 }, (_, i) => ({
      ...gateAttemptWire(9 + i, "sess-verify-weak", ["G", "H", "I", "G", "H"][i], i < 3, late),
      sessionType: "GOLD_VERIFICATION",
      sessionId: "sess-verify-weak"
    }));
    const weakRes = await upload(weakKid.deviceToken, weak);
    assert.equal(weakRes.json.progress.units.find((u) => u.unitId === "K-M2").keyState, "SILVER_KEY");
  });
});

describe("server values equal the engine math (facts in, engine out)", () => {
  test("a 4/4 topic session projects the exact engine derivation", async () => {
    const kid = await consentedChild();
    const raws = [2.0, 2.2, 1.9, 2.4];
    const batch = raws.map((raw, i) => attemptWire(i + 1, { rawTimeSec: raw }));
    const res = await upload(kid.deviceToken, batch);
    assert.equal(res.status, 200);

    const motor = 0.42;
    const target = 6; // K-M2 gate_max_speed_sec
    const cogTimes = raws.map((r) => computeCognitiveTimeSec(r, motor, 0));
    const medSpeed = Number(median(cogTimes).toFixed(2));
    const accPct = 100;
    const crowns = accPct >= 95 && medSpeed <= target ? 3 : 2;
    const fg = computeFluencyGrade(true, medSpeed, target);
    const sr = updateTopicMemoryStability({
      currentStabilityDays: 1.0,
      fluencyGrade: fg,
      gradeGrowthFactor: 1.85, // kindergarten pack SR policy
      maxIntervalCapDays: 30
    });

    const topic = res.json.progress.topics.find((t) => t.topicId === "K-M2-G");
    assert.equal(topic.completed, 1);
    assert.equal(topic.crowns, crowns);
    assert.equal(topic.bestAccuracyPct, accPct);
    assert.equal(topic.bestMedianSpeedSec, medSpeed);
    assert.equal(topic.fluencyGrade, fg);
    assert.ok(Math.abs(topic.stabilityDays - sr.stabilityDays) < 1e-6);
    // last_reviewed_at adopts the session's client timestamp.
    assert.equal(Date.parse(topic.lastReviewedAt), batch[3].answeredAtMs);
  });
});

describe("deterministic convergence across batch splits (Risk-3 mitigation)", () => {
  /** mulberry32 — same seeded PRNG as the mobile suite. */
  function prng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function seededSessions(seed, nowMs = Date.now() - 48 * 3_600_000) {
    const rand = prng(seed);
    const sessions = [];
    let seq = 0;
    let t = nowMs;
    const sessionCount = 3 + Math.floor(rand() * 3); // 3-5 sessions
    for (let s = 0; s < sessionCount; s += 1) {
      const kind = rand() < 0.6 ? "TOPIC_PRACTICE" : "GATE";
      const items = kind === "TOPIC_PRACTICE" ? 3 + Math.floor(rand() * 5) : 6 + Math.floor(rand() * 3);
      const sessionId = `sess-${seed}-${s}`;
      const attempts = [];
      for (let i = 0; i < items; i += 1) {
        seq += 1;
        t += 120_000;
        const topicCode = ["G", "H", "I"][Math.floor(rand() * 3)];
        attempts.push({
          seq,
          unitId: "K-M2",
          topicId: `K-M2-${topicCode}`,
          questionId: `K-M2-${topicCode}-Q${(i % 10) + 1}`,
          sessionType: kind,
          sessionId,
          chosenAnswer: String(i),
          isCorrect: rand() < 0.85,
          rawTimeSec: Number((0.8 + rand() * 4).toFixed(2)),
          audioDurationSec: 0,
          misconceptionTags: [],
          answeredAtMs: t,
          motorBaselineSec: 0.42
        });
      }
      sessions.push(attempts);
    }
    return sessions;
  }

  test("identical stream as 1 batch / 2 batches / per-session batches -> identical snapshots", async () => {
    const sessions = seededSessions(48);
    // Seed 48's randomized gate sessions may all fail; append one
    // guaranteed-PASSING gate session (all correct, fast) so the unit
    // surface (K-M2) deterministically exists for the convergence
    // comparison — identical bytes for every student.
    const gateAt = Date.now() - 30 * 3_600_000;
    const gateSeqStart = sessions.flat().length;
    const topics = ["G", "H", "I"];
    const passingGate = Array.from({ length: 8 }, (_, i) => ({
      seq: gateSeqStart + i + 1,
      unitId: "K-M2",
      topicId: `K-M2-${topics[i % 3]}`,
      questionId: `K-M2-${topics[i % 3]}-Q${i + 1}`,
      sessionType: "GATE",
      sessionId: "sess-gate-pass",
      chosenAnswer: "1",
      isCorrect: true,
      rawTimeSec: 2,
      audioDurationSec: 0,
      misconceptionTags: [],
      answeredAtMs: gateAt + i * 60_000,
      motorBaselineSec: 0.42
    }));
    sessions.push(passingGate);
    const flat = sessions.flat();

    const [one, two, many] = await Promise.all([consentedChild(), consentedChild(), consentedChild()]);

    const r1 = await upload(one.deviceToken, flat);
    assert.equal(r1.status, 200, JSON.stringify(r1.json));

    // Split at the SESSION BOUNDARY nearest the midpoint — the split
    // the mobile engine produces under a capped drain (whole sessions
    // only; a mid-session cut would violate the protocol contract).
    let cut = 0;
    let bestDist = Infinity;
    let cumulative = 0;
    for (const session of sessions) {
      cumulative += session.length;
      if (Math.abs(cumulative - flat.length / 2) < bestDist) {
        bestDist = Math.abs(cumulative - flat.length / 2);
        cut = cumulative;
      }
    }
    assert.ok(cut > 0 && cut < flat.length, "boundary split must produce two non-empty batches");
    const r2a = await upload(two.deviceToken, flat.slice(0, cut));
    const r2b = await upload(two.deviceToken, flat.slice(cut));
    assert.equal(r2a.status, 200);
    assert.equal(r2b.status, 200);

    for (const session of sessions) {
      const r = await upload(many.deviceToken, session);
      assert.equal(r.status, 200);
    }

    // The snapshot also carries each child's creation-time UNLOCK SEED
    // rows (starter unit progress stamped at the child's creation
    // moment) — per-student by design and outside the synced surface.
    // The convergence criterion is the SYNCED unit (K-M2): identical
    // across every batch split, engine-deterministic.
    const pick = (res) => ({
      units: res.json.progress.units.filter((u) => u.unitId === "K-M2"),
      topics: res.json.progress.topics.filter((t) => t.unitId === "K-M2")
    });
    assert.deepEqual(pick(r2b), pick(r1), "two-batch delivery must converge to one-batch");
    const manyRes = await api("/api/sync/progress", { token: many.deviceToken });
    assert.deepEqual(pick(manyRes), pick(r1), "per-session batches must converge to one-batch");
    // And the synced surface actually exists (the stream reconciled).
    assert.equal(pick(r1).units.length, 1);
    assert.ok(pick(r1).topics.length > 0);
  });

  test("different seeds produce deterministic (reproducible) streams", async () => {
    // Fixed clock base: the SEED must be the only variable. A live
    // Date.now() base made this a same-millisecond lottery under CI load
    // (surfaced by #64's added test files) — the flake, not the PRNG,
    // differed between runs.
    const a = seededSessions(21, 1_700_000_000_000);
    const b = seededSessions(21, 1_700_000_000_000);
    assert.deepEqual(a, b, "same seed must produce the identical stream");
  });
});

describe("snapshot GET + content handshake", () => {
  test("GET /api/sync/progress returns serverTime + snapshot; stale pack flagged", async () => {
    const kid = await consentedChild();
    const res = await api("/api/sync/progress", {
      token: kid.deviceToken
    });
    assert.equal(res.status, 200);
    assert.ok(res.json.serverTime);
    // A fresh child has only its creation-time unlock-seed unit rows —
    // no topic rows, no synced K-M2 surface.
    assert.deepEqual(res.json.progress.topics, []);
    assert.equal(
      res.json.progress.units.filter((u) => u.unitId === "K-M2").length,
      0,
      "no synced K-M2 rows before any upload"
    );

    const stale = await api("/api/sync/progress?packs=kindergarten:0.9.0", {
      token: kid.deviceToken
    });
    assert.equal(stale.status, 200);
    const flagged = stale.json.packsOutdated.find((p) => p.gradeId === "kindergarten");
    assert.ok(flagged, "stale kindergarten pack must be flagged");
    assert.equal(flagged.installedVersion, "0.9.0");
    assert.equal(flagged.currentVersion, "1.0.0");

    const current = await api("/api/sync/progress?packs=kindergarten:1.0.0", {
      token: kid.deviceToken
    });
    assert.equal(current.json.packsOutdated.length, 0);
  });

  test("upload handshake flags outdated packs in the response", async () => {
    const kid = await consentedChild();
    const res = await upload(kid.deviceToken, [attemptWire(1)], [
      { gradeId: "kindergarten", contentVersion: "0.9.0" }
    ]);
    assert.equal(res.status, 200);
    assert.equal(res.json.packsOutdated.length, 1);
    assert.equal(res.json.packsOutdated[0].currentVersion, "1.0.0");
  });
});

describe("batch caps and schema edges", () => {
  test("more than 200 attempts in one batch -> 400 validation", async () => {
    const kid = await consentedChild();
    const big = Array.from({ length: 201 }, (_, i) => attemptWire(i + 1));
    const res = await upload(kid.deviceToken, big);
    assert.equal(res.status, 400);
  });

  test("empty attempts array -> 400 validation", async () => {
    const kid = await consentedChild();
    const res = await upload(kid.deviceToken, []);
    assert.equal(res.status, 400);
  });

  test("unknown sessionType -> 400 validation", async () => {
    const kid = await consentedChild();
    const res = await upload(kid.deviceToken, [
      attemptWire(1, { sessionType: "HACK_SESSION" })
    ]);
    assert.equal(res.status, 400);
    assert.equal(await attemptsInDb(kid.studentId), 0);
  });
});

// --- GAME sessions (issue #52: the game framework's telemetry rides -----------
// --- the existing pipeline; the replay derives per-topic progress) ------------

function gameAttemptWire(n, sessionId, topicId, unitId, correct) {
  clock += 60_000;
  return {
    seq: n,
    unitId,
    topicId,
    questionId: `${topicId}-Q${n}`,
    sessionType: "GAME",
    sessionId,
    chosenAnswer: "1",
    isCorrect: correct,
    rawTimeSec: 2,
    audioDurationSec: 0,
    misconceptionTags: [],
    answeredAtMs: clock,
    motorBaselineSec: 0.42
  };
}

describe("GAME sessions (#52): accepted, per-topic derivation, idempotent", () => {
  test("a spiral-mixed GAME session credits EVERY topic it served, exactly once", async () => {
    const kid = await consentedChild();
    // 70/20/10-shaped session: 6 items on the current topic, 2 on a
    // prerequisite-unit topic (the contrastive slice) — one sessionId.
    const session = "sess-game-1";
    const batch = [
      ...Array.from({ length: 6 }, (_, i) => gameAttemptWire(i + 1, session, "K-M2-G", "K-M2", true)),
      ...Array.from({ length: 2 }, (_, i) => gameAttemptWire(7 + i, session, "K-M1-D", "K-M1", true))
    ];
    const res = await upload(kid.deviceToken, batch);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.stats.inserted, 8);
    assert.equal(res.json.stats.sessionsReplayed, 1);

    const topics = res.json.progress.topics;
    const current = topics.find((t) => t.topicId === "K-M2-G");
    const prereq = topics.find((t) => t.topicId === "K-M1-D");
    assert.ok(current, "current topic projected from its own 6 items");
    assert.ok(prereq, "prerequisite topic projected from its own 2 items");
    // Each topic derived from ITS OWN items: 6/6 and 2/2, 100% both.
    assert.equal(current.attemptsCount, 1);
    assert.equal(prereq.attemptsCount, 1);
    assert.equal(current.bestAccuracyPct, 100);
    assert.equal(prereq.bestAccuracyPct, 100);
    // Unit attribution follows each topic's owning unit.
    assert.equal(current.unitId, "K-M2");
    assert.equal(prereq.unitId, "K-M1");
    // 2/2 correct on the prereq topic passes the 80% bar (not a
    // sample-size error: deriveTopicSession treats the group as the
    // session for that topic, same as any small topic session).
    assert.equal(prereq.completed, 1);
    // Both rows persist with session_type GAME.
    const rows = await queryDb(
      "SELECT session_type, COUNT(*)::int AS n FROM student_question_attempts WHERE student_id = $1 AND session_id = $2 GROUP BY session_type",
      [kid.studentId, session]
    );
    assert.deepEqual(rows, [{ session_type: "GAME", n: 8 }]);
  });

  test("idempotent GAME replay: same batch twice = one count per topic, no drift", async () => {
    const kid = await consentedChild();
    const session = "sess-game-2";
    const batch = [
      ...Array.from({ length: 5 }, (_, i) => gameAttemptWire(i + 1, session, "K-M2-G", "K-M2", true)),
      gameAttemptWire(6, session, "K-M2-G", "K-M2", false),
      gameAttemptWire(7, session, "K-M1-D", "K-M1", true)
    ];
    const first = await upload(kid.deviceToken, batch);
    assert.equal(first.status, 200, JSON.stringify(first.json));
    const second = await upload(kid.deviceToken, batch);
    assert.equal(second.status, 200);
    assert.equal(second.json.stats.inserted, 0);
    assert.equal(second.json.stats.duplicates, 7);
    assert.deepEqual(second.json.progress, first.json.progress);
    for (const topicId of ["K-M2-G", "K-M1-D"]) {
      const topic = second.json.progress.topics.find((t) => t.topicId === topicId);
      assert.ok(topic, `${topicId} projected`);
      assert.equal(topic.attemptsCount, 1, `${topicId} counted exactly once`);
    }
  });

  test("GAME pass transition rewards coins once per topic; replay never re-rewards", async () => {
    const kid = await consentedChild();
    const coinsBefore = async () => {
      const rows = await queryDb("SELECT star_coins FROM students WHERE student_id = $1", [
        kid.studentId
      ]);
      return rows[0].star_coins;
    };
    const before = await coinsBefore();
    const session = "sess-game-3";
    const batch = Array.from({ length: 6 }, (_, i) =>
      gameAttemptWire(i + 1, session, "K-M2-G", "K-M2", true)
    );
    const res = await upload(kid.deviceToken, batch);
    assert.equal(res.status, 200);
    // 6/6 correct -> crowns by speed vs the unit target; coins = 15 + crowns*5.
    const topic = res.json.progress.topics.find((t) => t.topicId === "K-M2-G");
    assert.ok(topic);
    const after = await coinsBefore();
    assert.equal(after - before, 15 + topic.crowns * 5);
    // Replay: zero new coins.
    await upload(kid.deviceToken, batch);
    assert.equal(await coinsBefore(), after);
  });

  test("a GAME session with a failing topic group does not complete that topic", async () => {
    const kid = await consentedChild();
    const session = "sess-game-4";
    const batch = [
      ...Array.from({ length: 2 }, (_, i) => gameAttemptWire(i + 1, session, "K-M2-G", "K-M2", true)),
      ...Array.from({ length: 4 }, (_, i) => gameAttemptWire(3 + i, session, "K-M2-G", "K-M2", false)),
      gameAttemptWire(7, session, "K-M1-D", "K-M1", true)
    ];
    const res = await upload(kid.deviceToken, batch);
    assert.equal(res.status, 200);
    const current = res.json.progress.topics.find((t) => t.topicId === "K-M2-G");
    const prereq = res.json.progress.topics.find((t) => t.topicId === "K-M1-D");
    // 2/6 = 33.3% on the current topic: below 80, not completed; the
    // prereq group's 1/1 must be unaffected by the current topic's miss.
    assert.equal(current.completed, 0);
    assert.equal(current.bestAccuracyPct, 33.3);
    assert.equal(prereq.completed, 1);
    assert.equal(prereq.bestAccuracyPct, 100);
  });

  test("per-topic engine math: GAME group values equal deriveTopicSession on that group", async () => {
    const kid = await consentedChild();
    const session = "sess-game-5";
    const rawTimes = [2, 3, 4, 2, 2];
    const batch = rawTimes.map((rawTimeSec, i) =>
      gameAttemptWire(i + 1, session, "K-M2-G", "K-M2", i !== 2)
    );
    const res = await upload(kid.deviceToken, batch);
    assert.equal(res.status, 200);
    const topic = res.json.progress.topics.find((t) => t.topicId === "K-M2-G");
    assert.ok(topic);
    const cog = rawTimes.map((t) => computeCognitiveTimeSec(t, 0.42, 0));
    const med = Number(median(cog).toFixed(2));
    assert.equal(topic.bestAccuracyPct, 80);
    assert.equal(topic.bestMedianSpeedSec, med);
    assert.equal(topic.completed, 1); // exactly at the 80% boundary
  });

  // --- tester additions (#52 brief): 3-topic stream + key-path guard ------
  test("a THREE-topic spiral stream credits every owning topic with audio-aware math", async () => {
    const kid = await consentedChild();
    // 70/20/10-shaped session over three topics: current + a
    // prerequisite-unit item (contrastive slice) + a second foreign
    // topic (the spaced-review slice) — one sessionId.
    const session = "sess-game-6";
    const batch = [
      ...Array.from({ length: 6 }, (_, i) => {
        const wire = gameAttemptWire(i + 1, session, "K-M2-G", "K-M2", true);
        // GAME attempts are audio-aware server-side too (isTopic ===
        // TOPIC_PRACTICE only): a narration must bend the median away
        // from the no-audio value (raw 4.2: 2.28 vs 3.78, clear of the
        // engine's 0.5s floor).
        wire.rawTimeSec = 4.2;
        wire.audioDurationSec = 1.5;
        return wire;
      }),
      gameAttemptWire(7, session, "K-M1-D", "K-M1", true),
      gameAttemptWire(8, session, "K-M1-E", "K-M1", true)
    ];
    const res = await upload(kid.deviceToken, batch);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const topics = res.json.progress.topics;
    for (const topicId of ["K-M2-G", "K-M1-D", "K-M1-E"]) {
      const topic = topics.find((t) => t.topicId === topicId);
      assert.ok(topic, `${topicId} projected from its own items`);
      assert.equal(topic.unitId, topicId.slice(0, 4), `${topicId} attributed to its owning unit`);
      assert.equal(topic.attemptsCount, 1, `${topicId} counted exactly once`);
    }
    // The topic-projection median is the audio-0 TOPIC math (the same
    // deriveTopicSession both sides run — parity by construction):
    // raw 4.2 - motor .42 = 3.78 even though the rows carry audio.
    const current = topics.find((t) => t.topicId === "K-M2-G");
    assert.equal(current.bestAccuracyPct, 100);
    assert.equal(current.bestMedianSpeedSec, 3.78);
    // The audio-aware GAME rule lives at the ROW level (the server's
    // isTopic === TOPIC_PRACTICE branch): stored cognitive_time_sec =
    // raw 4.2 - motor .42 - audio 1.5 = 2.28 for the narrated items.
    const narrated = await queryDb(
      "SELECT cognitive_time_sec FROM student_question_attempts WHERE student_id = $1 AND session_id = $2 AND topic_id = 'K-M2-G'",
      [kid.studentId, session]
    );
    assert.equal(narrated.length, 6);
    for (const row of narrated) assert.equal(row.cognitive_time_sec, 2.28);
    // The foreign groups (audio 0) derive independently at both levels.
    const prereq = topics.find((t) => t.topicId === "K-M1-D");
    assert.equal(prereq.bestMedianSpeedSec, computeCognitiveTimeSec(2, 0.42, 0));
  });

  test("a GAME session never touches the key/gold path (pre-#52 else-branch tripwire)", async () => {
    const kid = await consentedChild();
    const session = "sess-game-7";
    // 5/5 correct: under the OLD replay branching a GAME session fell
    // into the gold-verification else-branch and would have upgraded
    // the unit to GOLD_KEY (>= 4-of-5). The explicit GAME branch must
    // derive topic progress ONLY — the session's unit gets NO key row.
    // (The student's pre-seeded prerequisite-grade unlock rows — PK-M7,
    // PK-E7, GOLD by creation — must be the ONLY keyed units.)
    const batch = Array.from({ length: 5 }, (_, i) =>
      gameAttemptWire(i + 1, session, "K-M2-G", "K-M2", true)
    );
    const res = await upload(kid.deviceToken, batch);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const unitRows = await queryDb(
      "SELECT unit_id, key_state FROM student_unit_progress WHERE student_id = $1 ORDER BY unit_id ASC",
      [kid.studentId]
    );
    const keyed = unitRows.filter((r) => r.key_state !== null);
    assert.deepEqual(
      keyed.map((r) => r.unit_id),
      ["PK-E7", "PK-M7"],
      `only the creation-time prerequisite unlocks may hold keys; got ${JSON.stringify(unitRows)}`
    );
    assert.ok(
      !unitRows.some((r) => r.unit_id === "K-M2"),
      "a GAME session must not create or upgrade the session unit's key row"
    );
    // And the topic projection DID happen (the session was replayed as
    // per-topic, not silently dropped).
    const topic = res.json.progress.topics.find((t) => t.topicId === "K-M2-G");
    assert.ok(topic, "topic progress projected");
    assert.equal(topic.completed, 1);
  });
});

// --- Hearts session outcomes (issue #56, roadmap D6: the additive ------
// --- sessionOutcomes wire field + exactly-once ingestion) ---------------

function uploadWithOutcomes(token, attempts, sessionOutcomes) {
  return api("/api/sync/attempts", {
    method: "POST",
    token,
    body: { attempts, sessionOutcomes }
  });
}

function outcomeWire(overrides = {}) {
  return {
    seq: 1,
    sessionId: "sess-hearts-1",
    sessionType: "GAME",
    stage: "fluency",
    heartsLost: 5,
    heartsRemaining: 0,
    endReason: "hearts-empty",
    endedAtMs: clock,
    ...overrides
  };
}

describe("hearts session outcomes (#56): additive wire, exactly-once, validated", () => {
  test("a hearts-empty outcome rides the batch, is acknowledged, and persists exactly once", async () => {
    const kid = await consentedChild();
    const session = "sess-hearts-1";
    const batch = Array.from({ length: 6 }, (_, i) =>
      gameAttemptWire(i + 1, session, "K-M2-G", "K-M2", i < 1)
    );
    const res = await uploadWithOutcomes(kid.deviceToken, batch, [outcomeWire()]);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.deepEqual(res.json.ackedOutcomeIds, [1]);
    assert.equal(res.json.stats.outcomesInserted, 1);

    const rows = await queryDb(
      "SELECT session_id, session_type, stage, hearts_lost, hearts_remaining, end_reason, device_id FROM student_session_outcomes WHERE student_id = $1",
      [kid.studentId]
    );
    assert.deepEqual(rows, [
      {
        session_id: session,
        session_type: "GAME",
        stage: "fluency",
        hearts_lost: 5,
        hearts_remaining: 0,
        end_reason: "hearts-empty",
        device_id: kid.deviceId
      }
    ]);

    // Re-send the same batch (crash-before-ack replay): attempts
    // dedupe AND the outcome inserts nothing — exactly-once by the
    // (student, session) constraint, acked again.
    const replay = await uploadWithOutcomes(kid.deviceToken, batch, [outcomeWire()]);
    assert.equal(replay.status, 200);
    assert.equal(replay.json.stats.inserted, 0);
    assert.equal(replay.json.stats.outcomesInserted, 0);
    assert.deepEqual(replay.json.ackedOutcomeIds, [1]);
    const still = await queryDb(
      "SELECT COUNT(*)::int AS n FROM student_session_outcomes WHERE student_id = $1",
      [kid.studentId]
    );
    assert.equal(still[0].n, 1);
  });

  test("a completed outcome persists with its full heart row", async () => {
    const kid = await consentedChild();
    const batch = [
      gameAttemptWire(1, "sess-hearts-2", "K-M2-G", "K-M2", true),
      gameAttemptWire(2, "sess-hearts-2", "K-M2-G", "K-M2", true)
    ];
    const res = await uploadWithOutcomes(kid.deviceToken, batch, [
      outcomeWire({
        seq: 2,
        sessionId: "sess-hearts-2",
        heartsLost: 0,
        heartsRemaining: 5,
        endReason: "completed"
      })
    ]);
    assert.equal(res.status, 200, JSON.stringify(res.json));
    assert.equal(res.json.stats.outcomesInserted, 1);
    const rows = await queryDb(
      "SELECT hearts_lost, hearts_remaining, end_reason FROM student_session_outcomes WHERE student_id = $1",
      [kid.studentId]
    );
    assert.deepEqual(rows, [{ hearts_lost: 0, hearts_remaining: 5, end_reason: "completed" }]);
  });

  test("legacy batches (no sessionOutcomes) keep the pre-#56 response shape", async () => {
    const kid = await consentedChild();
    const res = await upload(kid.deviceToken, [gameAttemptWire(1, "sess-hearts-3", "K-M2-G", "K-M2", true)]);
    assert.equal(res.status, 200);
    assert.ok(!("ackedOutcomeIds" in res.json), "no ack field when no outcomes were sent");
  });

  test("invalid outcomes fail the WHOLE batch (nothing partial is stored)", async () => {
    const kid = await consentedChild();
    const cases = [
      // Counts that do not account for every heart.
      outcomeWire({ heartsLost: 2, heartsRemaining: 2 }),
      // End-reason contradictions.
      outcomeWire({ heartsLost: 4, heartsRemaining: 1, endReason: "hearts-empty" }),
      outcomeWire({ heartsLost: 5, heartsRemaining: 0, endReason: "completed" }),
      // Duplicate session ends in one batch.
      [outcomeWire({ seq: 1 }), outcomeWire({ seq: 2 })]
    ];
    for (const outcomeCase of cases) {
      const outcomes = Array.isArray(outcomeCase) ? outcomeCase : [outcomeCase];
      const batch = [gameAttemptWire(1, "sess-hearts-invalid", "K-M2-G", "K-M2", true)];
      const res = await uploadWithOutcomes(kid.deviceToken, batch, outcomes);
      assert.equal(res.status, 400, JSON.stringify(outcomes));
    }
    assert.equal(await attemptsInDb(kid.studentId), 0);
    const rows = await queryDb(
      "SELECT COUNT(*)::int AS n FROM student_session_outcomes WHERE student_id = $1",
      [kid.studentId]
    );
    assert.equal(rows[0].n, 0);
  });

  test("schema edges: wrong sessionType/stage and out-of-range counts -> 400", async () => {
    const kid = await consentedChild();
    const batch = [gameAttemptWire(1, "sess-hearts-edge", "K-M2-G", "K-M2", true)];
    for (const overrides of [
      { sessionType: "TOPIC_PRACTICE" },
      { stage: "guided" },
      { heartsLost: 6, heartsRemaining: 0 },
      { endReason: "rage-quit" }
    ]) {
      const res = await uploadWithOutcomes(kid.deviceToken, batch, [outcomeWire(overrides)]);
      assert.equal(res.status, 400, JSON.stringify(overrides));
    }
  });
});
