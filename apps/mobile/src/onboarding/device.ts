/**
 * Device identity for child creation and device-session minting
 * (issue #44). The server's devices table upserts on
 * (parent_id, client_device_id), so a stable per-install id keeps the
 * device row stable across mints.
 *
 * PURE module: randomness is injected (tests pass a deterministic rng);
 * the react-native Platform.OS value is supplied by the caller so this
 * file never imports react-native.
 */

import type { PlatformId } from "./types";

/** Map a react-native Platform.OS value to the server's platform enum. */
export function mapPlatform(os: string): PlatformId {
  switch (os) {
    case "ios":
      return "ios";
    case "android":
      return "android";
    default:
      return "web";
  }
}

/**
 * A fresh client device id (>= 8 chars per the API schema). The value is
 * opaque to the server; it is not a secret (it never authenticates
 * anything by itself) but it is persisted via the secure store so all
 * identity-ish values live in one seam.
 */
export function newClientDeviceId(rng: () => number = Math.random): string {
  const hex = Array.from({ length: 16 }, () => Math.floor(rng() * 16).toString(16)).join("");
  return `dev-app-${hex}`;
}
