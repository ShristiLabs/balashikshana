/**
 * Legal footer (issue #68, COPPA legal pack): the versioned Privacy
 * Policy and Terms of Service, reachable from EVERY portal view —
 * including the login screen (pre-authentication reachability is the
 * COPPA good-practice posture; the documents are public by nature and
 * the endpoints need no token).
 *
 * The text renders in-app (a dialog), never as an external link. A
 * failed fetch shows an inline retry state; the footer itself never
 * disappears on error.
 */
import { useCallback, useState } from "react";
import { api, type LegalDocument } from "../api";

type DialogState =
  | { open: false }
  | { open: true; kind: LegalDocument["kind"]; status: "loading" }
  | { open: true; kind: LegalDocument["kind"]; status: "error" }
  | { open: true; kind: LegalDocument["kind"]; status: "ready"; doc: LegalDocument };

const TITLES: Record<LegalDocument["kind"], string> = {
  "privacy-policy": "Privacy Policy",
  "terms-of-service": "Terms of Service",
};

export function LegalFooter() {
  const [dialog, setDialog] = useState<DialogState>({ open: false });

  const open = useCallback((kind: LegalDocument["kind"]) => {
    setDialog({ open: true, kind, status: "loading" });
    api
      .legalDocument(kind)
      .then((doc) => setDialog({ open: true, kind, status: "ready", doc }))
      .catch(() => {
        // Public route; any failure (offline included) is a retryable
        // load failure — the footer itself never disappears.
        setDialog({ open: true, kind, status: "error" });
      });
  }, []);

  return (
    <footer className="app-footer">
      <button
        type="button"
        className="btn btn-link"
        onClick={() => open("privacy-policy")}
        aria-haspopup="dialog"
      >
        Privacy Policy
      </button>
      <button
        type="button"
        className="btn btn-link"
        onClick={() => open("terms-of-service")}
        aria-haspopup="dialog"
      >
        Terms of Service
      </button>

      {dialog.open ? (
        <div
          className="legal-dialog"
          role="dialog"
          aria-modal="false"
          aria-label={TITLES[dialog.kind]}
          data-testid={`legal-dialog-${dialog.kind}`}
        >
          <div className="card">
            <h2>{TITLES[dialog.kind]}</h2>
            {dialog.status === "loading" ? (
              <p role="status">Loading the {TITLES[dialog.kind].toLowerCase()}...</p>
            ) : dialog.status === "error" ? (
              <div>
                <p role="alert">Could not load the {TITLES[dialog.kind].toLowerCase()}.</p>
                <button type="button" className="btn btn-secondary" onClick={() => open(dialog.kind)}>
                  Try again
                </button>
              </div>
            ) : (
              <pre className="legal-text">{dialog.doc.body}</pre>
            )}
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => setDialog({ open: false })}
            >
              Close
            </button>
          </div>
        </div>
      ) : null}
    </footer>
  );
}
