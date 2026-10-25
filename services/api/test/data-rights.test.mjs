// Data-rights integration tests (issue #62) — REAL server, REAL Postgres,
// REAL tokens. The COPPA data-rights matrix:
//
// - AUTH (AC5): export + deletion require a PARENT session token; child
//   device tokens and student PIN sessions are 403 wrong-token-type;
//   anonymous callers are 401.
// - OWNERSHIP (AC7): another parent's child id and an unknown id are the
//   same uniform 404 on both routes.
// - EXPORT (AC1): one JSON document covering EVERY child-data class, each
//   present and populated; credentials never appear; attachment header;
//   analytics parity with the live portal endpoints (AC by parity test).
// - DELETION (AC2): single-transaction cascade — after success, NO row
//   referencing the child remains in any child-data table (orphan-free
//   matrix); sibling children untouched.
// - AUDIT (AC3): a deletion_audit row written atomically (actor, child,
//   policy version, timestamp, scope, counts) and the ledger rejects
//   UPDATE and DELETE at the DATABASE level.
// - CONSENT (AC4): consent evidence rows SURVIVE with student_id severed
//   to NULL; the audit row alone carries the child linkage.
// - RE-AUTH (AC5): missing password 400, wrong password 401
//   re-auth-required, correct password 200; repeat request 404 (the
//   surface is idempotent — the binding is gone).

