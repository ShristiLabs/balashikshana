# deploy/dwara — Dwara edge gateway configuration (issue #65, D10)

Deliverable of #65: the gateway CONFIG + integration + IaC wiring.
No Dwara product changes — the gateway is ShristiLabs/dwara as shipped.

## Layout

- `envs/{dev,staging,prod}.yaml` — the dwara.yaml per environment.
  staging and prod are byte-identical; dev differs ONLY by the origin
  upstream triple (loopback http1 vs origin ALB https). Enforced by
  `services/api/test/dwara-config.test.mjs`.
- `schema/config-reference.json` — the Dwara config JSON Schema, VENDORED
  so CI (which cannot see the sibling repo) validates configs with the
  same schema the gateway itself uses.
- `gen-dev-certs.sh` — self-signed dev TLS material into `certs/`
  (gitignored; never commit key material).
- `verify-edge.sh` — scripts the issue's acceptance criteria against a
  running fronted environment (staging or local).
- `docker/Dockerfile.gateway` + `docker/entrypoint.sh` — the operator-side
  image build (binary from the dwara repo, one env config baked in,
  SSM-injected TLS material written to files at task start).

## Schema provenance (pin)

`schema/config-reference.json` is a byte-for-byte copy of
`ShristiLabs/dwara` `config-reference.json`:

- source commit: `68f6c69c4675f44b3430bda89f04d2e51d50821d` (2026-09-16)
- sha256: `a7cca27c445f022abf3825a2cfef124773380e3c3f9b06145972fd4741848a21`

The test suite pins this sha: any drift (accidental edit, upstream bump)
fails CI until the file is re-vendored deliberately and the pin updated
here AND in `services/api/test/dwara-config.test.mjs`.

## Validation

In CI / locally (no gateway binary needed):

```sh
cd services/api && npx vitest run test/dwara-config.test.mjs
```

62 gates: schema validation of all three env files, credential
ref-only enforcement, admin mTLS isolation, OpenAPI route coverage,
policy registry consistency, D10 X-Consumer-* stripping, TLS posture,
env parity DRY, staged-rollout pin, secret scan.

Live validation (binary or image available): see docs/gateway.md
"Local fronting" and `verify-edge.sh` (edge health, D10 origin-auth
probe, 429+Retry-After burst, admin mTLS rejection).

## Building the image (operator-side; pipeline never pushes)

Before building: replace the PLACEHOLDER origin upstream in the target
env config. `envs/staging.yaml` and `envs/prod.yaml` ship the placeholder
host `api.balashikshana.example` (services -> upstreams -> address); set
the real origin host for the environment being built FIRST — the
Dockerfile COPYs the env file into the image, so the value is baked in
at build time and a wrong placeholder survives until the image is
rebuilt.

```sh
# 1. dwara checkout beside this repo (read-only reference):
git clone git@github.com:ShristiLabs/dwara.git ../dwara   # if absent
ln -sfn ../dwara dwara-src   # build context expects ./dwara-src
# 2. Replace the placeholder origin upstream (see above) in
#    deploy/dwara/envs/<env>.yaml BEFORE the build.
# 3. Build + push:
docker build -f deploy/dwara/docker/Dockerfile.gateway \
  --build-arg DWARA_ENV=staging \
  -t <ecr>/balashikshana-staging/gateway:latest .
docker push <ecr>/balashikshana-staging/gateway:latest
```

Terraform wiring: `infra/modules/gateway` (NLB TCP passthrough, ECS
Fargate service, SSM secret injection, admin-port SG). See
docs/gateway.md for the full runbook.
