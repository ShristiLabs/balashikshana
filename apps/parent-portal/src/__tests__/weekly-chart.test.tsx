// WeeklyChart component tests — the weekly table contract: one row per
// ISO week, honest zeroed weeks ("—" accuracy, 0 min), and readable
// minute bars.

import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { WeeklyChart } from "../components/WeeklyChart";
import type { WeeklyWeek } from "../types";

function week(overrides: Partial<WeeklyWeek>): WeeklyWeek {
  return {
    weekStartIso: "2026-10-19T00:00:00.000Z",
    weekStartMs: Date.UTC(2026, 9, 19),
    attempts: 10,
    correct: 9,
    accuracyPct: 90,
    activeMinutes: 25.5,
    topicsPracticed: 4,
    topicsFirstMastered: 2,
    cumulativeTopicsMastered: 6,
    ...overrides
  };
}

describe("WeeklyChart", () => {
  test("renders one row per week with the week-of heading", () => {
    render(
      <WeeklyChart
        series={[
          week({}),
          week({ weekStartIso: "2026-10-26T00:00:00.000Z", weekStartMs: Date.UTC(2026, 9, 26) })
        ]}
      />
    );
    const rows = screen.getAllByRole("row");
    expect(rows.length).toBe(3); // header + 2 weeks
  });

  test("zeroed weeks show 0 minutes and an em-dash accuracy, not 0%", () => {
    render(<WeeklyChart series={[week({ attempts: 0, correct: 0, accuracyPct: null, activeMinutes: 0, topicsPracticed: 0 })]} />);
    expect(screen.getByText("0 min")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  test("active minutes and accuracy appear per row", () => {
    render(<WeeklyChart series={[week({})]} />);
    expect(screen.getByText("25.5 min")).toBeInTheDocument();
    expect(screen.getByText("90%")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "25.5 minutes of practice" })).toBeInTheDocument();
  });
});
