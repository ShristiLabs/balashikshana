#!/usr/bin/env bash
# Deploy orchestration (issue #64) — implements the runbook sequence from
# docs/deployment.md as one reviewable command:
#
#   1. migrations job       (BEFORE traffic shifts — see migrate.sh)
#   2. service redeploy     (force new deployment; the ALB health check
#                            gates traffic on /api/health, and the target
#                            group drains the old task for the configured
#                            deregistration delay)
#   3. wait for stable      (ECS deployment circuit breaker)
#   4. post-deploy smoke    (scripts/post-deploy-smoke.mjs — non-zero exit
#                            fails the deploy)
#
# Manual-deploy preference (binding): this script runs the MECHANICAL steps
# after a human has reviewed `terraform plan` and pushed the image. It never
# runs terraform apply.
#
# Usage:  infra/scripts/deploy.sh <dev|staging|prod> [--dry-run]
#                [--skip-migrate]   # when the deploy intentionally ships
#                                   # no migration (additive-only ledger
#                                   # discipline: docs/database-migrations.md)
# Needs:  aws CLI v2 + jq + node 22; image must already be pushed.

set -euo pipefail

ENVIRONMENT="${1:-}"
shift || true
DRY_RUN=0
SKIP_MIGRATE=0
for arg in "$@"; do
  case "${arg}" in
    --dry-run) DRY_RUN=1 ;;
    --skip-migrate) SKIP_MIGRATE=1 ;;
    *) echo "unknown flag: ${arg}" >&2; exit 2 ;;
  esac
done

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "${INFRA_DIR}/.." && pwd)"
ENV_DIR="${INFRA_DIR}/environments/${ENVIRONMENT}"
SMOKE="${REPO_DIR}/scripts/post-deploy-smoke.mjs"

if [[ "${ENVIRONMENT}" != "dev" && "${ENVIRONMENT}" != "staging" && "${ENVIRONMENT}" != "prod" ]]; then
  echo "usage: $0 <dev|staging|prod> [--dry-run] [--skip-migrate]" >&2
  exit 2
fi
if [[ ! -d "${ENV_DIR}" ]]; then
  echo "missing environment directory: ${ENV_DIR}" >&2
  exit 2
fi

cd "${ENV_DIR}"

if [[ "${DRY_RUN}" == "1" ]]; then
  echo "=== deploy ${ENVIRONMENT} (DRY-RUN) ==="
  echo "ordered sequence that would execute:"
  echo "  0. cd infra/environments/${ENVIRONMENT} && terraform output -raw ecs_cluster_name / ecs_service_name / api_url / portal_url"
  if [[ "${SKIP_MIGRATE}" == "1" ]]; then
    echo "  1. SKIP migrations (--skip-migrate)"
  else
    echo "  1. infra/scripts/migrate.sh ${ENVIRONMENT}  (node-pg-migrate up, pre-traffic)"
  fi
  echo "  2. aws ecs update-service --force-new-deployment (rolling replace behind the ALB)"
  echo "  3. aws ecs wait services-stable"
  echo "  4. node scripts/post-deploy-smoke.mjs --base-url <api_url> --portal-url <portal_url>"
  exit 0
fi

CLUSTER="$(terraform output -raw ecs_cluster_name)"
SERVICE="$(terraform output -raw ecs_service_name)"
API_URL="$(terraform output -raw api_url)"
PORTAL_URL="$(terraform output -raw portal_url)"

echo "=== deploy ${ENVIRONMENT} ==="
echo "cluster:  ${CLUSTER}"
echo "service:  ${SERVICE}"
echo "api:      ${API_URL}"
echo "portal:   ${PORTAL_URL}"

# 1. Migrations BEFORE traffic (skip only with an explicit, deliberate flag).
if [[ "${SKIP_MIGRATE}" == "1" ]]; then
  echo "step 1: migrations SKIPPED by --skip-migrate (no schema change in this deploy)"
else
  "${INFRA_DIR}/scripts/migrate.sh" "${ENVIRONMENT}"
fi

# 2. Rolling replacement. The ALB health check (/api/health) only routes
#    traffic to the new task once it answers; the old task drains for the
#    target group's deregistration delay.
echo "step 2: rolling out a new deployment..."
aws ecs update-service --cluster "${CLUSTER}" --service "${SERVICE}" --force-new-deployment >/dev/null

# 3. Stability gate — ECS stops when the service is stable, non-zero when the
#    deployment circuit breaker rolls it back.
echo "step 3: waiting for the service to stabilize..."
aws ecs wait services-stable --cluster "${CLUSTER}" --services "${SERVICE}"

# 4. Post-deploy smoke — the deploy FAILS if any check fails (issue #64 AC).
echo "step 4: post-deploy smoke..."
node "${SMOKE}" --base-url "${API_URL}" --portal-url "${PORTAL_URL}"

echo "deploy ${ENVIRONMENT}: COMPLETE"
