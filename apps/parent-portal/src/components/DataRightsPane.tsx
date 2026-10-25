// Data & privacy pane (issue #62) — the parent's COPPA self-serve surface
// for one child: download the complete JSON export, and delete the
// child's data behind TWO independent confirmation gates:
//
// 1. The account password (re-authentication — the server verifies it
//    against the stored hash; the bearer token alone can never delete).
// 2. A press-and-hold button (3 seconds) so a single tap or click can
//    never fire the destructive call — the same COPPA-gate norm as the
//    app's parental gates. Keyboard users hold Space or Enter; pointer
//    users press and hold. Releasing early cancels.
//
// The consequence copy is explicit and plain-language: what is deleted
// (every class of the child's learning data — permanent), and what is
// retained (proof of the parent's consent and a record that a deletion
// happened — the COPPA record-keeping obligation), so the parent makes
// the decision on the facts.

import { useEffect, useRef, useState } from "react";
import { api, ApiError, isUnauthorizedError } from "../api";
import { errorText } from "../App";

const HOLD_MS_DEFAULT = 3000;

export function DataRightsPane({
  token,
  studentId,
  nickname,
  onDeleted,
  onUnauthorized,
  holdMs
}: {
  token: string;
  studentId: string;
  nickname: string;
  onDeleted: () => void;
  onUnauthorized: () => void;
  /** Hold duration; overridable so tests drive the gate deterministically. */
  holdMs?: number;
}) {
  const effectiveHoldMs = holdMs ?? HOLD_MS_DEFAULT;
  const [password, setPassword] = useState("");
  const [holdPct, setHoldPct] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletedDone, setDeletedDone] = useState(false);

  const holdTimer = useRef<number | null>(null);
  const holdTick = useRef<number | null>(null);
  const holdStart = useRef<number>(0);
  const completed = useRef(false);

  useEffect(() => {
    return () => {
      // StrictMode double-mounts in dev; never leave timers running.
      if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
      if (holdTick.current !== null) window.clearInterval(holdTick.current);
    };
  }, []);

  function cancelHold() {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    if (holdTick.current !== null) window.clearInterval(holdTick.current);
    holdTimer.current = null;
    holdTick.current = null;
    setHoldPct(0);
  }

  // Note on the gate's event set: EVERY path that ends a sustained press
  // must cancel — pointerup, pointerleave, POINTERCANCEL (the browser
  // takes the gesture back for scrolling: fires with NO pointerup), the
  // long-press context menu, keyup, and blur. touch-action:none on the
  // button keeps scroll takeover from starting in the first place; the
  // cancel handlers are the belt to that braces (reviewer finding: a
  // pointercancel left the hold running to completion on touch).

  async function executeDeletion() {
    if (completed.current) return;
    completed.current = true;
    cancelHold();
    setDeleting(true);
    setError(null);
    setInfo(null);
    try {
      const summary = await api.deleteChild(token, studentId, password);
      setPassword("");
      setInfo(
        `${nickname}'s data has been deleted. Reference ${summary.auditId} (kept as the record of this deletion).`
      );
      setDeletedDone(true);
      // Leave the (now gone) child detail view after the parent reads the
      // confirmation.
      window.setTimeout(() => onDeleted(), 1500);
    } catch (err) {
      completed.current = false;
      if (isUnauthorizedError(err)) return onUnauthorized();
      setError(err instanceof ApiError ? err.message : errorText(err));
    } finally {
      setDeleting(false);
    }
  }

  function startHold() {
    if (deleting || deletedDone || holdTimer.current !== null) return;
    setError(null);
    if (password.trim().length < 12) {
      setError("Enter your account password first (at least 12 characters).");
      return;
    }
    holdStart.current = Date.now();
    holdTick.current = window.setInterval(() => {
      setHoldPct(Math.min(100, ((Date.now() - holdStart.current) / effectiveHoldMs) * 100));
    }, 50);
    holdTimer.current = window.setTimeout(() => {
      holdTimer.current = null;
      if (holdTick.current !== null) window.clearInterval(holdTick.current);
      holdTick.current = null;
      setHoldPct(100);
      void executeDeletion();
    }, effectiveHoldMs);
  }

  async function onDownload() {
    setDownloading(true);
    setError(null);
    setInfo(null);
    try {
      const blob = await api.exportChildData(token, studentId);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `balashikshana-data-export-${studentId}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setInfo(`Downloaded ${nickname}'s data as a JSON file.`);
    } catch (err) {
      if (isUnauthorizedError(err)) return onUnauthorized();
      setError(err instanceof ApiError ? err.message : errorText(err));
    } finally {
      setDownloading(false);
    }
  }

  const holdLabel = deleting
    ? "Deleting..."
    : holdPct > 0
      ? "Keep holding to confirm deletion..."
      : `Hold for ${Math.round(effectiveHoldMs / 1000)} seconds to delete ${nickname}'s data`;

  return (
    <section className="card" aria-labelledby="data-rights-heading">
      <h2 id="data-rights-heading">Data and privacy</h2>

      {error ? (
        <div className="error-banner" role="alert">
          {error}
        </div>
      ) : null}
      {info ? (
        <div className="notice-banner" role="status">
          {info}
        </div>
      ) : null}

      <h3>Download my child's data</h3>
      <p className="quad-note">
        A single JSON file with everything we hold for {nickname}: profile, every recorded answer,
        progress, sessions, gamification, placement records, your consent records, and your portal
        settings for this child.
      </p>
      <button type="button" className="btn btn-secondary" onClick={onDownload} disabled={downloading || deletedDone}>
        {downloading ? "Preparing download..." : "Download my child's data"}
      </button>

      <h3>Delete my child's data</h3>
      <p className="quad-note">
        This permanently deletes {nickname}'s profile and every class of their learning data:
        answers, progress, sessions, rewards, and placement records. It cannot be undone. Two
        things are kept, as children's-privacy law requires: proof that you, the parent, agreed to
        this child's use of the app, and a record that this deletion happened. Neither contains
        your child's profile or answers.
      </p>
      {deletedDone ? (
        <p role="status">This child's data has been deleted.</p>
      ) : (
        <>
          <label className="field" htmlFor="delete-password" style={{ maxWidth: "16rem" }}>
            <span>Your account password</span>
            <input
              id="delete-password"
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={deleting}
            />
          </label>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(holdPct)}
            aria-label="Deletion confirmation progress"
            style={{
              border: "1px solid var(--color-line)",
              borderRadius: "6px",
              height: "1.25rem",
              marginTop: "0.75rem",
              maxWidth: "24rem",
              overflow: "hidden"
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${holdPct}%`,
                background: "var(--color-coral-ink)",
                transition: "width 50ms linear"
              }}
            />
          </div>
          <button
            type="button"
            className="btn btn-danger"
            aria-label={holdLabel}
            disabled={deleting}
            style={{ touchAction: "none" }}
            onPointerDown={(e) => {
              // Only the primary button/pointer starts the gate; a
              // right-button or pen-eraser hold must never arm deletion.
              // Real browsers ALWAYS define e.button on pointer events;
              // the null check only tolerates synthetic events that omit
              // it (test harness artifact), never a non-primary press.
              if (e.button != null && e.button !== 0) return;
              e.preventDefault();
              startHold();
            }}
            onPointerUp={cancelHold}
            onPointerLeave={cancelHold}
            onPointerCancel={cancelHold}
            onContextMenu={cancelHold}
            onKeyDown={(e) => {
              if ((e.key === " " || e.key === "Enter") && !e.repeat) {
                e.preventDefault();
                startHold();
              }
            }}
            onKeyUp={cancelHold}
            onBlur={cancelHold}
          >
            {holdLabel}
          </button>
        </>
      )}
    </section>
  );
}
