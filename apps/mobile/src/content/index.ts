/**
 * Content-pack module barrel (issue #46). Exposes the service surface for
 * #47 (offline practice core) and the onboarding trigger; the RN bindings
 * stay behind getContentPackService in nativeContent.ts.
 */
export { ContentPackService } from "./service";
export { CONTENT_STORAGE_BUDGET_BYTES, decidePrune } from "./prunePolicy";
export { compareContentVersion, needsUpdate } from "./versioning";
export { verifyPackArtifact, base64Decode, bytesToHex, hexToBytes } from "./verify";
export {
  parseManifestEntry,
  parseManifestIndex,
  PACK_FORMAT_VERSION,
  GRADE_ID_RE,
} from "./manifest";
export { trustedKeysForEnvironment, DEV_SIGNING_KEY, RELEASE_KEY } from "./keys";
export { CONTENT_DB_MIGRATIONS, CONTENT_DB_NAME } from "./schema";
export type { PackManifest } from "./manifest";
export type {
  ContentPackDeps,
  EnsureResult,
  EnsureStatus,
  PackInfoRow,
  PackMetaRow,
} from "./types";
