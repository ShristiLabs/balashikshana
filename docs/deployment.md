# Deployment — Infrastructure as Code, Environments, and the Deploy Runbook

Issue #64 (M6 Enterprise Launch). This document is the deploy runbook and
the record of the deployment decisions behind `infra/`. It is written to be
runnable by an engineer who has never touched this repository.

Two rules govern everything here:

1. **Validate-only in version control.** The delivery pipeline and CI run
   `terraform fmt` and `terraform validate` — nothing else. `terraform
   plan` and `terraform apply` are **human steps** (standing
   manual-deploy preference; the issue body restates it). No automation in
   this repo ever creates a cloud resource.
2. **No secrets in the repo, ever.** Two enforced layers: `.gitignore`
   rejects `*.auto.tfvars` and state files, and
   `services/api/test/infra-secrets.test.mjs` scans every committed
   Terraform/compose/Dockerfile file for secret-shaped literals in CI.

## Topology

One AWS account, three environments (dev / staging / prod), each a thin
Terraform root over the same shared modules:

```
                     Route53 zone (existing, e.g. balashikshana.example.)
                        │
        ┌───────────────┼───────────────────┐
        │               │                   │
   api.<env>.<zone>  portal.<env>.<zone>  gateway.<env>.<zone>   (Dwara edge, #65)
        │               │                   │
     ALB (TLS)     CloudFront ── S3     NLB (TCP passthrough, 443)
        │  health /api/health       portal dist (private, OAC)
     ECS Fargate service —                    │ TLS terminates HERE
     docker/Dockerfile.api image (1 task, D2) │  consumers + edge rate limits
        ▲                                    ECS Fargate gateway — deploy/dwara
        │ HTTPS (edge -> origin)             │  admin :2019 mTLS, ops-CIDR SG only
        └────────────────────────────────────┘
        │
   RDS PostgreSQL 16 (private subnets, :5432 from the task SG only)

   S3 packs bucket (compiled content packs, versioned)
   SSM Parameter Store /balashikshana/<env>/* (secrets)
```

