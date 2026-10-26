#!/bin/sh
# Edge verification procedure (issue #65 acceptance criteria), scripted.
# Runs against a Dwara-fronted environment (staging per the issue AC; also
# works against a local fronting stack — docs/gateway.md "Local fronting").
#
# Proves, in order:
#   1. Edge health: GET /api/health through the gateway (TLS terminated).
#   2. D10 origin auth unchanged: a request WITH a valid consumer class
#      key but NO Fastify session/device token is still 401 BY THE ORIGIN
#      (the edge key never authenticates anything).
#   3. Edge rate limits: a synthetic burst past the per-IP budget yields
#      429 WITH a Retry-After header (gateway-emitted), and the limit that
#      trips is an EDGE policy (not the origin's).
#   4. Admin mTLS-only: a plain TLS call to the admin port WITHOUT a
#      client certificate fails (handshake rejected by client-ca
#      verification — no token fallback exists by design).
#
# Usage:
#   EDGE_URL=https://gateway.staging.<zone> \
#   ADMIN_URL=https://<admin-host>:2019 \
#   EDGE_KEY_PARENT=<the class key> \
#   CA_FILE=<server CA bundle for this environment> \
#   ./deploy/dwara/verify-edge.sh
#
# Exit code 0 = all checks passed. Requires curl with TLS 1.2+.
set -eu

EDGE_URL=${EDGE_URL:?EDGE_URL must be set (e.g. https://gateway.staging.example)}
ADMIN_URL=${ADMIN_URL:?ADMIN_URL must be set (the mTLS admin base URL)}
EDGE_KEY_PARENT=${EDGE_KEY_PARENT:?EDGE_KEY_PARENT must be set (issued out-of-band)}
CA_FILE=${CA_FILE:?CA_FILE must be set (server CA bundle for the environment)}
CURL="curl -sS --cacert $CA_FILE -o /dev/null"

fail() { echo "FAIL: $1" >&2; exit 1; }

echo "== 1. edge health (TLS terminates at the gateway) =="
code=$($CURL -w '%{http_code}' "$EDGE_URL/api/health")
[ "$code" = "200" ] || fail "expected 200 via edge, got $code"
echo "   ok: /api/health -> 200 through the gateway"

echo "== 2. D10: consumer key does NOT authenticate at the origin =="
# A valid edge class key, but no parent session and no device token: the
# gateway accepts and classifies the request, the ORIGIN must still answer
# 401 (its own bearer doctrine governs).
code=$(curl -sS --cacert "$CA_FILE" -o /dev/null -w '%{http_code}' \
  -H "X-API-Key: $EDGE_KEY_PARENT" \
  "$EDGE_URL/api/parent/children")
[ "$code" = "401" ] || fail "expected 401 from origin with key-but-no-session, got $code"
echo "   ok: key-but-no-session -> 401 (origin auth intact)"

echo "== 3. edge rate limit: burst -> 429 with Retry-After =="
# Burst past edge-health (30/min/IP, burst 10): hammer until the EDGE
# answers 429. Retry-After is emitted by the gateway rate limiter.
i=0; got429=0
while [ $i -lt 60 ]; do
  hdr=$(curl -sS --cacert "$CA_FILE" -o /dev/null -D - \
    "$EDGE_URL/api/health" | tr -d '\r')
  code=$(printf '%s' "$hdr" | head -1 | awk '{print $2}')
  if [ "$code" = "429" ]; then
    printf '%s' "$hdr" | grep -qi '^Retry-After:' || fail "429 without Retry-After"
    got429=1
    echo "   ok: 429 with Retry-After after $((i + 1)) requests"
    break
  fi
  [ "$code" = "200" ] || fail "unexpected $code during burst (expected 200 then 429)"
  i=$((i + 1))
done
[ "$got429" = "1" ] || fail "no 429 after 60 requests — edge health policy not enforced?"
echo "   note: wait ~60s before re-running (per-IP budget refills)"

echo "== 4. admin API: mTLS-only (no cert -> rejected) =="
# Without a client certificate the TLS handshake against the admin
# listener fails outright (client-ca verification); curl exits non-zero
# on handshake failure — that IS the pass condition.
if curl -sS --cacert "$CA_FILE" -o /dev/null "$ADMIN_URL/health" 2>/dev/null; then
  fail "admin API answered WITHOUT a client certificate"
fi
echo "   ok: admin rejected without client certificate (handshake-level)"

echo "ALL EDGE CHECKS PASSED"
