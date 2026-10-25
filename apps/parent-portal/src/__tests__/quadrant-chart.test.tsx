// QuadrantChart component tests — rendering contract for the four
// labeled quadrants, dot placement math, the accessible data table,
// and the empty state.

import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { QuadrantChart } from "../components/QuadrantChart";
import type { QuadrantPoint } from "../types";

function point(overrides: Partial<QuadrantPoint>): QuadrantPoint {
  return {
    topicId: "K-M1-A",
    topicName: "Counting",
    unitId: "K-M1",
    subject: "math",
    attempts: 6,
    correct: 6,
    accuracyPct: 100,
    medianSpeedSec: 2,
    targetSpeedSec: 4.5,
    quadrant: "fluent",
    ...overrides
  };
}

describe("QuadrantChart", () => {
  test("renders the four quadrant corner labels", () => {
    render(<QuadrantChart points={[point({})]} />);
    // "Fluent mastery" appears in BOTH the legend and the corner label.
    expect(screen.getAllByText("Fluent mastery").length).toBe(2);
    expect(screen.getByText("Accurate, slower")).toBeInTheDocument();
    expect(screen.getByText("Rushing")).toBeInTheDocument();
    expect(screen.getByText("Needs review")).toBeInTheDocument();
  });

  test("renders one dot per plottable topic with a tooltip", () => {
    const { container } = render(
      <QuadrantChart
        points={[point({ topicId: "a" }), point({ topicId: "b", quadrant: "needs-review", accuracyPct: 40 })]}
      />
    );
    const dots = container.querySelectorAll("circle");
    expect(dots.length).toBe(2);
    expect(dots[0].querySelector("title")?.textContent).toContain("Counting");
  });

  test("points without a usable target speed are excluded from the plot but kept in the table", () => {
    const { container } = render(
      <QuadrantChart
        points={[point({ topicId: "ok" }), point({ topicId: "gray", targetSpeedSec: null, quadrant: null })]}
      />
    );
    expect(container.querySelectorAll("circle").length).toBe(1);
    expect(screen.getByText("Not classified")).toBeInTheDocument();
    expect(screen.getByText(/1 topic shown gray/)).toBeInTheDocument();
  });

  test("carries an accessible data table with per-topic numbers", () => {
    render(<QuadrantChart points={[point({ accuracyPct: 80 })]} />);
    const table = screen.getByRole("table");
    expect(table).toBeInTheDocument();
    expect(screen.getByText("80%")).toBeInTheDocument();
    expect(screen.getByText("2s")).toBeInTheDocument(); // median speed cell
    expect(screen.getByText("Fluent mastery (fast and accurate)")).toBeInTheDocument(); // reading column
  });

  test("empty points render the friendly empty state", () => {
    render(<QuadrantChart points={[]} />);
    expect(screen.getByText(/No practice recorded yet/)).toBeInTheDocument();
  });

  test("the SVG exposes a summarizing aria-label", () => {
    render(<QuadrantChart points={[point({}), point({ topicId: "x", quadrant: "needs-review", accuracyPct: 30 })]} />);
    const svg = screen.getByRole("img");
    expect(svg.getAttribute("aria-label")).toContain("2 skill topics");
    expect(svg.getAttribute("aria-label")).toContain("1 fluent");
    expect(svg.getAttribute("aria-label")).toContain("1 needing review");
  });
});
