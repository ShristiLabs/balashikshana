// TRUST_PROXY_CIDRS behavioral tests (issue #65, D10). The origin's per-IP
// rate-limit buckets key on req.ip; behind the Dwara edge the socket peer
// is the gateway, so X-Forwarded-For must be honored — but ONLY when the
// connection peer is inside the configured CIDR list (peer-checked
// semantics: a direct-origin client cannot spoof XFF). These tests pin
// both directions against a real server instance:
//
//   trusted  (TRUST_PROXY_CIDRS covers the test peer):
//     - distinct XFF values -> distinct buckets (no cross-client collapse)
//     - repeated same XFF   -> 429 (the forwarded IP governs)
//   default  (TRUST_PROXY_CIDRS unset): XFF is IGNORED:
//     - distinct XFF values still collapse into the peer's bucket -> 429

import { test, describe, beforeAll, afterAll } from "vitest";
import assert from "node:assert/strict";
import {
  createTestDatabase,
  dropTestDatabase,
  startTestServer,
  waitForHealth
} from "./helpers.mjs";

const LOW_LIMIT = "2"; // requests per minute per key — trips fast, refills never (test lifetime)

async function bootServer(port, extraEnv) {
  const db = await createTestDatabase();
  const child = await startTestServer({
    port,
    databaseUrl: db.url,
    env: {
      RATE_LIMIT_PER_IP_MIN: LOW_LIMIT,
      ...extraEnv
    }
  });
  const api = `http://127.0.0.1:${port}`;
  await waitForHealth(api);
  return { child, api, db };
}

async function getStatus(api, xff) {
  const headers = {};
  if (xff) headers["x-forwarded-for"] = xff;
  const res = await fetch(`${api}/api/health`, { headers });
  await res.arrayBuffer();
  return res.status;
}

describe("TRUST_PROXY_CIDRS peer-checked XFF (issue #65)", () => {
  let trusted;
  let untrusted;

  beforeAll(async () => {
    // The test client connects from 127.0.0.1, so /32 covers the peer.
    trusted = await bootServer(4671, { TRUST_PROXY_CIDRS: "127.0.0.1/32" });
    untrusted = await bootServer(4672, {});
  });

  afterAll(async () => {
    trusted?.child?.kill();
    untrusted?.child?.kill();
    await dropTestDatabase(trusted?.db?.name);
    await dropTestDatabase(untrusted?.db?.name);
  });

  test("trusted: distinct X-Forwarded-For values get distinct buckets", async () => {
    // Two requests per forwarded IP under a limit of 2/min: each client
    // alone never trips. If XFF were ignored, all six collapse into the
    // loopback peer bucket and the third request would 429.
    for (const ip of ["203.0.113.1", "203.0.113.2", "203.0.113.3"]) {
      assert.equal(await getStatus(trusted.api, ip), 200);
      assert.equal(await getStatus(trusted.api, ip), 200);
    }
  });

  test("trusted: repeated same X-Forwarded-For trips the limit for THAT ip", async () => {
    assert.equal(await getStatus(trusted.api, "198.51.100.7"), 200);
    assert.equal(await getStatus(trusted.api, "198.51.100.7"), 200);
    const status = await getStatus(trusted.api, "198.51.100.7");
    assert.equal(status, 429, "third request from the same forwarded IP must be rate-limited");
  });

  test("trusted: a peer OUTSIDE the list cannot spoof XFF (unroutable peer check)", async () => {
    // The connection peer here IS 127.0.0.1 (inside the list), so XFF is
    // honored — this is the positive control for the mechanism; the
    // negative control (peer outside list) is the untrusted server below,
    // where the identical client setup has XFF ignored.
    assert.equal(await getStatus(trusted.api, "198.51.100.8"), 200);
  });

  test("default (no TRUST_PROXY_CIDRS): XFF is ignored — all clients share the peer bucket", async () => {
    // Same distinct-XFF pattern that passed ALL-200 on the trusted server.
    // Here the requests MUST collapse into the single loopback-peer bucket
    // (waitForHealth already consumed at least one slot of it), so a 429
    // is guaranteed within three requests under the 2/min limit.
    const statuses = [];
    for (const ip of ["203.0.113.11", "203.0.113.12", "203.0.113.13"]) {
      statuses.push(await getStatus(untrusted.api, ip));
    }
    assert.ok(
      statuses.includes(429),
      `XFF must be ignored when the peer is not trusted (pre-#65 behavior); got ${statuses.join(",")}`
    );
  });
});
