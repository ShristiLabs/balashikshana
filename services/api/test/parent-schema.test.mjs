// Parent accounts and consent schema coverage for issue #39 (migration
// 002), the consent policy catalog from issue #41 (migration 004), and the
// child-profile/device-session schema from issue #42 (migration 005): FK
// integrity, the COPPA delete rules (evidence RESTRICTs, live
// bindings/devices/sessions CASCADE), case-insensitive email uniqueness,
// composite uniqueness on parent_children and devices, the email shape
// guard, the audit_students_without_consent view, the consent method CHECK
// + policy FK + single-active-policy index, the 005 value-set CHECKs +
// students.status lifecycle + exactly-one-claimant partial unique index,
// and 002/003/004/005 reversibility.
//
// Schema-level: it applies migrations to a throwaway database directly
// through node-pg-migrate with the same options db.mjs runMigrations uses
// (the route-level consent behavior lives in consent.test.mjs). That also
// lets the reversibility case run `down` for exactly the M2-parent stack.

import { test, describe, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pgmigrate from "node-pg-migrate";
import { Client } from "pg";
import { createTestDatabase, dropTestDatabase } from "./helpers.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, "../migrations");

let testDatabase;
let db;

async function migrate({ direction, count = Infinity }) {
  await pgmigrate({
    databaseUrl: testDatabase.url,
    migrationsTable: "pgmigrations",
    dir: MIGRATIONS_DIR,
    direction,
    count,
    log: () => {},
    verbose: false
  });
}

// Every test mints its own ids so no test depends on another's rows.
let seq = 0;
const uid = (prefix) => `${prefix}-ps${++seq}`;
const ISO_NOW = () => new Date().toISOString();
const PIN_HASH = "scrypt$16384$8$1$00$00";

async function insertStudent() {
  const studentId = uid("stu");
  const username = studentId; // students.username is globally unique
  await db.query(
    `INSERT INTO students (student_id, username, pin_hash, nickname, avatar, age_years, current_grade, last_active_at, created_at)
     VALUES ($1, $2, $3, $2, 'fox', 6, 'ps-grade', $4, $4)`,
    [studentId, username, PIN_HASH, ISO_NOW()]
  );
  return studentId;
}

async function insertParent(email) {
  const parentId = uid("par");
  await db.query("INSERT INTO parents (parent_id, email, password_hash) VALUES ($1, $2, $3)", [
    parentId,
    email,
    PIN_HASH
  ]);
  return parentId;
}

async function insertConsent(parentId, studentId = null) {
  const consentId = uid("con");
  await db.query(
    `INSERT INTO consent_records (consent_id, parent_id, student_id, policy_version, method)
     VALUES ($1, $2, $3, '1', 'signup-form')`,
    [consentId, parentId, studentId]
  );
  return consentId;
}

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  await migrate({ direction: "up" });
  db = new Client({ connectionString: testDatabase.url });
  await db.connect();
  // students.current_grade references grades; one shared fixture grade.
  await db.query(
    `INSERT INTO grades (grade_id, grade_name, target_age_years, sequence_order, sr_growth_factor, sr_max_interval_days, sr_schedule_json)
     VALUES ('ps-grade', 'Parent Schema Test', '6', 1, 1.0, 30, '[]')`
  );
});

afterAll(async () => {
  try {
    await db?.end();
  } catch {
    // already closed
  }
  if (testDatabase) await dropTestDatabase(testDatabase.name);
});

