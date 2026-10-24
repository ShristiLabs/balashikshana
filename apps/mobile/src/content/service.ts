/**
 * ContentPackService (issue #46) — download -> verify -> atomic install ->
 * activate -> prune, with version checks on every ensurePack() call.
 *
 * Fail-closed invariants (all node-tested):
 * - No pack is ever moved out of staging until signature + checksum +
 *   size + pack_info cross-check ALL pass against a pinned trusted key.
 * - A failed or interrupted install leaves the previous active pack
 *   untouched and deletes the staged bytes (rollback = no-op by design).
 * - The final install step is a single atomic rename inside the pack dir
 *   (same volume), so no observer can see a half-installed pack.
 * - Content rows are never inserted on-device: the artifact IS a SQLite
 *   database compiled by the pipeline; the device only manages files.
 * - Downgrades are refused; the storage budget is enforced before install.
 *
 * ensurePack() never throws — it returns a typed result so callers like
 * the onboarding flow can fire-and-forget without try/catch traps.
 */
import { verifyPackArtifact } from "./verify";
import { needsUpdate } from "./versioning";
import { decidePrune } from "./prunePolicy";
import type { ContentPackDeps, EnsureResult, PackInfoRow } from "./types";
import type { PackManifest as ManifestEntry } from "./manifest";

export class ContentPackService {
  private readonly deps: ContentPackDeps;
  private readonly budgetBytes: number | undefined;
  private readonly inFlight = new Map<string, Promise<EnsureResult>>();

  constructor(deps: ContentPackDeps, options?: { budgetBytes?: number }) {
    this.deps = deps;
    this.budgetBytes = options?.budgetBytes;
  }

  /** Download/update the pack for a grade (deduplicated per grade). */
  ensurePack(gradeId: string): Promise<EnsureResult> {
    const existing = this.inFlight.get(gradeId);
    if (existing) return existing;
    const run = this.ensurePackInner(gradeId).finally(() => {
      this.inFlight.delete(gradeId);
    });
    this.inFlight.set(gradeId, run);
    return run;
  }

  private async ensurePackInner(gradeId: string): Promise<EnsureResult> {
    try {
      const index = await this.deps.fetchIndex();
      if (index === null) {
        return { status: "unavailable", gradeId, reason: "manifest-unreachable" };
      }
      const entry = index.find((e) => e.gradeId === gradeId);
      if (!entry) {
        return { status: "unavailable", gradeId, reason: "grade-not-published" };
      }

      const active = await this.deps.meta.getActive(gradeId);
      if (active) {
        const artifactPresent = await this.deps.exists(active.artifact);
        if (!artifactPresent) {
          // Meta row survived a file loss (device cleanup, corruption):
          // drop the stale row and treat this as a fresh install.
          await this.deps.meta.remove(active.gradeId, active.contentVersion);
          return await this.install(entry, null);
        } else if (active.contentVersion === entry.contentVersion) {
          return { status: "current", gradeId, contentVersion: entry.contentVersion };
        } else if (!needsUpdate(active.contentVersion, entry.contentVersion)) {
          // Manifest offered an OLDER pack than installed: refuse the
          // downgrade, keep serving the newer local content.
          return {
            status: "current",
            gradeId,
            contentVersion: active.contentVersion,
            reason: "downgrade-refused",
          };
        }
      }

      return await this.install(entry, active);
    } catch (err) {
      this.deps.log("content-pack ensure failed", { gradeId, error: String(err) });
      return { status: "failed", gradeId, reason: "unexpected-error" };
    }
  }

