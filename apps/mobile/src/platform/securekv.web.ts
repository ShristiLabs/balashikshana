/**
 * Web secure key-value seam (issue #71): browser-storage-backed
 * implementation of the SecureKeyValue contract.
 *
 * HONEST LIMIT (documented, surfaced to review): browsers offer no
 * hardware-backed encrypted store equivalent to expo-secure-store (the
 * web platform has no Keychain/Keystore access; expo-secure-store's own
 * web build is an empty stub). Tokens and credentials are therefore
 * persisted as plain strings inside the app's IndexedDB origin
 * partition: device-local, origin-scoped, never transmitted anywhere
 * except the API's own authenticated calls, and wiped with site data.
 * That is a deliberate, documented weakening for the web edition only —
 * the same local-only data doctrine (no new data classes, no third
 * parties). data-flow-inventory carries the row.
 */
import type { SecureKeyValue } from "../onboarding/storage";
import { openKeyValueStore } from "./webStorage";

const STORE_NAME = "secure-kv";

async function store() {
  return openKeyValueStore(STORE_NAME);
}

export const secureKeyValue: SecureKeyValue = {
  async get(key) {
    const value = await (await store()).get(key);
    return typeof value === "string" ? value : null;
  },
  async set(key, value) {
    await (await store()).put(key, value);
  },
  async delete(key) {
    await (await store()).delete(key);
  },
};
