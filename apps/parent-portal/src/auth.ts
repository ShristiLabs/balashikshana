// Portal token storage (issue #61 security decision, documented):
//
// The API's bearer doctrine is UNCHANGED — the portal receives the #40
// parent session token and presents it as `Authorization: Bearer ...`.
// The decision this module owns is WHERE the SPA keeps it:
//
// - in-memory + a sessionStorage mirror (chosen): the token survives a
//   page reload within the tab (the mirror) but NEVER persists to disk
//   across browser sessions, is unreachable from other origins, and an
//   XSS compromise can only read it inside the live tab it already
//   runs in — there is no durable credential to steal for later.
// - localStorage (rejected): disk-persistent for the full 7-day TTL; a
//   single XSS escalates into week-long account access.
// - cookies (rejected): the API has no cookie/CSRF surface, and adding
//   one would invent new auth semantics the issue does not ask for.
//
// Refresh strategy: the token IS the session (7d TTL, 30d sliding
// refresh window). On a 401 the app attempts ONE rotation via POST
// /api/parents/refresh (atomic revoke-and-reissue server-side); if that
// also fails, the session is over and the login screen returns. No
// silent retries.

const STORAGE_KEY = "balashi.portal.session";

let cached: string | null = null;

export function loadSessionToken(): string | null {
  if (cached !== null) return cached;
  try {
    cached = window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage unavailable (privacy modes) — in-memory only this run.
    cached = null;
  }
  return cached;
}

export function saveSessionToken(token: string): void {
  cached = token;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Same as above: degrade to in-memory.
  }
}

export function clearSessionToken(): void {
  cached = null;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing durable to clear.
  }
}
