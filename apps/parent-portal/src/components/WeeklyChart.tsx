// Weekly time/progress view — an accessible table with inline activity
// bars (hand-rolled, same zero-dependency choice as the quadrant): one
// row per ISO week (Monday UTC), active minutes as a proportional bar,
// plus attempts, accuracy, and the mastered-topics curve. Zeroed weeks
// render as genuine zero rows ("—" accuracy) because the API zero-fills
// instead of erroring — parents see the quiet weeks honestly.

import { weekLabel } from "../format";
import type { WeeklyWeek } from "../types";

export function WeeklyChart({ series }: { series: WeeklyWeek[] }) {
  const maxMinutes = Math.max(1, ...series.map((w) => w.activeMinutes));
  return (
    <div>
      <table className="data-table">
        <caption className="visually-hidden">Weekly practice time and progress (ISO weeks, Monday UTC)</caption>
        <thead>
          <tr>
            <th scope="col">Week of</th>
            <th scope="col">Active time</th>
            <th scope="col">Attempts</th>
            <th scope="col">Accuracy</th>
            <th scope="col">Topics practiced</th>
            <th scope="col">New topics mastered</th>
            <th scope="col">Mastered so far</th>
          </tr>
        </thead>
        <tbody>
          {series.map((w) => (
            <tr key={w.weekStartIso}>
              <th scope="row">{weekLabel(w.weekStartIso)}</th>
              <td>
                <div
                  style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
                  role="img"
                  aria-label={`${w.activeMinutes} minutes of practice`}
                >
                  <span className="week-bar-track" aria-hidden="true">
                    <span
                      className="week-bar-fill"
                      style={{ display: "block", width: `${Math.round((w.activeMinutes / maxMinutes) * 100)}%` }}
                    />
                  </span>
                  <span>{w.activeMinutes} min</span>
                </div>
              </td>
              <td>{w.attempts}</td>
              <td>{w.accuracyPct === null ? "—" : `${w.accuracyPct}%`}</td>
              <td>{w.topicsPracticed}</td>
              <td>{w.topicsFirstMastered}</td>
              <td>{w.cumulativeTopicsMastered}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
