# Gateway Runbook — Dwara Edge Fronting (issue #65, roadmap D10)

The Dwara gateway (ShristiLabs' in-house Rust API gateway) fronts the
public API: it terminates TLS, classifies client traffic into consumers
with per-class credentials and budgets, applies coarse volumetric rate
limits, and exposes an mTLS-only admin surface. **The Fastify origin
keeps its own auth** (scrypt credentials, the M2 dual-token doctrine —
parent session vs child device token — the CORS allowlist, IDOR-safe
session middleware). D10: the edge ADDS protections; it never replaces an
origin check.

## 1. Topology

```
client ──TLS──> NLB (TCP passthrough, 443)
                    │
                    ▼ TLS terminates HERE
               Dwara gateway (ECS Fargate, :8443 public / :2019 admin)
                    │  consumers · edge rate limits · security headers
                    ▼ HTTPS (origin ALB, ACM cert)
               Fastify origin (services/api) ── scrypt auth, semantic
                    rate limits, CORS, problem+json ──> Postgres
```

- The NLB is **L4 passthrough** so TLS terminates at the gateway (issue
  AC). An ALB in front would terminate TLS first and falsify that.
- Edge -> origin traffic is HTTPS to the origin ALB — never plaintext
  across the network (dev fronting on loopback is the one exception).
- Admin (`:2019`) is NOT wired to any load balancer; the task security
  group admits it from internal ops CIDRs only (`gateway_admin_ingress_cidrs`
  — the Terraform variable rejects `0.0.0.0/0` by validation).
- In-repo artifacts: `deploy/dwara/envs/{dev,staging,prod}.yaml` (the
  gateway config), `deploy/dwara/schema/` (vendored Dwara JSON Schema,
  provenance-pinned), `deploy/dwara/docker/` (image build), `infra/modules/gateway`
  (Terraform). Validation is enforced by
  `services/api/test/dwara-config.test.mjs` (62 structural + schema gates).

## 2. Consumers and credentials (ADR)

Edge keys are **class identifiers, never identity**. The origin's session
and device tokens remain the only authentication that matters.

| Consumer | Credential | Why this type |
|---|---|---|
| `parent-app` | API key (`X-API-Key`), `${BALASHIKSHANA_EDGE_KEY_PARENT}` | Native app can embed a class key; secrecy is not claimed (a mobile binary is extractable) — the key only buys a budget class. The origin parent session is the auth. |
| `child-device` | API key, `${BALASHIKSHANA_EDGE_KEY_CHILD_DEVICE}` | Same reasoning for the app's child mode; per-device identity stays the origin's device-token doctrine. HMAC request signing is the documented upgrade path once apps/mobile can ship a signer (#71 is the next mobile-touching issue). |
| `portal` | API key, `${BALASHIKSHANA_EDGE_KEY_PORTAL}` | A browser SPA cannot hold a secret — the key ships in the static build and is PUBLIC BY DESIGN. It classifies portal traffic for budgeting, nothing more. |
| admin (ops) | mTLS client certificate (CN `balashikshana-admin`, CA `edge_tls_client_ca`) | The admin API's own mTLS listener; the client certificate IS the authentication (no token layer). Not a data-plane consumer. |

**Staged rollout.** Routes are `auth_required: false` today: deployed
clients (mobile builds in the field, the portal SPA) do not yet send edge
keys, and flipping the switch now would break them. Stage 2 — set
`auth_required: true` on the `/api/` routes — lands when client releases
ship the class keys; the config test pins stage 1 so the flip is a
deliberate, reviewed change. The flip also re-arms the per-credential
`edge-auth-sensitive` cap on ALL login traffic: the 60/min per-credential
sizing must be re-checked against real stage-1 login telemetry at flip
time, since classroom and household bursts then share one credential
budget. Anonymous traffic is still edge-rate-limited
per IP (the `credential` selector falls back to `ip` until a key
identifies the consumer).

**Key issuance.** Keys are generated out-of-band (e.g. `openssl rand -hex
32`), stored as SSM SecureStrings
`/balashikshana/<env>/edge_key_{parent,child_device,portal}`, and injected
into the gateway task as environment variables; `dwara.yaml` references
them as `${...}` and the resolved values never touch the repo (enforced
by the secret-scan tests). A key is rotated by writing the new SSM value
and redeploying the gateway service.

## 3. Rate-limit layering (edge vs origin)

Two layers with different jobs — complementary, never redundant:

- **Edge (Dwara):** coarse VOLUMETRIC caps per client class and per client
  IP, applied before TLS proxying costs anything. Stacked GCRA; a denial
  is `429` with `Retry-After`.
- **Origin (Fastify `@fastify/rate-limit`):** tight SEMANTIC caps keyed to
  application meaning — login attempts per IP, signups per IP, sync per
  device token, deletes per IP (`RATE_LIMIT_*` env, defaults in
  `services/api/server.mjs`).

| Policy (edge) | Scope | Limit | Rationale |
|---|---|---|---|
| `edge-default` | listener, per IP | 600/min, 10k/hour, burst 200 | Floor for EVERYTHING (incl. unrouted 404s). Far above the origin's 120/min/IP general semantic so legit users never trip the edge first; sheds floods. |
| `edge-health` | `/api/health`, per IP | 30/min, 300/hour, burst 10 | Anonymous probe: pollers need a few/min, scrapers get nothing more. |
| `edge-auth-sensitive` | login/signup/verify/refresh/reset, per IP | 30/min, 300/hour, burst 15 | Sized ABOVE the origin's tightest semantic (signup 5/min/IP) so the origin governs legit use; the hour window catches slow-drip credential stuffing. |
| `edge-auth-sensitive` | same, per credential | 60/min, 600/hour | Class-level bound once keys are presented. |
| `edge-sync` | `/api/sync/*`, per credential | 600/min, 50k/hour, burst 300 | Child-device CLASS budget; the origin's 30/min per device token stays the real per-device cap. |
| `edge-sync` | same, per IP | 120/min, 2k/hour, burst 60 | Households (1-3 devices/IP) today. MUST be re-sized for school NAT aggregation when B2B licensing lands (#70). |
| `edge-general` | `/api/*`, per credential | 1200/min, 20k/hour, burst 300 | General class ceiling. |
| consumer quotas | per consumer | parent 200k/day, child-device 500k/day, portal 200k/day | Daily class ceilings at ~10x expected peak. |

**The per-IP pitfall and its fix.** The origin's per-IP buckets key on
the socket peer. Behind the edge (and in fact behind any L7 proxy), the
peer is the proxy, not the client — all clients would collapse into one
bucket. `TRUST_PROXY_CIDRS` (added in #65, default empty = off) lets the
origin honor `X-Forwarded-For` with **peer-checked semantics**: XFF is
trusted only when the connection peer is inside the listed CIDRs, so a
client hitting the origin directly cannot spoof XFF. The Terraform root
sets it to the VPC CIDR exactly when `enable_gateway` is true. The chain
is: client -> NLB (L4, preserves client IP) -> Dwara (appends true client
IP to XFF) -> origin ALB (appends Dwara's IP) -> origin (peer = ALB in
VPC = trusted; walks back past VPC-internal hops to the true client IP).

**D10 header isolation.** Every proxy route strips the gateway-injected
`X-Consumer-Name` / `X-Consumer-Type` headers before forwarding (config
`transforms.request.headers.remove`) — the origin never even sees edge
identity, so no future origin code can accidentally trust it. The edge
also never trusts inbound `X-Consumer-*` (the gateway strips client-
supplied ones itself — spoof prevention). `X-Forwarded-For` is the one
edge header the origin consumes, and only via the peer-checked path
above.

## 4. TLS and certificates

- Public listener: TLS 1.2+/1.3 terminate at the gateway
  (`listeners[].tls`), PEM files at `/etc/dwara/certs/` inside the task.
- Staging/prod material: operator-issued certificate + key stored as SSM
  SecureStrings (`edge_tls_cert`, `edge_tls_key`); the image entrypoint
  writes them to files at task start — key material never lives in the
  image or the repo.
- Admin mTLS: same server pair plus `edge_tls_client_ca` (the CA that
  signs admin client certificates). Ops clients present a certificate
  signed by that CA; the certificate IS the admin auth.
- Dev: `deploy/dwara/gen-dev-certs.sh` generates self-signed material
  into `deploy/dwara/certs/` (gitignored).
- Rotation: replace the SSM parameter values and redeploy the gateway
  task (`aws ecs update-service --force-new-deployment`). The gateway
  reloads config hot, but certificate FILES are written at task start —
  rotation is a task replacement.

## 5. Operating the admin API

The admin listener binds `:2019`, requires a client certificate chained
to the admin CA, and is reachable only from the ops CIDRs:

```sh
curl --cert deploy/dwara/certs/client.crt --key deploy/dwara/certs/client.key \
     --cacert deploy/dwara/certs/server.crt \
     https://<gateway-host>:2019/health          # via the ops network path
```

Non-mTLS attempts fail at the TLS handshake — there is no token fallback
(`verify-edge.sh` check 4 proves it). Treat the client key like a prod
credential; issue per-operator certificates from the admin CA.

## 6. Deployment (validate-only doctrine)

The pipeline NEVER applies Terraform (standing manual-deploy preference,
#64). What the repo guarantees: `terraform fmt/validate` green across
all envs, and the dwara config schema/structure validated in CI. The
operator sequence for staging:

1. Provision SSM SecureStrings (once): `edge_tls_cert`, `edge_tls_key`,
   `edge_tls_client_ca`, `edge_key_parent`, `edge_key_child_device`,
   `edge_key_portal` under `/balashikshana/staging` (see
   `infra/environments/staging/secrets.auto.tfvars.example`).
2. Replace the PLACEHOLDER origin upstream in the target env config:
   `deploy/dwara/envs/staging.yaml` (and prod.yaml) ship the placeholder
   host `api.balashikshana.example` (services -> upstreams -> address);
   set the real origin host for the environment being built. This MUST
   happen before the build — the Dockerfile COPYs the env file into the
   image, so the value is baked in at build time.
3. Build + push the gateway image:
   `docker build -f deploy/dwara/docker/Dockerfile.gateway --build-arg
   DWARA_ENV=staging ...` (README below) and push to the module's ECR
   repo; set `gateway_image_uri` in tfvars if the tag changed.
4. `terraform plan/apply` (human step) — creates the NLB, gateway
   service, DNS record `gateway.<env>.<zone>` (the #64 edge slot,
   retargeted), and security groups.
5. Verify: `EDGE_URL=... ADMIN_URL=... EDGE_KEY_PARENT=... CA_FILE=...
   ./deploy/dwara/verify-edge.sh` — proves all four issue ACs (edge
   health, D10 origin-auth intact with key-but-no-session, 429 +
   Retry-After on burst, admin mTLS rejection).
6. Post-deploy smoke with the edge path:
   `node scripts/post-deploy-smoke.mjs --base-url https://api... --edge-url
   https://gateway...`.

## 7. Local fronting (dev)

With no gateway binary or cloud:

```sh
./deploy/dwara/gen-dev-certs.sh
./startup.sh                                   # origin on 127.0.0.1:4000
BALASHIKSHANA_EDGE_KEY_PARENT=devkey \
BALASHIKSHANA_EDGE_KEY_CHILD_DEVICE=devkey2 \
BALASHIKSHANA_EDGE_KEY_PORTAL=devkey3 \
  dwara --config deploy/dwara/envs/dev.yaml    # or docker run the image
curl --cacert deploy/dwara/certs/server.crt https://localhost:8443/api/health
```

`deploy/dwara/envs/dev.yaml` targets the loopback origin. If a `dwara`
binary (or the built image) is available, `verify-edge.sh` runs against
it unchanged (admin URL `https://localhost:2019`). Without a binary, the
62-gate schema/structure suite remains the validation of record — it
validates the config against the same JSON Schema the gateway's own
`dwara-cli validate` uses.

## 8. Known limitations (documented, deliberate)

- Consumer quota counters live in task-local SQLite (`DWARA_STATE_DB` on
  task storage): they reset on task replacement. Moving them to a shared
  store is the multi-instance D2 revisit (Dwara's `redis_quotas` exists
  for exactly that).
- `auth_required` is stage-1 false (see the ADR above).
- Per-IP edge limits are household-sized; re-size for school NATs at the
  B2B seam (#70).
- Analytics/observability blocks are OFF at the edge; #66 (observability)
  turns on first-party edge metrics — Dwara's analytics surface feeds it
  (no child PII at the edge, D5).

## 9. ADR — credential-type choices per client class

Decision: API-key classing for all three data-plane audiences, mTLS for
admin, HMAC deferred.

- Considered per audience: HMAC (child-device), JWT/OIDC (parent), IP
  allowlists (portal). All rejected FOR NOW: HMAC and JWT require client
  releases (mobile untouched until #71; portal SPA cannot hold JWT
  signing material), and portal traffic is browser-originated where IP
  classing breaks on mobile networks and VPNs.
- API keys are honest about what they are: extractable, non-secret class
  markers whose ONLY function is budget/route classing — the security
  boundary stays the origin's dual-token doctrine (D10), so extracting a
  class key buys an attacker nothing but a rate-limit class.
- Consequences: cheap rotation (SSM value + redeploy), no client-side
  crypto, and a clean stage-2 flip to `auth_required: true` per class
  once clients ship keys. HMAC (per-device, replay-protected) is the
  documented upgrade for child-device at #71.