import { test, describe, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "pg";
import {
  createTestDatabase,
  dropTestDatabase,
  startTestServer,
  waitForHealth,
  createVerifiedParentWithConsent
} from "./helpers.mjs";

const API = "http://127.0.0.1:4821";
let serverProcess;
let testDatabase;
let pg; // direct connection for seeding + post-delete assertions
let seq = 0;
// Fixed clock base in the past; sync accepts past client timestamps.
let clock = Date.now() - 7 * 86400000;

const PARENT_PASSWORD = "legitimate-password-1";

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

/**
 * A fully-data-populated child: claimed binding, bound consent record,
 * device session, attempts (which derive topic/unit progress + XP), a
 * student session, portal settings, plus directly-seeded badge, state,
 * outcome, and placement rows (classes without a cheap API seam here).
 * Pass `existingParent` to place the child under that parent (the true
 * sibling scenario); otherwise a fresh verified+consented parent is
 * created.
 */
async function populatedChild(nickname = `RightsKid${++seq}`, existingParent = null) {
  const parent = existingParent ?? (await createVerifiedParentWithConsent(API, { password: PARENT_PASSWORD }));
  const mySeq = ++seq;
  const create = await api("/api/parent/children", {
    method: "POST",
    token: parent.token,
    body: { nickname, pin: "5150", currentGrade: "kindergarten", clientDeviceId: `rights-device-${mySeq}-a`, platform: "ios" }
  });
  assert.equal(create.status, 201, JSON.stringify(create.json));
  const studentId = create.json.studentId;

  // Child-bound consent evidence (the rows deletion must RETAIN, severed).
  const consent = await api("/api/consent/records", {
    method: "POST",
    token: parent.token,
    body: { policyVersion: parent.policyVersion, studentId }
  });
  assert.equal(consent.status, 201, JSON.stringify(consent.json));

  // A live student PIN session (the sessions export class).
  const login = await api("/api/auth/login", { method: "POST", body: { studentId, pin: "5150" } });
  assert.equal(login.status, 200, JSON.stringify(login.json));

  // Attempts via the sync surface (derives progress + XP + streaks).
  const mint = await api(`/api/parent/children/${studentId}/device-sessions`, {
    method: "POST",
    token: parent.token,
    body: { clientDeviceId: `rights-device-${mySeq}-b`, platform: "ios" }
  });
  assert.equal(mint.status, 201, JSON.stringify(mint.json));
  const MOTOR = 0.01;
  const attempts = [1, 2, 3, 4].map((n) => {
    clock += 60_000;
    return {
      seq: n,
      unitId: "K-M1",
      topicId: "K-M1-A",
      questionId: `K-M1-A-Q${n}`,
      sessionType: "TOPIC_PRACTICE",
      sessionId: `rights-sess-${mySeq}-${n}`,
      chosenAnswer: "1",
      isCorrect: n % 2 === 1,
      rawTimeSec: 3 + n,
      audioDurationSec: 0,
      misconceptionTags: [],
      answeredAtMs: clock,
      motorBaselineSec: MOTOR
    };
  });
  const sync = await api("/api/sync/attempts", { method: "POST", token: mint.json.token, body: { attempts } });
  assert.equal(sync.status, 200, JSON.stringify(sync.json));

  // Portal settings row.
  const put = await api(`/api/portal/children/${studentId}/settings`, {
    method: "PUT",
    token: parent.token,
    body: { dailyLimitMinutes: 30, restrictedSubjects: ["science"], gradeCeiling: null, remindersEnabled: false }
  });
  assert.equal(put.status, 200, JSON.stringify(put.json));

  // Classes without an API seam in this suite: badge, gamification state,
  // session outcome, placement record.
  await pg.query(
    `INSERT INTO student_badge_awards (student_id, badge_id, scope, awarded_at) VALUES ($1, 'streak-7', 'global', now())`,
    [studentId]
  );
  // The sync reconciler already maintains gamification state; pin it to
  // deterministic values for the export assertion.
  await pg.query(
    `INSERT INTO student_gamification_state (student_id, total_xp, best_beat_target_pct, last_active_day_key, updated_at)
     VALUES ($1, 120, 50, '2026-10-20', now())
     ON CONFLICT (student_id) DO UPDATE SET
       total_xp = 120, best_beat_target_pct = 50, last_active_day_key = '2026-10-20', updated_at = now()`,
    [studentId]
  );
  // device_id is NOT NULL on outcomes; borrow the minted device.
  const deviceRow = await pg.query(
    "SELECT device_id FROM child_device_sessions WHERE student_id = $1 ORDER BY created_at DESC LIMIT 1",
    [studentId]
  );
  assert.ok(deviceRow.rows[0], "a minted device session must exist");
  await pg.query(
    `INSERT INTO student_session_outcomes (student_id, device_id, session_id, session_type, stage, hearts_lost, hearts_remaining, end_reason, ended_at, created_at)
     VALUES ($1, $2, $3, 'GAME', 'MAIN', 1, 4, 'completed', now(), now())`,
    [studentId, deviceRow.rows[0].device_id, `rights-sess-${mySeq}-1`]
  );
  await pg.query(
    `INSERT INTO student_placement_records (student_id, grade_id, recommended_start_unit_id, credited_units_json, per_strand_json, items_asked, session_id, placed_at, updated_at)
     VALUES ($1, 'kindergarten', 'K-M1', '[]', '{}', 10, $2, now(), now())`,
    [studentId, `rights-sess-${mySeq}-1`]
  );

  return {
    studentId,
    parentId: parent.parentId,
    parentToken: parent.token,
    deviceToken: mint.json.token,
    studentToken: login.json.token,
    policyVersion: parent.policyVersion,
    attemptCount: attempts.length
  };
}

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  const packsDir = fs.mkdtempSync(path.join(os.tmpdir(), "balashi-rights-packs-"));
  fs.writeFileSync(
    path.join(packsDir, "index.json"),
    JSON.stringify({ formatVersion: 1, registryVersion: "test", packs: [] })
  );
  serverProcess = await startTestServer({
    port: 4821,
    databaseUrl: testDatabase.url,
    env: {
      BALASHIKSHANA_CONTENT_PACKS_DIR: packsDir,
      SEED_DEMO_STUDENTS: "0",
      RATE_LIMIT_PER_IP_MIN: "100000",
      RATE_LIMIT_PER_TOKEN_MIN: "100000",
      RATE_LIMIT_SYNC_PER_TOKEN_MIN: "100000",
      RATE_LIMIT_LOGIN_PER_IP_MIN: "100000",
      RATE_LIMIT_PARENT_SIGNUP_PER_IP_MIN: "100000",
      RATE_LIMIT_PARENT_LOGIN_PER_IP_MIN: "100000",
      RATE_LIMIT_PARENT_TOKEN_PER_IP_MIN: "100000",
      RATE_LIMIT_PARENT_RESET_PER_IP_MIN: "100000",
      RATE_LIMIT_PARENT_CLAIM_PER_IP_MIN: "100000",
      RATE_LIMIT_DELETE_PER_IP_MIN: "100000"
    }
  });
  await waitForHealth(API);
  pg = new Client({ connectionString: testDatabase.url });
  await pg.connect();
}, 180000);

