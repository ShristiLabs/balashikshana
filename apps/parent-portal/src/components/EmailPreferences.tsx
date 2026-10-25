// Email preferences — the parent-level weekly summary toggle (issue
// #63). Sits on the children overview because it is account-level, not
// per-child (unlike the per-child reminder settings). The toggle saves
// IMMEDIATELY on change: the digest job reads the flag when it selects
// recipients, so the next scheduled run is already bound by the new
// value — no "save" button to forget.

import { useEffect, useState } from "react";
import type { ChangeEvent } from "react";
import { api } from "../api";
import { errorText } from "../App";

export function EmailPreferences({ token, onUnauthorized }: { token: string; onUnauthorized: () => void }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .notificationPreferences(token)
      .then((res) => {
        if (!cancelled) setEnabled(res.weeklyEmailEnabled);
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

  function onToggle(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.checked;
    setEnabled(next);
    setError(null);
    setStatus(null);
    setBusy(true);
    api
      .putNotificationPreferences(token, next)
      .then((res) => {
        setEnabled(res.weeklyEmailEnabled);
        setStatus(res.weeklyEmailEnabled ? "Weekly summary emails are on." : "Weekly summary emails are off. You will not receive the next one.");
      })
      .catch((err) => {
        if (err?.name === "UnauthorizedError") return onUnauthorized();
        setError(errorText(err));
        // Re-read so the checkbox reflects the server's truth, not the
        // failed optimistic flip.
        api
          .notificationPreferences(token)
          .then((res) => setEnabled(res.weeklyEmailEnabled))
          .catch(() => setEnabled(null));
      })
      .finally(() => setBusy(false));
  }

  return (
    <section className="card" aria-labelledby="email-prefs-heading">
      <h3 id="email-prefs-heading">Email preferences</h3>
      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : null}
      {enabled === null && !error ? <p role="status">Loading your email preferences...</p> : null}
      {enabled !== null ? (
        <>
          <p>Receive a weekly summary email of each child's practice, progress, and streaks. Sent to your verified email address only.</p>
          <label style={{ display: "inline-flex", alignItems: "center", gap: "0.5rem" }}>
            <input type="checkbox" checked={enabled} onChange={onToggle} disabled={busy} />
            Weekly summary email {enabled ? "on" : "off"}
          </label>
          {status ? (
            <p role="status" style={{ marginTop: "0.5rem" }}>
              {status}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
