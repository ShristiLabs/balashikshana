// Parent portal integration tests (issue #61) — REAL server, REAL
// Postgres, REAL tokens. The security + aggregation matrix:
//
// - AUTH (AC1): every /api/portal/* route requires a PARENT session
//   token; student PIN sessions and child device tokens are 403
//   wrong-token-type (the #40 dual-token doctrine extended); anonymous
//   callers are 401.
// - OWNERSHIP (AC2): children resolve ONLY through the caller's CLAIMED
//   parent_children binding; another parent's child id is the same
//   uniform 404 as an unknown id (anti-enumeration).
// - AGGREGATION (AC4/AC5): quadrant accuracy/median-cognitive-speed
//   hand-computed from seeded sync attempts; ISO-week weekly series with
//   zeroed empty weeks; degenerate child -> empty topics, all-zero
//   weeks.
// - SETTINGS (AC7): platform defaults (reminders OFF, 17:00 shape);
//   persistence round-trip; schema bounds enforced.
// - ENFORCEMENT (AC6): a child over the daily cap is REFUSED new
//   practice (sync upload 429 time-limit-exceeded; pure backfill still
//   lands); a gated subject returns NO questions on the practice routes
//   (student + child-device callers); grade ceiling gates units and the
//   pack index/artifact; sync/progress carries the advisory
//   parentSettings block.

import { test, describe, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createTestDatabase,
  dropTestDatabase,
  startTestServer,
  waitForHealth,
  createVerifiedParentWithConsent
} from "./helpers.mjs";

const API = "http://127.0.0.1:4819";
let serverProcess;
let testDatabase;
let packsDir;
let seq = 0;
// Fixed clock base in the past; sync accepts past client timestamps.
let clock = Date.now() - 7 * 86400000;

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
  return { status: res.status, json, headers: res.headers };
}

async function consentedChild(nickname = `PortalKid${++seq}`) {
  const parent = await createVerifiedParentWithConsent(API);
  const create = await api("/api/parent/children", {
    method: "POST",
    token: parent.token,
    body: {
      nickname,
      pin: "5150",
      currentGrade: "kindergarten",
      clientDeviceId: `portal-device-${seq}-xy`,
      platform: "ios"
    }
  });
  assert.equal(create.status, 201, JSON.stringify(create.json));
  const mint = await api(`/api/parent/children/${create.json.studentId}/device-sessions`, {
    method: "POST",
    token: parent.token,
    body: { clientDeviceId: `portal-device-${seq}-xy2`, platform: "ios" }
  });
  assert.equal(mint.status, 201, JSON.stringify(mint.json));
  return {
    studentId: create.json.studentId,
    deviceToken: mint.json.token,
    parentToken: parent.token,
    parentId: parent.parentId
  };
}

/**
 * A TOPIC_PRACTICE attempt on the wire. The server derives ledger
 * cognitive seconds as round2(raw - motorBaseline) using the session's
 * first wire motorBaselineSec (sync.mjs; the falsy-0 fallback means 0
 * becomes 0.42 — so tests send 0.01 and compute expectations with
 * engineCognitive, the exact same formula).
 */
const MOTOR = 0.01;
function engineCognitive(rawSec) {
  return Number(Math.max(0.5, rawSec - MOTOR).toFixed(2));
}
function wire(n, { unitId, topicCode, isCorrect, rawSec, atMs }, sessionId) {
  clock += 60_000;
  return {
    seq: n,
    unitId,
    topicId: `${unitId}-${topicCode}`,
    questionId: `${unitId}-${topicCode}-Q${n}`,
    sessionType: "TOPIC_PRACTICE",
    sessionId,
    chosenAnswer: "1",
    isCorrect,
    rawTimeSec: rawSec,
    audioDurationSec: 0,
    misconceptionTags: [],
    answeredAtMs: atMs ?? clock,
    motorBaselineSec: MOTOR
  };
}

async function syncUpload(child, attempts) {
  return api("/api/sync/attempts", {
    method: "POST",
    token: child.deviceToken,
    body: { attempts }
  });
}

