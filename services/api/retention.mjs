// Retention/cleanup sweep (issue #62, M5 data rights).
//
// A scheduled, idempotent purge of expired session and token rows, safe
// to re-run and safe to run concurrently with the API:
//
// - Every sweep statement is a single-statement DELETE whose predicate is
//   "expires_at has passed" — running it twice reaches the identical end
//   state (the second run deletes zero rows), and concurrent API traffic
//   only ever races the same per-row DELETE (Postgres row locks; the
//   per-token lazy deletes in resolveBearerAuth already cooperate with
//   this pattern — they are the same predicate scoped to one row).
// - "Orphaned rows past retention" from the issue need no sweep of their
//   own: every child-data table cascades from students (001-010 delete
//   rules), so orphans are structurally impossible. The TTL columns the
//   schema actually carries are exactly the four purged here:
//   student_sessions.expires_at (001, TEXT ISO-8601 — lexicographic
//   comparison is exact because every writer stores
//   new Date().toISOString()), parent_sessions.expires_at (003),
//   child_device_sessions.expires_at (005), parent_tokens.expires_at
//   (003 — consumed single-use tokens purge on the same clock).
// - The sweep NEVER touches consent_records, deletion_audit, or any
//   attempt/progress row — evidence tables have no TTL (D8 / COPPA
//   record-keeping; the only sanctioned attempt rewrite is the #62
//   audited deletion).
//
// Scheduling decision (the repo has no scheduler and #62 does not add
// one): the server boots a lightweight interval sweep — one immediate
// pass at startup, then RETENTION_SWEEP_INTERVAL_MS (default 6 hours,
// 0 disables). The timer is unref'd so it never holds the process open.
// runRetentionSweep is exported separately so tests drive it with an
// injected clock (deterministic TTL boundaries) and operators/scripts
// can run it on demand without waiting for the interval.

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * One idempotent purge pass. `db` needs only .run(sql, params) (the
 * standard db facade); `now` defaults to the real clock and is injectable
 * for deterministic boundary tests. Returns per-table deleted counts.
 */
export async function runRetentionSweep(db, { now = new Date() } = {}) {
  const nowIso = now.toISOString();
  const counts = {};

  // student_sessions.expires_at is TEXT ISO-8601 (001); lexicographic
  // comparison equals chronological comparison for the toISOString()
  // format every writer uses (always Z, always fixed width).
  const studentSessions = await db.run("DELETE FROM student_sessions WHERE expires_at <= $1", [nowIso]);
  counts.studentSessions = studentSessions.rowCount ?? 0;

  // The other three carry real timestamptz columns; pg casts the ISO param.
  const parentSessions = await db.run("DELETE FROM parent_sessions WHERE expires_at <= $1", [nowIso]);
  counts.parentSessions = parentSessions.rowCount ?? 0;

  const childDeviceSessions = await db.run("DELETE FROM child_device_sessions WHERE expires_at <= $1", [nowIso]);
  counts.childDeviceSessions = childDeviceSessions.rowCount ?? 0;

  const parentTokens = await db.run("DELETE FROM parent_tokens WHERE expires_at <= $1", [nowIso]);
  counts.parentTokens = parentTokens.rowCount ?? 0;

  // #66: first-party error events are a ROLLING OPERATIONAL WINDOW, not
  // evidence — error_events rows older than ERROR_EVENT_RETENTION_DAYS
  // (default 30) purge on the same sweep. Bounded storage for a table
  // whose volume is failure-driven (flood-capped at capture as well).
  const errorRetentionDays = Number(process.env.ERROR_EVENT_RETENTION_DAYS || 30);
  const safeDays = Number.isFinite(errorRetentionDays) && errorRetentionDays > 0 ? errorRetentionDays : 30;
  const cutoffIso = new Date(now.getTime() - safeDays * 24 * 60 * 60 * 1000).toISOString();
  const errorEvents = await db.run("DELETE FROM error_events WHERE captured_at <= $1", [cutoffIso]);
  counts.errorEvents = errorEvents.rowCount ?? 0;

  return counts;
}

/**
 * Boot the interval sweep on the server. Fires one pass immediately
 * (expired rows from downtime do not wait for the first tick), then every
 * interval. RETENTION_SWEEP_INTERVAL_MS=0 disables scheduling entirely
 * (the exported sweep stays available to callers). Returns the timer (or
 * null when disabled) so the caller could clear it; the timer is unref'd
 * regardless.
 */
export function startRetentionSweep(db, logger) {
  const raw = Number(process.env.RETENTION_SWEEP_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  const intervalMs = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_INTERVAL_MS;
  if (intervalMs === 0) {
    logger?.info?.({ intervalMs }, "Retention sweep scheduling disabled (RETENTION_SWEEP_INTERVAL_MS=0)");
    return null;
  }

  const tick = async (label) => {
    try {
      const counts = await runRetentionSweep(db);
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      if (total > 0) {
        // Counts only — never row contents (no PII in server logs; the
        // deletion_audit ledger is the record for deletion events, and
        // expiry purges are not deletions of child data).
        logger?.info?.({ counts }, `Retention sweep (${label}) purged ${total} expired rows`);
      }
    } catch (err) {
      // A failed sweep never takes the server down; the next tick retries.
      logger?.error?.({ err: err.message }, "Retention sweep failed");
    }
  };

  tick("boot");
  const timer = setInterval(() => tick("interval"), intervalMs);
  timer.unref?.();
  return timer;
}
