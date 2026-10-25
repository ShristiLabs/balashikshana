// Accuracy-vs-speed quadrant chart — hand-rolled SVG (documented choice:
// a quadrant is positioned dots in a box; a charting library would add
// ~100KB+ of dependency for nothing the portal needs). Rendering contract
// mirrors the architecture doc sec 3: Accuracy % on the Y axis (split at
// the 80% pass line), median cognitive speed on the X axis (split at
// each topic's unit target speed, normalized so 1.0x target sits at the
// quadrant boundary), and the four labeled quadrants:
//   top-right green  — fluent mastery (fast and accurate)
//   top-left  yellow/gold — understands, needs speed practice
//   bottom-right orange — rushing / guessing
//   bottom-left  red/coral — needs concept review
// Accessibility: the SVG is role="img" with a summarizing label, every
// dot carries a native <title> tooltip, and a real data table rides
// along in a disclosure so screen-reader and keyboard users get the
// exact numbers.

import { QUADRANT_COLORS, QUADRANT_LABELS, subjectLabel } from "../format";
import type { QuadrantPoint } from "../types";

const W = 560;
const H = 400;
const PAD_L = 56;
const PAD_B = 44;
const PAD_T = 16;
const PAD_R = 16;
// X domain: median speed as a multiple of the topic's target speed,
// 0 .. 2x. Points beyond 2x clamp to the right edge (annotated).
const X_MAX_RATIO = 2;

