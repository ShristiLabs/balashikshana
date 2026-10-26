// Portal shell. Views are plain state (no router dependency — the
// portal is three screens behind one login; a URL router would add a
// dependency and an auth-bypass surface for nothing). Every navigation
// is a real button; the main heading receives focus on view change so
// keyboard and screen-reader users land in the new view deliberately.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, UnauthorizedError } from "./api";
import { clearSessionToken, loadSessionToken, saveSessionToken } from "./auth";
import type { ParentPublic } from "./types";
import { LoginPage } from "./components/LoginPage";
import { ChildrenOverview } from "./components/ChildrenOverview";
import { ChildDetail } from "./components/ChildDetail";
import { LegalFooter } from "./components/LegalFooter";

type View = { page: "login" } | { page: "children" } | { page: "child"; studentId: string };

export function App() {
  const [token, setToken] = useState<string | null>(() => loadSessionToken());
  const [parent, setParent] = useState<ParentPublic | null>(null);
  const [view, setView] = useState<View>({ page: "login" });
  const [notice, setNotice] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // On boot with a stored token, try one silent refresh rotation: it
  // proves the session is live AND re-arms the 7-day TTL. Failure
  // simply lands on the login screen (no error noise).
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api
      .refresh(token)
      .then(({ token: rotated }) => {
        if (cancelled) return;
        saveSessionToken(rotated);
        setToken(rotated);
      })
      .catch(() => {
        if (cancelled) return;
        if (token) {
          // A refreshable-but-expired window or a revoked session: fall
          // back to trying the stored token itself once on real use;
          // simplest honest path is a clean logout.
          clearSessionToken();
          setToken(null);
        }
      });
    return () => {
      cancelled = true;
    };
    // Boot-time only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (view.page !== "login") headingRef.current?.focus();
  }, [view]);

  const onLoggedIn = useCallback((newToken: string, parentInfo: ParentPublic) => {
    saveSessionToken(newToken);
    setToken(newToken);
    setParent(parentInfo);
    setView({ page: "children" });
    setNotice(parentInfo.emailVerified ? null : "Your email is not verified yet. Verify it to manage consent and add children.");
  }, []);

  const onLoggedOut = useCallback(async () => {
    if (token) {
      try {
        await api.logout(token);
      } catch {
        // Server-side revocation is best-effort here; the local token
        // is dropped regardless.
      }
    }
    clearSessionToken();
    setToken(null);
    setParent(null);
    setView({ page: "login" });
    setNotice(null);
  }, [token]);

  const onUnauthorized = useCallback(() => {
    clearSessionToken();
    setToken(null);
    setParent(null);
    setView({ page: "login" });
    setNotice("Your session has expired. Please log in again.");
  }, []);

  if (!token || view.page === "login") {
    return (
      <>
        <a className="skip-link" href="#main-heading">
          Skip to content
        </a>
        {notice ? (
          <div className="notice-banner" role="status">
            {notice}
          </div>
        ) : null}
        <LoginPage onLoggedIn={onLoggedIn} />
        {/* Legal pack (#68): reachable pre-login too — public documents. */}
        <LegalFooter />
      </>
    );
  }

  return (
    <>
      <a className="skip-link" href="#main-heading">
        Skip to content
      </a>
      <header className="app-header">
        <h1 id="main-heading" className="app-title" tabIndex={-1} ref={headingRef}>
          {view.page === "child" ? "Child details" : "Your children"}
        </h1>
        <div>
          {parent ? <span style={{ marginRight: "1rem" }}>{parent.email}</span> : null}
          <button type="button" className="btn btn-secondary" onClick={onLoggedOut}>
            Log out
          </button>
        </div>
      </header>
      {notice ? (
        <div className="notice-banner" role="status">
          {notice}
        </div>
      ) : null}
      {view.page === "children" ? (
        <ChildrenOverview
          token={token}
          onOpenChild={(studentId) => setView({ page: "child", studentId })}
          onUnauthorized={onUnauthorized}
        />
      ) : null}
      {view.page === "child" ? (
        <ChildDetail
          token={token}
          studentId={view.studentId}
          onBack={() => setView({ page: "children" })}
          onUnauthorized={onUnauthorized}
        />
      ) : null}
      <LegalFooter />
    </>
  );
}

/** Shared error banner text for views (ApiError-aware). */
export function errorText(err: unknown): string {
  if (err instanceof UnauthorizedError) return err.message;
  if (err instanceof ApiError) return err.message;
  return "Something went wrong. Please try again.";
}
