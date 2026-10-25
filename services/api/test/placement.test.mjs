// Placement integration tests (issue #60) — REAL server, REAL Postgres,
// REAL child-device tokens. The D8/D3 agreement matrix:
//
// - placement attempts ride the EXISTING sync attempt stream
//   (sessionType PLACEMENT); the server recomputes the record from the
//   stream via the same core-engine placement module the client runs
// - GET /api/placement/record serves the stored outcome (child-device
//   tokens only; consent-gated; 404 when none for the grade)
// - provisional credit: stability-only topic rows (no completion, no
//   crowns, no unit rows, no keys) — the #60 guardrails, structurally
// - idempotent replay: same batch twice = same record + same snapshot
// - per-attempt XP credited (correct answers are correct answers, D9);
//   NO outcome XP/coins (nothing was passed)
// - degenerate streams: all-wrong -> unit-1 start, zero credit

import { test, describe, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDatabase, dropTestDatabase, startTestServer, waitForHealth, createVerifiedParentWithConsent } from "./helpers.mjs";
import { derivePlacementOutcome, PLACEMENT_RULES } from "../../../packages/core-engine/src/index.mjs";

const API = "http://127.0.0.1:4817";
let serverProcess;
let testDatabase;
let packsDir;
let seq = 0;
let clock = 1_780_000_000_000;

// The CLIENT-side derivation input: the same registry the server's units
// table was seeded from, shaped the way the RN placement adapter shapes
// pack rows. Same source, same engine => agreement by construction, and
// these tests pin that the construction holds through the real wire.
const registry = JSON.parse(
  fs.readFileSync(new URL("../../../docs/us-curriculum-registry.json", import.meta.url), "utf8")
);
function engineUnitsForGrade(gradeId) {
  const grade = registry.grades.find((g) => g.gradeId === gradeId);
  const units = [];
  for (const [subjectKey, subject] of Object.entries(grade.subjects)) {
    for (const unit of subject.units) {
      units.push({
        unitId: unit.unitId,
        strand: subjectKey,
        sequenceOrder: unit.sequenceOrder,
        title: unit.title,
        prerequisiteUnitIds: unit.prerequisiteUnitIds || [],
        masteryGate: unit.masteryGate,
        skillTopics: unit.skillTopics
      });
    }
  }
  return units;
}

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
      nickname: `PlaceKid${++seq}`,
      pin: "5150",
      currentGrade: "kindergarten",
      clientDeviceId: `place-device-${seq}-xy`,
      platform: "ios"
    }
  });
  assert.equal(create.status, 201, JSON.stringify(create.json));
  const mint = await api(`/api/parent/children/${create.json.studentId}/device-sessions`, {
    method: "POST",
    token: parent.token,
    body: { clientDeviceId: `place-device-${seq}-xy2`, platform: "ios" }
  });
  assert.equal(mint.status, 201, JSON.stringify(mint.json));
  return {
    studentId: create.json.studentId,
    deviceToken: mint.json.token,
    parentToken: parent.token
  };
}

/** A PLACEMENT attempt on the wire (facts only, like every session type). */
function placementWire(n, { unitId, topicCode, isCorrect }, sessionId) {
  clock += 60_000;
  return {
    seq: n,
    unitId,
    topicId: `${unitId}-${topicCode}`,
    questionId: `${unitId}-${topicCode}-P${n}`,
    sessionType: "PLACEMENT",
    sessionId,
    chosenAnswer: "1",
    isCorrect,
    rawTimeSec: 2.5,
    audioDurationSec: 0,
    misconceptionTags: [],
    answeredAtMs: clock,
    motorBaselineSec: 0.42
  };
}

/** First real topic code of a unit, off the registry (wire topicIds must be real). */
function firstTopicCode(units, unitId) {
  const unit = units.find((u) => u.unitId === unitId);
  return unit && Array.isArray(unit.skillTopics) && unit.skillTopics.length > 0
    ? unit.skillTopics[0].code
    : "A";
}

/**
 * A client-run placement session over the real K chains: correct on both
 * grade-entry units, wrong+confirmed-wrong on both second units — the
 * mixed-child frontier shape. Returns wire attempts + the engine's own
 * outcome over the same responses (what the RN client computes locally).
 */
