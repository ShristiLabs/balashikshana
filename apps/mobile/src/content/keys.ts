/**
 * Pinned Ed25519 public-key registry (issue #46).
 *
 * The private halves live ONLY in the signing environment (gitignored
 * tools/content-pipeline/keys/*.key); devices pin the public halves here.
 *
 * Trust doctrine (fail closed):
 * - Development builds (__DEV__) trust the dev-local key so the dev loop
 *   can compile + sign + install packs locally.
 * - Production builds trust ONLY the release key — which is deliberately
 *   NOT pinned yet. Until release engineering provisions it (M6 store
 *   submissions), a production build trusts no keys and therefore refuses
 *   to install ANY pack. That is the correct failure mode: an empty trust
 *   list must never fall back to the dev key (anyone can regenerate the
 *   dev keypair, so trusting it in prod would defeat signing entirely).
 *
 * To provision the release key: generate a keypair outside the repo
 * (content-pipeline `keys` command), pin the public hex in RELEASE_KEY
 * below, and keep the private half in the signing environment only.
 */

export interface TrustedKey {
  keyId: string;
  /** Raw 32-byte Ed25519 public key, hex. */
  publicKeyHex: string;
}

export const DEV_SIGNING_KEY: TrustedKey = {
  keyId: "dev-local",
  publicKeyHex: "414cf1c4acaf06b1b018681bd3df9c69e390d35b1f672eafb5fb909356c28c18",
};

/** Release key slot — intentionally empty until M6 provisioning. */
export const RELEASE_KEY: TrustedKey | null = null;

export function trustedKeysForEnvironment(isDev: boolean): Map<string, string> {
  const keys: TrustedKey[] = [];
  if (isDev) keys.push(DEV_SIGNING_KEY);
  if (RELEASE_KEY !== null) keys.push(RELEASE_KEY);
  return new Map(keys.map((k) => [k.keyId, k.publicKeyHex]));
}

/**
 * Content-trust mode for a build (#71 web export).
 *
 * Dev/staging deployments serve packs signed with the dev-local key, but
 * a web export is a PRODUCTION bundle (__DEV__ === false) — without this
 * switch those builds would trust no keys and refuse every pack, which
 * is the correct fail-closed default for release engineering but makes
 * the dev/staging serving surfaces (issue AC) impossible to run.
 *
 * EXPO_PUBLIC_CONTENT_TRUST_DEV=true is baked at EXPORT time, ONLY for
 * dev/staging builds whose packs are dev-signed by construction.
 * Production builds never set it and keep the full doctrine: trust only
 * the (future) release key; an empty trust list installs nothing.
 */
export function contentTrustIsDev(runtimeDev: boolean): boolean {
  return runtimeDev || process.env.EXPO_PUBLIC_CONTENT_TRUST_DEV === "true";
}
