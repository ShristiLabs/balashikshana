// Weekly email progress summaries (issue #63, M5 — the FINAL M5 issue).
//
// A scheduled, idempotent, parent-facing-only weekly digest: one email
// per eligible parent summarizing each linked child's completed week
// (time practiced, topics completed, units mastered, keys, streak).
//
// DOCTRINE (each decision documented once, here):
//
// - PARITY BY CONSTRUCTION: every digest number comes from the SAME
//   shared helpers the portal serves — weeklySeriesForChild (portal.mjs,
//   which #62's export also reuses) for the week row, and the children
//   overview's keys SQL. One aggregation, two renderings (chart vs
//   email); the digest never forks the math (AC2). Parity is asserted
//   by test: digest numbers deep-equal weeklySeriesForChild output.
//
// - DIGEST WEEK = the most recently COMPLETE ISO week (Monday-anchored
//   UTC, portal-analytics.mjs's convention): at any instant in week W
//   the digest describes week W-1. Partial weeks are never summarized
//   (mid-week numbers would read as alarmingly low activity), and the
//   Monday boundary doubles as the send policy: the first scheduler
//   tick at/after Monday 00:00 UTC sends the week that just closed
//   (with the default 1h tick, within an hour of the boundary).
//
// - IDEMPOTENCY (parent, ISO week): weekly_digest_sent (migration 012)
//   carries PRIMARY KEY (parent_id, iso_week). The ledger row is
//   CLAIMED-ON-SUCCESS — inserted (ON CONFLICT DO NOTHING) only after a
//   send resolved ok — so a failed send is naturally retried by the
//   NEXT run ("retried on the next run", the issue's wording; never
//   mid-run) and a sequential re-run sends nothing (AC6's "a re-run
//   sends no duplicates", tested including across a fresh process).
//
// - OVERLAP SAFETY: claim-on-success alone would let two CONCURRENT
//   runs both send before either claims. The job therefore opens with
//   a session-scoped pg advisory lock (pg_try_advisory_lock on a
//   dedicated pooled client held for the run's duration): an
//   overlapping run simply skips. Residual window, documented honestly:
//   a process CRASH between a successful send and its ledger insert
//   loses that one marker row and the next run may re-send that parent
//   once — bounded to exactly the crash instant, the same single-point
//   every at-least-once mail system carries. Single-instance deployment
//   is the standing assumption (the #62 retention scheduler runs under
//   it); multi-instance needs the lock, which is already here.
//
// - GATING (each category counted in the run summary): only parents
//   with a VERIFIED email (parents.email_verified_at, #40's seam —
//   AC3), weekly email ENABLED (parents.weekly_email_enabled, default
//   on, the portal's notification-preferences toggle — AC4), and at
//   least one CLAIMED child (a parent whose last child was deleted via
//   #62 gets no digest) receive mail. No child recipients, no CC/BCC —
//   one explicit parent address per send.
//
// - FAILURE ISOLATION + PACING: sends are sequential with a small
//   inter-send delay (SMTP round-trips self-pace; the delay is cheap
//   insurance), each parent wrapped individually — one failed send
//   logs a first-party structured line ({parentId, isoWeek, outcome},
//   counts only, never the address) and the batch continues (AC7).
//
// - D5 (first-party only): the rendered email contains no images, no
//   links, no beacons or third-party embeds of any kind — asserted by
//   test over the rendered output (AC5). No links is also the
//   anti-phishing posture: the footer tells the parent where to manage
//   preferences instead of linking (a link is the one element a
//   phishing copy would abuse).
//
// - PII MINIMIZATION: child nickname + aggregate numbers only (the
//   architecture doc's data-minimization rule); nicknames are
//   HTML-escaped in the renderer (an email client is a rendering
//   engine too).

import { isoWeekStartMs } from "./portal-analytics.mjs";
import { weeklySeriesForChild } from "./portal.mjs";
import { smtpConfigured } from "./mailer.mjs";

// The digest job's advisory-lock key. Arbitrary but stable; hex spells
// "mail" (0x6D61696C) so it is greppable and collision-unlikely.
// Exported for tests and ops tooling (lock inspection).
export const DIGEST_ADVISORY_LOCK_KEY = 0x6d61696c;

