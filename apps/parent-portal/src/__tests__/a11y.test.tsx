// Accessibility enforcement (issue #67): every portal view runs axe
// (via jest-axe — the established OSS wrapper, pinned axe-core engine)
// in the existing jsdom + testing-library suite, so the CI portal gate
// FAILS on any new WCAG violation. The canary test below plants known
// violations and proves the harness actually catches them — a green
// suite is only meaningful because the same engine demonstrably goes
// red on bad markup.

import { describe, expect, test, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import type { VitestAxeResults } from "./axe-helper";
import { api } from "../api";
import { App } from "../App";
import { ChildrenOverview } from "../components/ChildrenOverview";
import { ChildDetail } from "../components/ChildDetail";
import { SettingsForm } from "../components/SettingsForm";
import { EmailPreferences } from "../components/EmailPreferences";
import { QuadrantChart } from "../components/QuadrantChart";
import { WeeklyChart } from "../components/WeeklyChart";
import type {
  PortalChildrenResponse,
  PortalQuadrantResponse,
  PortalSettingsResponse,
  PortalWeeklyResponse,
} from "../types";


/** Stock-matcher assertion: empty violations, full report on failure. */
async function expectNoViolations(container: HTMLElement): Promise<void> {
  const results = (await axe(container)) as unknown as VitestAxeResults;
  expect(
    results.violations.map((v) => ({ id: v.id, impact: v.impact })),
    JSON.stringify(results.violations, null, 2),
  ).toEqual([]);
}

// ---------------------------------------------------------------------------
// Fixture data (wire shapes per src/types.ts, mirroring the OpenAPI
// baseline — realistic values so the rendered markup matches production).
// ---------------------------------------------------------------------------
const children: PortalChildrenResponse = {
  parentId: "par-1",
  children: [
    {
      studentId: "stu-1",
      nickname: "Asha",
      avatar: "fox",
      currentGrade: "grade-1",
      streakDays: 4,
      lastActiveAt: "2026-10-20T10:00:00.000Z",
      unitsStarted: 6,
      unitsMastered: 2,
      silverKeys: 1,
      goldKeys: 0,
    },
  ],
};

const quadrant: PortalQuadrantResponse = {
  studentId: "stu-1",
  generatedAt: "2026-10-20T10:00:00.000Z",
  topics: [
    {
      topicId: "K-M2/I",
      topicName: "Counting to 10",
      unitId: "K-M2",
      attempts: 12,
      correct: 10,
      accuracyPct: 83,
      medianSpeedSec: 6,
      targetSpeedSec: 8,
      quadrant: "fluent",
    },
    {
      topicId: "K-M3/E",
      topicName: "Shape match",
      unitId: "K-M3",
      attempts: 9,
      correct: 3,
      accuracyPct: 33,
      medianSpeedSec: null,
      targetSpeedSec: null,
      quadrant: "needs-review",
    },
  ],
};

const weekly: PortalWeeklyResponse = {
  studentId: "stu-1",
  weeks: 8,
  generatedAt: "2026-10-20T10:00:00.000Z",
  series: Array.from({ length: 8 }, (_, i) => ({
    weekStartIso: `2026-09-${String(7 * (i + 1)).padStart(2, "0")}`,
    weekStartMs: 1_750_000_000_000 + i * 604_800_000,
    attempts: 10 + i,
    correct: 8 + i,
    accuracyPct: 80,
    activeMinutes: 12 + i,
    topicsPracticed: 3,
    topicsFirstMastered: i % 2,
    cumulativeTopicsMastered: i,
  })),
};

const settings: PortalSettingsResponse = {
  studentId: "stu-1",
  settings: {
    dailyLimitMinutes: null,
    restrictedSubjects: [],
    gradeCeiling: null,
    remindersEnabled: false,
    reminderHour: 17,
    reminderMinute: 0,
  },
  updatedAt: null,
  usage: { dailyLimitMinutes: null, usedMinutesToday: 0, exceeded: false },
  serverTime: "2026-10-20T10:00:00.000Z",
};

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.spyOn(api, "children").mockResolvedValue(children);
  vi.spyOn(api, "quadrant").mockResolvedValue(quadrant);
  vi.spyOn(api, "weekly").mockResolvedValue(weekly);
  vi.spyOn(api, "settings").mockResolvedValue(settings);
  vi.spyOn(api, "notificationPreferences").mockResolvedValue({
    weeklyEmailEnabled: false,
    serverTime: "2026-10-20T10:00:00.000Z",
  });
});