/** Monday 00:00 UTC of the ISO week containing `epochMs`. */
function mondayOf(epochMs) {
  const d = new Date(epochMs);
  const utc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  return utc - ((new Date(utc).getUTCDay() + 6) % 7) * 86400000;
}

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  packsDir = fs.mkdtempSync(path.join(os.tmpdir(), "balashi-portal-packs-"));
  // A full 5-grade index so ceiling filtering is observable. Artifact
  // names are canonical; the artifact FILES only matter for downloads.
  const grades = ["pre-k", "kindergarten", "grade-1", "grade-2", "grade-3"];
  fs.writeFileSync(
    path.join(packsDir, "index.json"),
    JSON.stringify({
      formatVersion: 1,
      registryVersion: "test",
      packs: grades.map((gradeId) => ({
        gradeId,
        contentVersion: "1.0.0",
        artifact: `pack-${gradeId}-v1.0.0.sqlite`,
        sizeBytes: 10,
        sha256: "0".repeat(64)
      }))
    })
  );
  serverProcess = await startTestServer({
    port: 4819,
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

// --- AC1: auth matrix ----------------------------------------------------------

describe("portal auth: parent tokens only (AC1)", () => {
  const ROUTES = [
    ["GET", "/api/portal/children"],
    ["GET", "/api/portal/children/stu-x/analytics/quadrant"],
    ["GET", "/api/portal/children/stu-x/analytics/weekly"],
    ["GET", "/api/portal/children/stu-x/settings"],
    ["PUT", "/api/portal/children/stu-x/settings"]
  ];

  test("anonymous callers get 401 on every portal route", async () => {
    for (const [method, route] of ROUTES) {
      const res = await api(route, { method, body: method === "PUT" ? { restrictedSubjects: [], remindersEnabled: false } : undefined });
      assert.equal(res.status, 401, `${method} ${route}`);
      assert.ok(res.json.type.includes("unauthorized"));
    }
  });

  test("child device tokens are 403 wrong-token-type on every portal route", async () => {
    const child = await consentedChild();
    for (const [method, route] of ROUTES) {
      const res = await api(route.replace("stu-x", child.studentId), {
        method,
        token: child.deviceToken,
        body: method === "PUT" ? { restrictedSubjects: [], remindersEnabled: false } : undefined
      });
      assert.equal(res.status, 403, `${method} ${route}`);
      assert.ok(res.json.type.includes("wrong-token-type"), `${method} ${route}: ${res.json.type}`);
    }
  });

  test("student PIN session tokens are 403 wrong-token-type", async () => {
    const { token: studentToken } = await (async () => {
      const reg = await api("/api/students", {
        method: "POST",
        token: (await createVerifiedParentWithConsent(API)).token,
        body: { nickname: "StuPin", currentGrade: "kindergarten", pin: "4455" }
      });
      assert.equal(reg.status, 201, JSON.stringify(reg.json));
      return reg.json;
    })();
    for (const [method, route] of ROUTES) {
      const res = await api(route, {
        method,
        token: studentToken,
        body: method === "PUT" ? { restrictedSubjects: [], remindersEnabled: false } : undefined
      });
      assert.equal(res.status, 403, `${method} ${route}`);
      assert.ok(res.json.type.includes("wrong-token-type"));
    }
  });

  test("the owning parent gets 200 (happy path across all routes)", async () => {
    const child = await consentedChild();
    const overview = await api("/api/portal/children", { token: child.parentToken });
    assert.equal(overview.status, 200);
    for (const route of ["analytics/quadrant", "analytics/weekly", "settings"]) {
      const res = await api(`/api/portal/children/${child.studentId}/${route}`, { token: child.parentToken });
      assert.equal(res.status, 200, route);
    }
  });
});

// --- AC2: ownership ------------------------------------------------------------

describe("portal ownership: parent_children scoping (AC2)", () => {
  test("another parent's child id returns the SAME uniform 404 as an unknown id", async () => {
    const owner = await consentedChild();
    const stranger = await consentedChild();
    const strangerHit = await api(`/api/portal/children/${owner.studentId}/analytics/quadrant`, {
      token: stranger.parentToken
    });
    const unknownHit = await api("/api/portal/children/stu-does-not-exist/analytics/quadrant", {
      token: stranger.parentToken
    });
    assert.equal(strangerHit.status, 404);
    assert.equal(unknownHit.status, 404);
    // Anti-enumeration: identical problem shape (the RFC instance field
    // names the caller's own path by design, so compare the rest).
    const { instance: _s, requestId: _rs, ...strangerBody } = strangerHit.json;
    const { instance: _u, requestId: _ru, ...unknownBody } = unknownHit.json;
    assert.deepEqual(strangerBody, unknownBody);
    // Same for settings read/write and weekly.
    for (const [method, route] of [
      ["GET", "analytics/weekly"],
      ["GET", "settings"],
      ["PUT", "settings"]
    ]) {
      const res = await api(`/api/portal/children/${owner.studentId}/${route}`, {
        method,
        token: stranger.parentToken,
        body: method === "PUT" ? { restrictedSubjects: [], remindersEnabled: false } : undefined
      });
      assert.equal(res.status, 404, `${method} ${route}`);
    }
  });

  test("overview lists ONLY the caller's claimed children", async () => {
    const a = await consentedChild("OnlyMineA");
    const b = await consentedChild("OnlyMineB");
    const res = await api("/api/portal/children", { token: a.parentToken });
    assert.equal(res.status, 200);
    const ids = res.json.children.map((c) => c.studentId);
    assert.ok(ids.includes(a.studentId));
    assert.ok(!ids.includes(b.studentId));
    const card = res.json.children.find((c) => c.studentId === a.studentId);
    assert.equal(card.nickname, "OnlyMineA");
    assert.equal(card.currentGrade, "kindergarten");
    assert.ok(typeof card.streakDays === "number");
    assert.ok(typeof card.unitsMastered === "number");
    assert.ok(typeof card.silverKeys === "number");
    assert.ok(typeof card.goldKeys === "number");
  });
});

// --- AC4/AC5: aggregation ------------------------------------------------------

describe("portal analytics: quadrant + weekly (AC4/AC5)", () => {
  test("quadrant: per-topic accuracy % and exact median cognitive speed vs hand-computed values", async () => {
    const child = await consentedChild();
    // K-M1 topic A: 4 correct of 5 (80%), cognitive times 2,2,2,2,2 -> median 2 (fast, <= 4.5)
    // K-M1 topic B: 1 correct of 4 (25%), cognitive times 30,30,30,30 -> median 30 (slow, > 4.5)
    const s1 = `q-fast-${child.studentId}`;
    const s2 = `q-slow-${child.studentId}`;
    const attempts = [
      wire(1, { unitId: "K-M1", topicCode: "A", isCorrect: true, rawSec: 2 }, s1),
      wire(2, { unitId: "K-M1", topicCode: "A", isCorrect: true, rawSec: 2 }, s1),
      wire(3, { unitId: "K-M1", topicCode: "A", isCorrect: true, rawSec: 2 }, s1),
      wire(4, { unitId: "K-M1", topicCode: "A", isCorrect: true, rawSec: 2 }, s1),
      wire(5, { unitId: "K-M1", topicCode: "A", isCorrect: false, rawSec: 2 }, s1),
      wire(6, { unitId: "K-M1", topicCode: "B", isCorrect: true, rawSec: 30 }, s2),
      wire(7, { unitId: "K-M1", topicCode: "B", isCorrect: false, rawSec: 30 }, s2),
      wire(8, { unitId: "K-M1", topicCode: "B", isCorrect: false, rawSec: 30 }, s2),
      wire(9, { unitId: "K-M1", topicCode: "B", isCorrect: false, rawSec: 30 }, s2)
    ];
    const up = await syncUpload(child, attempts);
    assert.equal(up.status, 200, JSON.stringify(up.json));

    const res = await api(`/api/portal/children/${child.studentId}/analytics/quadrant`, { token: child.parentToken });
    assert.equal(res.status, 200);
    const byTopic = new Map(res.json.topics.map((t) => [t.topicId, t]));
    const a = byTopic.get("K-M1-A");
    const b = byTopic.get("K-M1-B");
    assert.ok(a && b, "both topics present");
    assert.equal(a.attempts, 5);
    assert.equal(a.correct, 4);
    assert.equal(a.accuracyPct, 80);
    // cognitive_time_sec is a Postgres real (float32): tolerance-compare.
    assert.ok(Math.abs(a.medianSpeedSec - engineCognitive(2)) < 1e-3);
    assert.equal(a.subject, "math");
    // Exactly 80% = accurate (the platform pass line is inclusive); the
    // ~2s median vs the 4.5s target = fast -> top-right fluent.
    assert.equal(a.quadrant, "fluent");
    assert.equal(b.accuracyPct, 25);
    assert.ok(Math.abs(b.medianSpeedSec - engineCognitive(30)) < 1e-3);
    assert.equal(b.quadrant, "needs-review"); // slow AND inaccurate
  });

  test("quadrant: a child with no attempts returns an empty topics array", async () => {
    const child = await consentedChild();
    const res = await api(`/api/portal/children/${child.studentId}/analytics/quadrant`, { token: child.parentToken });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.topics, []);
  });

  test("quadrant: even-count median is the average of the middle pair", async () => {
    const child = await consentedChild();
    const s = `q-even-${child.studentId}`;
    const attempts = [
      wire(1, { unitId: "K-M1", topicCode: "C", isCorrect: true, rawSec: 2 }, s),
      wire(2, { unitId: "K-M1", topicCode: "C", isCorrect: true, rawSec: 4 }, s),
      wire(3, { unitId: "K-M1", topicCode: "C", isCorrect: true, rawSec: 8 }, s),
      wire(4, { unitId: "K-M1", topicCode: "C", isCorrect: true, rawSec: 16 }, s)
    ];
    const up = await syncUpload(child, attempts);
    assert.equal(up.status, 200, JSON.stringify(up.json));
    const res = await api(`/api/portal/children/${child.studentId}/analytics/quadrant`, { token: child.parentToken });
    const t = res.json.topics.find((x) => x.topicId === "K-M1-C");
    // PERCENTILE_CONT(0.5) interpolates the middle pair of the four
    // stored cognitive values.
    const cogs = [engineCognitive(2), engineCognitive(4), engineCognitive(8), engineCognitive(16)];
    assert.ok(Math.abs(t.medianSpeedSec - (cogs[1] + cogs[2]) / 2) < 1e-3);
  });

  test("weekly: ISO-week buckets with zeroed empty weeks (accuracy null, not errors)", async () => {
    const child = await consentedChild();
    const now = Date.now();
    const thisMonday = mondayOf(now);
    const twoMondaysAgo = thisMonday - 2 * 604800000;
    // 90s cognitive this week (3 x 30s), 60s two weeks ago; middle week empty.
    const sNow = `w-now-${child.studentId}`;
    const sOld = `w-old-${child.studentId}`;
    const attempts = [
      wire(1, { unitId: "K-E1", topicCode: "A", isCorrect: true, rawSec: 30, atMs: thisMonday + 3600000 }, sNow),
      wire(2, { unitId: "K-E1", topicCode: "A", isCorrect: false, rawSec: 30, atMs: thisMonday + 7200000 }, sNow),
      wire(3, { unitId: "K-E1", topicCode: "A", isCorrect: true, rawSec: 30, atMs: thisMonday + 10800000 }, sNow),
      wire(4, { unitId: "K-E1", topicCode: "B", isCorrect: true, rawSec: 60, atMs: twoMondaysAgo + 3600000 }, sOld)
    ];
    const up = await syncUpload(child, attempts);
    assert.equal(up.status, 200, JSON.stringify(up.json));

    const res = await api(`/api/portal/children/${child.studentId}/analytics/weekly?weeks=3`, { token: child.parentToken });
    assert.equal(res.status, 200);
    assert.equal(res.json.series.length, 3);
    const [oldWeek, middleWeek, currentWeek] = res.json.series;
    assert.equal(new Date(oldWeek.weekStartIso).getTime(), twoMondaysAgo);
    assert.equal(oldWeek.attempts, 1);
    assert.equal(oldWeek.activeMinutes, 1); // 60s
    // Zeroed empty week: numbers at zero, accuracy NULL (no fake 0%).
    assert.equal(middleWeek.attempts, 0);
    assert.equal(middleWeek.accuracyPct, null);
    assert.equal(middleWeek.activeMinutes, 0);
    assert.equal(currentWeek.attempts, 3);
    assert.equal(currentWeek.correct, 2);
    assert.equal(currentWeek.accuracyPct, 66.7);
    assert.equal(currentWeek.activeMinutes, 1.5); // 90s
    // Mastery curve: sNow is 2/3 = 66.7% (not passing); sOld is 100% -> 1 cumulative.
    assert.equal(currentWeek.cumulativeTopicsMastered, 1);
  });

  test("weekly: a child with no attempts returns an all-zero series", async () => {
    const child = await consentedChild();
    const res = await api(`/api/portal/children/${child.studentId}/analytics/weekly`, { token: child.parentToken });
    assert.equal(res.status, 200);
    assert.equal(res.json.series.length, 8); // default weeks
    assert.ok(res.json.series.every((w) => w.attempts === 0 && w.accuracyPct === null));
  });
});

// --- AC7: settings --------------------------------------------------------------

describe("portal settings: defaults, persistence, validation (AC7)", () => {
  test("defaults: no limit, nothing restricted, reminders OFF with the 17:00 shape", async () => {
    const child = await consentedChild();
    const res = await api(`/api/portal/children/${child.studentId}/settings`, { token: child.parentToken });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.settings, {
      dailyLimitMinutes: null,
      restrictedSubjects: [],
      gradeCeiling: null,
      remindersEnabled: false,
      reminderHour: 17,
      reminderMinute: 0
    });
    assert.equal(res.json.usage.dailyLimitMinutes, null);
    assert.equal(res.json.usage.exceeded, false);
    assert.ok(typeof res.json.usage.usedMinutesToday === "number");
  });

  test("PUT persists per parent+child and GET reflects the stored row", async () => {
    const child = await consentedChild();
    const put = await api(`/api/portal/children/${child.studentId}/settings`, {
      method: "PUT",
      token: child.parentToken,
      body: {
        dailyLimitMinutes: 30,
        restrictedSubjects: ["math"],
        gradeCeiling: "grade-1",
        remindersEnabled: true,
        reminderHour: 19,
        reminderMinute: 30
      }
    });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    assert.equal(put.json.settings.dailyLimitMinutes, 30);
    const get = await api(`/api/portal/children/${child.studentId}/settings`, { token: child.parentToken });
    assert.deepEqual(get.json.settings.restrictedSubjects, ["math"]);
    assert.equal(get.json.settings.gradeCeiling, "grade-1");
    assert.equal(get.json.settings.remindersEnabled, true);
    assert.equal(get.json.settings.reminderHour, 19);
    assert.equal(get.json.usage.dailyLimitMinutes, 30);
    // A second child of the same parent is unaffected (per-child rows).
    const other = await consentedChild();
    const otherGet = await api(`/api/portal/children/${other.studentId}/settings`, { token: other.parentToken });
    assert.equal(otherGet.json.settings.dailyLimitMinutes, null);
  });

  test("PUT without optional fields resets them to defaults (full-shape semantics)", async () => {
    const child = await consentedChild();
    await api(`/api/portal/children/${child.studentId}/settings`, {
      method: "PUT",
      token: child.parentToken,
      body: { dailyLimitMinutes: 30, restrictedSubjects: ["math"], gradeCeiling: "grade-1", remindersEnabled: false }
    });
    const reset = await api(`/api/portal/children/${child.studentId}/settings`, {
      method: "PUT",
      token: child.parentToken,
      body: { restrictedSubjects: [], remindersEnabled: false }
    });
    assert.equal(reset.status, 200);
    assert.equal(reset.json.settings.dailyLimitMinutes, null);
    assert.equal(reset.json.settings.gradeCeiling, null);
  });

  test("schema bounds: bad subject, 0-minute and 490-minute caps, bad grade are 400", async () => {
    const child = await consentedChild();
    const cases = [
      { dailyLimitMinutes: 0, restrictedSubjects: [], remindersEnabled: false },
      { dailyLimitMinutes: 490, restrictedSubjects: [], remindersEnabled: false },
      { restrictedSubjects: ["art"], remindersEnabled: false },
      { restrictedSubjects: [], remindersEnabled: false, gradeCeiling: "grade-9" },
      { restrictedSubjects: [], remindersEnabled: false, reminderHour: 24 },
      { restrictedSubjects: ["math", "math"], remindersEnabled: false }
    ];
    for (const body of cases) {
      const res = await api(`/api/portal/children/${child.studentId}/settings`, {
        method: "PUT",
        token: child.parentToken,
        body
      });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });
});

// --- AC6: enforcement ------------------------------------------------------------

describe("time limits: server-side refusal on the child-device sync surface (AC6)", () => {
  test("a child over the daily cap is refused new practice; backfill still lands", async () => {
    const child = await consentedChild();
    // Cap 5 minutes; seed 6 minutes of TODAY usage first.
    const put = await api(`/api/portal/children/${child.studentId}/settings`, {
      method: "PUT",
      token: child.parentToken,
      body: { dailyLimitMinutes: 5, restrictedSubjects: [], remindersEnabled: false }
    });
    assert.equal(put.status, 200);
    const now = Date.now();
    const seedSession = `tl-seed-${child.studentId}`;
    // 4 attempts x 90s cognitive = 360s = 6 min >= 5 (crossing session lands in full).
    const seed = [1, 2, 3, 4].map((n) =>
      wire(n, { unitId: "K-M1", topicCode: "A", isCorrect: true, rawSec: 90, atMs: now - 60000 }, seedSession)
    );
    const seedUp = await syncUpload(child, seed);
    assert.equal(seedUp.status, 200, JSON.stringify(seedUp.json));

    // NEW practice today -> refused (429 time-limit-exceeded; the RFC
    // 9457 extension members merge at the TOP level of the problem body).
    const refused = await syncUpload(child, [wire(5, { unitId: "K-M1", topicCode: "B", isCorrect: true, rawSec: 5, atMs: now - 30000 }, `tl-new-${child.studentId}`)]);
    assert.equal(refused.status, 429, JSON.stringify(refused.json));
    assert.ok(refused.json.type.includes("time-limit-exceeded"));
    assert.equal(refused.json.limitMinutes, 5);
    assert.equal(refused.json.usedMinutes, 6);
    assert.ok(refused.json.resetsAtUtc);
    assert.ok(Number(refused.headers.get("retry-after")) > 0);

    // PURE BACKFILL of an earlier UTC day still lands (accounting, not new practice).
    const yesterday = now - 86400000;
    const backfill = await syncUpload(child, [wire(6, { unitId: "K-M1", topicCode: "C", isCorrect: true, rawSec: 5, atMs: yesterday }, `tl-old-${child.studentId}`)]);
    assert.equal(backfill.status, 200, JSON.stringify(backfill.json));

    // The settings read shows the live exceeded state.
    const settings = await api(`/api/portal/children/${child.studentId}/settings`, { token: child.parentToken });
    assert.equal(settings.json.usage.exceeded, true);
    assert.equal(settings.json.usage.usedMinutesToday, 6);
  });

  test("under the cap, sync proceeds; a child with no cap is never refused", async () => {
    const child = await consentedChild();
    // No cap configured (defaults) -> a large upload succeeds.
    const big = [1, 2, 3, 4, 5, 6].map((n) =>
      wire(n, { unitId: "K-E1", topicCode: "A", isCorrect: true, rawSec: 120, atMs: Date.now() - 60000 }, `tl-nocap-${child.studentId}`)
    );
    const up = await syncUpload(child, big);
    assert.equal(up.status, 200, JSON.stringify(up.json));
  });
});

describe("content controls: gated subjects return no questions (AC6)", () => {
  test("a restricted subject empties the topic + unit routes for the CHILD caller (both token kinds)", async () => {
    const child = await consentedChild();
    await api(`/api/portal/children/${child.studentId}/settings`, {
      method: "PUT",
      token: child.parentToken,
      body: { restrictedSubjects: ["math"], remindersEnabled: false }
    });
    // Child-device caller: math topic route -> NO questions + reason.
    const topicRes = await api("/api/practice/topic/K-M1/A", { token: child.deviceToken });
    assert.equal(topicRes.status, 200);
    assert.deepEqual(topicRes.json.practiceProblems, []);
    assert.equal(topicRes.json.contentRestricted, true);
    assert.equal(topicRes.json.contentRestrictedReason, "subject-restricted");
    // Unit route (gate questions) -> NO questions.
    const unitRes = await api("/api/curriculum/unit/K-M1", { token: child.deviceToken });
    assert.equal(unitRes.status, 200);
    assert.deepEqual(unitRes.json.generatedQuestions, []);
    assert.equal(unitRes.json.contentRestricted, true);
    // An UNRESTRICTED subject still serves questions to the same child.
    const elaRes = await api("/api/practice/topic/K-E1/A", { token: child.deviceToken });
    assert.equal(elaRes.status, 200);
    assert.ok(elaRes.json.practiceProblems.length > 0);
    assert.notEqual(elaRes.json.contentRestricted, true);
    // Anonymous dev-harness callers are unchanged.
    const anon = await api("/api/practice/topic/K-M1/A");
    assert.equal(anon.status, 200);
    assert.ok(anon.json.practiceProblems.length > 0);
  });

  test("grade ceiling: an above-ceiling unit is restricted; at-ceiling is allowed", async () => {
    const child = await consentedChild();
    await api(`/api/portal/children/${child.studentId}/settings`, {
      method: "PUT",
      token: child.parentToken,
      body: { restrictedSubjects: [], gradeCeiling: "pre-k", remindersEnabled: false }
    });
    const above = await api("/api/practice/topic/K-M1/A", { token: child.deviceToken });
    assert.equal(above.json.contentRestricted, true);
    assert.equal(above.json.contentRestrictedReason, "grade-ceiling");
    assert.deepEqual(above.json.practiceProblems, []);
  });

  test("pack index filters to the ceiling for child callers; artifact above ceiling is 403", async () => {
    const child = await consentedChild();
    await api(`/api/portal/children/${child.studentId}/settings`, {
      method: "PUT",
      token: child.parentToken,
      body: { restrictedSubjects: [], gradeCeiling: "kindergarten", remindersEnabled: false }
    });
    const list = await api("/api/content/packs", { token: child.deviceToken });
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.json.packs.map((p) => p.gradeId),
      ["pre-k", "kindergarten"]
    );
    const artifact = await api("/api/content/packs/grade-2", { token: child.deviceToken });
    assert.equal(artifact.status, 403);
    assert.ok(artifact.json.type.includes("content-restricted"));
    // Anonymous listing unchanged.
    const anon = await api("/api/content/packs");
    assert.equal(anon.json.packs.length, 5);
  });
});

