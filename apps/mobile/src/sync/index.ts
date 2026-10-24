/**
 * Sync module barrel (issue #48). Pure contracts + engine — RN-free,
 * node-testable. nativeSync.ts (netinfo + transport + controller) stays
 * OUT of the barrel per the content/practice module precedent.
 */
export { SyncEngine } from "./syncEngine";
export { computeBackoffDelay, backoffUpperBound } from "./backoff";
export { SyncTransportError, FATAL_STATUS_CODES } from "./types";
export type {
  SyncAttemptWire,
  AttemptLogRow,
  SyncUploadStats,
  PackVersionSignal,
  SnapshotUnitRow,
  SnapshotTopicRow,
  ProgressSnapshot,
  SyncUploadResponse,
  SyncProgressResponse,
  SyncOutcome,
  SyncRunResult,
  SyncStorage,
  SyncCredentialSource,
  SyncTransport,
  Connectivity,
  SyncLogEvent,
  SyncLogger,
  SyncDeps,
} from "./types";
