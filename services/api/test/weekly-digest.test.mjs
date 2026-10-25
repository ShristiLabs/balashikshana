// Weekly digest INTEGRATION tests (issue #63) — real Postgres, real
// server process, injected clock + capture transport (ZERO network):
//
// - Content parity: the digest's per-child numbers come from the SAME
//   shared helpers the portal weekly route serves — asserted by
//   re-deriving the expected email through weeklySeriesForChild + the
//   keys query and deep-equaling the captured send (parity by
//   construction; the HTTP route itself uses Date.now() so a past week
//   cannot be fetched over HTTP — the helper IS the route's code).
// - Idempotency (AC6): sequential re-runs at the same clock, later in
//   the same ISO week, and across a fresh invocation ("restart") send
//   nothing; the next ISO week sends again.
// - Gating (AC3/AC4 + zero-children): unverified, opted-out, and
//   zero-children parents are each skipped and counted.
// - Failure isolation (AC7): a failing parent never aborts the batch;
//   the failure is NOT retried mid-run and IS retried on the next run;
//   the successful parent is never re-sent.
// - Overlap safety: a held advisory lock skips the run entirely.
// - The notification-preferences HTTP surface: auth matrix + shape.

import { test, describe, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { Client } from "pg";
import { createTestDatabase, dropTestDatabase, startTestServer, waitForHealth, createVerifiedParentWithConsent } from "./helpers.mjs";
import { runWeeklyDigest, startWeeklyDigestScheduler, renderWeeklyDigest, DIGEST_ADVISORY_LOCK_KEY } from "../weekly-digest.mjs";
import { weeklySeriesForChild } from "../portal.mjs";
import { createCaptureTransport } from "../mailer.mjs";

const API = "http://127.0.0.1:4823";
let serverProcess;
let testDatabase;
let pg;
let seq = 0;

// The fixed digest clock: Monday 2026-10-26 12:00 UTC. The digest week
// is the completed week Oct 19-25 (2026-W43); attempts land on Wed Oct 21.
const NOW = new Date("2026-10-26T12:00:00.000Z");
const WEEK_START_MS = new Date("2026-10-19T00:00:00.000Z").getTime();
const WEEK_END_MS = new Date("2026-10-26T00:00:00.000Z").getTime();
const ATTEMPT_AT_MS = new Date("2026-10-21T10:00:00.000Z").getTime();

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

/** db facade over the shared test client (+ optional fake pool for the lock path). */
function facade(pool) {
  return {
    pool,
    async get(sql, params = []) {
      return (await pg.query(sql, params)).rows[0];
    },
    async all(sql, params = []) {
      return (await pg.query(sql, params)).rows;
    },
    async run(sql, params = []) {
      return pg.query(sql, params);
    }
  };
}

/** A fully eligible parent (verified, consented, opted-in) with one
 *  child carrying deterministic attempts inside the digest week:
 *  topic A session 4/4 correct (=> first mastery THIS week), topic B
 *  session 2/4 (practiced, not mastered). */
async function parentWithActiveChild(nickname) {
  const parent = await createVerifiedParentWithConsent(API);
  const mySeq = ++seq;
  const create = await api("/api/parent/children", {
    method: "POST",
    token: parent.token,
    body: { nickname, pin: "5150", currentGrade: "kindergarten", clientDeviceId: `digest-dev-${mySeq}-a`, platform: "ios" }
  });
  assert.equal(create.status, 201, JSON.stringify(create.json));
  const studentId = create.json.studentId;
  const mint = await api(`/api/parent/children/${studentId}/device-sessions`, {
    method: "POST",
    token: parent.token,
    body: { clientDeviceId: `digest-dev-${mySeq}-b`, platform: "ios" }
  });
  assert.equal(mint.status, 201, JSON.stringify(mint.json));

  const spec = [
    // Topic A, session s1: 4/4 correct -> >= 80% -> first mastered this week.
    ...[1, 2, 3, 4].map((n) => ({ topic: "K-M1-A", q: n, session: `dig-s1-${mySeq}`, correct: true })),
    // Topic B, session s2: 2/4 -> below the line, practiced only.
    { topic: "K-M1-B", q: 1, session: `dig-s2-${mySeq}`, correct: true },
    { topic: "K-M1-B", q: 2, session: `dig-s2-${mySeq}`, correct: true },
    { topic: "K-M1-B", q: 3, session: `dig-s2-${mySeq}`, correct: false },
    { topic: "K-M1-B", q: 4, session: `dig-s2-${mySeq}`, correct: false }
  ];
  const attempts = spec.map((a, i) => ({
    seq: i + 1,
    unitId: "K-M1",
    topicId: a.topic,
    questionId: `${a.topic}-Q${a.q}`,
    sessionType: "TOPIC_PRACTICE",
    sessionId: a.session,
    chosenAnswer: "1",
    isCorrect: a.correct,
    rawTimeSec: 6,
    audioDurationSec: 0,
    misconceptionTags: [],
    answeredAtMs: ATTEMPT_AT_MS + i * 60_000,
    motorBaselineSec: 0.01
  }));
  const sync = await api("/api/sync/attempts", { method: "POST", token: mint.json.token, body: { attempts } });
  assert.equal(sync.status, 200, JSON.stringify(sync.json));
  return { parentId: parent.parentId, email: parent.email, token: parent.token, studentId };
}

/** Add a SECOND (or later) child with the same deterministic attempt
 *  fixture to an EXISTING parent (token) — for multi-child families. */
async function addChildWithAttempts(parentToken, nickname) {
  const mySeq = ++seq;
  const create = await api("/api/parent/children", {
    method: "POST",
    token: parentToken,
    body: { nickname, pin: "5150", currentGrade: "kindergarten", clientDeviceId: `digest-dev-${mySeq}-a`, platform: "ios" }
  });
  assert.equal(create.status, 201, JSON.stringify(create.json));
  const studentId = create.json.studentId;
  const mint = await api(`/api/parent/children/${studentId}/device-sessions`, {
    method: "POST",
    token: parentToken,
    body: { clientDeviceId: `digest-dev-${mySeq}-b`, platform: "ios" }
  });
  assert.equal(mint.status, 201, JSON.stringify(mint.json));
  const attempts = [1, 2, 3, 4].map((n, i) => ({
    seq: i + 1,
    unitId: "K-M1",
    topicId: "K-M1-A",
    questionId: `K-M1-A-Q${n}`,
    sessionType: "TOPIC_PRACTICE",
    sessionId: `dig-mc-${mySeq}`,
    chosenAnswer: "1",
    isCorrect: true,
    rawTimeSec: 5,
    audioDurationSec: 0,
    misconceptionTags: [],
    answeredAtMs: ATTEMPT_AT_MS + i * 60_000,
    motorBaselineSec: 0.01
  }));
  const sync = await api("/api/sync/attempts", { method: "POST", token: mint.json.token, body: { attempts } });
  assert.equal(sync.status, 200, JSON.stringify(sync.json));
  return studentId;
}

/** The expected digest for one child, derived through the SAME shared
 *  helpers the job uses (weeklySeriesForChild + the keys query). */
async function expectedEmailFor(children) {
  const childBlocks = [];
  for (const c of children) {
    const series = await weeklySeriesForChild(facade(), c.studentId, 1, WEEK_END_MS - 1);
    const week = series[0];
    const keys = (
      await pg.query(
        `SELECT
           COUNT(*) FILTER (WHERE silver_awarded_at >= $2 AND silver_awarded_at < $3)::int AS mastered_this_week,
           COUNT(*) FILTER (WHERE silver_awarded_at IS NOT NULL)::int AS silver_keys,
           COUNT(*) FILTER (WHERE gold_verified_at IS NOT NULL)::int AS gold_keys
         FROM student_unit_progress WHERE student_id = $1`,
        [c.studentId, new Date(WEEK_START_MS).toISOString(), new Date(WEEK_END_MS).toISOString()]
      )
    ).rows[0];
    const stu = (await pg.query("SELECT nickname, streak_days FROM students WHERE student_id = $1", [c.studentId])).rows[0];
    childBlocks.push({
      nickname: stu.nickname,
      attempts: week.attempts,
      activeMinutes: week.activeMinutes,
      topicsFirstMastered: week.topicsFirstMastered,
      cumulativeTopicsMastered: week.cumulativeTopicsMastered,
      unitsMasteredThisWeek: keys.mastered_this_week,
      silverKeys: keys.silver_keys,
      goldKeys: keys.gold_keys,
      streakDays: Number(stu.streak_days) || 0
    });
  }
  return { children: childBlocks, email: renderWeeklyDigest({ weekStartMs: WEEK_START_MS, children: childBlocks }) };
}

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  serverProcess = await startTestServer({
    port: 4823,
    databaseUrl: testDatabase.url,
    env: {
      SEED_DEMO_STUDENTS: "0",
      RATE_LIMIT_PER_IP_MIN: "100000",
      RATE_LIMIT_PER_TOKEN_MIN: "100000",
      RATE_LIMIT_SYNC_PER_TOKEN_MIN: "100000",
      RATE_LIMIT_PARENT_SIGNUP_PER_IP_MIN: "100000",
      RATE_LIMIT_PARENT_LOGIN_PER_IP_MIN: "100000",
      RATE_LIMIT_PARENT_TOKEN_PER_IP_MIN: "100000"
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

describe("runWeeklyDigest", () => {
  test("sends exactly one email per eligible parent; content is parity-identical to the shared weekly aggregation; recipients are verified parent addresses only", async () => {
    const fam = await parentWithActiveChild("DigestKid");

    const transport = createCaptureTransport();
    const summary = await runWeeklyDigest(facade(), { now: NOW, transport, logger: undefined, sendDelayMs: 0 });

    assert.equal(summary.isoWeek, "2026-W43");
    assert.equal(summary.sent, 1);
    assert.equal(summary.failed, 0);
    assert.equal(transport.sends.length, 1, "exactly one send");
    const send = transport.sends[0];
    assert.equal(send.to, fam.email, "recipient is the parent's verified email");
    assert.ok(!("cc" in send) && !("bcc" in send), "no cc/bcc in the envelope");
    assert.match(send.subject, /Balashikshana weekly summary - week of Oct 19, 2026/);
    assert.match(send.text, /DigestKid/);

    // PARITY: re-derive through the shared helpers; byte-identical email.
    const expected = await expectedEmailFor([{ studentId: fam.studentId }]);
    assert.equal(expected.children[0].attempts, 8, "fixture sanity: all 8 attempts landed in the digest week");
    assert.equal(expected.children[0].topicsFirstMastered, 1, "fixture sanity: topic A first-mastered this week");
    assert.deepEqual(
      { subject: send.subject, text: send.text, html: send.html },
      expected.email,
      "digest email must equal renderer(shared weekly aggregation)"
    );

    // The ledger row (the idempotency claim).
    const ledger = await pg.query("SELECT * FROM weekly_digest_sent WHERE parent_id = $1 AND iso_week = '2026-W43'", [fam.parentId]);
    assert.equal(ledger.rows.length, 1);
    assert.equal(ledger.rows[0].children_count, 1);
  });

  test("idempotent: same-clock re-run, later-same-week re-run, and a fresh invocation (restart) all send nothing; the next ISO week sends again", async () => {
    const fam = await parentWithActiveChild("IdemKid");
    // Earlier tests leave other eligible parents in the DB: scope every
    // assertion to THIS parent's address (the ledger is per-parent).
    const toFam = (t) => t.sends.filter((s) => s.to === fam.email);

    const t1 = createCaptureTransport();
    await runWeeklyDigest(facade(), { now: NOW, transport: t1, sendDelayMs: 0 });
    assert.equal(toFam(t1).length, 1, "first run sends");

    // Same clock, sequential re-run.
    const t2 = createCaptureTransport();
    const s2 = await runWeeklyDigest(facade(), { now: NOW, transport: t2, sendDelayMs: 0 });
    assert.equal(toFam(t2).length, 0, "same-clock re-run sends nothing");
    assert.equal(s2.skippedAlreadySent >= 1, true);

    // Later in the same ISO week (Friday).
    const t3 = createCaptureTransport();
    await runWeeklyDigest(facade(), { now: new Date("2026-10-30T09:00:00.000Z"), transport: t3, sendDelayMs: 0 });
    assert.equal(toFam(t3).length, 0, "later-same-week run sends nothing");

    // "Restart": fresh transport + fresh facade objects (a new process
    // would rebuild both; only the DB ledger persists).
    const t4 = createCaptureTransport();
    await runWeeklyDigest(facade(), { now: NOW, transport: t4, sendDelayMs: 0 });
    assert.equal(toFam(t4).length, 0, "restart re-run sends nothing (ledger persists)");

    // Next ISO week: the new week (Oct 26 - Nov 1) has no attempts -> a
    // quiet-week email is still sent exactly once for 2026-W44.
    const t5 = createCaptureTransport();
    const s5 = await runWeeklyDigest(facade(), { now: new Date("2026-11-02T12:00:00.000Z"), transport: t5, sendDelayMs: 0 });
    assert.equal(s5.isoWeek, "2026-W44");
    assert.equal(toFam(t5).length, 1, "the new week sends");
    assert.match(toFam(t5)[0].text, /No practice recorded this week\./);
    const rows = await pg.query("SELECT iso_week FROM weekly_digest_sent WHERE parent_id = $1 ORDER BY iso_week", [fam.parentId]);
    assert.deepEqual(rows.rows.map((r) => r.iso_week), ["2026-W43", "2026-W44"]);
  });

  test("gating: unverified, opted-out, and zero-children parents are skipped, each counted; opt-out takes effect on the next run", async () => {
    // Opted-out: eligible parent flips the toggle off through the REAL route.
    const optedOut = await parentWithActiveChild("OptedKid");
    const put = await api("/api/portal/notification-preferences", {
      method: "PUT",
      token: optedOut.token,
      body: { weeklyEmailEnabled: false }
    });
    assert.equal(put.status, 200);
    assert.equal(put.json.weeklyEmailEnabled, false);

    // Unverified: verified parent loses the flag directly (no API seam
    // un-verifies; the storage layer is the honest lever).
    const unverified = await parentWithActiveChild("UnverKid");
    await pg.query("UPDATE parents SET email_verified_at = NULL WHERE parent_id = $1", [unverified.parentId]);

    // Zero children: verified + consented parent, no child ever created.
    const childless = await createVerifiedParentWithConsent(API);

    const transport = createCaptureTransport();
    const summary = await runWeeklyDigest(facade(), { now: NOW, transport, sendDelayMs: 0 });
    const recipients = transport.sends.map((s) => s.to);
    assert.ok(!recipients.includes(optedOut.email), "opted-out parent receives nothing");
    assert.ok(!recipients.includes(unverified.email), "unverified parent receives nothing");
    assert.ok(!recipients.includes(childless.email), "zero-children parent receives nothing");
    assert.equal(summary.skippedOptedOut >= 1, true);
    assert.equal(summary.skippedUnverified >= 1, true);
    assert.equal(summary.skippedZeroChildren >= 1, true);
    for (const p of [optedOut, unverified]) {
      const ledger = await pg.query("SELECT 1 FROM weekly_digest_sent WHERE parent_id = $1", [p.parentId]);
      assert.equal(ledger.rows.length, 0, "skipped parents never claim a week");
    }
  });

  test("failure isolation: one parent's failed send never aborts the batch, is not retried mid-run, and retries on the NEXT run; the successful parent is never re-sent", async () => {
    const failing = await parentWithActiveChild("FailKid");
    const succeeding = await parentWithActiveChild("OkKid");

    let failFor = failing.email;
    const flaky = {
      sends: [],
      async send(envelope) {
        if (envelope.to === failFor) return { ok: false, messageId: null, error: "SMTP 421 temporarily unavailable" };
        this.sends.push({ ...envelope });
        return { ok: true, messageId: "flaky-1" };
      }
    };
    const s1 = await runWeeklyDigest(facade(), { now: NOW, transport: flaky, sendDelayMs: 0 });
    assert.equal(s1.sent, 1, "the healthy parent still got mail");
    assert.equal(s1.failed, 1, "the failing parent is counted failed");
    assert.equal(flaky.sends.length, 1);
    assert.equal(flaky.sends[0].to, succeeding.email);
    // The failed parent claimed nothing -> next run may retry.
    const failedLedger = await pg.query("SELECT 1 FROM weekly_digest_sent WHERE parent_id = $1 AND iso_week = '2026-W43'", [failing.parentId]);
    assert.equal(failedLedger.rows.length, 0);

    // Next run, transport recovered: only the failed parent is retried;
    // the already-sent parent is not.
    failFor = null;
    const s2 = await runWeeklyDigest(facade(), { now: NOW, transport: flaky, sendDelayMs: 0 });
    assert.equal(s2.sent, 1);
    assert.equal(s2.failed, 0);
    assert.equal(flaky.sends.filter((s) => s.to === failing.email).length, 1, "the failed parent retried exactly once more");
    assert.equal(flaky.sends.filter((s) => s.to === succeeding.email).length, 1, "no duplicate for the already-sent parent");
  });

  test("digest-week boundary: a SUNDAY tick digests the week before last (partial weeks never summarized); the first tick at/after Monday 00:00 UTC digests the just-closed week", async () => {
    // Fixture attempts live Wed Oct 21 (2026-W43). A tick on Sunday Oct 25
    // is still INSIDE W43: the most recently COMPLETE week is W42 (Oct
    // 12-18, zero attempts) — the run must summarize W42 and never leak
    // the partial W43 numbers. The tick one millisecond into Monday Oct
    // 26 digests W43 with the real numbers.
    const fam = await parentWithActiveChild("BoundaryKid");
    const toFam = (t) => t.sends.filter((s) => s.to === fam.email);

    const sunday = createCaptureTransport();
    const s1 = await runWeeklyDigest(facade(), { now: new Date("2026-10-25T23:00:00.000Z"), transport: sunday, sendDelayMs: 0 });
    assert.equal(s1.isoWeek, "2026-W42", "Sunday still inside W43 -> digests the last COMPLETE week (W42)");
    assert.equal(toFam(sunday).length, 1);
    assert.match(toFam(sunday)[0].subject, /week of Oct 12, 2026/);
    assert.match(toFam(sunday)[0].text, /No practice recorded this week\./, "no W43 activity leaks into the W42 digest");
    assert.ok(!toFam(sunday)[0].text.includes("Topics completed: 1"), "partial-week numbers must not appear");

    const monday = createCaptureTransport();
    const s2 = await runWeeklyDigest(facade(), { now: new Date("2026-10-26T00:00:00.001Z"), transport: monday, sendDelayMs: 0 });
    assert.equal(s2.isoWeek, "2026-W43", "first tick at/after Monday 00:00 UTC digests the week that just closed");
    assert.equal(toFam(monday).length, 1);
    assert.match(toFam(monday)[0].subject, /week of Oct 19, 2026/);
    assert.match(toFam(monday)[0].text, /Topics completed: 1/, "the closed week's numbers arrive on the Monday tick");

    const weeks = await pg.query("SELECT iso_week FROM weekly_digest_sent WHERE parent_id = $1 ORDER BY iso_week", [fam.parentId]);
    assert.deepEqual(weeks.rows.map((r) => r.iso_week), ["2026-W42", "2026-W43"], "both complete weeks claimed, exactly once each");
  });

  test("multi-child family: ONE email per parent carrying EVERY child's section; ledger children_count matches", async () => {
    const fam = await parentWithActiveChild("FirstKid");
    await addChildWithAttempts(fam.token, "SecondKid");

    const transport = createCaptureTransport();
    const summary = await runWeeklyDigest(facade(), { now: NOW, transport, sendDelayMs: 0 });

    const mine = transport.sends.filter((s) => s.to === fam.email);
    assert.equal(mine.length, 1, "exactly one email for the whole family");
    assert.match(mine[0].text, /FirstKid:/);
    assert.match(mine[0].text, /SecondKid:/);
    assert.equal((mine[0].text.match(/Practice streak:/g) || []).length, 2, "one streak line per child");
    const ledger = await pg.query("SELECT children_count FROM weekly_digest_sent WHERE parent_id = $1 AND iso_week = '2026-W43'", [fam.parentId]);
    assert.equal(ledger.rows[0].children_count, 2);
    // The summary counts PARENTS, not children (one email per parent).
    assert.equal(summary.sent >= 1, true);
  });

  test("documented crash window: a send that succeeds while the ledger insert is lost re-sends that parent exactly ONCE on the next run (at-least-once), then never again", async () => {
    const fam = await parentWithActiveChild("CrashKid");
    const toFam = (t) => t.sends.filter((s) => s.to === fam.email);

    // Sabotage ONLY the ledger insert (simulates a crash between the
    // successful send and the claim); every other statement passes.
    const sabotaged = {
      ...facade(),
      async run(sql, params = []) {
        if (sql.includes("INSERT INTO weekly_digest_sent")) throw new Error("simulated crash between send and claim");
        return pg.query(sql, params);
      }
    };
    const t1 = createCaptureTransport();
    const s1 = await runWeeklyDigest(sabotaged, { now: NOW, transport: t1, sendDelayMs: 0 });
    assert.equal(toFam(t1).length, 1, "the mail WENT OUT");
    assert.equal(s1.failed >= 1, true, "the run reports the lost claim as a failure");
    const noClaim = await pg.query("SELECT 1 FROM weekly_digest_sent WHERE parent_id = $1 AND iso_week = '2026-W43'", [fam.parentId]);
    assert.equal(noClaim.rows.length, 0, "no ledger row survived");

    // Next (healthy) run: the parent is re-sent ONCE — the documented
    // crash-window behavior — and the claim now lands.
    const t2 = createCaptureTransport();
    await runWeeklyDigest(facade(), { now: NOW, transport: t2, sendDelayMs: 0 });
    assert.equal(toFam(t2).length, 1, "re-sent exactly once after the lost claim");

    const t3 = createCaptureTransport();
    await runWeeklyDigest(facade(), { now: NOW, transport: t3, sendDelayMs: 0 });
    assert.equal(toFam(t3).length, 0, "and never again (claim present)");
  });

  test("ledger table guards: the iso_week shape CHECK rejects junk keys and the PK rejects duplicate (parent, week) rows", async () => {
    await assert.rejects(
      pg.query("INSERT INTO weekly_digest_sent (parent_id, iso_week, children_count) VALUES ($1, $2, 0)", ["guard-parent", "week-43"]),
      /check/i,
      "non-ISO iso_week must violate the shape CHECK"
    );
    await assert.rejects(
      pg.query("INSERT INTO weekly_digest_sent (parent_id, iso_week, children_count) VALUES ($1, $2, 0)", ["guard-parent", "2026-W4X"]),
      /check/i
    );
    const ok = await pg.query("INSERT INTO weekly_digest_sent (parent_id, iso_week, children_count) VALUES ($1, $2, 0)", ["guard-parent", "2026-W43"]);
    assert.equal(ok.rowCount, 1);
    await assert.rejects(
      pg.query("INSERT INTO weekly_digest_sent (parent_id, iso_week, children_count) VALUES ($1, $2, 0)", ["guard-parent", "2026-W43"]),
      /duplicate key/i,
      "the (parent_id, iso_week) PK is the idempotency contract at the storage layer"
    );
  });

  test("overlap safety: a held advisory lock skips the run entirely; releasing it lets the next run proceed", async () => {
    const fam = await parentWithActiveChild("LockKid");

    // A "leased client" wrapper: runWeeklyDigest expects the pooled
    // client shape (query + release). The lock holder and the run MUST
    // be different sessions — advisory locks are reentrant within one.
    const leased = (c) => ({ query: (sql, params) => c.query(sql, params), release: () => {} });

    const holder = new Client({ connectionString: testDatabase.url });
    await holder.connect();
    const runner = new Client({ connectionString: testDatabase.url });
    await runner.connect();
    await holder.query("SELECT pg_advisory_lock($1)", [DIGEST_ADVISORY_LOCK_KEY]);
    try {
      const transport = createCaptureTransport();
      const summary = await runWeeklyDigest(facade({ connect: () => Promise.resolve(leased(runner)) }), {
        now: NOW,
        transport,
        sendDelayMs: 0
      });
      assert.equal(summary.skippedRun, true, "run must skip while the lock is held");
      assert.equal(transport.sends.length, 0);
      assert.equal(summary.sent, 0);
    } finally {
      await holder.query("SELECT pg_advisory_unlock($1)", [DIGEST_ADVISORY_LOCK_KEY]);
      await holder.end();
    }

    // Lock released -> a normal run proceeds (and this parent's week
    // sends now, proving the skip sent nothing earlier).
    const transport2 = createCaptureTransport();
    const summary2 = await runWeeklyDigest(facade({ connect: () => Promise.resolve(leased(runner)) }), { now: NOW, transport: transport2, sendDelayMs: 0 });
    await runner.end();
    assert.equal(summary2.skippedRun, false);
    assert.ok(transport2.sends.some((s) => s.to === fam.email));
  });
});

describe("scheduler", () => {
  test("WEEKLY_DIGEST_ENABLED unset (the default) disables scheduling: no timer, no boot run", async () => {
    const prev = process.env.WEEKLY_DIGEST_ENABLED;
    delete process.env.WEEKLY_DIGEST_ENABLED;
    try {
      const timer = startWeeklyDigestScheduler(facade(), undefined, async () => createCaptureTransport());
      assert.equal(timer, null, "disabled scheduler returns null (no boot pass, no interval)");
    } finally {
      if (prev !== undefined) process.env.WEEKLY_DIGEST_ENABLED = prev;
    }
  });

  test("enabled without SMTP_HOST and without an injected transport refuses to start (misconfiguration guard)", async () => {
    const prevEnabled = process.env.WEEKLY_DIGEST_ENABLED;
    const prevHost = process.env.SMTP_HOST;
    process.env.WEEKLY_DIGEST_ENABLED = "1";
    delete process.env.SMTP_HOST;
    try {
      const timer = startWeeklyDigestScheduler(facade(), undefined, undefined);
      assert.equal(timer, null, "enabled-but-unconfigured scheduler must refuse (null, loud log, no boot run)");
    } finally {
      if (prevEnabled === undefined) delete process.env.WEEKLY_DIGEST_ENABLED;
      else process.env.WEEKLY_DIGEST_ENABLED = prevEnabled;
      if (prevHost === undefined) delete process.env.SMTP_HOST;
      else process.env.SMTP_HOST = prevHost;
    }
  });

  test("enabled with an injected transport schedules (boot pass runs once; timer cleared)", async () => {
    const prevEnabled = process.env.WEEKLY_DIGEST_ENABLED;
    const prevInterval = process.env.WEEKLY_DIGEST_INTERVAL_MS;
    process.env.WEEKLY_DIGEST_ENABLED = "1";
    process.env.WEEKLY_DIGEST_INTERVAL_MS = String(60 * 60 * 1000);
    try {
      let transports = 0;
      const timer = startWeeklyDigestScheduler(facade(), undefined, async () => {
        transports += 1;
        return createCaptureTransport();
      });
      assert.ok(timer, "scheduler started");
      // The boot tick fires on the next macrotask; give it a beat, then
      // clear so the suite never depends on the interval firing.
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(transports >= 1, true, "the boot pass resolved a transport");
      clearInterval(timer);
    } finally {
      if (prevEnabled === undefined) delete process.env.WEEKLY_DIGEST_ENABLED;
      else process.env.WEEKLY_DIGEST_ENABLED = prevEnabled;
      if (prevInterval === undefined) delete process.env.WEEKLY_DIGEST_INTERVAL_MS;
      else process.env.WEEKLY_DIGEST_INTERVAL_MS = prevInterval;
    }
  });
});

describe("notification preferences HTTP surface", () => {
  test("GET defaults to enabled; PUT round-trips off and on (immediate effect for the next run)", async () => {
    const parent = await createVerifiedParentWithConsent(API);
    const get1 = await api("/api/portal/notification-preferences", { token: parent.token });
    assert.equal(get1.status, 200);
    assert.equal(get1.json.weeklyEmailEnabled, true, "default on (migration 012)");

    const putOff = await api("/api/portal/notification-preferences", {
      method: "PUT",
      token: parent.token,
      body: { weeklyEmailEnabled: false }
    });
    assert.equal(putOff.status, 200);
    assert.equal(putOff.json.weeklyEmailEnabled, false);

    const get2 = await api("/api/portal/notification-preferences", { token: parent.token });
    assert.equal(get2.json.weeklyEmailEnabled, false);

    const putOn = await api("/api/portal/notification-preferences", {
      method: "PUT",
      token: parent.token,
      body: { weeklyEmailEnabled: true }
    });
    assert.equal(putOn.json.weeklyEmailEnabled, true);
  });

  test("auth matrix: anonymous 401; child-device and student tokens 403 wrong-token-type; malformed body 400", async () => {
    const fam = await parentWithActiveChild("PrefsKid");

    const anon = await api("/api/portal/notification-preferences");
    assert.equal(anon.status, 401);

    const mint = await api(`/api/parent/children/${fam.studentId}/device-sessions`, {
      method: "POST",
      token: fam.token,
      body: { clientDeviceId: `digest-prefs-${++seq}-dev`, platform: "ios" }
    });
    assert.equal(mint.status, 201);
    const childDevice = await api("/api/portal/notification-preferences", { token: mint.json.token });
    assert.equal(childDevice.status, 403);
    assert.match(childDevice.json.type ?? "", /wrong-token-type/);

    const login = await api("/api/auth/login", { method: "POST", body: { studentId: fam.studentId, pin: "5150" } });
    assert.equal(login.status, 200);
    const student = await api("/api/portal/notification-preferences", { token: login.json.token });
    assert.equal(student.status, 403);

    const badBody = await api("/api/portal/notification-preferences", {
      method: "PUT",
      token: fam.token,
      body: { weeklyEmailEnabled: "yes" }
    });
    assert.equal(badBody.status, 400);
  });
});