describe("sync progress carries the advisory parentSettings block (AC6 seam)", () => {
  test("block reflects the parent's live settings and usage", async () => {
    const child = await consentedChild();
    await api(`/api/portal/children/${child.studentId}/settings`, {
      method: "PUT",
      token: child.parentToken,
      body: { dailyLimitMinutes: 15, restrictedSubjects: ["science"], gradeCeiling: "grade-3", remindersEnabled: true, reminderHour: 18, reminderMinute: 15 }
    });
    const res = await api("/api/sync/progress", { token: child.deviceToken });
    assert.equal(res.status, 200);
    const block = res.json.parentSettings;
    assert.ok(block, "parentSettings present");
    assert.equal(block.timeLimits.dailyLimitMinutes, 15);
    assert.equal(block.timeLimits.exceeded, false);
    assert.deepEqual(block.contentControls.restrictedSubjects, ["science"]);
    assert.equal(block.contentControls.gradeCeiling, "grade-3");
    assert.equal(block.notifications.remindersEnabled, true);
    assert.equal(block.notifications.reminderHour, 18);
  });

  test("default settings render the unlimited/off posture", async () => {
    const child = await consentedChild();
    const res = await api("/api/sync/progress", { token: child.deviceToken });
    assert.equal(res.status, 200);
    assert.equal(res.json.parentSettings.timeLimits.dailyLimitMinutes, null);
    assert.equal(res.json.parentSettings.notifications.remindersEnabled, false);
    assert.deepEqual(res.json.parentSettings.contentControls.restrictedSubjects, []);
  });
});