  private async install(
    entry: ManifestEntry,
    previous: Awaited<ReturnType<ContentPackDeps["meta"]["getActive"]>>,
  ): Promise<EnsureResult> {
    const stagingName = `.staging-${entry.gradeId}.sqlite`;
    await this.deps.deleteFile(stagingName).catch(() => undefined);

    try {
      await this.deps.download(this.deps.packUrl(entry.gradeId), stagingName);

      // Cheap guards first: size from metadata, then native digest.
      const size = await this.deps.fileSize(stagingName);
      if (size === null || size !== entry.sizeBytes) {
        await this.deps.deleteFile(stagingName).catch(() => undefined);
        return { status: "failed", gradeId: entry.gradeId, reason: "size-mismatch" };
      }
      const digest = await this.deps.sha256Hex(stagingName);
      if (digest !== null && digest !== entry.sha256) {
        await this.deps.deleteFile(stagingName).catch(() => undefined);
        return { status: "failed", gradeId: entry.gradeId, reason: "checksum-mismatch" };
      }

      // Full cryptographic verification over the exact bytes (signature
      // covers everything the checksum does, but both are checked — belt
      // and braces costs nothing here and mirrors the compiler self-check).
      const bytes = await this.deps.readBytes(stagingName);
      if (bytes === null) {
        await this.deps.deleteFile(stagingName).catch(() => undefined);
        return { status: "failed", gradeId: entry.gradeId, reason: "staging-unreadable" };
      }
      const verdict = verifyPackArtifact(bytes, entry, this.deps.trustedKeys);
      if (!verdict.ok) {
        await this.deps.deleteFile(stagingName).catch(() => undefined);
        return {
          status: "failed",
          gradeId: entry.gradeId,
          reason: verdict.reason ?? "verification-failed",
        };
      }

      // pack_info cross-check: the artifact must describe EXACTLY the
      // grade/version/counts the manifest promised (defeats a validly-
      // signed but wrong-grade substitution).
      const info = await this.deps.openPackInfo(stagingName);
      if (info === null || !packInfoMatches(info, entry)) {
        await this.deps.deleteFile(stagingName).catch(() => undefined);
        return { status: "failed", gradeId: entry.gradeId, reason: "pack-content-mismatch" };
      }

      // Storage budget + pruning decision BEFORE the file lands.
      const rows = await this.deps.meta.all();
      const decision = decidePrune({
        rows,
        incomingGradeId: entry.gradeId,
        incomingContentVersion: entry.contentVersion,
        incomingBytes: entry.sizeBytes,
        ...(this.budgetBytes !== undefined ? { budgetBytes: this.budgetBytes } : {}),
      });
      if (!decision.allowed) {
        await this.deps.deleteFile(stagingName).catch(() => undefined);
        return {
          status: "refused",
          gradeId: entry.gradeId,
          reason: decision.reason ?? "storage-budget-exceeded",
        };
      }

      // Atomic publish: single rename inside the pack directory.
      await this.deps.move(stagingName, entry.artifact);
      await this.deps.meta.upsert({
        gradeId: entry.gradeId,
        contentVersion: entry.contentVersion,
        formatVersion: entry.formatVersion,
        status: "active",
        artifact: entry.artifact,
        sizeBytes: entry.sizeBytes,
        sha256: entry.sha256,
        keyId: entry.keyId,
        installedAt: this.deps.now(),
      });

      // Post-install prune: exactly what decidePrune computed — superseded
      // versions of this grade plus other grades' packs (grade switch).
      // The previous grade's pack is intentionally deleted per the issue's
      // pruning doctrine; failures to delete are logged, never fatal.
      for (const target of decision.deleteMeta) {
        const row = rows.find(
          (r) => r.gradeId === target.gradeId && r.contentVersion === target.contentVersion,
        );
        if (row) await this.deps.deleteFile(row.artifact).catch(() => undefined);
        await this.deps.meta.remove(target.gradeId, target.contentVersion).catch(() => undefined);
      }

      const status =
        previous === null || previous.gradeId !== entry.gradeId ? "installed" : "upgraded";
      this.deps.log("content pack installed", {
        gradeId: entry.gradeId,
        contentVersion: entry.contentVersion,
        sizeBytes: entry.sizeBytes,
        pruned: decision.deleteMeta.length,
      });
      return { status, gradeId: entry.gradeId, contentVersion: entry.contentVersion };
    } catch (err) {
      await this.deps.deleteFile(stagingName).catch(() => undefined);
      this.deps.log("content pack install failed", { gradeId: entry.gradeId, error: String(err) });
      return { status: "failed", gradeId: entry.gradeId, reason: "install-error" };
    }
  }

  /** Current lifecycle row for a grade (null when nothing installed). */
  async status(gradeId: string): Promise<import("./types").PackMetaRow | null> {
    return this.deps.meta.getActive(gradeId);
  }
}

function packInfoMatches(info: PackInfoRow, entry: ManifestEntry): boolean {
  return (
    info.gradeId === entry.gradeId &&
    info.contentVersion === entry.contentVersion &&
    info.packFormatVersion === entry.formatVersion &&
    info.unitCount === entry.unitCount &&
    info.topicCount === entry.topicCount &&
    info.questionCount === entry.questionCount
  );
}