describe("foreign key integrity (issue #39)", () => {
  test("parent_children insert with an unknown parent fails with FK violation 23503", async () => {
    const studentId = await insertStudent();
    await assert.rejects(
      db.query(
        "INSERT INTO parent_children (parent_id, student_id, relation) VALUES ($1, $2, 'mother')",
        ["par-does-not-exist", studentId]
      ),
      (err) => err.code === "23503"
    );
  });

  test("parent_children insert with an unknown student fails with FK violation 23503", async () => {
    const parentId = await insertParent("fk-pc-stu@example.com");
    await assert.rejects(
      db.query(
        "INSERT INTO parent_children (parent_id, student_id, relation) VALUES ($1, $2, 'father')",
        [parentId, "stu-does-not-exist"]
      ),
      (err) => err.code === "23503"
    );
  });

  test("consent_records insert with an unknown parent fails with FK violation 23503", async () => {
    await assert.rejects(
      db.query(
        `INSERT INTO consent_records (consent_id, parent_id, policy_version, method)
         VALUES ($1, $2, '1', 'signup-form')`,
        [uid("con"), "par-does-not-exist"]
      ),
      (err) => err.code === "23503"
    );
  });

  test("consent_records insert with an unknown student value fails with FK violation 23503", async () => {
    const parentId = await insertParent("fk-con-stu@example.com");
    await assert.rejects(
      db.query(
        `INSERT INTO consent_records (consent_id, parent_id, student_id, policy_version, method)
         VALUES ($1, $2, $3, '1', 'signup-form')`,
        [uid("con"), parentId, "stu-does-not-exist"]
      ),
      (err) => err.code === "23503"
    );
  });

  test("devices insert with an unknown parent fails with FK violation 23503", async () => {
    await assert.rejects(
      db.query(
        "INSERT INTO devices (device_id, parent_id, client_device_id, platform) VALUES ($1, $2, 'client-1', 'ios')",
        [uid("dev"), "par-does-not-exist"]
      ),
      (err) => err.code === "23503"
    );
  });
});

describe("delete rules (COPPA evidence vs live bindings)", () => {
  test("deleting a parent with consent evidence is RESTRICTed (23503), then allowed once evidence is handled explicitly", async () => {
    const parentId = await insertParent("restrict-con-par@example.com");
    await insertConsent(parentId);

    await assert.rejects(
      db.query("DELETE FROM parents WHERE parent_id = $1", [parentId]),
      (err) => err.code === "23503"
    );

    // The intended #62 data-rights flow: handle evidence first, then delete.
    await db.query("DELETE FROM consent_records WHERE parent_id = $1", [parentId]);
    await db.query("DELETE FROM parents WHERE parent_id = $1", [parentId]);
    const row = (await db.query("SELECT 1 FROM parents WHERE parent_id = $1", [parentId])).rows[0];
    assert.equal(row, undefined, "parent must be deletable after its evidence is handled");
  });

  test("deleting a student referenced by consent evidence is RESTRICTed (23503)", async () => {
    const parentId = await insertParent("restrict-con-stu@example.com");
    const studentId = await insertStudent();
    await insertConsent(parentId, studentId);

    await assert.rejects(
      db.query("DELETE FROM students WHERE student_id = $1", [studentId]),
      (err) => err.code === "23503"
    );
  });

  test("deleting a parent cascades to their parent_children bindings", async () => {
    const parentId = await insertParent("cascade-pc-par@example.com");
    const studentId = await insertStudent();
    await db.query("INSERT INTO parent_children (parent_id, student_id, relation) VALUES ($1, $2, 'guardian')", [
      parentId,
      studentId
    ]);

    await db.query("DELETE FROM parents WHERE parent_id = $1", [parentId]);

    const row = (await db.query("SELECT 1 FROM parent_children WHERE parent_id = $1", [parentId])).rows[0];
    assert.equal(row, undefined, "bindings must cascade-delete with the parent");
  });

  test("deleting a student cascades to their parent_children bindings", async () => {
    const parentId = await insertParent("cascade-pc-stu@example.com");
    const studentId = await insertStudent();
    await db.query("INSERT INTO parent_children (parent_id, student_id, relation) VALUES ($1, $2, 'mother')", [
      parentId,
      studentId
    ]);

    await db.query("DELETE FROM students WHERE student_id = $1", [studentId]);

    const row = (await db.query("SELECT 1 FROM parent_children WHERE student_id = $1", [studentId])).rows[0];
    assert.equal(row, undefined, "bindings must cascade-delete with the student");
  });

  test("deleting a parent cascades to their devices", async () => {
    const parentId = await insertParent("cascade-dev-par@example.com");
    await db.query(
      "INSERT INTO devices (device_id, parent_id, client_device_id, platform) VALUES ($1, $2, 'client-1', 'android')",
      [uid("dev"), parentId]
    );

    await db.query("DELETE FROM parents WHERE parent_id = $1", [parentId]);

    const row = (await db.query("SELECT 1 FROM devices WHERE parent_id = $1", [parentId])).rows[0];
    assert.equal(row, undefined, "devices must cascade-delete with the parent");
  });
});