// --- AC2 seam: archived bindings --------------------------------------------------

describe("portal ownership: archived bindings (AC2 seam)", () => {
  test("an archived child leaves the overview and 404s uniformly on every child route (settings row unreachable)", async () => {
    const child = await consentedChild("ArchivedKid");
    // Persist a settings row FIRST so the archive path is proven to make an
    // EXISTING row unreachable (not merely "no row was ever written").
    const put = await api(`/api/portal/children/${child.studentId}/settings`, {
      method: "PUT",
      token: child.parentToken,
      body: { dailyLimitMinutes: 45, restrictedSubjects: ["ela"], remindersEnabled: false }
    });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    const archive = await api(`/api/parent/children/${child.studentId}/archive`, {
      method: "POST",
      token: child.parentToken
    });
    assert.equal(archive.status, 200, JSON.stringify(archive.json));

    const overview = await api("/api/portal/children", { token: child.parentToken });
    assert.equal(overview.status, 200);
    assert.ok(!overview.json.children.some((c) => c.studentId === child.studentId), "archived child hidden from overview");

    for (const [method, route] of [
      ["GET", "analytics/quadrant"],
      ["GET", "analytics/weekly"],
      ["GET", "settings"],
      ["PUT", "settings"]
    ]) {
      const res = await api(`/api/portal/children/${child.studentId}/${route}`, {
        method,
        token: child.parentToken,
        body: method === "PUT" ? { restrictedSubjects: [], remindersEnabled: false } : undefined
      });
      assert.equal(res.status, 404, `${method} ${route}`);
      assert.ok(res.json.type.includes("child-not-found"), `${method} ${route}: ${res.json.type}`);
    }
  });
});

