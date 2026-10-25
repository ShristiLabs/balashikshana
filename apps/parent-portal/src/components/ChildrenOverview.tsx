// Children overview — one card per linked child: profile, streak, and
// unit-achievement counts (the issue's overview card: nickname, avatar,
// grade, streak, mastered units, Silver/Gold keys).

import { useEffect, useState } from "react";
import { api } from "../api";
import { errorText } from "../App";
import { gradeLabel } from "../format";
import type { PortalChildOverview } from "../types";

export function ChildrenOverview({
  token,
  onOpenChild,
  onUnauthorized
}: {
  token: string;
  onOpenChild: (studentId: string) => void;
  onUnauthorized: () => void;
}) {
  const [children, setChildren] = useState<PortalChildOverview[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .children(token)
      .then((res) => {
        if (!cancelled) setChildren(res.children);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err?.name === "UnauthorizedError") return onUnauthorized();
        setError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [token, onUnauthorized]);

  if (error) {
    return (
      <div className="error-banner" role="alert">
        {error}
      </div>
    );
  }
  if (children === null) return <p role="status">Loading your children...</p>;
  if (children.length === 0) {
    return (
      <div className="notice-banner" role="status">
        No children are linked to this account yet. Add a child from the mobile app's onboarding to see them here.
      </div>
    );
  }

  return (
    <main>
      <ul className="card-grid" style={{ listStyle: "none", padding: 0 }}>
        {children.map((child) => (
          <li key={child.studentId} className="card">
            <div className="section-heading-row">
              <h3>
                <span className="child-avatar" aria-hidden="true">
                  {child.avatar}
                </span>{" "}
                {child.nickname}
              </h3>
            </div>
            <div className="stat-row">
              <span>
                Grade: <strong>{gradeLabel(child.currentGrade)}</strong>
              </span>
              <span>
                Streak: <strong>{child.streakDays} day{child.streakDays === 1 ? "" : "s"}</strong>
              </span>
            </div>
            <div className="stat-row">
              <span>
                Units mastered: <strong>{child.unitsMastered}</strong>
              </span>
              <span title="Silver keys: units passed at the mastery gate">
                Silver keys: <strong>{child.silverKeys}</strong>
              </span>
              <span title="Gold keys: units that also passed the 14-hour verification">
                Gold keys: <strong>{child.goldKeys}</strong>
              </span>
            </div>
            <p>
              <button type="button" className="btn" onClick={() => onOpenChild(child.studentId)}>
                View {child.nickname}'s details
              </button>
            </p>
          </li>
        ))}
      </ul>
    </main>
  );
}
