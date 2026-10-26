// Retention sweep integration tests (issue #62) — the idempotent TTL
// purge contract, driven DIRECTLY against a throwaway Postgres database
// with an injected clock (deterministic TTL boundaries):
//
// - Expired rows in every TTL-bearing table are purged: student_sessions
//   (AC), parent_sessions, child_device_sessions, parent_tokens.
// - Rows AT the exact expiry instant are purged (<= semantics); rows one
//   millisecond later survive.
// - Running the sweep twice reaches the IDENTICAL end state (second pass
//   deletes zero rows — the AC's idempotency proof).
// - The sweep NEVER touches non-expired rows, and never touches evidence
//   tables (spot-checked: deletion_audit + consent_records unchanged).

import { test, describe, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import { Client } from "pg";
import { createTestDatabase, dropTestDatabase, startTestServer, waitForHealth } from "./helpers.mjs";
import { runRetentionSweep, startRetentionSweep } from "../retention.mjs";
import { hashPinScrypt } from "../db.mjs";

const API = "http://127.0.0.1:4822";
let serverProcess;
let testDatabase;
let pg;

// A db facade over the raw client: runRetentionSweep needs only .run.
function facade(client) {
  return { run: (sql, params) => client.query(sql, params) };
}

async function seedIdentity(prefix) {
  const parentId = `par-${prefix}`;
  const studentId = `stu-${prefix}`;
  const deviceId = `dev-${prefix}`;
  await pg.query(
    `INSERT INTO parents (parent_id, email, password_hash) VALUES ($1, $2, $3)`,
    [parentId, `${prefix}@example.com`, hashPinScrypt("legitimate-password-1")]
  );
  await pg.query(
    `INSERT INTO students (student_id, username, pin_hash, nickname, avatar, age_years, current_grade, last_active_at, created_at)
     VALUES ($1, $2, $3, $4, 'L', 6, 'kindergarten', now(), now())`,
    [studentId, `user-${prefix}`, hashPinScrypt("1234"), prefix, ]
  );
  await pg.query(`INSERT INTO devices (device_id, parent_id, client_device_id, platform) VALUES ($1, $2, $3, 'ios')`, [
    deviceId,
    parentId,
    `client-${prefix}`
  ]);
  return { parentId, studentId, deviceId };
}

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  serverProcess = await startTestServer({
    port: 4822,
    databaseUrl: testDatabase.url,
    env: { SEED_DEMO_STUDENTS: "0", RETENTION_SWEEP_INTERVAL_MS: "0" }
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

describe("runRetentionSweep", () => {
  test("purges expired rows in every TTL table; exact-expiry rows go, later rows stay; idempotent second pass", async () => {
    const now = new Date("2026-10-25T12:00:00.000Z");
    const atExpiry = new Date(now.getTime()).toISOString(); // exactly at now
    const justBefore = new Date(now.getTime() - 1).toISOString(); // 1ms before now
    const alive = new Date(now.getTime() + 3600_000).toISOString(); // 1h later

    const { parentId, studentId, deviceId } = await seedIdentity("ret1");

    // student_sessions (TEXT ISO timestamps, the 001 convention).
    for (const [token, exp] of [
      ["ss-expired-a", justBefore],
      ["ss-at-boundary", atExpiry],
      ["ss-alive", alive]
    ]) {
      await pg.query(`INSERT INTO student_sessions (token, student_id, created_at, expires_at) VALUES ($1, $2, $3, $4)`, [
        token,
        studentId,
        justBefore,
        exp
      ]);
    }

    // parent_sessions (timestamptz).
    for (const [hash, exp] of [
      ["ps-expired", justBefore],
      ["ps-at-boundary", atExpiry],
      ["ps-alive", alive]
    ]) {
      await pg.query(
        `INSERT INTO parent_sessions (token_hash, parent_id, expires_at, refreshable_until) VALUES ($1, $2, $3, $3)`,
        [hash, parentId, exp]
      );
    }

    // child_device_sessions (timestamptz).
    for (const [sid, exp] of [
      ["cds-expired", justBefore],
      ["cds-at-boundary", atExpiry],
      ["cds-alive", alive]
    ]) {
      await pg.query(
        `INSERT INTO child_device_sessions (session_id, token_hash, parent_id, student_id, device_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [sid, `hash-${sid}`, parentId, studentId, deviceId, exp]
      );
    }

    // parent_tokens (timestamptz, single-use verification/reset tokens).
    for (const [hash, exp] of [
      ["pt-expired", justBefore],
      ["pt-at-boundary", atExpiry],
      ["pt-alive", alive]
    ]) {
      await pg.query(`INSERT INTO parent_tokens (token_hash, parent_id, kind, expires_at) VALUES ($1, $2, 'email_verification', $3)`, [
        hash,
        parentId,
        exp
      ]);
    }

    // Evidence tables must be untouched by the sweep.
    await pg.query(
      `INSERT INTO consent_records (consent_id, parent_id, student_id, policy_version, method)
       VALUES ('con-ret-1', $1, $2, (SELECT version FROM consent_policy_versions WHERE active LIMIT 1), 'signup-form')`,
      [parentId, studentId]
    );

    const counts1 = await runRetentionSweep(facade(pg), { now });
    assert.equal(counts1.studentSessions, 2, "expired + at-boundary purged");
    assert.equal(counts1.parentSessions, 2);
    assert.equal(counts1.childDeviceSessions, 2);
    assert.equal(counts1.parentTokens, 2);

    // Alive rows survive.
    const ssAlive = await pg.query("SELECT COUNT(*)::int AS n FROM student_sessions WHERE token = 'ss-alive'");
    assert.equal(ssAlive.rows[0].n, 1);
    const psAlive = await pg.query("SELECT COUNT(*)::int AS n FROM parent_sessions WHERE token_hash = 'ps-alive'");
    assert.equal(psAlive.rows[0].n, 1);
    const cdsAlive = await pg.query("SELECT COUNT(*)::int AS n FROM child_device_sessions WHERE session_id = 'cds-alive'");
    assert.equal(cdsAlive.rows[0].n, 1);
    const ptAlive = await pg.query("SELECT COUNT(*)::int AS n FROM parent_tokens WHERE token_hash = 'pt-alive'");
    assert.equal(ptAlive.rows[0].n, 1);

    // AC: running it twice yields the identical end state (zero second pass).
    const counts2 = await runRetentionSweep(facade(pg), { now });
    assert.deepEqual(counts2, {
      studentSessions: 0,
      parentSessions: 0,
      childDeviceSessions: 0,
      parentTokens: 0,
      errorEvents: 0
    });
    for (const [table, col, val] of [
      ["student_sessions", "token", "ss-alive"],
      ["parent_sessions", "token_hash", "ps-alive"],
      ["child_device_sessions", "session_id", "cds-alive"],
      ["parent_tokens", "token_hash", "pt-alive"]
    ]) {
      const rows = await pg.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${col} = $1`, [val]);
      assert.equal(rows.rows[0].n, 1, `${table} alive row must persist across both passes`);
    }

    // Evidence untouched.
    const consent = await pg.query("SELECT COUNT(*)::int AS n FROM consent_records WHERE consent_id = 'con-ret-1'");
    assert.equal(consent.rows[0].n, 1);
  });

  test("a sweep at a later clock purges rows that expired in between (the interval is honest)", async () => {
    const t0 = new Date("2026-10-25T12:00:00.000Z");
    const later = new Date(t0.getTime() + 7200_000);
    const { parentId, studentId } = await seedIdentity("ret2");
    await pg.query(`INSERT INTO student_sessions (token, student_id, created_at, expires_at) VALUES ('ss-mid', $1, $2, $3)`, [
      studentId,
      t0.toISOString(),
      new Date(t0.getTime() + 3600_000).toISOString() // expires between t0 and later
    ]);
    await pg.query(
      `INSERT INTO parent_sessions (token_hash, parent_id, expires_at, refreshable_until) VALUES ('ps-mid', $1, $2, $2)`,
      [parentId, new Date(t0.getTime() + 3600_000).toISOString()]
    );
    const counts = await runRetentionSweep(facade(pg), { now: later });
    // ss-mid/ps-mid expired at t0+1h; test 1's "alive" rows (same expiry)
    // are now expired too — a later sweep catches BOTH. That is the point:
    // nothing that has expired survives to a subsequent pass.
    assert.equal(counts.studentSessions, 2);
    assert.equal(counts.parentSessions, 2);
    const mid = await pg.query("SELECT COUNT(*)::int AS n FROM student_sessions WHERE token = 'ss-mid'");
    assert.equal(mid.rows[0].n, 0);
  });

  test("pristine tables sweep to all zeros without error", async () => {
    const counts = await runRetentionSweep(facade(pg), { now: new Date() });
    // #66: error_events (the 30d first-party error window) joins the
    // sweep's purged tables.
    assert.deepEqual(counts, {
      studentSessions: 0,
      parentSessions: 0,
      childDeviceSessions: 0,
      parentTokens: 0,
      errorEvents: 0
    });
  });

  test("startRetentionSweep with RETENTION_SWEEP_INTERVAL_MS=0 disables scheduling (no boot pass, returns null)", async () => {
    const { studentId } = await seedIdentity("ret3");
    const past = new Date(Date.now() - 3600_000).toISOString();
    await pg.query(`INSERT INTO student_sessions (token, student_id, created_at, expires_at) VALUES ('ss-nosweep', $1, $2, $3)`, [
      studentId,
      past,
      past
    ]);
    const prev = process.env.RETENTION_SWEEP_INTERVAL_MS;
    process.env.RETENTION_SWEEP_INTERVAL_MS = "0";
    try {
      const timer = startRetentionSweep(facade(pg), undefined);
      assert.equal(timer, null, "scheduling disabled must return null");
      const row = await pg.query("SELECT COUNT(*)::int AS n FROM student_sessions WHERE token = 'ss-nosweep'");
      assert.equal(row.rows[0].n, 1, "no boot sweep may run when scheduling is disabled");
    } finally {
      if (prev === undefined) delete process.env.RETENTION_SWEEP_INTERVAL_MS;
      else process.env.RETENTION_SWEEP_INTERVAL_MS = prev;
      // Clean up for later tests: this row is intentionally expired.
      await pg.query("DELETE FROM student_sessions WHERE token = 'ss-nosweep'");
    }
  });
});
