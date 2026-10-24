/**
 * Exponential backoff with full jitter (issue #48).
 *
 * AWS "Exponential Backoff and Jitter" full-jitter variant: delay =
 * random(0, min(cap, base * 2^attempt)). Full jitter (rather than
 * equal-jitter) spreads retried batches maximally after a server blip
 * and is the standard choice for client-driven retry loops. Pure
 * functions; the RNG is injected for deterministic tests.
 */

export function computeBackoffDelay(
  attempt: number,
  options?: { baseMs?: number; maxMs?: number; random?: () => number },
): number {
  const baseMs = options?.baseMs ?? 1000;
  const maxMs = options?.maxMs ?? 60000;
  const random = options?.random ?? Math.random;
  const exponential = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(random() * exponential);
}

/** Upper bound of the delay distribution (test assertion helper). */
export function backoffUpperBound(
  attempt: number,
  options?: { baseMs?: number; maxMs?: number },
): number {
  const baseMs = options?.baseMs ?? 1000;
  const maxMs = options?.maxMs ?? 60000;
  return Math.min(maxMs, baseMs * 2 ** attempt);
}