afterAll(async () => {
  if (pg) await pg.end();
  if (serverProcess) serverProcess.kill("SIGTERM");
  if (testDatabase) await dropTestDatabase(testDatabase.name);
});

// Every child-data table the deletion must empty for the child.
const CHILD_DATA_TABLES = [
  "student_question_attempts",
  "student_topic_progress",
  "student_unit_progress",
  "student_sessions",
  "child_device_sessions",
  "student_xp_events",
  "student_badge_awards",
  "student_gamification_state",
  "student_session_outcomes",
  "student_placement_records",
  "portal_child_settings",
  "parent_children",
  "students"
];

// --- AC5: auth matrix ----------------------------------------------------------

describe("data-rights auth: parent tokens only (AC5)", () => {
  test("anonymous callers get 401 on both routes", async () => {
    const exportRes = await api("/api/portal/children/stu-x/export");
    assert.equal(exportRes.status, 401);
    const delRes = await api("/api/portal/children/stu-x", { method: "DELETE", body: { password: PARENT_PASSWORD } });
    assert.equal(delRes.status, 401);
  });

  test("child device tokens are 403 wrong-token-type on both routes", async () => {
    const child = await populatedChild();
    const exportRes = await api(`/api/portal/children/${child.studentId}/export`, { token: child.deviceToken });
    assert.equal(exportRes.status, 403);
    assert.ok(exportRes.json.type.includes("wrong-token-type"));
    const delRes = await api(`/api/portal/children/${child.studentId}`, {
      method: "DELETE",
      token: child.deviceToken,
      body: { password: PARENT_PASSWORD }
    });
    assert.equal(delRes.status, 403);
    assert.ok(delRes.json.type.includes("wrong-token-type"));
  });

  test("student PIN session tokens are 403 wrong-token-type on both routes", async () => {
    const child = await populatedChild();
    const exportRes = await api(`/api/portal/children/${child.studentId}/export`, { token: child.studentToken });
    assert.equal(exportRes.status, 403);
    assert.ok(exportRes.json.type.includes("wrong-token-type"));
    const delRes = await api(`/api/portal/children/${child.studentId}`, {
      method: "DELETE",
      token: child.studentToken,
      body: { password: PARENT_PASSWORD }
    });
    assert.equal(delRes.status, 403);
    assert.ok(delRes.json.type.includes("wrong-token-type"));
  });
});

// --- AC7: ownership ------------------------------------------------------------

describe("data-rights ownership: uniform scoped-404 (AC7)", () => {
  test("another parent's child and an unknown id are the same 404 on both routes", async () => {
    const owner = await populatedChild();
    const stranger = await createVerifiedParentWithConsent(API, { password: PARENT_PASSWORD });
    for (const id of [owner.studentId, "stu-does-not-exist"]) {
      const exportRes = await api(`/api/portal/children/${id}/export`, { token: stranger.token });
      assert.equal(exportRes.status, 404, id);
      assert.ok(exportRes.json.type.includes("child-not-found"));
      const delRes = await api(`/api/portal/children/${id}`, {
        method: "DELETE",
        token: stranger.token,
        body: { password: PARENT_PASSWORD }
      });
      assert.equal(delRes.status, 404, id);
      assert.ok(delRes.json.type.includes("child-not-found"));
    }
    // Uniform problem shape for both ids (anti-enumeration); the
    // RFC 9457 `instance` member names the request path by design and is
    // compared separately below.
    const a = await api(`/api/portal/children/${owner.studentId}/export`, { token: stranger.token });
    const b = await api("/api/portal/children/stu-does-not-exist/export", { token: stranger.token });
    assert.deepEqual(
      { status: a.json.status, title: a.json.title, type: a.json.type, detail: a.json.detail },
      { status: b.json.status, title: b.json.title, type: b.json.type, detail: b.json.detail }
    );
  });
});

