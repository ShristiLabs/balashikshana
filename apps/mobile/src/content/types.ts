/**
 * Content-pack service types (issue #46).
 *
 * Doctrine (repo pattern): every module under src/content stays
 * node-testable EXCEPT nativeContent.ts — the service consumes injected
 * seams for networking, files, SQLite, and pack reading, mirroring the
 * onboarding/audio DI pattern.
 */

/** One manifest entry from GET /api/content/packs (canonical compiler output). */
export interface PackManifestEntry {
  formatVersion: number;
  gradeId: string;
  gradeName: string;
  contentVersion: string;
  registryVersion: string;
  artifact: string;
  sizeBytes: number;
  sha256: string;
  keyId: string;
  signature: string;
  unitCount: number;
  topicCount: number;
  questionCount: number;
}

/** pack_info row read from inside a pack artifact. */
export interface PackInfoRow {
  packFormatVersion: number;
  packSchemaVersion: number;
  gradeId: string;
  gradeName: string;
  contentVersion: string;
  registryVersion: string;
  unitCount: number;
  topicCount: number;
  questionCount: number;
}

/** Lifecycle row in the on-device content DB (balashikshana_content.db). */
export interface PackMetaRow {
  gradeId: string;
  contentVersion: string;
  formatVersion: number;
  status: "active";
  artifact: string;
  sizeBytes: number;
  sha256: string;
  keyId: string;
  installedAt: number;
}

export type EnsureStatus =
  "current" | "installed" | "upgraded" | "unavailable" | "refused" | "failed";

export interface EnsureResult {
  status: EnsureStatus;
  gradeId: string;
  contentVersion?: string;
  reason?: string;
}

/** Injected filesystem/DB/network seams (nativeContent.ts implements them). */
export interface ContentPackDeps {
  fetchIndex(): Promise<PackManifestEntry[] | null>;
  download(url: string, fileName: string): Promise<void>;
  fileSize(fileName: string): Promise<number | null>;
  sha256Hex(fileName: string): Promise<string | null>;
  readBytes(fileName: string): Promise<Uint8Array | null>;
  move(fromFileName: string, toFileName: string): Promise<void>;
  deleteFile(fileName: string): Promise<void>;
  exists(fileName: string): Promise<boolean>;
  listArtifacts(): Promise<string[]>;
  openPackInfo(fileName: string): Promise<PackInfoRow | null>;
  meta: {
    getActive(gradeId: string): Promise<PackMetaRow | null>;
    upsert(row: PackMetaRow): Promise<void>;
    all(): Promise<PackMetaRow[]>;
    remove(gradeId: string, contentVersion: string): Promise<void>;
  };
  trustedKeys: Map<string, string>;
  packUrl(gradeId: string): string;
  now(): number;
  log(message: string, extra?: Record<string, unknown>): void;
}