function kindergartenMixedSession(sessionId) {
  const units = engineUnitsForGrade("kindergarten");
  const unitFacts = [
    { unitId: "K-M1", isCorrect: true },
    { unitId: "K-E1", isCorrect: true },
    { unitId: "K-M2", isCorrect: false },
    { unitId: "K-M2", isCorrect: false },
    { unitId: "K-E2", isCorrect: false },
    { unitId: "K-E2", isCorrect: false }
  ];
  const facts = unitFacts.map((f) => ({ ...f, topicCode: firstTopicCode(units, f.unitId) }));
  // Engine units without skillTopics are enough for the outcome mapping.
  const outcomeUnits = units.map((u) => ({ ...u, skillTopics: undefined }));
  const responses = facts.map((f) => ({ unitId: f.unitId, topicId: `${f.unitId}-${f.topicCode}`, isCorrect: f.isCorrect }));
  const expected = derivePlacementOutcome({ responses, units: outcomeUnits });
  const attempts = facts.map((f, i) => placementWire(i + 1, f, sessionId));
  return { attempts, expected, outcomeUnits, responses };
}

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  packsDir = fs.mkdtempSync(path.join(os.tmpdir(), "balashi-placement-packs-"));
  fs.writeFileSync(path.join(packsDir, "index.json"), JSON.stringify({ generatedAt: new Date(0).toISOString(), packs: [] }));
  serverProcess = await startTestServer({
    port: 4817,
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
});