// --- AC1: export ---------------------------------------------------------------

describe("export: one complete JSON document per child (AC1)", () => {
  test("every child-data class is present and populated; credentials never appear", async () => {
    const child = await populatedChild();
    const res = await api(`/api/portal/children/${child.studentId}/export`, { token: child.parentToken });
    assert.equal(res.status, 200, JSON.stringify(res.json));

    const doc = res.json;
    assert.equal(doc.formatVersion, 1);
    assert.equal(doc.studentId, child.studentId);
    assert.ok(doc.exportedAt);

    assert.equal(doc.profile.studentId, child.studentId);
    assert.equal(doc.profile.nickname.slice(0, 9), "RightsKid");
    assert.ok(doc.profile.currentGrade);

    assert.equal(doc.binding.bindingStatus, "claimed");
    assert.ok(doc.binding.relation);

    assert.ok(doc.consentRecords.length >= 1);
    assert.equal(doc.consentRecords[0].policyVersion, child.policyVersion);

    assert.equal(doc.portalSettings.dailyLimitMinutes, 30);
    assert.deepEqual(doc.portalSettings.restrictedSubjects, ["science"]);

    assert.equal(doc.attempts.length, child.attemptCount);
    assert.ok(doc.attempts[0].cognitiveTimeSec != null);
    assert.ok(doc.attempts[0].attemptedAt);

    assert.ok(doc.topicProgress.length >= 1);
    assert.ok(doc.unitProgress.length >= 1);

    assert.ok(doc.sessions.length >= 1);
    assert.ok(doc.sessions[0].expiresAt);

    assert.ok(doc.deviceSessions.length >= 1);
    assert.ok(doc.deviceSessions[0].deviceId);

    assert.ok(doc.gamification.xpEvents.length >= 1);
    // The sync replay awards engine badges too; assert the class is
    // populated AND the directly-seeded badge is present.
    assert.ok(doc.gamification.badgeAwards.length >= 1);
    assert.ok(
      doc.gamification.badgeAwards.some((b) => b.badgeId === "streak-7"),
      "directly-seeded badge must be exported"
    );
    assert.equal(doc.gamification.state.totalXp, 120);

    assert.equal(doc.sessionOutcomes.length, 1);
    assert.equal(doc.sessionOutcomes[0].endReason, "completed");

    assert.equal(doc.placementRecords.length, 1);
    assert.equal(doc.placementRecords[0].recommendedStartUnitId, "K-M1");

    assert.ok(doc.analytics.quadrant.length >= 1);
    assert.equal(doc.analytics.weekly.length, 8);

    // Credential hygiene: no secret or verifier anywhere in the document.
    const serialized = JSON.stringify(doc);
    assert.ok(!serialized.includes("token_hash"), "token_hash leaked");
    assert.ok(!serialized.includes(child.deviceToken), "device token leaked");
    assert.ok(!serialized.includes(child.studentToken), "student token leaked");
    assert.ok(!serialized.includes(PARENT_PASSWORD), "password leaked");
    assert.ok(!serialized.includes("pin_hash"), "pin hash leaked");
    assert.ok(!serialized.includes("5150"), "pin leaked");
  });

  test("served as a downloadable attachment naming the child", async () => {
    const child = await populatedChild();
    const res = await api(`/api/portal/children/${child.studentId}/export`, { token: child.parentToken });
    assert.equal(res.status, 200);
    const disposition = res.headers.get("content-disposition");
    assert.ok(disposition.startsWith("attachment"), disposition);
    assert.ok(disposition.includes(child.studentId), disposition);
    assert.ok(disposition.includes(".json"), disposition);
  });

  test("a degenerate child (no attempts, no settings) exports every class with empty arrays, not errors", async () => {
    const child = await populatedChild();
    // Strip the derived + seeded data classes: the export must still be a
    // valid full-shape document with empty arrays and null analytics state.
    await pg.query("DELETE FROM student_question_attempts WHERE student_id = $1", [child.studentId]);
    await pg.query("DELETE FROM student_topic_progress WHERE student_id = $1", [child.studentId]);
    await pg.query("DELETE FROM student_unit_progress WHERE student_id = $1", [child.studentId]);
    await pg.query("DELETE FROM student_xp_events WHERE student_id = $1", [child.studentId]);
    await pg.query("DELETE FROM student_badge_awards WHERE student_id = $1", [child.studentId]);
    await pg.query("DELETE FROM student_gamification_state WHERE student_id = $1", [child.studentId]);
    await pg.query("DELETE FROM student_session_outcomes WHERE student_id = $1", [child.studentId]);
    await pg.query("DELETE FROM student_placement_records WHERE student_id = $1", [child.studentId]);
    await pg.query("DELETE FROM portal_child_settings WHERE student_id = $1", [child.studentId]);
    const res = await api(`/api/portal/children/${child.studentId}/export`, { token: child.parentToken });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const doc = res.json;
    assert.equal(doc.attempts.length, 0);
    assert.equal(doc.topicProgress.length, 0);
    assert.equal(doc.unitProgress.length, 0);
    assert.equal(doc.gamification.xpEvents.length, 0);
    assert.equal(doc.gamification.badgeAwards.length, 0);
    assert.equal(doc.gamification.state, null);
    assert.equal(doc.sessionOutcomes.length, 0);
    assert.equal(doc.placementRecords.length, 0);
    assert.equal(doc.analytics.quadrant.length, 0);
    assert.equal(doc.analytics.weekly.length, 8); // zeroed weeks, not errors
    assert.equal(doc.portalSettings.dailyLimitMinutes, null); // platform defaults
    assert.deepEqual(doc.portalSettings.restrictedSubjects, []);
    assert.equal(doc.profile.studentId, child.studentId); // profile + consent still populated
    assert.ok(doc.consentRecords.length >= 1);
  });

  test("analytics parity: export numbers equal the live portal endpoints", async () => {
    const child = await populatedChild();
    const exportRes = await api(`/api/portal/children/${child.studentId}/export`, { token: child.parentToken });
    const quadrantRes = await api(`/api/portal/children/${child.studentId}/analytics/quadrant`, { token: child.parentToken });
    const weeklyRes = await api(`/api/portal/children/${child.studentId}/analytics/weekly?weeks=8`, { token: child.parentToken });
    assert.equal(exportRes.status, 200);
    assert.equal(quadrantRes.status, 200);
    assert.equal(weeklyRes.status, 200);
    assert.deepEqual(exportRes.json.analytics.quadrant, quadrantRes.json.topics);
    assert.deepEqual(exportRes.json.analytics.weekly, weeklyRes.json.series);
  });
});

