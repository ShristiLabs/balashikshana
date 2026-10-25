// Login view — the ONLY entry to the portal. Parent email + password
// against the existing #40 parent-auth API (signup/password-reset live
// on the same API surface but the portal v1 links nowhere else; account
// creation flows through the mobile onboarding parental gate).

import { useState } from "react";
import type { FormEvent } from "react";
import { api, ApiError } from "../api";
import type { ParentPublic } from "../types";

export function LoginPage({ onLoggedIn }: { onLoggedIn: (token: string, parent: ParentPublic) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api.login(email.trim(), password);
      onLoggedIn(res.token, res.parent);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Login failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <section className="card login-card" aria-labelledby="login-heading">
        <h2 id="login-heading">Parent login</h2>
        <p>Sign in with your parent account to see how your children are doing.</p>
        <form onSubmit={onSubmit} noValidate>
          {error ? (
            <div className="error-banner" role="alert">
              {error}
            </div>
          ) : null}
          <label className="field">
            <span>Email</span>
            <input
              className="input"
              type="email"
              name="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              aria-invalid={error ? true : undefined}
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              className="input"
              type="password"
              name="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={error ? true : undefined}
            />
          </label>
          <button className="btn" type="submit" disabled={busy}>
            {busy ? "Signing in..." : "Sign in"}
          </button>
        </form>
      </section>
    </main>
  );
}