`gateway.<env>.<zone>` is the Dwara edge (roadmap D10, issue #65): when
`enable_gateway = true` the `infra/modules/gateway` module owns the DNS
record (NLB TCP passthrough -> gateway terminating TLS -> origin ALB over
HTTPS) and `create_edge_slot`'s placeholder CNAME is suppressed
automatically. The origin KEEPS its own auth; the gateway adds consumer
keys, quotas, and TLS at the edge. Gateway runbook (credentials,
rate-limit layering, mTLS admin, verification):
**`docs/gateway.md`**.

### Why AWS (decision record)

The issue and roadmap mandate **Terraform** but do not name a provider.
Chosen: **AWS, single region** — the most defensible default for a small US
SaaS: the most mature Terraform provider, ECS Fargate runs the existing
`docker/Dockerfile.api` image unchanged, RDS matches the PostgreSQL 16 +
node-pg-migrate stack exactly, S3+CloudFront is the standard static host for
the Vite portal, and SSM Parameter Store covers secrets without extra
per-secret cost. **GCP (Cloud Run + Cloud SQL)** was considered and
rejected for this milestone: Cloud Run's scale-to-zero is attractive, but
the AWS surface here is already minimal and single-vendor. The surface is
deliberately small and parameterized (`infra/environments/*/terraform.tfvars`)
so a different provider is a modules/ rewrite, not a runbook rewrite.

## Repository layout

```
infra/
  modules/
    network/       VPC, public/private subnets (2 AZs), single NAT gateway
    postgres/      RDS PostgreSQL 16, encrypted, private-only, SG-scoped
    api_service/   ECR, ECS Fargate service, task def (env + SSM secrets),
                   ALB + TLS listeners, DNS records, edge slot, autoscaling (off)
    gateway/       Dwara edge (issue #65): NLB TCP passthrough, gateway ECS
                   service, SSM secret injection, mTLS admin SG (ops CIDRs only)
    static_site/   S3 + CloudFront (OAC) for the parent-portal dist
    packs_store/   S3 bucket for compiled content packs (versioned, lifecycle)
  environments/
    dev/ staging/ prod/
      main.tf variables.tf versions.tf outputs.tf   <- byte-identical across envs
      terraform.tfvars                              <- the ONLY per-env file
      secrets.auto.tfvars.example                   <- template (no secrets)
  scripts/
    migrate.sh      migrations job (one-off ECS run-task, pre-traffic)
    deploy.sh       ordered deploy: migrate -> rollout -> stable -> smoke
```

The three environment roots are **byte-identical except `terraform.tfvars`**
— enforced by `services/api/test/infra-secrets.test.mjs`. Adding an
environment means copying the four `.tf` files and writing one tfvars.

### Environment matrix (committed tfvars)

| | dev | staging | prod |
|---|---|---|---|
| DB instance | db.t4g.micro | db.t4g.micro | db.t4g.small, multi-AZ |
| DB deletion protection | off | off | **on** |
| DB final snapshot | skipped | kept | kept |
| Backups | 1 day | 7 days | 14 days |
| API task | 0.25 vCPU / 512 MB | 0.25 / 512 | 0.5 / 1024 |
| Desired count | 1 | 1 | 1 (single-instance doctrine, D2) |
| Rolling deploy | replace freely (min healthy 0) | min 0 | **min healthy 100** |
| Seed demo students | yes | no | no |
| Weekly digest (#63) | off | off | on (SMTP via SSM) |
| Edge slot (#65) | no | yes | yes |
| Deletion protection (ALB/buckets) | off | off | on |

## Secrets

All environment secrets live in **SSM Parameter Store** under
`/balashikshana/<env>/`, type `SecureString`:

| Parameter | Owner | Notes |
|---|---|---|
| `db_master_password` | operator, pre-created **before first apply** | RDS master password |
| `smtp_user`, `smtp_pass` | operator, pre-created | #63 digest transport (#63 keeps SMTP swappable) |
| `database_url` | **Terraform-managed** | composed from the RDS endpoint + master password after each apply |

The ECS task definition injects `DATABASE_URL`, `SMTP_USER`, `SMTP_PASS`
from those parameters at task start (`secrets` block, ARN references
only). Nothing secret is ever written into `.tf` files, tfvars, or the
task-definition JSON payload. Non-secret configuration (CORS origins,
rate-limit buckets, scheduler intervals, SMTP host/from) is regular
environment configuration in the task definition.

**Local plans:** if you prefer tfvars over SSM for a local plan, copy
`secrets.auto.tfvars.example` to `secrets.auto.tfvars` (gitignored —
enforced) and fill values there. Committed files must stay clean.

**Rotation:** update the SSM value, then `terraform apply` — the apply
updates the RDS password and rewrites `database_url` atomically; the next
rolling deploy restarts tasks against the new value. Rotate SMTP
credentials by updating the two SSM parameters and re-deploying (no apply
needed).

**State sensitivity:** Terraform state contains the RDS master password and
the composed `database_url`. This is the standard accepted posture for
TF-managed RDS. The mitigation is the remote-state setup below (encrypted
S3, tight bucket policy, DynamoDB lock). Never commit state; `.gitignore`
rejects `*.tfstate*`.

## Remote state

Per environment, once per account (uncomment the `backend "s3"` block in
`infra/environments/<env>/versions.tf` and point it at your buckets):

```
terraform {
  backend "s3" {
    bucket         = "balashikshana-tfstate-<account-id>"   # private, SSE-KMS
    key            = "env/<env>/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    dynamodb_table = "balashikshana-tfstate-locks"
  }
}
```

CI's `terraform init -backend=false` intentionally ignores this block —
the pipeline never touches state.

## First-time bootstrap (per environment)

1. **Route53 zone** exists for your domain; put its name in
   `terraform.tfvars` (`hosted_zone_name`).
2. **ACM certificates**: one in the deploy region for the ALB
   (`api.<env>.<zone>`), one in `us-east-1` for CloudFront
   (`portal.<env>.<zone>`). Put ARNs in tfvars.
3. **Create the bootstrap SSM parameters** (SecureString):
   `db_master_password`, `smtp_user`, `smtp_pass` —
   `aws ssm put-parameter --name /balashikshana/<env>/db_master_password --type SecureString --value ...`
4. Configure the S3+DynamoDB state backend (above) and `terraform init`.
5. `terraform plan -var-file=terraform.tfvars` — **review it**; this is
   the reviewable plan the issue asks for.
6. `terraform apply` — the human step.
7. Push the API image (below), then run the deploy runbook.

Terraform is pinned to **1.5.7** (the version CI validates with); the AWS
provider is `~> 5.0` with lock files covering `darwin_arm64` (laptops) and
`linux_amd64` (CI).

## Deploy runbook (every deploy)

Prereq: `docker/Dockerfile.api` image built and pushed to the
environment's ECR repo (`terraform output -raw ecr_repository_url`):

```
docker build -f docker/Dockerfile.api -t <repo>:<tag> .
docker push <repo>:<tag>
# tag it as the tfvars api_image_uri (mutable-tag redeploy flow) or update tfvars + apply
```

Then one command runs the ordered sequence (`infra/scripts/deploy.sh`):

```
infra/scripts/deploy.sh staging          # or dev / prod
infra/scripts/deploy.sh prod --dry-run   # print the sequence, touch nothing
```

which executes:

1. **Migrate** — `infra/scripts/migrate.sh <env>`: one-off ECS task from
   the *same* task definition the service runs, command override
   `npm run migrate` (node-pg-migrate is a regular dependency). Waits for
   `STOPPED`, asserts `exitCode == 0`, and **refuses to continue
   otherwise** — the old service keeps serving.
2. **Rollout** — `aws ecs update-service --force-new-deployment`: rolling
   replacement behind the ALB. Traffic only moves when the new task passes
   the `/api/health` target-group check; the old task drains for the
   deregistration delay (60 s).
3. **Stable** — `aws ecs wait services-stable` (the ECS circuit breaker
   rolls back a failed replacement).
4. **Smoke** — `node scripts/post-deploy-smoke.mjs --base-url
   https://api.<env>.<zone> --portal-url https://portal.<env>.<zone>`:
   health (asserts the full 6,140-question seed), curriculum summary,
   practice fetch, content-pack index, portal origin. **Any failure fails
   the deploy** (non-zero exit).

`--skip-migrate` exists for deploys that intentionally ship no migration
(the migration ledger is additive-only; see below). The smoke script also
runs standalone: `node scripts/post-deploy-smoke.mjs --base-url
http://127.0.0.1:4000` against local dev.

### Migrations on deploy

Doctrine, per the issue body and the migration ledger
(`docs/database-migrations.md`):

- Migrations run **before the new version takes traffic** — as the
  dedicated step 1 job above, not only at task boot.
- **Boot backstop:** `services/api/db.mjs` re-runs node-pg-migrate
  idempotently at every boot (`runMigrations`), so a task that starts
  against a schema behind the ledger catches up — but the deploy ordering
  makes that a backstop, never the mechanism.
- **Rollback/drain:** the ledger is additive-only (expand/contract), so
  the previous API version remains schema-compatible after a forward
  migration — rolling back a deploy = `aws ecs update-service` to the
  previous task definition; no down-migration needed. Connection drain is
  the target group's deregistration delay. `migrate:down` is a last
  resort and follows the ledger doc's cautions.
- **Demonstrating on staging** (issue AC): the first real deploy of every
  change runs on staging via this runbook; step 1's exit-code assertion is
  the migration gate.

### Content packs

The API serves packs from a local directory
(`BALASHIKSHANA_CONTENT_PACKS_DIR`, default
`/app/services/api/content-packs` in the image). The cloud flow:

1. Build packs: `npm run build --workspaces=false --prefix tools/content-pipeline`
2. Sync to the environment bucket: `aws s3 sync <packs-out>/ s3://$(cd infra/environments/<env> && terraform output -raw packs_bucket)/`
3. Publish to the running service with a one-off task (same pattern as
   migrate.sh, command override syncing to the container's packs dir), or
   bake into the image at build time — the module leaves this to the
   operator; the smoke's pack-index check fails any deploy that forgot it
   (the API answers 503 when no index is published).

### Parent portal deploys

```
npm run build --workspaces=false --prefix apps/parent-portal
aws s3 sync apps/parent-portal/dist/ s3://<portal_bucket>/ --delete
aws cloudfront create-invalidation --distribution-id <id> --paths "/*"
```

Portal deploys never touch the API. `ALLOWED_ORIGINS` on the API must list
the portal origin of the same environment (tfvars `allowed_origins`).

## Single instance vs multi-instance (roadmap D2, revisited — decision)

**Decision: stay single-instance; remove the unused Redis; document the
path.** Per D2 ("Redis stays out until multi-instance"), the compose Redis
service was dead infrastructure — nothing in the API ever read `REDIS_URL`
(verified by grep in #64) — and `docker/docker-compose.yml` no longer
starts it. Rationale and the migration path:

- **What is already multi-instance-safe:** the background schedulers.
  The retention sweep (#62) and weekly digest (#63) hold
  `pg_try_advisory_lock` for the duration of a run — a second instance's
  tick loses the lock and skips. The locks are the seam that makes a
  future `desired_count = 2` safe for scheduled work by construction.
- **What is not:** `@fastify/rate-limit` buckets are per-process, so
  raising the count multiplies effective rate ceilings; and the pack index
  is read per-instance from local disk (an operator pack sync must hit all
  instances).
- **The path to multi-instance** (when load demands it, not before):
  raise `api_desired_count` / enable `api_enable_autoscaling`, move the
  rate-limit store to Redis or a Postgres-backed store, and make pack
  publishing a deploy step. That is the moment Redis re-enters the stack —
  wired to something real, not standing by unused.
- **Why not wire Redis now:** an unused Redis is cost + attack surface +
  a false signal that scale-out is already handled. The advisory locks
  already provide correctness; everything else is load-driven.

## Observability (issue #66 — cross-reference)

First-party telemetry: the API tasks expose Prometheus metrics on a
separate internal port (`metrics_port`, default 9101; module wiring in
`infra/modules/api_service`). Scraping ingress is OPT-IN — set
`metrics_scrape_cidrs` in an environment's tfvars to your self-hosted
Prometheus hosts' CIDRs (empty default = no ingress rule at all; never
`0.0.0.0/0`); optionally set `METRICS_TOKEN` (SSM -> task env) as a
bearer gate. Alert rules (`deploy/observability/alert-rules.yml`),
promtool tests, and the Grafana dashboard ship in-repo; the operator
wiring (self-hosted Prometheus/Grafana/Alertmanager, edge analytics
toggle) is documented in docs/observability.md. containerInsights stays
OFF (D5) — the first-party stack replaces it.

## Cost posture

Single NAT gateway per environment (~$32/mo each), `db.t4g` burstable
instances, Fargate 0.25 vCPU tasks, CloudFront `PriceClass_100`,
container insights off (first-party telemetry only, D5), dev's RDS at
1-day backups. Dev can hibernate: `enable_nat_gateway = false` +
`api_desired_count = 0` + stop the RDS instance.

## Local development (unchanged)

`docker/docker-compose.yml` still brings up postgres + api + web for local
work (Redis removed — see the D2 section above). `startup.sh` / `stop.sh`
run the API + dev harness on :4000 / :4200 against the compose Postgres.
The post-deploy smoke script runs against either.

## CI

One cheap step inside the existing single job
(`.github/workflows/ci.yml`): download Terraform 1.5.7, `fmt -check` the
whole `infra/` tree, then `init -backend=false && validate` for each of
dev/staging/prod (shared provider cache). The secret-scan/DRY tests run in
the API vitest step. No cloud credentials are needed or used.
