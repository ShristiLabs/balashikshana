/**
 * OnboardingFlow - the issue #44 driver. Owns:
 *
 * - bootstrap: native stores (SQLite snapshot + secure token store), the
 *   API client (EXPO_PUBLIC_API_BASE, dev default localhost:4000), and the
 *   per-install client device id.
 * - reconcile + resume: on mount, load the snapshot + tokens, query
 *   consent status and children (read-only GETs), and let planResume()
 *   pick the landing step. Kills at any step resume correctly; the state
 *   machine's in-flight markers make duplicate submissions impossible.
 * - the submission sequence: in-flight marker -> POST /api/parent/children
 *   -> persist studentId -> mint device session -> persist -> complete.
 * - token lifecycle: every authed call goes through authed(), which
 *   attempts exactly ONE sliding refresh on a 401 before routing back to
 *   the account step (passwords are never persisted, by doctrine).
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, Text, View } from "react-native";
import { useTheme } from "../design/theme";
import { spacing, typeRamp } from "../design/tokens";
import {
  ApiError,
  createApiClient,
  type ApiClient,
  type LoginResult,
  type SignupResult,
} from "./api";
import { mapPlatform, newClientDeviceId } from "./device";
import { adoptChild, applyEvent, ensureCompleted, initialSnapshot, planResume } from "./state";
import type { ChildProfileInfo, GradeId, OnboardingSnapshot, OnboardingStep } from "./types";
import { createNativeDependencies } from "./nativeStores";
import { TokenStore, type OnboardingStore } from "./storage";
import { AccountStep } from "./steps/AccountStep";
import { AddChildStep } from "./steps/AddChildStep";
import { CompleteStep } from "./steps/CompleteStep";
import { ConsentStep } from "./steps/ConsentStep";
import { GateStep } from "./steps/GateStep";
import { GradeStep } from "./steps/GradeStep";
import { VerifyEmailStep } from "./steps/VerifyEmailStep";

const API_BASE = process.env.EXPO_PUBLIC_API_BASE ?? "http://localhost:4000";

interface FlowDependencies {
  api: ApiClient;
  tokens: TokenStore;
  store: OnboardingStore;
  platform: "ios" | "android" | "web";
}

function newestChild(children: ChildProfileInfo[]): ChildProfileInfo | null {
  if (children.length === 0) return null;
  return children[children.length - 1] ?? null;
}

export function OnboardingFlow() {
  const { colors } = useTheme();
  const [ready, setReady] = useState(false);
  const [api, setApi] = useState<ApiClient | null>(null);
  const [snapshot, setSnapshot] = useState<OnboardingSnapshot | null>(null);
  const [step, setStep] = useState<OnboardingStep>("gate");
  const [bootError, setBootError] = useState<string | null>(null);
  const [devToken, setDevToken] = useState<string | null>(null);
  const [reconsent, setReconsent] = useState(false);
  const [mintError, setMintError] = useState<ApiError | null>(null);
  const snapshotRef = useRef<OnboardingSnapshot | null>(null);
  const depsRef = useRef<FlowDependencies | null>(null);
  const submittingRef = useRef(false);

  const setSnapshotBoth = useCallback((next: OnboardingSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  const persist = useCallback(
    async (next: OnboardingSnapshot) => {
      setSnapshotBoth(next);
      await depsRef.current?.store.save(next);
    },
    [setSnapshotBoth],
  );

  // Fire-and-forget transition persistence (UI steps; the mutation
  // sequence awaits persist() itself where ordering is load-bearing).
  const applyAndPersist = useCallback(
    (event: Parameters<typeof applyEvent>[1]) => {
      const current = snapshotRef.current;
      if (!current) return;
      void persist(applyEvent(current, event, Date.now()));
    },
    [persist],
  );

  // --- Bootstrap + reconcile --------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const native = await createNativeDependencies();
        const tokens = new TokenStore(native.secure);
        const api = createApiClient({ baseUrl: API_BASE });
        depsRef.current = {
          api,
          tokens,
          store: native.onboardingStore,
          platform: mapPlatform(Platform.OS),
        };

        let clientDeviceId = await tokens.getClientDeviceId();
        if (!clientDeviceId) {
          clientDeviceId = newClientDeviceId();
          await tokens.setClientDeviceId(clientDeviceId);
        }

        const loaded = await native.onboardingStore.load();
        const snap = loaded ?? initialSnapshot(Date.now());
        const parentToken = await tokens.getParentSessionToken();
        const childSession = await tokens.getChildDeviceSession();

        let consentStatus = null;
        let children: ChildProfileInfo[] | null = null;
        if (parentToken) {
          try {
            consentStatus = await api.consentStatus(parentToken);
            children = (await api.listChildren(parentToken)).children;
          } catch {
            // Offline or token dead at boot: nulls fall through and the
            // planner picks the most defensible step; every mutation
            // re-checks server state before writing.
          }
        }

        const plan = planResume({
          snapshot: loaded,
          parentToken,
          childDeviceSessionStored: childSession !== null,
          consentStatus,
          children,
        });

        let landing = snap;
        if (plan.adoptedChild) landing = adoptChild(snap, plan.adoptedChild, Date.now());
        if (plan.step === "complete") {
          // Reviewer HIGH fix: a complete landing must carry completedAt or
          // the journey guard stays locked; persist the ensured snapshot so
          // other surfaces (journey) read completion from the store.
          const ensured = ensureCompleted(landing, Date.now());
          if (ensured !== landing) {
            landing = ensured;
            await native.onboardingStore.save(landing);
          }
        }
        setReconsent(plan.needsConsent && consentStatus !== null);
        setDevToken(await tokens.getPendingVerificationToken());
        setSnapshotBoth(landing);
        setStep(plan.step);
        setApi(api);
        if (!cancelled) setReady(true);
      } catch (err) {
        if (!cancelled) setBootError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [setSnapshotBoth]);

  // --- Session wrapper: one sliding-refresh retry on 401 ------------------------
  const authed = useCallback(async <T,>(fn: (token: string) => Promise<T>): Promise<T> => {
    const flowDeps = depsRef.current;
    if (!flowDeps) throw new ApiError("unknown", "Not ready");
    const token = await flowDeps.tokens.getParentSessionToken();
    if (!token) {
      setStep("account");
      throw new ApiError("unauthorized", "No parent session");
    }
    try {
      return await fn(token);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        try {
          const rotated = await flowDeps.api.refresh(token);
          await flowDeps.tokens.setParentSessionToken(rotated.token);
          return await fn(rotated.token);
        } catch {
          // Refresh window closed or token revoked: only the PARENT token
          // dies; the child device token is an independent credential.
          await flowDeps.tokens.clearParentSessionToken();
          setStep("account");
          throw err instanceof ApiError ? err : new ApiError("unknown", "Session expired");
        }
      }
      throw err;
    }
  }, []);

  // --- Step handlers ------------------------------------------------------------

  const handleSignedUp = useCallback(
    async (result: SignupResult) => {
      const flowDeps = depsRef.current;
      if (!flowDeps) return;
      if (result.verificationToken) {
        await flowDeps.tokens.setPendingVerificationToken(result.verificationToken);
        setDevToken(result.verificationToken);
      }
      const next = applyEvent(
        snapshotRef.current ?? initialSnapshot(Date.now()),
        {
          type: "account-ready",
          parentId: result.parentId,
          email: result.email,
          emailVerified: false,
        },
        Date.now(),
      );
      await persist(next);
      setStep(next.step);
    },
    [persist],
  );

  const handleLoggedIn = useCallback(
    async (result: LoginResult) => {
      const flowDeps = depsRef.current;
      if (!flowDeps) return;
      await flowDeps.tokens.setParentSessionToken(result.token);
      await flowDeps.tokens.clearPendingVerificationToken();
      setDevToken(null);

      let consentStatus = null;
      let children: ChildProfileInfo[] | null = null;
      try {
        consentStatus = await flowDeps.api.consentStatus(result.token);
        children = (await flowDeps.api.listChildren(result.token)).children;
      } catch {
        // Offline: planner routes onward; mutations re-check server-side.
      }

      let next = applyEvent(
        snapshotRef.current ?? initialSnapshot(Date.now()),
        {
          type: "account-ready",
          parentId: result.parent.parentId,
          email: result.parent.email,
          emailVerified: result.parent.emailVerified,
        },
        Date.now(),
      );
      if (result.parent.emailVerified && consentStatus?.consentCurrent) {
        next = applyEvent(next, { type: "email-verified" }, Date.now());
        next = applyEvent(
          next,
          { type: "consent-captured", policyVersion: consentStatus.currentPolicyVersion ?? "" },
          Date.now(),
        );
      }
      const existing = children ? newestChild(children) : null;
      if (existing && !next.studentId) next = adoptChild(next, existing, Date.now());

      const plan = planResume({
        snapshot: next,
        parentToken: result.token,
        childDeviceSessionStored: (await flowDeps.tokens.getChildDeviceSession()) !== null,
        consentStatus,
        children,
      });
      if (plan.adoptedChild) next = adoptChild(next, plan.adoptedChild, Date.now());
      if (plan.step === "complete") next = ensureCompleted(next, Date.now());
      setReconsent(consentStatus !== null && !consentStatus.consentCurrent);
      await persist(next);
      setStep(plan.step);
    },
    [persist],
  );

  const handleVerified = useCallback(async () => {
    const flowDeps = depsRef.current;
    if (!flowDeps) return;
    await flowDeps.tokens.clearPendingVerificationToken();
    setDevToken(null);
    const next = applyEvent(
      snapshotRef.current ?? initialSnapshot(Date.now()),
      { type: "email-verified" },
      Date.now(),
    );
    await persist(next);
    setStep("consent");
  }, [persist]);

  const handleAcceptConsent = useCallback(
    async (policyVersion: string) => {
      await authed(async (token) => {
        const flowDeps = depsRef.current!;
        const result = await flowDeps.api.captureConsent(token, policyVersion);
        const next = applyEvent(
          snapshotRef.current ?? initialSnapshot(Date.now()),
          { type: "consent-captured", policyVersion: result.policyVersion },
          Date.now(),
        );
        setReconsent(false);
        await persist(next);
        setStep("add-child");
      });
    },
    [authed, persist],
  );

  const handleDrafted = useCallback(
    async (nickname: string, avatar: string, pin: string) => {
      const flowDeps = depsRef.current;
      if (!flowDeps) return;
      // The PIN is a credential: secure store only, never the snapshot.
      await flowDeps.tokens.setDraftChildPin(pin);
      const next = applyEvent(
        snapshotRef.current ?? initialSnapshot(Date.now()),
        { type: "child-drafted", nickname, avatar },
        Date.now(),
      );
      await persist(next);
      setStep("grade");
    },
    [persist],
  );

  /**
   * The creation sequence (duplicate-safe by construction):
   * 1. Re-assert consent currency (the client keeps the #41 server
   *    invariant unexercised even under resume races).
   * 2. Persist the in-flight marker (a kill after this point => the next
   *    reconcile adopts the landed child or re-submits, never duplicates).
   * 3. POST /api/parent/children -> persist studentId immediately.
   * 4. Mint the child device session -> persist in the secure store.
   * 5. Complete.
   *
   * SEAM (#46): the content-pack download trigger chains after step 4.
   */
  const submitChild = useCallback(
    async (gradeId: GradeId) => {
      // Reviewer MEDIUM fix: one in-flight submission per session. A second
      // grade tap in the sub-render window must be a silent no-op, never a
      // second createChild POST (the in-flight marker only protects across
      // restarts).
      if (submittingRef.current) return;
      submittingRef.current = true;
      try {
        await authed(async (token) => {
          const flowDeps = depsRef.current!;
          const current = snapshotRef.current;
          if (!current) throw new ApiError("unknown", "No state");

          const status = await flowDeps.api.consentStatus(token);
          if (!status.consentCurrent) {
            setReconsent(true);
            setStep("consent");
            throw new ApiError("consent-required", "Consent must be recorded first");
          }

          // On a resumed in-flight submission the POST never landed (the
          // planner proved that via GET children), so the user's fresh grade
          // pick is authoritative; the marker contributes nickname/avatar.
          const inflight = current.childSubmissionInFlight;
          const draft = inflight ?? current.childDraft ?? { nickname: "Explorer", avatar: "" };
          const effectiveGrade: GradeId = gradeId;

          const pin = await flowDeps.tokens.getDraftChildPin();
          if (!pin || !/^[0-9]{4}$/.test(pin)) {
            setStep("add-child");
            throw new ApiError("validation", "Please set the learner PIN again");
          }

          // (2) Marker BEFORE the POST.
          const marked = applyEvent(
            current,
            { type: "child-submission-in-flight", gradeId: effectiveGrade },
            Date.now(),
          );
          await persist(marked);

          // (3) Create.
          const clientDeviceId = (await flowDeps.tokens.getClientDeviceId()) ?? newClientDeviceId();
          const created = await flowDeps.api.createChild(token, {
            nickname: draft.nickname,
            avatar: draft.avatar,
            pin,
            currentGrade: effectiveGrade,
            clientDeviceId,
            platform: flowDeps.platform,
          });
          const withChild = applyEvent(
            marked,
            { type: "child-created", studentId: created.studentId, gradeId: effectiveGrade },
            Date.now(),
          );
          await persist(withChild);
          await flowDeps.tokens.clearDraftChildPin();

          // (4) Device session (re-minted on resume if its response was
          // lost; a possibly-orphaned earlier session is revocable later
          // from the parent portal surface, #61).
          const session = await flowDeps.api.mintDeviceSession(
            token,
            created.studentId,
            clientDeviceId,
            flowDeps.platform,
          );
          await flowDeps.tokens.setChildDeviceSession({
            token: session.token,
            sessionId: session.sessionId,
            studentId: session.studentId,
            deviceId: session.deviceId,
            expiresAt: session.expiresAt,
          });

          // (5) Complete.
          const done = applyEvent(withChild, { type: "onboarding-completed" }, Date.now());
          await persist(done);
          setMintError(null);
          setStep("complete");
        });
      } finally {
        submittingRef.current = false;
      }
    },
    [authed, persist],
  );

  // Resume case: landing on complete with no stored device session (the
  // mint was interrupted or its response lost) -> re-mint, surfaced as a
  // retryable banner on the completion screen.
  const remintIfNeeded = useCallback(async () => {
    const flowDeps = depsRef.current;
    const current = snapshotRef.current;
    if (!flowDeps || !current?.studentId) return;
    if (await flowDeps.tokens.getChildDeviceSession()) return;
    try {
      await authed(async (token) => {
        const clientDeviceId = (await flowDeps.tokens.getClientDeviceId()) ?? newClientDeviceId();
        const session = await flowDeps.api.mintDeviceSession(
          token,
          current.studentId!,
          clientDeviceId,
          flowDeps.platform,
        );
        await flowDeps.tokens.setChildDeviceSession({
          token: session.token,
          sessionId: session.sessionId,
          studentId: session.studentId,
          deviceId: session.deviceId,
          expiresAt: session.expiresAt,
        });
        setMintError(null);
      });
    } catch (err) {
      setMintError(err instanceof ApiError ? err : new ApiError("unknown", "Mint failed"));
    }
  }, [authed]);

  useEffect(() => {
    if (ready && step === "complete") void remintIfNeeded();
  }, [ready, step, remintIfNeeded]);

  // --- Render -------------------------------------------------------------------

  if (bootError) {
    return (
      <View style={{ padding: spacing.xxl, gap: spacing.md }}>
        <Text style={{ ...typeRamp.h3, color: colors.text }}>Setup could not start</Text>
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>
          Local setup state could not be opened. Please restart the app and try again.
        </Text>
      </View>
    );
  }

  if (!ready || !snapshot || !api) {
    return (
      <View style={{ padding: spacing.xxl, alignItems: "center", gap: spacing.md }}>
        <ActivityIndicator color={colors.primary.fill} accessibilityLabel="Loading onboarding" />
        <Text style={{ ...typeRamp.bodyMuted, color: colors.textMuted }}>Loading setup...</Text>
      </View>
    );
  }

  const inflight = snapshot.childSubmissionInFlight;
  const shownNickname = inflight?.nickname ?? snapshot.childDraft?.nickname ?? "";
  const shownAvatar = inflight?.avatar ?? snapshot.childDraft?.avatar ?? "";

  switch (step) {
    case "gate":
      return <GateStep onPassed={() => applyAndPersist({ type: "gate-passed" })} />;
    case "account":
      return (
        <AccountStep
          api={api}
          initialEmail={snapshot.email}
          onSignedUp={handleSignedUp}
          onLoggedIn={handleLoggedIn}
        />
      );
    case "verify-email":
      return (
        <VerifyEmailStep
          api={api}
          email={snapshot.email ?? ""}
          devToken={devToken}
          onVerified={() => void handleVerified()}
          onBackToAccount={() => setStep("account")}
        />
      );
    case "consent":
      return <ConsentStep api={api} onAccept={handleAcceptConsent} isReconsent={reconsent} />;
    case "add-child":
      return (
        <AddChildStep
          initialNickname={shownNickname}
          initialAvatar={shownAvatar || undefined}
          onDrafted={(nickname, avatar, pin) => void handleDrafted(nickname, avatar, pin)}
        />
      );
    case "grade":
      return (
        <GradeStep
          childNickname={shownNickname || "your learner"}
          childAvatar={shownAvatar || ""}
          resumingSubmission={Boolean(inflight)}
          onGradeChosen={submitChild}
        />
      );
    case "complete":
      return (
        <CompleteStep
          childNickname={shownNickname || "your learner"}
          childAvatar={shownAvatar || ""}
          gradeId={snapshot.gradeId}
          mintError={mintError}
          onRetryMint={() => void remintIfNeeded()}
        />
      );
    default:
      return <GateStep onPassed={() => applyAndPersist({ type: "gate-passed" })} />;
  }
}
