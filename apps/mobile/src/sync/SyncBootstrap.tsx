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
 * #49 wiring: the transport now carries the clientPacks handshake —
 * every upload/progress fetch reports the device's ACTIVE pack rows
 * (pack_meta: grade + content version) so the server can flag stale
 * packs in packsOutdated (the journey's grade switcher surfaces it).
 *
 * The engine/controller singletons are exported so screen-level
 * consumers (the #49 journey map's mount-time hydration kick) share the
 * SAME instance and its in-flight guard instead of racing a second one.
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
import type { PackVersionSignal, SyncStorage } from "./types";

let controllerSingleton: SyncController | null = null;

/**
 * The shared sync controller (null before the bootstrap mounts or when
 * no child-device session exists). Callers fire-and-forget kick().
 */
export function getSyncController(): SyncController | null {
  return controllerSingleton;
}

let contentOutdatedListener: ((packs: PackVersionSignal[]) => void) | null = null;

/**
 * Subscribe to the server's packsOutdated handshake results (the #49
 * grade switcher marks stale grades). Returns an unsubscribe function.
 */
export function subscribeContentOutdated(
  listener: (packs: PackVersionSignal[]) => void,
): () => void {
  contentOutdatedListener = listener;
  return () => {
    if (contentOutdatedListener === listener) contentOutdatedListener = null;
  };
}

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
        // #49: the dormant handshake is live — report every ACTIVE pack
        // row so the server's snapshot flags outdated content.
        clientPacks: () => practiceDeps.storage.activePackVersions(),
      }),
      connectivity: createNetInfoConnectivity(),
      // Whole-session batching: defer any session the child is still
      // answering (the shared practice engine's live sessions).
      isActiveSession: (sessionId) => getPracticeEngine().activeSessionIds().includes(sessionId),
      // The #48 content handshake's UI bridge: the journey's grade
      // switcher subscribes (subscribeContentOutdated) and marks the
      // flagged grades stale.
      onContentOutdated: (packs) => contentOutdatedListener?.(packs),
    });

    const controller = new SyncController({
      engine,
      connectivity: createNetInfoConnectivity(),
      studentId: async () => {
        const session = await tokenStore.getChildDeviceSession();
        return session?.studentId ?? null;
      },
    });
    controllerSingleton = controller;

    // The practice runner (#50) will call notifyActivity() after each
    // session; the initial mount kick also drains any backlog from the
    // last offline period.
    void controller.kick();

    return () => {
      controller.dispose();
      if (controllerSingleton === controller) controllerSingleton = null;
    };
  }, []);
  return null;
}