describe("uniqueness and shape guards", () => {
  test("duplicate parent email is rejected case-insensitively (23505 on LOWER(email) index)", async () => {
    await insertParent("Case.Insensitive@Example.com");
    await assert.rejects(
      db.query("INSERT INTO parents (parent_id, email, password_hash) VALUES ($1, $2, $3)", [
        uid("par"),
        "case.insensitive@example.COM",
        PIN_HASH
      ]),
      (err) => err.code === "23505"
    );
  });

  test("duplicate (parent_id, student_id) binding is rejected (23505)", async () => {
    const parentId = await insertParent("dup-pc@example.com");
    const studentId = await insertStudent();
    await db.query("INSERT INTO parent_children (parent_id, student_id, relation) VALUES ($1, $2, 'mother')", [
      parentId,
      studentId
    ]);

    await assert.rejects(
      db.query("INSERT INTO parent_children (parent_id, student_id, relation) VALUES ($1, $2, 'father')", [
        parentId,
        studentId
      ]),
      (err) => err.code === "23505"
    );
  });

  test("duplicate (parent_id, client_device_id) is rejected, but the same client id under another parent is allowed", async () => {
    const parentA = await insertParent("dup-dev-a@example.com");
    const parentB = await insertParent("dup-dev-b@example.com");
    await db.query(
      "INSERT INTO devices (device_id, parent_id, client_device_id, platform) VALUES ($1, $2, 'shared-client', 'ios')",
      [uid("dev"), parentA]
    );

    // Uniqueness is per parent: another family's device may share the id.
    await db.query(
      "INSERT INTO devices (device_id, parent_id, client_device_id, platform) VALUES ($1, $2, 'shared-client', 'ios')",
      [uid("dev"), parentB]
    );

    await assert.rejects(
      db.query(
        "INSERT INTO devices (device_id, parent_id, client_device_id, platform) VALUES ($1, $2, 'shared-client', 'ios')",
        [uid("dev"), parentA]
      ),
      (err) => err.code === "23505"
    );
  });

  test("parent email without the @host shape fails the CHECK constraint (23514)", async () => {
    await assert.rejects(
      db.query("INSERT INTO parents (parent_id, email, password_hash) VALUES ($1, $2, $3)", [
        uid("par"),
        "not-an-email",
        PIN_HASH
      ]),
      (err) => err.code === "23514"
    );
  });

  test("consent_records accepts a NULL student_id (capture before child binding, #42 boundary)", async () => {
    const parentId = await insertParent("null-stu@example.com");
    const consentId = await insertConsent(parentId, null);
    const row = (await db.query("SELECT student_id FROM consent_records WHERE consent_id = $1", [consentId]))
      .rows[0];
    assert.ok(row, "consent row must exist");
    assert.equal(row.student_id, null, "student_id must be nullable until #42 binds a child");
  });
});

describe("consent policy catalog (issue #41, migration 004)", () => {
  test("v1 placeholder policy is seeded active with NON-LEGAL marking", async () => {
    const row = (await db.query("SELECT * FROM consent_policy_versions WHERE version = '1'")).rows[0];
    assert.ok(row, "v1 policy row must be seeded");
    assert.equal(row.active, true);
    assert.equal(row.locale, "en-US");
    assert.match(row.policy_text, /NOT LEGAL ADVICE/, "seed text must be clearly marked non-legal");
  });

  test("the partial unique index rejects a second active policy per locale (23505)", async () => {
    await assert.rejects(
      db.query(
        "INSERT INTO consent_policy_versions (version, locale, policy_text, active) VALUES ($1, 'en-US', $2, true)",
        ["1-dup", "second active policy for the same locale"]
      ),
      (err) => err.code === "23505"
    );
    // An inactive row for the same locale is fine (history is append-only).
    await db.query(
      "INSERT INTO consent_policy_versions (version, locale, policy_text, active) VALUES ($1, 'en-US', $2, false)",
      ["0.9", "retired draft"]
    );
  });

  test("consent_records method CHECK rejects values outside the set (23514)", async () => {
    const parentId = await insertParent("method-ck@example.com");
    await assert.rejects(
      db.query(
        `INSERT INTO consent_records (consent_id, parent_id, policy_version, method)
         VALUES ($1, $2, '1', 'carrier-pigeon')`,
        [uid("con"), parentId]
      ),
      (err) => err.code === "23514"
    );
  });

  test("consent_records policy_version FK rejects an unknown version (23503)", async () => {
    const parentId = await insertParent("policy-fk@example.com");
    await assert.rejects(
      db.query(
        `INSERT INTO consent_records (consent_id, parent_id, policy_version, method)
         VALUES ($1, $2, 'does-not-exist', 'signup-form')`,
        [uid("con"), parentId]
      ),
      (err) => err.code === "23503"
    );
  });

  test("an active policy version with consent evidence is RESTRICTed from delete (23503)", async () => {
    const parentId = await insertParent("policy-restrict@example.com");
    await insertConsent(parentId);
    await assert.rejects(
      db.query("DELETE FROM consent_policy_versions WHERE version = '1'"),
      (err) => err.code === "23503"
    );
  });
});