describe("placement over the sync stream (D8 agreement)", () => {
  test("server record equals the engine outcome computed client-side from the same stream", async () => {
    const child = await consentedChild();
    const session = kindergartenMixedSession("place-sess-1");
    const upload = await api("/api/sync/attempts", {
      method: "POST",
      token: child.deviceToken,
      body: { attempts: session.attempts }
    });
    assert.equal(upload.status, 200, JSON.stringify(upload.json));
    assert.equal(upload.json.stats.sessionsReplayed, 1);

    const record = await api("/api/placement/record?gradeId=kindergarten", { token: child.deviceToken });
    assert.equal(record.status, 200, JSON.stringify(record.json));
    assert.equal(record.json.recommendedStartUnitId, session.expected.recommendedStartUnitId);
    assert.equal(record.json.itemsAsked, session.expected.itemsAsked);
    const serverCredited = record.json.creditedUnits
      .flatMap((strand) => strand.unitIds)
      .sort();
    const engineCredited = session.expected.creditedUnits.map((u) => u.unitId).sort();
    assert.deepEqual(serverCredited, engineCredited);
    // The guardrail held: a small mixed run credits the two entry units
    // only. The recommended start is the earliest unfinished strand in
    // journey order — unprobed strands (science/social studies) pin at
    // their own first units, so the recommendation lands on the earliest
    // such point, never inside an uncredited chain.
    assert.deepEqual(engineCredited, ["K-E1", "K-M1"]);
    const allKUnitIds = engineUnitsForGrade("kindergarten").map((u) => u.unitId);
    assert.ok(allKUnitIds.includes(record.json.recommendedStartUnitId));
  });

  test("provisional credit is stability-only: no completion, no crowns, no unit rows, no keys", async () => {
    const child = await consentedChild();
    const session = kindergartenMixedSession("place-sess-2");
    const upload = await api("/api/sync/attempts", {
      method: "POST",
      token: child.deviceToken,
      body: { attempts: session.attempts }
    });
    assert.equal(upload.status, 200);

    const snapshot = await api("/api/sync/progress", { token: child.deviceToken });
    assert.equal(snapshot.status, 200);
    // Placement NEVER writes unit progress: the only unit rows are the
    // child-creation prerequisite seeds (prior-grade final units), never
    // a placement-probed unit, and never a status/key change.
    const unitIds = snapshot.json.progress.units.map((u) => u.unitId).sort();
    assert.deepEqual(unitIds, ["PK-E7", "PK-M7"]);
    // The credited topics carry provisional stability and stay incomplete.
    const topics = snapshot.json.progress.topics.filter((t) => session.expected.creditedUnits.some(
      (u) => u.topics.some((topic) => topic.topicId === t.topicId)
    ));
    assert.equal(topics.length, 2); // one per demonstrated entry unit
    for (const topic of topics) {
      assert.equal(topic.completed, 0);
      assert.equal(topic.crowns, 0);
      assert.equal(topic.masteryScore, 0);
      assert.ok(topic.stabilityDays > 0, "provisional stability granted");
      assert.ok(topic.stabilityDays <= 4, "stability stays in the provisional band");
    }
  });

  test("per-attempt XP credited for correct placement answers; no outcome rewards path", async () => {
    const child = await consentedChild();
    const session = kindergartenMixedSession("place-sess-3");
    const upload = await api("/api/sync/attempts", {
      method: "POST",
      token: child.deviceToken,
      body: { attempts: session.attempts }
    });
    assert.equal(upload.status, 200);
    // 2 correct answers x fluency-graded attempt XP (D9); the engine's
    // exact amount, but strictly > 0 and strictly < any outcome bonus.
    assert.ok(upload.json.stats.xpCredited > 0);
  });

  test("idempotent replay: same batch twice = same record, no drift", async () => {
    const child = await consentedChild();
    const session = kindergartenMixedSession("place-sess-4");
    const body = { attempts: session.attempts };
    const first = await api("/api/sync/attempts", { method: "POST", token: child.deviceToken, body });
    assert.equal(first.status, 200);
    const second = await api("/api/sync/attempts", { method: "POST", token: child.deviceToken, body });
    assert.equal(second.status, 200);
    assert.equal(second.json.stats.inserted, 0);

    const record = await api("/api/placement/record?gradeId=kindergarten", { token: child.deviceToken });
    assert.equal(record.status, 200);
    assert.equal(record.json.recommendedStartUnitId, session.expected.recommendedStartUnitId);
    assert.equal(record.json.itemsAsked, session.expected.itemsAsked);
    const snapshot = await api("/api/sync/progress", { token: child.deviceToken });
    for (const topic of snapshot.json.progress.topics) {
      assert.equal(topic.attemptsCount, 1, "no double count on replay");
    }
  });

  test("split batches converge: the union re-derives the same record", async () => {
    const child = await consentedChild();
    const session = kindergartenMixedSession("place-sess-5");
    const first = await api("/api/sync/attempts", {
      method: "POST",
      token: child.deviceToken,
      body: { attempts: session.attempts.slice(0, 3) }
    });
    assert.equal(first.status, 200);
    const second = await api("/api/sync/attempts", {
      method: "POST",
      token: child.deviceToken,
      body: { attempts: session.attempts.slice(3) }
    });
    assert.equal(second.status, 200);

    const record = await api("/api/placement/record?gradeId=kindergarten", { token: child.deviceToken });
    assert.equal(record.status, 200);
    assert.equal(record.json.recommendedStartUnitId, session.expected.recommendedStartUnitId);
    assert.equal(record.json.itemsAsked, session.expected.itemsAsked);
  });

  test("per-grade isolation: a second grade's placement never clobbers the first (uq student+grade)", async () => {
    const child = await consentedChild();

    // Kindergarten run first (the K mixed shape).
    const k = kindergartenMixedSession("place-sess-kg");
    assert.equal(
      (await api("/api/sync/attempts", { method: "POST", token: child.deviceToken, body: { attempts: k.attempts } })).status,
      200
    );

    // Then a GRADE-1 run: correct on G1-M1/G1-E1, wrong+confirm-wrong on
    // both second units — the same mixed shape over the G1 chains.
    const g1Units = engineUnitsForGrade("grade-1");
    const g1Facts = [
      { unitId: "G1-M1", isCorrect: true },
      { unitId: "G1-E1", isCorrect: true },
      { unitId: "G1-M2", isCorrect: false },
      { unitId: "G1-M2", isCorrect: false },
      { unitId: "G1-E2", isCorrect: false },
      { unitId: "G1-E2", isCorrect: false }
    ].map((f) => ({ ...f, topicCode: firstTopicCode(g1Units, f.unitId) }));
    // Distinct client seqs from the K run: the exactly-once seam
    // (student+device+client_seq) drops a re-used seq silently — a
    // second session MUST advance the device's sequence space.
    const g1Attempts = g1Facts.map((f, i) => placementWire(101 + i, f, "place-sess-g1"));
    assert.equal(
      (await api("/api/sync/attempts", { method: "POST", token: child.deviceToken, body: { attempts: g1Attempts } })).status,
      200
    );

    // BOTH records exist, each with its own grade's recommendation.
    const kRecord = await api("/api/placement/record?gradeId=kindergarten", { token: child.deviceToken });
    assert.equal(kRecord.status, 200);
    assert.equal(kRecord.json.recommendedStartUnitId, k.expected.recommendedStartUnitId);
    const g1Record = await api("/api/placement/record?gradeId=grade-1", { token: child.deviceToken });
    assert.equal(g1Record.status, 200);
    assert.ok(g1Record.json.recommendedStartUnitId.startsWith("G1-"), "grade-1 record carries a G1 unit");
    assert.notEqual(g1Record.json.sessionId, kRecord.json.sessionId);

    // A same-grade re-run OVERWRITES in place (one authoritative row per
    // student+grade; the unique index is the constraint under test).
    // Fresh seqs again — the device's sequence space only moves forward.
    const k2 = kindergartenMixedSession("place-sess-kg2");
    const k2Attempts = k2.attempts.map((a, i) => ({ ...a, seq: 201 + i }));
    assert.equal(
      (await api("/api/sync/attempts", { method: "POST", token: child.deviceToken, body: { attempts: k2Attempts } })).status,
      200
    );
    const kAfter = await api("/api/placement/record?gradeId=kindergarten", { token: child.deviceToken });
    assert.equal(kAfter.status, 200);
    assert.equal(kAfter.json.sessionId, "place-sess-kg2");
    assert.equal(kAfter.json.itemsAsked, k2.expected.itemsAsked);
    // And the grade-1 row is untouched by the kindergarten re-run.
    const g1After = await api("/api/placement/record?gradeId=grade-1", { token: child.deviceToken });
    assert.equal(g1After.json.sessionId, "place-sess-g1");
  });

  test("degenerate all-wrong stream: unit-1 start, zero credit, record still derived", async () => {
    const child = await consentedChild();
    const units = engineUnitsForGrade("kindergarten");
    const entryUnits = units.filter((u) => u.unitId === "K-M1" || u.unitId === "K-E1");
    const facts = entryUnits.flatMap((u) => [
      { unitId: u.unitId, topicCode: firstTopicCode(units, u.unitId), isCorrect: false },
      { unitId: u.unitId, topicCode: firstTopicCode(units, u.unitId), isCorrect: false }
    ]);
    const attempts = facts.map((f, i) => placementWire(i + 1, f, "place-sess-weak"));
    const upload = await api("/api/sync/attempts", {
      method: "POST",
      token: child.deviceToken,
      body: { attempts }
    });
    assert.equal(upload.status, 200);
    const record = await api("/api/placement/record?gradeId=kindergarten", { token: child.deviceToken });
    assert.equal(record.status, 200);
    assert.deepEqual(record.json.creditedUnits, []);
    assert.ok(["K-M1", "K-E1"].includes(record.json.recommendedStartUnitId));
    const snapshot = await api("/api/sync/progress", { token: child.deviceToken });
    // Only the child-creation prerequisite seeds; placement added nothing.
    assert.deepEqual(
      snapshot.json.progress.units.map((u) => u.unitId).sort(),
      ["PK-E7", "PK-M7"]
    );
  });
});

