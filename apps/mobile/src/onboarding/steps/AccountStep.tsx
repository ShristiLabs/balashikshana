/**
 * Step 2 - parent account: signup or login against the M2 API
 * (POST /api/parents/signup | /api/parents/login).
 *
 * Error handling mirrors the server doctrine: login failures are a
 * uniform 401 (unknown email == wrong password); signup on an existing
 * email is a 409 that routes to login. Passwords are held in component
 * state only - never persisted (a kill here means re-entering it).
 */
import React, { useState } from "react";
import { View } from "react-native";
import { Button } from "../../design/primitives";
import { spacing } from "../../design/tokens";
import { ApiError, type ApiClient, type LoginResult, type SignupResult } from "../api";
import { ErrorBanner, Field, StepHeading, StepScroll } from "./shared";

export type AccountMode = "signup" | "login";

export interface AccountStepProps {
  api: ApiClient;
  initialEmail?: string;
  initialMode?: AccountMode;
  /** Signup succeeded; the flow stashes the dev-seam verification token. */
  onSignedUp: (result: SignupResult) => void;
  /** Login succeeded; the flow stores the session token in secure storage. */
  onLoggedIn: (result: LoginResult) => void;
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 12;

export function AccountStep({
  api,
  initialEmail = "",
  initialMode = "signup",
  onSignedUp,
  onLoggedIn,
}: AccountStepProps) {
  const [mode, setMode] = useState<AccountMode>(initialMode);
  const [email, setEmail] = useState(initialEmail);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    setFieldError(null);
    if (!EMAIL_SHAPE.test(email)) {
      setFieldError("Please enter a valid email address.");
      return;
    }
    if (password.length < MIN_PASSWORD) {
      setFieldError(`Passwords are at least ${MIN_PASSWORD} characters long.`);
      return;
    }
    setBusy(true);
    try {
      if (mode === "signup") {
        const result = await api.signup(email.trim().toLowerCase(), password);
        onSignedUp(result);
      } else {
        const result = await api.login(email.trim().toLowerCase(), password);
        onLoggedIn(result);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError("unknown", "Unexpected error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepScroll testID="onboarding.step.account">
      <StepHeading
        title={mode === "signup" ? "Create your parent account" : "Welcome back"}
        subtitle={
          mode === "signup"
            ? "Your email and a password of at least 12 characters. We verify the email before any consent is recorded."
            : "Sign in with the email and password you set up before."
        }
      />

      <ErrorBanner error={error} />

      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        autoComplete="email"
        inputMode="email"
        keyboardType="email-address"
        error={fieldError}
        testID="onboarding.account.email"
      />
      <Field
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        autoCapitalize="none"
        testID="onboarding.account.password"
      />

      <View style={{ gap: spacing.md, marginTop: spacing.md }}>
        <Button
          label={mode === "signup" ? "Create account" : "Log in"}
          onPress={() => void submit()}
          disabled={busy}
          accessibilityHint={
            mode === "signup" ? "Create the parent account" : "Sign in to the parent account"
          }
          testID="onboarding.account.submit"
        />
        <Button
          label={mode === "signup" ? "I already have an account" : "Create a new account"}
          variant="outline"
          onPress={() => {
            setMode(mode === "signup" ? "login" : "signup");
            setError(null);
            setFieldError(null);
          }}
          disabled={busy}
          testID="onboarding.account.toggle"
        />
      </View>
    </StepScroll>
  );
}