describe("child profiles and device sessions (issue #42, migration 005)", () => {
  test("students.status CHECK rejects values outside the set (23514)", async () => {
    const studentId = await insertStudent();
    await assert.rejects(
      db.query("UPDATE students SET status = 'floating' WHERE student_id = $1", [studentId]),
      (err) => err.code === "23514"
    );
  });

  test("a binding-less student can be flagged legacy (the back-fill shape)", async () => {
    const studentId = await insertStudent();
    await db.query("UPDATE students SET status = 'legacy' WHERE student_id = $1", [studentId]);
    const row = (await db.query("SELECT status FROM students WHERE student_id = $1", [studentId])).rows[0];
    assert.equal(row.status, "legacy");
  });

  test("parent_children.status CHECK rejects values outside the set (23514)", async () => {
    const parentId = await insertParent("pc-status-ck@example.com");
    const studentId = await insertStudent();
    await db.query("INSERT INTO parent_children (parent_id, student_id, relation) VALUES ($1, $2, 'mother')", [
      parentId,
      studentId
    ]);
    await assert.rejects(
      db.query("UPDATE parent_children SET status = 'pending' WHERE student_id = $1", [studentId]),
      (err) => err.code === "23514"
    );
  });

  test("devices.platform CHECK rejects values outside the set (23514)", async () => {
    const parentId = await insertParent("platform-ck@example.com");
    await assert.rejects(
      db.query(
        "INSERT INTO devices (device_id, parent_id, client_device_id, platform) VALUES ($1, $2, 'ck-client', 'blackberry')",
        [uid("dev"), parentId]
      ),
      (err) => err.code === "23514"
    );
  });

  test("exactly-one-claimant: the partial unique index rejects a second 'claimed' binding for a student (23505)", async () => {
    const winner = await insertParent("claim-winner@example.com");
    const loser = await insertParent("claim-loser@example.com");
    const studentId = await insertStudent();
    await db.query("INSERT INTO parent_children (parent_id, student_id, relation) VALUES ($1, $2, 'mother')", [
      winner,
      studentId
    ]);
    await assert.rejects(
      db.query("INSERT INTO parent_children (parent_id, student_id, relation) VALUES ($1, $2, 'father')", [
        loser,
        studentId
      ]),
      (err) => err.code === "23505"
    );
    // Archived bindings do NOT occupy the claim slot (the index is partial).
    await db.query("UPDATE parent_children SET status = 'archived', archived_at = now() WHERE student_id = $1", [
      studentId
    ]);
    await db.query("INSERT INTO parent_children (parent_id, student_id, relation) VALUES ($1, $2, 'guardian')", [
      loser,
      studentId
    ]);
  });

  test("child_device_sessions: token_hash is unique and FKs to parents/students/devices", async () => {
    const parentId = await insertParent("cds-fk@example.com");
    const studentId = await insertStudent();
    const deviceId = uid("dev");
    await db.query(
      "INSERT INTO devices (device_id, parent_id, client_device_id, platform) VALUES ($1, $2, 'cds-client', 'ios')",
      [deviceId, parentId]
    );
    await db.query(
      `INSERT INTO child_device_sessions (session_id, token_hash, parent_id, student_id, device_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '30 days')`,
      [uid("cds"), "a".repeat(64), parentId, studentId, deviceId]
    );
    await assert.rejects(
      db.query(
        `INSERT INTO child_device_sessions (session_id, token_hash, parent_id, student_id, device_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + interval '30 days')`,
        [uid("cds"), "a".repeat(64), parentId, studentId, deviceId]
      ),
      (err) => err.code === "23505"
    );
    await assert.rejects(
      db.query(
        `INSERT INTO child_device_sessions (session_id, token_hash, parent_id, student_id, device_id, expires_at)
         VALUES ($1, $2, $3, 'stu-does-not-exist', $4, now() + interval '30 days')`,
        [uid("cds"), "b".repeat(64), parentId, deviceId]
      ),
      (err) => err.code === "23503"
    );
  });

  test("deleting a student cascades to their child_device_sessions", async () => {
    const parentId = await insertParent("cds-cascade@example.com");
    const studentId = await insertStudent();
    const deviceId = uid("dev");
    await db.query(
      "INSERT INTO devices (device_id, parent_id, client_device_id, platform) VALUES ($1, $2, 'cds-casc-client', 'android')",
      [deviceId, parentId]
    );
    const sessionId = uid("cds");
    await db.query(
      `INSERT INTO child_device_sessions (session_id, token_hash, parent_id, student_id, device_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '30 days')`,
      [sessionId, "c".repeat(64), parentId, studentId, deviceId]
    );

    // Student delete cascades (handle consent evidence first if any — none here).
    await db.query("DELETE FROM students WHERE student_id = $1", [studentId]);
    const gone = (
      await db.query("SELECT 1 FROM child_device_sessions WHERE session_id = $1", [sessionId])
    ).rows[0];
    assert.equal(gone, undefined, "sessions must cascade-delete with the student");
  });
});