describe("GET /api/placement/record auth scope", () => {
  test("no token -> 401; parent token -> 403 wrong-token-type; unknown grade -> 404", async () => {
    const child = await consentedChild();
    const session = kindergartenMixedSession("place-sess-auth");
    await api("/api/sync/attempts", { method: "POST", token: child.deviceToken, body: { attempts: session.attempts } });

    const noToken = await api("/api/placement/record?gradeId=kindergarten");
    assert.equal(noToken.status, 401);

    const parentToken = await api("/api/placement/record?gradeId=kindergarten", { token: child.parentToken });
    assert.equal(parentToken.status, 403);
    assert.ok(parentToken.json.type.includes("wrong-token-type"));

    const none = await api("/api/placement/record?gradeId=grade-3", { token: child.deviceToken });
    assert.equal(none.status, 404);
    assert.ok(none.json.type.includes("placement-not-found"));
  });
});

describe("engine guardrail sanity on the served record shape", () => {
  test("skip-ahead cap and PLACEMENT_RULES agree with what the server stored", async () => {
    const child = await consentedChild();
    // An all-correct capped stream over K (client stops at maxItems).
    const units = engineUnitsForGrade("kindergarten").map((u) => ({ ...u, skillTopics: [{ code: "A", name: "A" }] }));
    const facts = [];
    // Deterministic all-correct walk: entry units repeatedly confirmed.
    for (let i = 0; i < PLACEMENT_RULES.maxItems; i += 1) {
      facts.push({ unitId: i % 2 === 0 ? "K-M1" : "K-E1", topicCode: "A", isCorrect: true });
    }
    const attempts = facts.map((f, i) => placementWire(i + 1, f, "place-sess-cap"));
    const upload = await api("/api/sync/attempts", {
      method: "POST",
      token: child.deviceToken,
      body: { attempts }
    });
    assert.equal(upload.status, 200);
    const record = await api("/api/placement/record?gradeId=kindergarten", { token: child.deviceToken });
    assert.equal(record.status, 200);
    for (const strand of record.json.perStrand) {
      assert.ok(strand.creditedUnits <= PLACEMENT_RULES.maxSkipAheadUnits, "cap enforced");
    }
    const engineExpected = derivePlacementOutcome({
      responses: facts.map((f) => ({ unitId: f.unitId, topicId: `${f.unitId}-A`, isCorrect: true })),
      units
    });
    assert.equal(record.json.recommendedStartUnitId, engineExpected.recommendedStartUnitId);
  });
});