// --- AC6: time-limit boundary matrix ----------------------------------------------

describe("time limits: boundary matrix (AC6)", () => {
  // rawSec 60.01 with motorBaseline 0.01 -> cognitive 60.00s per attempt, so
  // 5 attempts = exactly 300s = 5.0 recorded minutes (no float noise).
  test("EXACTLY at the cap: new today practice refused; Retry-After and resetsAtUtc match the next UTC midnight", async () => {
    const child = await consentedChild();
    await api(`/api/portal/children/${child.studentId}/settings`, {
      method: "PUT",
      token: child.parentToken,
      body: { dailyLimitMinutes: 5, restrictedSubjects: [], remindersEnabled: false }
    });
    const seed = [1, 2, 3, 4, 5].map((n) =>
      wire(n, { unitId: "K-M1", topicCode: "A", isCorrect: true, rawSec: 60.01, atMs: Date.now() - 60000 }, `tlx-seed-${child.studentId}`)
    );
    // Usage was 0 (< 5) when this batch landed: the CROSSING session is
    // accepted whole (attempts are never split) and leaves usage at exactly 5.0.
    const seedUp = await syncUpload(child, seed);
    assert.equal(seedUp.status, 200, JSON.stringify(seedUp.json));

    const refused = await syncUpload(child, [
      wire(6, { unitId: "K-M1", topicCode: "B", isCorrect: true, rawSec: 5, atMs: Date.now() - 30000 }, `tlx-new-${child.studentId}`)
    ]);
    assert.equal(refused.status, 429, JSON.stringify(refused.json));
    assert.ok(refused.json.type.includes("time-limit-exceeded"));
    assert.equal(refused.json.usedMinutes, 5); // exactly at cap, not over

    // resetsAtUtc = next UTC midnight; Retry-After = seconds until it
    // (client/server clock skew is bounded; allow ±20s).
    const now = Date.now();
    const d = new Date(now);
    const nextMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    assert.ok(Math.abs(new Date(refused.json.resetsAtUtc).getTime() - nextMidnight) < 20000, `resetsAtUtc ${refused.json.resetsAtUtc}`);
    const retryAfter = Number(refused.headers.get("retry-after"));
    const expected = Math.ceil((nextMidnight - now) / 1000);
    assert.ok(retryAfter > 0 && retryAfter <= 86400, `retry-after ${retryAfter} out of range`);
    assert.ok(retryAfter >= expected - 20 && retryAfter <= expected + 20, `retry-after ${retryAfter} vs expected ~${expected}`);
  });

  test("cap-1 usage: an under-cap upload still lands (the boundary is >=)", async () => {
    const child = await consentedChild();
    await api(`/api/portal/children/${child.studentId}/settings`, {
      method: "PUT",
      token: child.parentToken,
      body: { dailyLimitMinutes: 5, restrictedSubjects: [], remindersEnabled: false }
    });
    // 4 x 60.00s = 4.0 minutes recorded today (cap is 5).
    const seed = [1, 2, 3, 4].map((n) =>
      wire(n, { unitId: "K-M1", topicCode: "A", isCorrect: true, rawSec: 60.01, atMs: Date.now() - 60000 }, `tlc-seed-${child.studentId}`)
    );
    assert.equal((await syncUpload(child, seed)).status, 200);
    const more = await syncUpload(child, [
      wire(5, { unitId: "K-M1", topicCode: "B", isCorrect: true, rawSec: 30, atMs: Date.now() - 30000 }, `tlc-more-${child.studentId}`)
    ]);
    assert.equal(more.status, 200, JSON.stringify(more.json));
  });

  test("a future-dated batch (beyond the clock tolerance) is clamped to today and still refused over cap", async () => {
    const child = await consentedChild();
    await api(`/api/portal/children/${child.studentId}/settings`, {
      method: "PUT",
      token: child.parentToken,
      body: { dailyLimitMinutes: 5, restrictedSubjects: [], remindersEnabled: false }
    });
    const seed = [1, 2, 3, 4, 5].map((n) =>
      wire(n, { unitId: "K-M1", topicCode: "A", isCorrect: true, rawSec: 60.01, atMs: Date.now() - 60000 }, `tlf-seed-${child.studentId}`)
    );
    assert.equal((await syncUpload(child, seed)).status, 200);
    // 1 hour in the future: beyond SYNC_FUTURE_CLOCK_TOLERANCE_MS (5 min), so
    // the verdict clamps it to "today" — a fast device clock cannot dodge the
    // cap by dating attempts "tomorrow". (Same near-UTC-midnight caveat as the
    // sibling tests: a batch dated now-60s already assumes today's day key.)
    const refused = await syncUpload(child, [
      wire(6, { unitId: "K-M1", topicCode: "B", isCorrect: true, rawSec: 5, atMs: Date.now() + 3600000 }, `tlf-new-${child.studentId}`)
    ]);
    assert.equal(refused.status, 429, JSON.stringify(refused.json));
    assert.ok(refused.json.type.includes("time-limit-exceeded"));
  });
});