const DEFAULT_INTERVAL_MS = 3600000; // 1h tick: the week's digest goes out within an hour of Monday 00:00 UTC.
const DEFAULT_SEND_DELAY_MS = 250; // pacing between sends; 0 in tests.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function sleep(ms) {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/** "Mon DD, YYYY" for an epoch-ms instant (UTC, fixed month names — deterministic for tests). */
function shortDate(ms) {
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

/**
 * ISO-8601 week key "YYYY-Www" for the week CONTAINING an epoch-ms
 * instant. Weeks are Monday-anchored (isoWeekStartMs); the ISO YEAR is
 * the calendar year of the week's THURSDAY (the standard's own rule —
 * Jan 1-3 can belong to the previous ISO year's week 52/53 and Dec
 * 29-31 to the next year's week 1), and the week number derives from
 * the Thursday's day-of-year. Pure; unit-tested across year seams.
 */
export function isoWeekKey(epochMs) {
  const mondayMs = isoWeekStartMs(epochMs);
  const thursday = new Date(mondayMs + 3 * 86400000);
  const isoYear = thursday.getUTCFullYear();
  const jan1Ms = Date.UTC(isoYear, 0, 1);
  const thursdayDayOfYear = Math.floor((mondayMs + 3 * 86400000 - jan1Ms) / 86400000) + 1; // 1-based
  const week = Math.floor((thursdayDayOfYear - 1) / 7) + 1;
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function childLines(c) {
  if (c.attempts === 0) {
    return [`No practice recorded this week.`, `Practice streak: ${c.streakDays} day${c.streakDays === 1 ? "" : "s"}`];
  }
  return [
    `Time practiced: ${c.activeMinutes} minutes`,
    `Topics completed: ${c.topicsFirstMastered} (${c.cumulativeTopicsMastered} mastered in total)`,
    `Units mastered this week: ${c.unitsMasteredThisWeek} (Silver keys: ${c.silverKeys}, Gold keys: ${c.goldKeys})`,
    `Practice streak: ${c.streakDays} day${c.streakDays === 1 ? "" : "s"}`
  ];
}

/**
 * Render the weekly digest email. PURE: no db, no clock (the week
 * window arrives as data), no transport — snapshot-tested, and the
 * no-tracking assertion (AC5) runs over this exact output.
 *
 * @param {{weekStartMs: number, children: Array<{nickname: string, attempts: number, activeMinutes: number,
 *   topicsFirstMastered: number, cumulativeTopicsMastered: number, unitsMasteredThisWeek: number,
 *   silverKeys: number, goldKeys: number, streakDays: number}>}} input
 * @returns {{subject: string, text: string, html: string}}
 */
export function renderWeeklyDigest({ weekStartMs, children }) {
  const weekEndMs = weekStartMs + 7 * 86400000;
  const windowLabel = `${shortDate(weekStartMs)} - ${shortDate(weekEndMs - 86400000)}`;
  const subject = `Balashikshana weekly summary - week of ${shortDate(weekStartMs)}`;

  const sections = children.map((c) => ({ nickname: c.nickname, lines: childLines(c) }));

  const text =
    [`Your family's weekly learning summary for ${windowLabel}.`, ""]
      .concat(...sections.map((s) => [`${s.nickname}:`, ...s.lines.map((l) => `- ${l}`), ""]))
      .concat([
        "You are receiving this weekly summary because you are a verified Balashikshana parent.",
        "Manage your email preferences in the parent portal settings."
      ])
      .join("\n");

  const html =
    `<p>Your family's weekly learning summary for ${escapeHtml(windowLabel)}.</p>` +
    sections
      .map(
        (s) =>
          `<h2>${escapeHtml(s.nickname)}</h2><ul>${s.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`
      )
      .join("") +
    "<p>You are receiving this weekly summary because you are a verified Balashikshana parent. " +
    "Manage your email preferences in the parent portal settings.</p>";

  return { subject, text, html };
}

/**
 * One digest run. `db` needs .get/.all/.run plus .pool for the overlap
 * lock (the production facade exposes it; pure test facades without
 * .pool simply run unlocked — single-threaded by construction).
 * `transport` is injected (tests pass a capture transport; the
 * scheduler passes the mailer seam default). `fromAddress` defaults to
 * the SMTP_FROM env convention (mailer.mjs). Returns the run summary.
 */
export async function runWeeklyDigest(
  db,
  { now = new Date(), transport, logger, sendDelayMs = DEFAULT_SEND_DELAY_MS, fromAddress } = {}
) {
  const from = fromAddress || process.env.SMTP_FROM || "Balashikshana <no-reply@balashikshana.local>";
  const nowMs = now.getTime();
  // The digest week is the most recent COMPLETE ISO week.
  const weekStartMs = isoWeekStartMs(nowMs) - 7 * 86400000;
  const weekEndMs = weekStartMs + 7 * 86400000; // == current week start (exclusive)
  const isoWeek = isoWeekKey(weekStartMs);

  const summary = {
    isoWeek,
    weekStartMs,
    weekEndMs,
    skippedRun: false,
    considered: 0,
    sent: 0,
    failed: 0,
    skippedUnverified: 0,
    skippedOptedOut: 0,
    skippedZeroChildren: 0,
    skippedAlreadySent: 0
  };

  // Overlap lock (see doctrine): a dedicated pooled client held for the
  // whole run, so try/unlock land on the SAME session.
  let lockClient = null;
  if (db.pool?.connect) {
    lockClient = await db.pool.connect();
    try {
      const locked = await lockClient.query("SELECT pg_try_advisory_lock($1) AS ok", [DIGEST_ADVISORY_LOCK_KEY]);
      if (!locked.rows[0]?.ok) {
        logger?.info?.({ isoWeek }, "Weekly digest run skipped: another run holds the lock");
        summary.skippedRun = true;
        lockClient.release();
        return summary;
      }
    } catch (err) {
      // Failure to LOCK is not failure to RUN — proceed unlocked (the
      // single-instance assumption covers it) rather than skipping mail.
      logger?.warn?.({ err: err?.message }, "Weekly digest advisory lock unavailable; running unlocked");
      lockClient.release();
      lockClient = null;
    }
  }

  try {
    // Selection + gating: every parent with claimed-children count, not
    // yet sent this ISO week. Categorization is data-driven (counts land
    // in the summary), selection is the query's job.
    const parents = await db.all(
      `SELECT p.parent_id, p.email, p.email_verified_at, p.weekly_email_enabled,
              (SELECT COUNT(*)::int FROM parent_children pc
                WHERE pc.parent_id = p.parent_id AND pc.status = 'claimed') AS claimed_children,
              EXISTS (SELECT 1 FROM weekly_digest_sent w WHERE w.parent_id = p.parent_id AND w.iso_week = $1) AS already_sent
       FROM parents p
       ORDER BY p.created_at ASC`,
      [isoWeek]
    );

    const eligible = [];
    for (const p of parents) {
      summary.considered += 1;
      if (!p.email_verified_at) {
        summary.skippedUnverified += 1;
        continue;
      }
      if (!p.weekly_email_enabled) {
        summary.skippedOptedOut += 1;
        continue;
      }
      if (p.claimed_children === 0) {
        summary.skippedZeroChildren += 1;
        continue;
      }
      if (p.already_sent) {
        summary.skippedAlreadySent += 1;
        continue;
      }
      eligible.push(p);
    }

    for (const parent of eligible) {
      try {
        // Per-child numbers — ALL through the shared helpers (parity).
        const childRows = await db.all(
          `SELECT s.student_id, s.nickname, s.streak_days
           FROM parent_children pc
           JOIN students s ON s.student_id = pc.student_id
           WHERE pc.parent_id = $1 AND pc.status = 'claimed'
           ORDER BY pc.claimed_at ASC`,
          [parent.parent_id]
        );
        const children = [];
        for (const child of childRows) {
          // weeks=1 evaluated at (weekEnd - 1ms): the single bucket IS
          // the digest week — the same row the portal weekly route
          // serves for that week (one aggregation, two renderings).
          const series = await weeklySeriesForChild(db, child.student_id, 1, weekEndMs - 1);
          const week = series[0];
          const keys = await db.get(
            `SELECT
               COUNT(*) FILTER (WHERE silver_awarded_at >= $2 AND silver_awarded_at < $3)::int AS mastered_this_week,
               COUNT(*) FILTER (WHERE silver_awarded_at IS NOT NULL)::int AS silver_keys,
               COUNT(*) FILTER (WHERE gold_verified_at IS NOT NULL)::int AS gold_keys
             FROM student_unit_progress WHERE student_id = $1`,
            [child.student_id, new Date(weekStartMs).toISOString(), new Date(weekEndMs).toISOString()]
          );
          children.push({
            nickname: child.nickname,
            attempts: week.attempts,
            activeMinutes: week.activeMinutes,
            topicsFirstMastered: week.topicsFirstMastered,
            cumulativeTopicsMastered: week.cumulativeTopicsMastered,
            unitsMasteredThisWeek: keys?.mastered_this_week ?? 0,
            silverKeys: keys?.silver_keys ?? 0,
            goldKeys: keys?.gold_keys ?? 0,
            streakDays: Number(child.streak_days) || 0
          });
        }

        const { subject, text, html } = renderWeeklyDigest({ weekStartMs, children });
        const result = await transport.send({
          from,
          to: parent.email,
          subject,
          text,
          html
        });

        if (result?.ok) {
          // Claim-on-success (see doctrine): the ledger insert is what
          // makes every later run this week a no-op for this parent.
          const inserted = await db.run(
            `INSERT INTO weekly_digest_sent (parent_id, iso_week, sent_at, children_count, message_id)
             VALUES ($1, $2, now(), $3, $4)
             ON CONFLICT (parent_id, iso_week) DO NOTHING`,
            [parent.parent_id, isoWeek, children.length, result.messageId ?? null]
          );
          summary.sent += 1;
          if ((inserted.rowCount ?? 1) === 0) summary.skippedAlreadySent += 1;
          logger?.info?.({ parentId: parent.parent_id, isoWeek, outcome: "sent", children: children.length }, "Weekly digest sent");
        } else {
          summary.failed += 1;
          logger?.warn?.({ parentId: parent.parent_id, isoWeek, outcome: "failed", err: result?.error }, "Weekly digest send failed (will retry next run)");
        }
      } catch (err) {
        // One parent's failure NEVER aborts the batch (AC7).
        summary.failed += 1;
        logger?.error?.({ parentId: parent.parent_id, isoWeek, outcome: "failed", err: err?.message }, "Weekly digest parent failed (will retry next run)");
      }
      await sleep(sendDelayMs); // pacing between sends
    }

    logger?.info?.(
      {
        isoWeek,
        sent: summary.sent,
        failed: summary.failed,
        skippedUnverified: summary.skippedUnverified,
        skippedOptedOut: summary.skippedOptedOut,
        skippedZeroChildren: summary.skippedZeroChildren,
        skippedAlreadySent: summary.skippedAlreadySent
      },
      "Weekly digest run complete"
    );
    return summary;
  } finally {
    if (lockClient) {
      try {
        await lockClient.query("SELECT pg_advisory_unlock($1)", [DIGEST_ADVISORY_LOCK_KEY]);
      } catch {
        // The session dies with the client regardless; unlock failure is noise.
      }
      lockClient.release();
    }
  }
}

/**
 * Boot the digest scheduler: one run immediately (downtime catch-up —
 * a server that was down over the Monday boundary still sends on
 * boot), then every WEEKLY_DIGEST_INTERVAL_MS (default 1h; the ledger
 * makes extra ticks no-ops — frequency bounds worst-case send latency,
 * never duplication). Opt-in: WEEKLY_DIGEST_ENABLED must be 1/true —
 * outbound mail is a side-effecting surface and the conservative
 * default is OFF (the null transport plus this gate means a bare dev
 * boot never sends anything, ever). The timer is unref'd. Returns the
 * timer (or null when disabled) so callers could clear it.
 */
export function startWeeklyDigestScheduler(db, logger, getTransport) {
  const enabled = ["1", "true", "yes"].includes(String(process.env.WEEKLY_DIGEST_ENABLED || "").trim().toLowerCase());
  if (!enabled) {
    logger?.info?.("Weekly digest scheduler disabled (WEEKLY_DIGEST_ENABLED not set; default off)");
    return null;
  }
  // Misconfiguration guard: enabling the digest without an SMTP host
  // would run every tick against the null transport — every send fails
  // honestly (see mailer.mjs) but the operator clearly MEANT to send
  // mail. Refuse loudly instead of failing silently forever. (Injected
  // transports — tests — bypass this via getTransport.)
  if (!getTransport && !smtpConfigured()) {
    logger?.error?.("Weekly digest scheduler enabled but SMTP_HOST is not configured; refusing to start. Set SMTP_HOST (or clear WEEKLY_DIGEST_ENABLED).");
    return null;
  }
  const raw = Number(process.env.WEEKLY_DIGEST_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  const intervalMs = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_INTERVAL_MS;
  if (intervalMs === 0) {
    logger?.info?.({ intervalMs }, "Weekly digest scheduling disabled (WEEKLY_DIGEST_INTERVAL_MS=0)");
    return null;
  }
  const resolveTransport = getTransport || ((lg) => import("./mailer.mjs").then((m) => m.defaultTransport(lg)));

  const tick = async (label) => {
    try {
      const transport = await resolveTransport(logger);
      const summary = await runWeeklyDigest(db, { transport, logger });
      if (!summary.skippedRun && (summary.sent > 0 || summary.failed > 0)) {
        logger?.info?.({ ...summary, tick: label }, `Weekly digest (${label})`);
      }
    } catch (err) {
      // A failed run never takes the server down; the next tick retries.
      logger?.error?.({ err: err?.message }, "Weekly digest run failed");
    }
  };

  tick("boot");
  const timer = setInterval(() => tick("interval"), intervalMs);
  timer.unref?.();
  return timer;
}