describe("axe: portal views have no accessibility violations", () => {
  test("login view via the real App shell (skip link + login form)", async () => {
    // Render App itself, not a hand-copied fixture: the skip link and
    // notice banner live in App.tsx, and a duplicated fixture would
    // stay green if the real shell lost them. No stored session token
    // in jsdom -> App lands on the login view.
    const { container } = render(<App />);
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(skip).toHaveAttribute("href", "#main-heading");
    await expectNoViolations(container);
  });

  test("children overview (data table + child cards)", async () => {
    const { container } = render(
      <ChildrenOverview token="tok" onOpenChild={() => {}} onUnauthorized={() => {}} />,
    );
    await screen.findByText("Asha");
    await expectNoViolations(container);
  });

  test("child detail (charts + settings + email prefs + data rights)", async () => {
    const { container } = render(
      <ChildDetail
        token="tok"
        studentId="stu-1"
        onBack={() => {}}
        onUnauthorized={() => {}}
      />,
    );
    // Settings save button only renders once the Promise.all pass lands.
    await screen.findByRole("button", { name: "Save settings" }, { timeout: 4000 });
    await expectNoViolations(container);
  });

  test("settings form (labeled inputs + fieldset)", async () => {
    const { container } = render(
      <SettingsForm
        token="tok"
        studentId="stu-1"
        initial={settings}
        onSaved={() => {}}
        onUnauthorized={() => {}}
      />,
    );
    await expectNoViolations(container);
  });

  test("email preferences (toggle + status)", async () => {
    const { container } = render(
      <EmailPreferences token="tok" onUnauthorized={() => {}} />,
    );
    await screen.findByLabelText(/weekly summary email/i);
    await expectNoViolations(container);
  });

  test("quadrant chart (svg with accessible name)", async () => {
    const { container } = render(<QuadrantChart points={quadrant.topics} />);
    // Direct role query, not just axe: mutation testing during the #67
    // audit showed axe's default rules do NOT flag a chart svg that
    // loses role="img"/aria-label while sitting inside a
    // heading-labeled section — the section name masks the nameless
    // graphic. This query fails deterministically on that regression.
    expect(
      screen.getByRole("img", { name: /accuracy versus speed quadrant/i }),
    ).toBeInTheDocument();
    await expectNoViolations(container);
  });

  test("weekly chart (data table with caption)", async () => {
    const { container } = render(<WeeklyChart series={weekly.series} />);
    await expectNoViolations(container);
  });
});

describe("axe harness canary: the engine demonstrably catches violations", () => {
  // A green suite above is only trustworthy because the same engine
  // fails on planted violations: an unnamed image, a bare onclick div,
  // and an empty button. If this ever goes green, the enforcement is
  // vacuous — treat that as a CI fire alarm, not a pass.
  test("planted violations are reported", async () => {
    const { container } = render(
      <div>
        {/* alt intentionally MISSING: image-alt must fire (alt="" would
            be a correct decorative image, not a violation). */}
        {/* eslint-disable-next-line jsx-a11y/alt-text */}
        <img src="x.png" />
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
        <div onClick={() => {}}>not a button</div>
        {/* eslint-disable-next-line jsx-a11y/anchor-has-content, jsx-a11y/anchor-is-valid */}
        <a href="#" />
        <button type="button" aria-label="" />
      </div>,
    );
    const results = (await axe(container)) as unknown as VitestAxeResults;
    const ids = results.violations.map((v) => v.id);
    expect(ids).toContain("image-alt");
    expect(ids).toContain("button-name");
    expect(results.violations.length).toBeGreaterThanOrEqual(3);
  });
});