describe("audit_students_without_consent view", () => {
  test("lists exactly the students lacking a consent_records row and excludes consented ones", async () => {
    const parentId = await insertParent("audit-view@example.com");
    const unconsentedId = await insertStudent();
    const consentedId = await insertStudent();
    await insertConsent(parentId, consentedId);

    const rows = (await db.query("SELECT student_id FROM audit_students_without_consent")).rows.map(
      (r) => r.student_id
    );

    assert.ok(rows.includes(unconsentedId), "unconsented student must appear in the audit view");
    assert.ok(!rows.includes(consentedId), "consented student must be excluded from the audit view");
    // Count check across every student in the database (earlier tests leave
    // consent evidence behind by design — RESTRICT keeps it), so derive the
    // consented count rather than assuming only this test's row exists.
    const totalStudents = (await db.query("SELECT COUNT(*)::int AS n FROM students")).rows[0].n;
    const consentedStudents = (
      await db.query("SELECT COUNT(DISTINCT student_id)::int AS n FROM consent_records WHERE student_id IS NOT NULL")
    ).rows[0].n;
    const viewCount = (await db.query("SELECT COUNT(*)::int AS n FROM audit_students_without_consent")).rows[0].n;
    assert.equal(viewCount, totalStudents - consentedStudents, "view must list exactly the students without consent");
  });
});

