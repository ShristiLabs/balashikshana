// Child detail — the per-child analytics + controls surface: quadrant,
// weekly time/progress, and settings. Data loads in one pass; the three
// sections are cards with real headings so the page outline (and any
// screen reader's heading navigation) reflects the structure.

import { useEffect, useState } from "react";
import { api } from "../api";
import { errorText } from "../App";
import { QuadrantChart } from "./QuadrantChart";
import { WeeklyChart } from "./WeeklyChart";
import { SettingsForm } from "./SettingsForm";
import type { PortalQuadrantResponse, PortalSettingsResponse, PortalWeeklyResponse } from "../types";

export function ChildDetail({
  token,
  studentId,
  onBack,
  onUnauthorized
}: {
  token: string;
  studentId: string;
  onBack: () => void;
  onUnauthorized: () => void;
}) {
  const [quadrant, setQuadrant] = useState<PortalQuadrantResponse | null>(null);
  const [weekly, setWeekly] = useState<PortalWeeklyResponse | null>(null);
  const [settings, setSettings] = useState<PortalSettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setQuadrant(null);
    setWeekly(null);
    setSettings(null);
    setError(null);
    Promise.all([api.quadrant(token, studentId), api.weekly(token, studentId), api.settings(token, studentId)])
      .then(([q, w, s]) => {
        if (cancelled) return;
        setQuadrant(q);
        setWeekly(w);
        setSettings(s);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err?.name === "UnauthorizedError") return onUnauthorized();
        setError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [token, studentId, onUnauthorized]);

  return (
    <main>
      <p>
        <button type="button" className="btn btn-secondary" onClick={onBack}>
          Back to all children
        </button>
      </p>
      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : null}

      <section className="card" aria-labelledby="quadrant-heading">
        <h2 id="quadrant-heading">Accuracy vs speed</h2>
        <p className="quad-note">
          Each dot is one skill topic. The vertical split is the 80% pass line; the horizontal split is the unit's
          target speed — top-right means fast and accurate.
        </p>
        {quadrant === null && !error ? <p role="status">Loading...</p> : null}
        {quadrant ? <QuadrantChart points={quadrant.topics} /> : null}
      </section>

      <section className="card" aria-labelledby="weekly-heading">
        <h2 id="weekly-heading">Weekly time and progress</h2>
        <p className="quad-note">Active practice time per week (UTC weeks), with accuracy and newly mastered topics.</p>
        {weekly === null && !error ? <p role="status">Loading...</p> : null}
        {weekly ? <WeeklyChart series={weekly.series} /> : null}
      </section>

      <section className="card" aria-labelledby="settings-heading">
        <h2 id="settings-heading">Settings</h2>
        {settings === null && !error ? <p role="status">Loading...</p> : null}
        {settings ? (
          <SettingsForm
            token={token}
            studentId={studentId}
            initial={settings}
            onSaved={setSettings}
            onUnauthorized={onUnauthorized}
          />
        ) : null}
      </section>
    </main>
  );
}
