/**
 * Content-pack format constants (issue #46).
 *
 * Versioning contract:
 * - PACK_FORMAT_VERSION bumps when the manifest/index envelope changes in a
 *   way old clients cannot parse. Devices refuse entries with an unknown
 *   formatVersion (fail closed).
 * - PACK_SCHEMA_VERSION is stamped into each pack's PRAGMA user_version and
 *   describes the SQLite table layout inside the artifact. #47's reader
 *   branches on it for on-device migrations.
 * - contentVersion itself comes from the registry (`version` field), so
 *   curriculum edits bump pack content without touching either constant.
 */

export const PACK_FORMAT_VERSION = 1;
export const PACK_INDEX_FORMAT_VERSION = 1;
export const PACK_SCHEMA_VERSION = 1;

/** SQLite application_id so pack files are identifiable on disk. */
export const PACK_APPLICATION_ID = 0x42a1_46c6; // "BA" + pack magic

/** Fixed page size so VACUUM output is byte-deterministic. */
export const PACK_PAGE_SIZE = 4096;

/** Canonical artifact naming (server routes and the device store rely on it). */
export function packArtifactName(gradeId, contentVersion) {
  return `pack-${gradeId}-v${contentVersion}.sqlite`;
}

export const GRADE_IDS = ["pre-k", "kindergarten", "grade-1", "grade-2", "grade-3"];