describe("migration 002 reversibility", () => {
  // Runs last in this file on purpose: `down` drops every 002 object and
  // the rows earlier tests created in them. No later test depends on them.
  // 003 (issue #40) layers parent_sessions/parent_tokens on top of 002, 004
  // (issue #41) layers the consent policy catalog + consent_records
  // constraints on top of that, 005 (issue #42) layers the child
  // profiles/device sessions, 006 (issue #48) layers the sync attempt
  // ledger, 007 (issue #55) layers the gamification ledger, and 008
  // (issue #56) layers the hearts session outcomes, 009 (issue #60) layers
  // the placement records, 010 (issue #61) layers the portal child
  // settings, 011 (issue #62) layers the deletion audit ledger, 012
  // (issue #63) layers the weekly digest sent-ledger + parent opt-out
  // column, and 013 (issue #66) layers the first-party error_events
  // store, so the rollback removes all twelve post-001 migrations (in
  // order) and the up restores them; the reversibility contract is unchanged.
  test("down removes exactly the 002..013 objects, up restores them (and re-derives the legacy flag)", async () => {
    await migrate({ direction: "down", count: 12 });

    let names = (await db.query("SELECT name FROM pgmigrations ORDER BY name")).rows.map((r) => r.name);
    assert.deepEqual(names, ["001_initial_schema"], "down must leave only 001 applied");

    const gone = (
      await db.query(
        `SELECT
           to_regclass('parents') AS parents,
           to_regclass('parent_children') AS parent_children,
           to_regclass('consent_records') AS consent_records,
           to_regclass('devices') AS devices,
           to_regclass('audit_students_without_consent') AS audit_view,
           to_regclass('parent_sessions') AS parent_sessions,
           to_regclass('parent_tokens') AS parent_tokens,
           to_regclass('consent_policy_versions') AS consent_policy_versions,
           to_regclass('child_device_sessions') AS child_device_sessions,
           to_regclass('student_xp_events') AS student_xp_events,
           to_regclass('student_badge_awards') AS student_badge_awards,
           to_regclass('student_gamification_state') AS student_gamification_state,
           to_regclass('student_session_outcomes') AS student_session_outcomes,
           to_regclass('student_placement_records') AS student_placement_records,
           to_regclass('portal_child_settings') AS portal_child_settings,
           to_regclass('weekly_digest_sent') AS weekly_digest_sent`
      )
    ).rows[0];
    assert.deepEqual(gone, {
      parents: null,
      parent_children: null,
      consent_records: null,
      devices: null,
      audit_view: null,
      parent_sessions: null,
      parent_tokens: null,
      consent_policy_versions: null,
      child_device_sessions: null,
      student_xp_events: null,
      student_badge_awards: null,
      student_gamification_state: null,
      student_session_outcomes: null,
      student_placement_records: null,
      portal_child_settings: null,
      weekly_digest_sent: null
    });

    // 012's parents.weekly_email_enabled column is gone with the rollback.
    const weeklyColGone = await db.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'parents' AND column_name = 'weekly_email_enabled'`
    );
    assert.equal(weeklyColGone.rows.length, 0, "parents.weekly_email_enabled must be removed by 012 down");

    // 005's students.status column is gone with the rollback.
    const statusGone = await db.query(
      `SELECT 1 FROM information_schema.columns WHERE table_name = 'students' AND column_name = 'status'`
    );
    assert.equal(statusGone.rows.length, 0, "students.status must be removed by 005 down");

    await migrate({ direction: "up" });

    names = (await db.query("SELECT name FROM pgmigrations ORDER BY name")).rows.map((r) => r.name);
    assert.deepEqual(
      names,
      [
        "001_initial_schema",
        "002_parent_accounts_consent",
        "003_parent_auth_tokens",
        "004_consent_policy_versions",
        "005_child_profiles_device_sessions",
        "006_sync_attempt_ledger",
        "007_gamification_ledger",
        "008_hearts_session_outcomes",
        "009_placement_records",
        "010_portal_child_settings",
        "011_deletion_audit",
        "012_weekly_digest",
        "013_error_events"
      ],
      "up must re-apply 002 through 013"
    );

    const back = (
      await db.query(
        `SELECT
           to_regclass('parents') AS parents,
           to_regclass('parent_children') AS parent_children,
           to_regclass('consent_records') AS consent_records,
           to_regclass('devices') AS devices,
           to_regclass('audit_students_without_consent') AS audit_view,
           to_regclass('parent_sessions') AS parent_sessions,
           to_regclass('parent_tokens') AS parent_tokens,
           to_regclass('consent_policy_versions') AS consent_policy_versions,
           to_regclass('child_device_sessions') AS child_device_sessions`
      )
    ).rows[0];
    for (const [object, regclass] of Object.entries(back)) {
      assert.ok(regclass, `${object} must exist again after up`);
    }

    // The up back-fill re-derives 'legacy' from the parent_children
    // population: the students earlier tests inserted had their bindings
    // dropped by the rollback, so they all re-emerge flagged legacy —
    // exactly the documented semantics of the status-only migration.
    const flags = (await db.query("SELECT DISTINCT status FROM students")).rows.map((r) => r.status);
    assert.deepEqual(flags, ["legacy"], "re-running up re-derives the legacy flag for binding-less students");
  });
});