// --- AC6: token-kind + robustness seams on public surfaces -------------------------

describe("content controls: student sessions, at-ceiling, and bearer robustness (AC6)", () => {
  test("a student-session token (web harness) is gated exactly like a child-device token", async () => {
    const parent = await createVerifiedParentWithConsent(API);
    const reg = await api("/api/students", {
      method: "POST",
      token: parent.token,
      body: { nickname: "StuGated", currentGrade: "kindergarten", pin: "4455" }
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.json));
    const studentId = reg.json.student.studentId;
    const put = await api(`/api/portal/children/${studentId}/settings`, {
      method: "PUT",
      token: parent.token,
      body: { restrictedSubjects: ["math"], remindersEnabled: false }
    });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    const res = await api("/api/practice/topic/K-M1/A", { token: reg.json.token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.practiceProblems, []);
    assert.equal(res.json.contentRestricted, true);
    assert.equal(res.json.contentRestrictedReason, "subject-restricted");
  });

  test("a unit AT the ceiling is allowed (inclusive boundary) and still serves questions", async () => {
    const child = await consentedChild();
    await api(`/api/portal/children/${child.studentId}/settings`, {
      method: "PUT",
      token: child.parentToken,
      body: { restrictedSubjects: [], gradeCeiling: "kindergarten", remindersEnabled: false }
    });
    // K-M1 is a kindergarten unit: AT the ceiling -> served.
    const res = await api("/api/practice/topic/K-M1/A", { token: child.deviceToken });
    assert.equal(res.status, 200);
    assert.ok(res.json.practiceProblems.length > 0);
    assert.notEqual(res.json.contentRestricted, true);
  });

  test("an unresolvable bearer on public routes is NOT a new failure mode (anonymous parity)", async () => {
    const child = await consentedChild();
    // Garbage bearer on the pack index: full unfiltered index, no 401/403.
    const garbage = await api("/api/content/packs", { token: "not-a-real-token" });
    assert.equal(garbage.status, 200, JSON.stringify(garbage.json));
    assert.equal(garbage.json.packs.length, 5);
    // Garbage bearer on the practice route: questions still served.
    const practice = await api("/api/practice/topic/K-M1/A", { token: "not-a-real-token" });
    assert.equal(practice.status, 200);
    assert.ok(practice.json.practiceProblems.length > 0);
    // And the anonymous body is byte-identical regardless of any child's
    // settings: snapshot before + after a ceiling exists on some child.
    const before = await api("/api/content/packs");
    await api(`/api/portal/children/${child.studentId}/settings`, {
      method: "PUT",
      token: child.parentToken,
      body: { restrictedSubjects: ["math"], gradeCeiling: "pre-k", remindersEnabled: false }
    });
    const after = await api("/api/content/packs");
    assert.deepEqual(after.json, before.json);
  });

  test("a below-ceiling pack artifact downloads fine for the child caller (200)", async () => {
    const child = await consentedChild();
    await api(`/api/portal/children/${child.studentId}/settings`, {
      method: "PUT",
      token: child.parentToken,
      body: { restrictedSubjects: [], gradeCeiling: "kindergarten", remindersEnabled: false }
    });
    // Materialize the real artifact the index references (10 bytes = sizeBytes).
    fs.writeFileSync(path.join(packsDir, "pack-kindergarten-v1.0.0.sqlite"), "0123456789");
    const res = await api("/api/content/packs/kindergarten", { token: child.deviceToken });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-length"), "10");
    assert.ok(res.headers.get("etag"));
  });
});

// --- CORS: the portal origin is a first-class dev default ---------------------------

describe("CORS: portal origins allowed, others blocked (AC3 seam)", () => {
  test("preflight from the portal dev origin is allowed; an unknown origin is refused", async () => {
    const allowed = await fetch(`${API}/api/portal/children`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:4300", "Access-Control-Request-Method": "GET" }
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:4300");

    const denied = await fetch(`${API}/api/portal/children`, {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:9999", "Access-Control-Request-Method": "GET" }
    });
    assert.equal(denied.status, 403);
    assert.ok((await denied.json()).type.includes("origin-not-allowed"));
  });

  test("an actual request from the portal origin carries ACAO; a foreign origin gets none", async () => {
    const child = await consentedChild();
    const allowed = await fetch(`${API}/api/portal/children`, {
      headers: { Origin: "http://localhost:4300", Authorization: `Bearer ${child.parentToken}` }
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:4300");

    // Non-preflight requests from disallowed origins are not rejected at the
    // server (the browser blocks on the MISSING allow-origin header).
    const foreign = await fetch(`${API}/api/portal/children`, {
      headers: { Origin: "http://evil.example", Authorization: `Bearer ${child.parentToken}` }
    });
    assert.equal(foreign.status, 200);
    assert.equal(foreign.headers.get("access-control-allow-origin"), null);
  });
});

// --- AC7: settings validation hardening ---------------------------------------------

describe("portal settings: validation hardening (AC7)", () => {
  test("unknown fields, missing required fields, negative/fractional/non-numeric caps are 400", async () => {
    const child = await consentedChild();
    const cases = [
      { restrictedSubjects: [], remindersEnabled: false, unexpectedField: 1 },
      { restrictedSubjects: [] }, // remindersEnabled missing
      { dailyLimitMinutes: -5, restrictedSubjects: [], remindersEnabled: false },
      { dailyLimitMinutes: 30.5, restrictedSubjects: [], remindersEnabled: false },
      { dailyLimitMinutes: "abc", restrictedSubjects: [], remindersEnabled: false },
      { restrictedSubjects: [], remindersEnabled: false, reminderMinute: -1 }
    ];
    for (const body of cases) {
      const res = await api(`/api/portal/children/${child.studentId}/settings`, {
        method: "PUT",
        token: child.parentToken,
        body
      });
      assert.equal(res.status, 400, JSON.stringify(body));
    }
  });

  test("reminders on without an explicit time persist the 17:00 default shape", async () => {
    const child = await consentedChild();
    const put = await api(`/api/portal/children/${child.studentId}/settings`, {
      method: "PUT",
      token: child.parentToken,
      body: { restrictedSubjects: [], remindersEnabled: true }
    });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    assert.equal(put.json.settings.reminderHour, 17);
    assert.equal(put.json.settings.reminderMinute, 0);
  });
});
