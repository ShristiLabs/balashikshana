/**
 * Sync bootstrap (issue #48): mounts the background sync controller.
 *
 * Mounted once at the root layout (same fire-and-forget pattern as
 * ContentPackProvider and PracticeWarmup). If a child-device session is
 * stored (#44 onboarding), the controller wires the battery-friendly
 * triggers — app foregrounding, connectivity regain, debounced
 * post-practice nudges — to the SyncEngine's drain loop. No UI, no
 * blocking: a failure is swallowed (the next trigger retries with
 * backoff inside the engine).
 *
 * This component also places the sync module (and its
 * @react-native-community/netinfo dependency) into the app's production
 * entry graph — the dual-platform Hermes export asserts the sync module
 * bundles.
 */
import { useEffect } from "react";
import { TokenStore } from "../onboarding/storage";
import { secureKeyValue } from "../onboarding/nativeStores";
import { getNativePracticeDeps } from "../practice/nativePractice";
import { getPracticeEngine } from "../practice/PracticeWarmup";
import { SyncEngine } from "./syncEngine";
import { HttpSyncTransport, SyncController, createNetInfoConnectivity } from "./nativeSync";
import type { SyncStorage } from "./types";

export function SyncBootstrap(): null {
  useEffect(() => {
    const tokenStore = new TokenStore(secureKeyValue);
    const practiceDeps = getNativePracticeDeps();

    const engine = new SyncEngine({
      storage: practiceDeps.storage as SyncStorage,
      transport: new HttpSyncTransport({
        credentials: {
          async getChildDeviceSession() {
            return tokenStore.getChildDeviceSession();
          },
        },
      }),
      connectivity: createNetInfoConnectivity(),
      // Whole-session batching: defer any session the child is still
      // answering (the shared practice engine's live sessions).
      isActiveSession: (sessionId) => getPracticeEngine().activeSessionIds().includes(sessionId),
    });

    const controller = new SyncController({
      engine,
      connectivity: createNetInfoConnectivity(),
      studentId: async () => {
        const session = await tokenStore.getChildDeviceSession();
        return session?.studentId ?? null;
      },
    });

    // The practice runner (#50) will call notifyActivity() after each
    // session; the initial mount kick also drains any backlog from the
    // last offline period.
    void controller.kick();

    return () => {
      controller.dispose();
    };
  }, []);
  return null;
}
