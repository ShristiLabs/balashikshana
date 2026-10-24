/**
 * Content-version comparison (issue #46).
 *
 * contentVersion is semver-like ("1.0.0") derived from the registry
 * version, so a plain numeric triple comparison is sufficient — no prerelease
 * semantics needed. Downgrades are refused by the service (a stale manifest
 * must never roll a device back).
 */

export function compareContentVersion(a: string, b: string): number {
  const pa = a.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const pb = b.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da < db ? -1 : 1;
  }
  return 0;
}

/** True when the offered version is strictly newer than the installed one. */
export function needsUpdate(installedVersion: string, offeredVersion: string): boolean {
  return compareContentVersion(offeredVersion, installedVersion) > 0;
}
