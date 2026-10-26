# infra/ — Terraform IaC (issues #64-#65)

AWS, validate-only in CI (`fmt` + `init -backend=false` + `validate`,
pinned Terraform 1.5.7). `plan`/`apply` are human steps — the runbook and
all decisions live in **docs/deployment.md** (read that first); the
Dwara edge gateway runbook is **docs/gateway.md**.

```
modules/
  network/       VPC, 2-AZ public/private subnets, single NAT (cost-lean)
  postgres/      RDS PostgreSQL 16, encrypted, private subnets, SG from the API tasks only
  api_service/   ECR + ECS Fargate service (docker/Dockerfile.api), ALB + TLS,
                 SSM-injected secrets, DNS aliases, Dwara edge slot (#65),
                 autoscaling OFF by default (single-instance doctrine, D2)
  gateway/       Dwara edge (#65, D10): ECR + ECS Fargate gateway service,
                 NLB TCP passthrough (TLS terminates at Dwara), gateway DNS
                 record, SSM-injected keys + TLS material, admin mTLS port
                 SG-restricted to ops CIDRs (0.0.0.0/0 rejected)
  static_site/   S3 + CloudFront (OAC) hosting apps/parent-portal dist/
  packs_store/   S3 bucket for compiled content packs (versioned + lifecycle)
environments/
  dev/ staging/ prod/   byte-identical roots; ONLY terraform.tfvars differs
scripts/
  migrate.sh     migrations job — one-off ECS run-task, npm run migrate, pre-traffic
  deploy.sh      migrate -> rolling rollout -> services-stable -> post-deploy smoke
```

Quick reference:

```
terraform fmt -check -recursive infra/
(cd infra/environments/dev && terraform init -backend=false && terraform validate)
infra/scripts/deploy.sh staging --dry-run
node scripts/post-deploy-smoke.mjs --base-url http://127.0.0.1:4000
```

Secrets: SSM Parameter Store `/balashikshana/<env>/*` — never in tf files
(scan-enforced by `services/api/test/infra-secrets.test.mjs`, ignore-enforced
by `.gitignore` `*.auto.tfvars`).
