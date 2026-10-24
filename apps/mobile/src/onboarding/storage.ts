/**
 * Onboarding persistence seams (issue #44).
 *
 * PURE module: interfaces plus the in-memory implementations used by the
 * vitest suite and by default fallbacks. The react-native bindings (expo
 * secure store, expo-sqlite) live in nativeStores.ts and are injected by
 * the screen layer - nothing under test imports a native module.
 *
 * Doctrine (issue #44 body): parent session tokens and child device tokens
 * live ONLY in the secure store - never plain AsyncStorage, never SQLite.
 * The SQLite-snapshot OnboardingSnapshot carries no secrets by type
 * contract (see types.ts); TokenStore is the ONLY seam through which a
 * token-shaped value can be persisted.
 */

import type { OnboardingSnapshot } from "./types";

/** String-only key/value contract for secure (encrypted) storage. */
export interface SecureKeyValue {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export const TOKEN_KEYS = {
  parentSession: "onboarding.parentSessionToken",
  pendingVerification: "onboarding.pendingVerificationToken",
  childDeviceSession: "onboarding.childDeviceSession",
  draftChildPin: "onboarding.draftChildPin",
  clientDeviceId: "install.clientDeviceId",
} as const;

export interface StoredChildDeviceSession {
  token: string;
  sessionId: string;
  studentId: string;
  deviceId: string;
  expiresAt: string;
}

function parseJson<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Token store: the secure-store adapter. Every credential the onboarding
 * flow touches goes through here - the snapshot store has no method that
 * could accept a token even by mistake.
 */
export class TokenStore {
  private readonly secure: SecureKeyValue;

  constructor(secure: SecureKeyValue) {
    this.secure = secure;
  }

  async getParentSessionToken(): Promise<string | null> {
    return this.secure.get(TOKEN_KEYS.parentSession);
  }

  async setParentSessionToken(token: string): Promise<void> {
    await this.secure.set(TOKEN_KEYS.parentSession, token);
  }

  async getPendingVerificationToken(): Promise<string | null> {
    return this.secure.get(TOKEN_KEYS.pendingVerification);
  }

  async setPendingVerificationToken(token: string): Promise<void> {
    await this.secure.set(TOKEN_KEYS.pendingVerification, token);
  }

  async clearPendingVerificationToken(): Promise<void> {
    await this.secure.delete(TOKEN_KEYS.pendingVerification);
  }

  async getChildDeviceSession(): Promise<StoredChildDeviceSession | null> {
    return parseJson<StoredChildDeviceSession>(
      await this.secure.get(TOKEN_KEYS.childDeviceSession),
    );
  }

  async setChildDeviceSession(session: StoredChildDeviceSession): Promise<void> {
    await this.secure.set(TOKEN_KEYS.childDeviceSession, JSON.stringify(session));
  }

  /** Draft child PIN lives in the secure store until the create call fires. */
  async getDraftChildPin(): Promise<string | null> {
    return this.secure.get(TOKEN_KEYS.draftChildPin);
  }

  async setDraftChildPin(pin: string): Promise<void> {
    await this.secure.set(TOKEN_KEYS.draftChildPin, pin);
  }

  async clearDraftChildPin(): Promise<void> {
    await this.secure.delete(TOKEN_KEYS.draftChildPin);
  }

  async getClientDeviceId(): Promise<string | null> {
    return this.secure.get(TOKEN_KEYS.clientDeviceId);
  }

  async setClientDeviceId(id: string): Promise<void> {
    await this.secure.set(TOKEN_KEYS.clientDeviceId, id);
  }

  async clearParentSessionToken(): Promise<void> {
    await this.secure.delete(TOKEN_KEYS.parentSession);
  }

  /** Full local credential wipe: logout / logout-all / switch parent. */
  async clearAllCredentials(): Promise<void> {
    await this.secure.delete(TOKEN_KEYS.parentSession);
    await this.secure.delete(TOKEN_KEYS.pendingVerification);
    await this.secure.delete(TOKEN_KEYS.childDeviceSession);
    await this.secure.delete(TOKEN_KEYS.draftChildPin);
  }
}

/** Snapshot persistence contract (SQLite-backed in the app, memory in tests). */
export interface OnboardingStore {
  load(): Promise<OnboardingSnapshot | null>;
  save(snapshot: OnboardingSnapshot): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Parse a persisted snapshot string. Returns null for corrupt JSON or an
 * unknown schemaVersion: a snapshot this build cannot faithfully read is
 * discarded (fresh onboarding) rather than misread. Pure - the native
 * SQLite adapter delegates here so the guard is unit-tested.
 */
export function parseSnapshot(raw: string | null): OnboardingSnapshot | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as OnboardingSnapshot;
    if (parsed.schemaVersion !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function createMemoryOnboardingStore(): OnboardingStore & {
  snapshot: OnboardingSnapshot | null;
} {
  let current: OnboardingSnapshot | null = null;
  return {
    get snapshot() {
      return current;
    },
    async load() {
      return current;
    },
    async save(snapshot) {
      current = { ...snapshot };
    },
    async clear() {
      current = null;
    },
  };
}

/** In-memory secure key/value for tests and storybook-style previews. */
export function createMemorySecureKeyValue(): SecureKeyValue & { dump(): Map<string, string> } {
  const map = new Map<string, string>();
  return {
    async get(key) {
      return map.get(key) ?? null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
    dump() {
      return map;
    },
  };
}