export function QuadrantChart({ points }: { points: QuadrantPoint[] }) {
  const plotW = W - PAD_L - PAD_R;
  const plotH = H - PAD_T - PAD_B;
  const yFor = (acc: number) => PAD_T + plotH * (1 - Math.min(100, Math.max(0, acc)) / 100);
  const xFor = (ratio: number) => PAD_L + plotW * (Math.min(X_MAX_RATIO, Math.max(0, ratio)) / X_MAX_RATIO);

  const withPos = points.map((p) => {
    const ratio =
      p.medianSpeedSec !== null && p.targetSpeedSec && p.targetSpeedSec > 0 ? p.medianSpeedSec / p.targetSpeedSec : null;
    return { p, ratio, x: ratio === null ? null : xFor(ratio), y: p.accuracyPct === null ? null : yFor(p.accuracyPct) };
  });
  const plottable = withPos.filter(
    (w): w is { p: QuadrantPoint; ratio: number; x: number; y: number } => w.x !== null && w.y !== null
  );
  const unclassified = withPos.filter((w) => w.p.quadrant === null);

  const quadCounts = {
    fluent: points.filter((p) => p.quadrant === "fluent").length,
    "accurate-slow": points.filter((p) => p.quadrant === "accurate-slow").length,
    rushing: points.filter((p) => p.quadrant === "rushing").length,
    "needs-review": points.filter((p) => p.quadrant === "needs-review").length
  };

  if (points.length === 0) {
    return (
      <div className="notice-banner" role="status">
        No practice recorded yet. The quadrant fills in as your child practices.
      </div>
    );
  }

  return (
    <div>
      <div className="legend" aria-hidden="true">
        <span className="legend-item">
          <span className="swatch" style={{ background: QUADRANT_COLORS.fluent }} />
          Fluent mastery
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: QUADRANT_COLORS["accurate-slow"] }} />
          Accurate but slow
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: QUADRANT_COLORS.rushing }} />
          Rushing / guessing
        </span>
        <span className="legend-item">
          <span className="swatch" style={{ background: QUADRANT_COLORS["needs-review"] }} />
          Needs concept review
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        aria-label={`Accuracy versus speed quadrant for ${points.length} skill topics: ${quadCounts.fluent} fluent, ${quadCounts["accurate-slow"]} accurate but slow, ${quadCounts.rushing} rushing, ${quadCounts["needs-review"]} needing review.`}
        style={{ maxWidth: "100%", height: "auto" }}
      >
        {/* Quadrant tints */}
        <rect x={PAD_L} y={PAD_T} width={plotW / 2} height={plotH / 2} fill="#d7ffb8" opacity="0.45" />
        <rect x={PAD_L + plotW / 2} y={PAD_T} width={plotW / 2} height={plotH / 2} fill="#fff3c4" opacity="0.6" />
        <rect x={PAD_L} y={PAD_T + plotH / 2} width={plotW / 2} height={plotH / 2} fill="#ffe3e3" opacity="0.6" />
        <rect x={PAD_L + plotW / 2} y={PAD_T + plotH / 2} width={plotW / 2} height={plotH / 2} fill="#ffedd6" opacity="0.7" />
        {/* Axes */}
        <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={H - PAD_B} stroke="#5f5f5f" strokeWidth="2" />
        <line x1={PAD_L} y1={H - PAD_B} x2={W - PAD_R} y2={H - PAD_B} stroke="#5f5f5f" strokeWidth="2" />
        {/* Split lines: 80% accuracy and 1x target speed */}
        <line x1={PAD_L} y1={yFor(80)} x2={W - PAD_R} y2={yFor(80)} stroke="#8a8a8a" strokeDasharray="6 4" />
        <line x1={xFor(1)} y1={PAD_T} x2={xFor(1)} y2={H - PAD_B} stroke="#8a8a8a" strokeDasharray="6 4" />
        {/* Axis labels */}
        <text x={12} y={PAD_T + 10} fontSize="12" fill="#3c3c3c">
          Accuracy 100%
        </text>
        <text x={12} y={yFor(80) + 4} fontSize="12" fill="#3c3c3c">
          80% (pass line)
        </text>
        <text x={12} y={H - PAD_B} fontSize="12" fill="#3c3c3c">
          0%
        </text>
        <text x={xFor(1) - 6} y={H - PAD_B + 18} fontSize="12" fill="#3c3c3c" textAnchor="middle">
          target speed
        </text>
        <text x={W - PAD_R} y={H - PAD_B + 34} fontSize="12" fill="#3c3c3c" textAnchor="end">
          slower →
        </text>
        <text x={PAD_L + 4} y={H - PAD_B + 18} fontSize="12" fill="#3c3c3c">
          faster ← (median cognitive seconds vs the unit target)
        </text>
        {/* Corner labels */}
        <text x={PAD_L + 6} y={PAD_T + 14} fontSize="12" fontWeight="700" fill="#5c4500">
          Accurate, slower
        </text>
        <text x={W - PAD_R - 6} y={PAD_T + 14} fontSize="12" fontWeight="700" fill="#173a00" textAnchor="end">
          Fluent mastery
        </text>
        <text x={PAD_L + 6} y={H - PAD_B - 6} fontSize="12" fontWeight="700" fill="#7a0c0c">
          Needs review
        </text>
        <text x={W - PAD_R - 6} y={H - PAD_B - 6} fontSize="12" fontWeight="700" fill="#6b3f00" textAnchor="end">
          Rushing
        </text>
        {/* Topic dots */}
        {plottable.map(({ p, x, y }) => (
          <circle
            key={p.topicId}
            cx={x}
            cy={y}
            r={p.attempts >= 10 ? 7 : 5}
            fill={p.quadrant ? QUADRANT_COLORS[p.quadrant] : "#9e9e9e"}
            stroke="#1a1a1a"
            strokeWidth="0.75"
          >
            <title>
              {`${p.topicName ?? p.topicId}${p.subject ? ` (${subjectLabel(p.subject)})` : ""}: ${p.accuracyPct}% accuracy, median ${p.medianSpeedSec}s vs ${p.targetSpeedSec}s target, ${p.attempts} attempts${p.quadrant ? ` — ${QUADRANT_LABELS[p.quadrant]}` : ""}`}
            </title>
          </circle>
        ))}
      </svg>
      {unclassified.length > 0 ? (
        <p className="quad-note">
          {unclassified.length} topic{unclassified.length === 1 ? "" : "s"} shown gray: no usable target speed for the
          unit yet.
        </p>
      ) : null}
      <details className="data-details">
        <summary>Show the numbers (data table)</summary>
        <table className="data-table">
          <caption className="visually-hidden">Per-topic accuracy and median speed</caption>
          <thead>
            <tr>
              <th scope="col">Topic</th>
              <th scope="col">Subject</th>
              <th scope="col">Attempts</th>
              <th scope="col">Accuracy</th>
              <th scope="col">Median speed</th>
              <th scope="col">Target</th>
              <th scope="col">Reading</th>
            </tr>
          </thead>
          <tbody>
            {points.map((p) => (
              <tr key={p.topicId}>
                <th scope="row">{p.topicName ?? p.topicId}</th>
                <td>{p.subject ? subjectLabel(p.subject) : "—"}</td>
                <td>{p.attempts}</td>
                <td>{p.accuracyPct === null ? "—" : `${p.accuracyPct}%`}</td>
                <td>{p.medianSpeedSec === null ? "—" : `${p.medianSpeedSec}s`}</td>
                <td>{p.targetSpeedSec ? `${p.targetSpeedSec}s` : "—"}</td>
                <td>{p.quadrant ? QUADRANT_LABELS[p.quadrant] : "Not classified"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
