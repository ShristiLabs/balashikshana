/**
 * React-native sync bindings (issue #48).
 *
 * The ONLY module in the sync tree that imports native modules:
 * - connectivity: @react-native-community/netinfo
 * - credentials: the onboarding TokenStore's secure key-value seam
 * - transport: global fetch against EXPO_PUBLIC_API_BASE
 *
 * CONNECTIVITY DEPENDENCY DECISION (issue requirement: "evaluate adding
 * @react-native-community/netinfo OSS dep vs expo's connectivity APIs;
 * decide + document"): NETINFO WINS. Expo SDK 58 ships NO first-party
 * connectivity module — the legacy expo connectivity API was removed
 * years ago, and Expo's own documentation points at
 * @react-native-community/netinfo as the supported reachability API for
 * Expo (and React Native generally). It is MIT-licensed OSS, maintained
 * by the React Native community org, autolinks in Expo dev clients, and
 * ships inside Expo Go. No alternative exists at parity; adding it is
 * the documented decision.
 *
 * TRIGGERS (battery doctrine — no polling): the SyncController fires on
 * (a) app foreground transitions (AppState), (b) connectivity regain
 * (netinfo event), and (c) post-practice nudges (notifyActivity,
 * debounced). Background fetch is deliberately NOT used in #48 — the
 * drain is resumable at every foregrounding, and quiet-device battery
 * beats minutes-to-latency for a kindergartner's progress upload.
 */

import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import { AppState } from "react-native";
import { SyncEngine } from "./syncEngine";
import {
  SyncTransportError,
  type Connectivity,
  type SyncCredentialSource,
  type SyncProgressResponse,
  type SyncTransport,
  type SyncUploadResponse,
  type SyncAttemptWire,
  type SessionOutcomeWire,
} from "./types";

const API_BASE = (process.env.EXPO_PUBLIC_API_BASE ?? "http://localhost:4000").replace(/\/+$/, "");

function stateOnline(state: NetInfoState): boolean {
  return Boolean(state.isConnected && state.isInternetReachable !== false);
}

export function createNetInfoConnectivity(): Connectivity {
  return {
    async isOnline() {
      return stateOnline(await NetInfo.fetch());
    },
    subscribe(listener) {
      return NetInfo.addEventListener((state) => {
        listener(stateOnline(state));
      });
    },
  };
}

export interface HttpSyncTransportOptions {
  baseUrl?: string;
  credentials: SyncCredentialSource;
  clientPacks?(): Promise<{ gradeId: string; contentVersion: string }[]>;
  fetchImpl?: typeof fetch;
}

export class HttpSyncTransport implements SyncTransport {
  private readonly baseUrl: string;
  private readonly credentials: SyncCredentialSource;
  private readonly clientPacks?: () => Promise<{ gradeId: string; contentVersion: string }[]>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpSyncTransportOptions) {
    this.baseUrl = (options.baseUrl ?? API_BASE).replace(/\/+$/, "");
    this.credentials = options.credentials;
    this.clientPacks = options.clientPacks;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async requireToken(): Promise<string> {
    const session = await this.credentials.getChildDeviceSession();
    if (!session) {
      // No stored device session: nothing to sync with — fatal for this
      // run (the onboarding flow mints one; retrying without it is
      // pointless noise).
      throw new SyncTransportError("no child device session stored", 401);
    }
    return session.token;
  }

  async uploadAttempts(
    attempts: SyncAttemptWire[],
    outcomes?: SessionOutcomeWire[],
  ): Promise<SyncUploadResponse> {
    const token = await this.requireToken();
    const clientPacks = this.clientPacks ? await this.clientPacks() : undefined;
    // #56: hearts session outcomes ride the same request as an
    // ADDITIVE optional body field (pre-#56 servers ignore it).
    const body: Record<string, unknown> = { attempts };
    if (outcomes && outcomes.length > 0) body.sessionOutcomes = outcomes;
    if (clientPacks) body.clientPacks = clientPacks;
    const res = await this.fetchImpl(`${this.baseUrl}/api/sync/attempts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new SyncTransportError(`sync upload failed (${res.status})`, res.status);
    }
    return (await res.json()) as SyncUploadResponse;
  }

  async fetchProgress(): Promise<SyncProgressResponse> {
    const token = await this.requireToken();
    let packsQuery = "";
    if (this.clientPacks) {
      const packs = await this.clientPacks();
      if (packs.length > 0) {
        packsQuery = `?packs=${encodeURIComponent(packs.map((p) => `${p.gradeId}:${p.contentVersion}`).join(","))}`;
      }
    }
    const res = await this.fetchImpl(`${this.baseUrl}/api/sync/progress${packsQuery}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new SyncTransportError(`sync progress fetch failed (${res.status})`, res.status);
    }
    return (await res.json()) as SyncProgressResponse;
  }
}

/**
 * Battery-friendly trigger wiring: foreground + reconnect + debounced
 * post-practice nudges. One in-flight guard prevents overlap; a failed
 * run stops quietly (the next trigger retries with backoff inside the
 * engine's bounded attempts).
 */
export class SyncController {
  private readonly engine: SyncEngine;
  private readonly studentId: () => Promise<string | null>;
  private readonly debounceMs: number;
  private inFlight = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly unsubscribers: (() => void)[] = [];

  constructor(options: {
    engine: SyncEngine;
    connectivity: Connectivity;
    studentId: () => Promise<string | null>;
    debounceMs?: number;
  }) {
    this.engine = options.engine;
    this.studentId = options.studentId;
    this.debounceMs = options.debounceMs ?? 30000;

    this.unsubscribers.push(
      options.connectivity.subscribe((online) => {
        if (online) void this.kick();
      }),
    );

    const appStateSub = AppState.addEventListener("change", (state) => {
      if (state === "active") void this.kick();
    });
    this.unsubscribers.push(() => appStateSub.remove());
  }

  /** Post-practice nudge (debounced — bursty session ends coalesce). */
  notifyActivity(): void {
    this.schedule();
  }

  /** Immediate trigger (reconnect/foreground path). */
  async kick(): Promise<void> {
    if (this.disposed || this.inFlight) return;
    this.clearTimer();
    await this.run();
  }

  private schedule(): void {
    if (this.disposed) return;
    this.clearTimer();
    this.timer = setTimeout(() => {
      void this.run();
    }, this.debounceMs);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private async run(): Promise<void> {
    if (this.inFlight || this.disposed) return;
    this.inFlight = true;
    try {
      const studentId = await this.studentId();
      if (studentId) await this.engine.sync(studentId);
    } finally {
      this.inFlight = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    for (const unsub of this.unsubscribers) unsub();
    this.unsubscribers.length = 0;
  }
}
