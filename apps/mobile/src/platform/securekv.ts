/**
 * Native secure key-value seam (issue #71): expo-secure-store, the
 * encrypted on-device store the onboarding flow mandates (never
 * AsyncStorage, never plain SQLite). The web twin lives in
 * securekv.web.ts; seam modules import "../platform/securekv" and
 * metro resolves per platform.
 */
import * as SecureStore from "expo-secure-store";
import type { SecureKeyValue } from "../onboarding/storage";

export const secureKeyValue: SecureKeyValue = {
  async get(key) {
    return SecureStore.getItemAsync(key);
  },
  async set(key, value) {
    await SecureStore.setItemAsync(key, value);
  },
  async delete(key) {
    await SecureStore.deleteItemAsync(key);
  },
};
