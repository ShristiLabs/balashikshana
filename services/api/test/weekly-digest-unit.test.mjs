// Weekly digest UNIT tests (issue #63) — pure functions, no database:
// the ISO-week key (year seams both directions, long years) and the
// digest renderer (shape, data minimization, D5 no-tracking over the
// RENDERED OUTPUT, HTML escaping).

import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { isoWeekKey, renderWeeklyDigest } from "../weekly-digest.mjs";
import { createCaptureTransport, createNullTransport, smtpConfigured, defaultTransport } from "../mailer.mjs";

describe("mailer seam (transport contract, no network)", () => {
  test("capture transport records the exact envelope and reports ok", async () => {
    const t = createCaptureTransport();
    const r = await t.send({ from: "f", to: "parent@example.com", subject: "s", text: "t", html: "<p>h</p>" });
    assert.deepEqual(r, { ok: true, messageId: null });
    assert.equal(t.sends.length, 1);
    assert.equal(t.sends[0].to, "parent@example.com");
    assert.ok(!("cc" in t.sends[0]) && !("bcc" in t.sends[0]), "the interface carries exactly one recipient");
  });

  test("null transport reports HONESTLY (ok:false — nothing was delivered, callers must not claim success)", async () => {
    const t = createNullTransport(undefined);
    const r = await t.send({ from: "f", to: "p@example.com", subject: "s", text: "t", html: "h" });
    assert.equal(r.ok, false);
    assert.ok(r.error);
    assert.equal(t.droppedCount, 1);
  });

  test("smtpConfigured reads SMTP_HOST; defaultTransport without it returns the null transport (nodemailer never loads)", async () => {
    assert.equal(smtpConfigured({}), false);
    assert.equal(smtpConfigured({ SMTP_HOST: "smtp.example.com" }), true);
    const t = await defaultTransport(undefined, {});
    const r = await t.send({ from: "f", to: "p@example.com", subject: "s", text: "t", html: "h" });
    assert.equal(r.ok, false, "unconfigured default is the honest null transport");
  });
});

describe("isoWeekKey (ISO-8601, Monday-anchored)", () => {
  // Known-good vectors verified against the ISO calendar.
  const cases = [
    ["2026-10-19T12:00:00.000Z", "2026-W43"], // plain mid-year Monday
    ["2026-10-23T00:30:00.000Z", "2026-W43"], // same week, later day
    ["2026-10-18T23:59:59.999Z", "2026-W42"], // Sunday just before
    ["2026-01-01T00:00:00.000Z", "2026-W01"], // Jan 1 is a Thursday -> W01 contains it
    ["2025-12-29T00:00:00.000Z", "2026-W01"], // ISO year is the NEXT calendar year
    ["2026-12-31T23:00:00.000Z", "2026-W53"], // 2026 is a LONG year (53 weeks)
    ["2027-01-03T23:59:59.999Z", "2026-W53"], // still 2026-W53 on a 2027 date
    ["2027-01-04T00:00:00.000Z", "2027-W01"], // the boundary instant
    ["2028-01-02T12:00:00.000Z", "2027-W52"], // Jan 1 2028 is Saturday -> carry-back
    ["2024-12-30T00:00:00.000Z", "2025-W01"], // leap-year neighbor: 2025 W01 Monday
    ["2024-02-29T12:00:00.000Z", "2024-W09"] // leap day itself
  ];
  for (const [instant, expected] of cases) {
    test(`${instant} -> ${expected}`, () => {
      assert.equal(isoWeekKey(new Date(instant).getTime()), expected);
    });
  }
});

describe("renderWeeklyDigest (pure renderer)", () => {
  const weekStartMs = new Date("2026-10-19T00:00:00.000Z").getTime(); // Monday, 2026-W43
  const activeChild = {
    nickname: "Aisha",
    attempts: 24,
    activeMinutes: 42.5,
    topicsFirstMastered: 3,
    cumulativeTopicsMastered: 37,
    unitsMasteredThisWeek: 1,
    silverKeys: 4,
    goldKeys: 1,
    streakDays: 6
  };
  const quietChild = {
    nickname: "Bilal",
    attempts: 0,
    activeMinutes: 0,
    topicsFirstMastered: 0,
    cumulativeTopicsMastered: 12,
    unitsMasteredThisWeek: 0,
    silverKeys: 1,
    goldKeys: 0,
    streakDays: 0
  };

  test("subject is stable and week-labeled; body carries every per-child stat", () => {
    const { subject, text, html } = renderWeeklyDigest({ weekStartMs, children: [activeChild, quietChild] });
    assert.equal(subject, "Balashikshana weekly summary - week of Oct 19, 2026");
    for (const content of [text, html]) {
      assert.match(content, /Oct 19, 2026 - Oct 25, 2026/);
      assert.match(content, /Aisha/);
      assert.match(content, /42\.5 minutes/);
      assert.match(content, /Topics completed: 3 \(37 mastered in total\)/);
      assert.match(content, /Units mastered this week: 1 \(Silver keys: 4, Gold keys: 1\)/);
      assert.match(content, /Practice streak: 6 days/);
      assert.match(content, /Bilal/);
      assert.match(content, /No practice recorded this week\./);
      assert.match(content, /parent portal settings/);
    }
  });

  test("D5: NO tracking pixels, beacons, images, links, or third-party embeds anywhere in the output", () => {
    const { subject, text, html } = renderWeeklyDigest({ weekStartMs, children: [activeChild] });
    for (const content of [subject, text, html]) {
      const lower = content.toLowerCase();
      assert.ok(!lower.includes("<img"), "no images");
      assert.ok(!lower.includes("<a "), "no anchor tags");
      assert.ok(!lower.includes("<iframe"), "no iframes");
      assert.ok(!lower.includes("http://"), "no http urls");
      assert.ok(!lower.includes("https://"), "no https urls");
      assert.ok(!lower.includes("track"), "no tracking vocabulary");
      assert.ok(!lower.includes("pixel"), "no pixel vocabulary");
      assert.ok(!lower.includes("beacon"), "no beacon vocabulary");
    }
  });

  test("nicknames are HTML-escaped (an email client is a rendering engine too)", () => {
    const hostile = { ...activeChild, nickname: `<script>alert("x")</script>` };
    const { html, text } = renderWeeklyDigest({ weekStartMs, children: [hostile] });
    assert.ok(!html.includes("<script>"), "raw markup must not survive");
    assert.ok(!html.includes('<h2><script>'), "no tag injection into headings");
    assert.ok(html.includes("&lt;script&gt;"), "escaped form present");
    // Plain text carries the raw nickname: text/plain cannot execute.
    assert.ok(text.includes("<script>"));
  });

  test("zero children renders a valid no-section email (defensive shape)", () => {
    const { subject, text, html } = renderWeeklyDigest({ weekStartMs, children: [] });
    assert.ok(subject.includes("Oct 19, 2026"));
    assert.match(text, /weekly learning summary/);
    assert.match(html, /<p>/);
  });
});