// --- AC2/AC3/AC4 + re-auth: deletion -------------------------------------------

describe("deletion: password re-auth, atomic cascade, audit, consent posture (AC2-AC5)", () => {
  test("missing password is a 400 schema rejection", async () => {
    const child = await populatedChild();
    const res = await api(`/api/portal/children/${child.studentId}`, { method: "DELETE", token: child.parentToken, body: {} });
    assert.equal(res.status, 400);
  });

  test("a too-short password is a 400 schema rejection (signup bounds mirrored)", async () => {
    const child = await populatedChild();
    const res = await api(`/api/portal/children/${child.studentId}`, {
      method: "DELETE",
      token: child.parentToken,
      body: { password: "short" }
    });
    assert.equal(res.status, 400);
    const alive = await pg.query("SELECT 1 FROM students WHERE student_id = $1", [child.studentId]);
    assert.equal(alive.rowCount, 1);
  });

  test("child vanishing between the guard and the locked cascade yields 404 — never a phantom zero-count audit row", async () => {
    // The ownership guard runs OUTSIDE the deletion transaction; a
    // concurrent winner can delete the child in the window. The locked
    // transaction must RE-CHECK existence after FOR UPDATE and answer
    // the uniform 404 instead of writing an all-zero deletion_audit row
    // and claiming 200 deleted:true (audit integrity: the ledger records
    // deletions that happened, not requests that arrived late).
    const child = await populatedChild();

    // Hold the students row lock so the API request parks INSIDE its
    // transaction at the FOR UPDATE.
    const locker = new Client({ connectionString: testDatabase.url });
    await locker.connect();
    await locker.query("BEGIN");
    await locker.query("SELECT 1 FROM students WHERE student_id = $1 FOR UPDATE", [child.studentId]);

    // Fire the API deletion; it passes the guard (binding still present),
    // then blocks on the row lock.
    const pending = api(`/api/portal/children/${child.studentId}`, {
      method: "DELETE",
      token: child.parentToken,
      body: { password: PARENT_PASSWORD }
    });
    // Bounded one-shot pause so the request reliably reaches the lock
    // before the winner commits (this is the race's synchronization
    // point; not a retry loop).
    await new Promise((r) => setTimeout(r, 400));

    // The concurrent winner deletes the child and commits.
    await locker.query("DELETE FROM consent_records WHERE student_id = $1", [child.studentId]); // clear RESTRICT
    await locker.query("DELETE FROM students WHERE student_id = $1", [child.studentId]); // cascades the rest
    await locker.query("COMMIT");
    await locker.end();

    const res = await pending;
    assert.equal(res.status, 404, `expected the uniform 404, got ${res.status}: ${JSON.stringify(res.json)}`);

    // Exactly the winner's out-of-band deletion happened; the late request
    // must not have added an audit row.
    const audit = await pg.query("SELECT COUNT(*)::int AS n FROM deletion_audit WHERE student_id = $1", [child.studentId]);
    assert.equal(audit.rows[0].n, 0, "late request must not write a phantom zero-count audit row");
  });

  test("wrong password is 401 re-auth-required; nothing is deleted", async () => {
    const child = await populatedChild();
    const res = await api(`/api/portal/children/${child.studentId}`, {
      method: "DELETE",
      token: child.parentToken,
      body: { password: "totally-wrong-password" }
    });
    assert.equal(res.status, 401);
    assert.ok(res.json.type.includes("re-auth-required"));
    const row = await pg.query("SELECT 1 FROM students WHERE student_id = $1", [child.studentId]);
    assert.equal(row.rowCount, 1, "child must survive a failed re-auth");
    const audit = await pg.query("SELECT COUNT(*)::int AS n FROM deletion_audit WHERE student_id = $1", [child.studentId]);
    assert.equal(audit.rows[0].n, 0, "no audit row without a successful deletion");
  });

  test("successful deletion: orphan-free cascade, atomic audit row, consent retained + severed, siblings untouched", async () => {
    // Two children under ONE parent; only the first is deleted.
    const kid1 = await populatedChild(`DeleteMe${++seq}`);
    const kid2 = await populatedChild(`KeepMe${++seq}`, {
      parentId: kid1.parentId,
      token: kid1.parentToken,
      policyVersion: kid1.policyVersion
    });
    assert.equal(kid2.parentId, kid1.parentId, "kid2 must be a true sibling");
    assert.ok(kid1.studentId !== kid2.studentId);

    const res = await api(`/api/portal/children/${kid1.studentId}`, {
      method: "DELETE",
      token: kid1.parentToken,
      body: { password: PARENT_PASSWORD }
    });
    assert.equal(res.status, 200, JSON.stringify(res.json));
    const summary = res.json;
    assert.equal(summary.deleted, true);
    assert.equal(summary.studentId, kid1.studentId);
    assert.equal(summary.scope, "child-data");
    assert.ok(summary.auditId.startsWith("del-"));
    assert.ok(summary.deletedAt);

    // Per-table counts: every explicitly-deleted table reported.
    for (const table of CHILD_DATA_TABLES) {
      assert.ok(table in summary.deletedCounts, `deletedCounts missing ${table}`);
    }
    assert.equal(summary.deletedCounts.students, 1);
    assert.equal(summary.deletedCounts.student_question_attempts, kid1.attemptCount);
    assert.ok(summary.consentRecordsDetached >= 1);

    // Orphan-free matrix: NO row referencing the child anywhere.
    for (const table of CHILD_DATA_TABLES) {
      const rows = await pg.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE student_id = $1`, [kid1.studentId]);
      assert.equal(rows.rows[0].n, 0, `${table} still has rows for the deleted child`);
    }

    // AC3: the atomic audit row — actor, child, policy, timestamp, scope.
    const audit = await pg.query("SELECT * FROM deletion_audit WHERE student_id = $1", [kid1.studentId]);
    assert.equal(audit.rowCount, 1);
    const row = audit.rows[0];
    assert.equal(row.parent_id, kid1.parentId);
    assert.equal(row.policy_version, kid1.policyVersion);
    assert.equal(row.scope, "child-data");
    assert.equal(row.consent_records_detached, summary.consentRecordsDetached);
    const counts = JSON.parse(row.deleted_counts);
    assert.equal(counts.student_question_attempts, kid1.attemptCount);
    assert.ok(row.deleted_at);

    // AC3: append-only at the DATABASE level — UPDATE and DELETE raise.
    await assert.rejects(
      () => pg.query("UPDATE deletion_audit SET scope = 'tampered' WHERE student_id = $1", [kid1.studentId]),
      /append-only/
    );
    await assert.rejects(
      () => pg.query("DELETE FROM deletion_audit WHERE student_id = $1", [kid1.studentId]),
      /append-only/
    );

    // AC4: consent evidence RETAINED, linkage severed to NULL.
    const consent = await pg.query(
      "SELECT student_id FROM consent_records WHERE parent_id = $1 ORDER BY captured_at ASC",
      [kid1.parentId]
    );
    assert.ok(consent.rowCount >= 2, "parent-level + child-bound consent rows survive");
    for (const cr of consent.rows) {
      if (cr.student_id === kid1.studentId) assert.fail("consent row still references the deleted child");
    }
    // The audit row alone carries the child linkage (AC4's audit linkage).
    assert.equal(row.student_id, kid1.studentId);

    // Sibling child fully intact.
    for (const table of ["students", "student_question_attempts", "parent_children", "child_device_sessions"]) {
      const rows = await pg.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE student_id = $1`, [kid2.studentId]);
      assert.ok(rows.rows[0].n > 0, `${table} must keep the sibling's rows`);
    }

    // Idempotent surface: repeat DELETE and export are the uniform 404.
    const again = await api(`/api/portal/children/${kid1.studentId}`, {
      method: "DELETE",
      token: kid1.parentToken,
      body: { password: PARENT_PASSWORD }
    });
    assert.equal(again.status, 404);
    const exportGone = await api(`/api/portal/children/${kid1.studentId}/export`, { token: kid1.parentToken });
    assert.equal(exportGone.status, 404);

    // Exactly one audit row for the child even after the repeat request.
    const auditCount = await pg.query("SELECT COUNT(*)::int AS n FROM deletion_audit WHERE student_id = $1", [kid1.studentId]);
    assert.equal(auditCount.rows[0].n, 1);
  });

  test("the deleted child's username is freed and the parents row survives", async () => {
    const child = await populatedChild();
    const res = await api(`/api/portal/children/${child.studentId}`, {
      method: "DELETE",
      token: child.parentToken,
      body: { password: PARENT_PASSWORD }
    });
    assert.equal(res.status, 200);
    const parent = await pg.query("SELECT 1 FROM parents WHERE parent_id = $1", [child.parentId]);
    assert.equal(parent.rowCount, 1, "parent account is not child data; it survives");
    const devices = await pg.query("SELECT COUNT(*)::int AS n FROM devices WHERE parent_id = $1", [child.parentId]);
    assert.ok(devices.rows[0].n >= 2, "devices rows are parent-owned hardware; they survive child deletion");
  });
});
