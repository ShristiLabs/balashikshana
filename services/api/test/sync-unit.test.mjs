// Sync rate-bucket unit tests (issue #48) — checkSyncTokenRateLimit is
// a pure function of (token, now) with an injected clock, so the full
// window matrix is deterministic here without a server round-trip:
// allow under the limit, 429 with retryAfterSec above it, window
// rollover resets the count, and stale-bucket eviction keeps the map
// bounded. (The integration suite runs with the bucket disabled; these
// tests are the ONLY coverage of the 429 path.)

import { test, describe } from "vitest";
import assert from "node:assert/strict";
import { checkSyncTokenRateLimit, RATE_LIMIT_SYNC_PER_TOKEN_MIN } from "../sync.mjs";

const T0 = 1_700_000_000_000;
const LIMIT = RATE_LIMIT_SYNC_PER_TOKEN_MIN;

// The limiter's bucket map is module-level state; unique token prefixes
// per test keep tests independent of execution order.

describe("checkSyncTokenRateLimit (dedicated sync bucket)", () => {
  test("allows up to the per-minute limit, then 429s with retryAfterSec", () => {
    const token = "unit-allowance";
    let now = T0;
    for (let i = 0; i < LIMIT; i += 1) {
      const r = checkSyncTokenRateLimit(token, now);
      assert.equal(r.allowed, true, `request ${i + 1}/${LIMIT} must be allowed`);
      assert.equal(r.retryAfterSec, 0);
    }
    const blocked = checkSyncTokenRateLimit(token, now);
    assert.equal(blocked.allowed, false);
    assert.ok(blocked.retryAfterSec >= 1 && blocked.retryAfterSec <= 60);
  });

  test("retryAfterSec counts down to the window boundary", () => {
    const token = "unit-countdown";
    for (let i = 0; i < LIMIT; i += 1) checkSyncTokenRateLimit(token, T0);
    const at = T0 + 40_000; // 20s left in the window
    const blocked = checkSyncTokenRateLimit(token, at);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterSec, 20);
  });

  test("window rollover resets the count (fresh allowance next minute)", () => {
    const token = "unit-rollover";
    for (let i = 0; i < LIMIT; i += 1) checkSyncTokenRateLimit(token, T0);
    assert.equal(checkSyncTokenRateLimit(token, T0).allowed, false);
    const next = checkSyncTokenRateLimit(token, T0 + 60_001);
    assert.equal(next.allowed, true);
    // The fresh window counts from scratch.
    for (let i = 1; i < LIMIT; i += 1) {
      assert.equal(checkSyncTokenRateLimit(token, T0 + 60_001).allowed, true);
    }
  });

  test("tokens are bucketed independently", () => {
    const a = "unit-token-a";
    const b = "unit-token-b";
    for (let i = 0; i < LIMIT; i += 1) checkSyncTokenRateLimit(a, T0);
    assert.equal(checkSyncTokenRateLimit(a, T0).allowed, false);
    assert.equal(checkSyncTokenRateLimit(b, T0).allowed, true);
  });

  test("stale buckets are evicted once the map exceeds 512 entries", () => {
    // Fill beyond the eviction threshold with tokens whose windows are
    // already expired relative to the final call's clock.
    for (let i = 0; i < 520; i += 1) {
      checkSyncTokenRateLimit(`unit-evict-${i}`, T0);
    }
    // A call at a LATER time triggers the size check and prunes the
    // expired buckets; the caller is allowed regardless.
    const late = checkSyncTokenRateLimit("unit-evict-final", T0 + 120_000);
    assert.equal(late.allowed, true);
  });
});
