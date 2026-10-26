#!/usr/bin/env bash
# Migrations-on-deploy step (issue #64): run node-pg-migrate as a one-off
# ECS task BEFORE the new API version receives traffic. Uses the SAME task
# definition the service runs (node-pg-migrate is a regular dependency, so
# the production image can run `npm run migrate`) with a command override.
#
# Why a separate step instead of boot-time only: db.mjs already re-runs
# migrations idempotently at boot as a backstop, but the deploy doctrine
# (issue body) wants schema changes applied before the rolling replacement
# starts — see docs/deployment.md "Migrations on deploy".
#
# Usage:  infra/scripts/migrate.sh <dev|staging|prod> [--dry-run]
# Needs:  aws CLI v2 + credentials with ecs:RunTask on the environment,
#         terraform (outputs only). Never provisions anything itself.

set -euo pipefail

ENVIRONMENT="${1:-}"
DRY_RUN="${2:-}"
INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_DIR="${INFRA_DIR}/environments/${ENVIRONMENT}"

if [[ "${ENVIRONMENT}" != "dev" && "${ENVIRONMENT}" != "staging" && "${ENVIRONMENT}" != "prod" ]]; then
  echo "usage: $0 <dev|staging|prod> [--dry-run]" >&2
  exit 2
fi
if [[ ! -d "${ENV_DIR}" ]]; then
  echo "missing environment directory: ${ENV_DIR}" >&2
  exit 2
fi

cd "${ENV_DIR}"

if [[ "${DRY_RUN}" == "--dry-run" ]]; then
  echo "DRY-RUN: would execute the migrations job against ${ENVIRONMENT}:"
  echo "  cd infra/environments/${ENVIRONMENT} && terraform output -raw ecs_cluster_name / ecs_service_name"
  echo "  aws ecs describe-services          (reuse the service's task def + network placement)"
  echo "  aws ecs run-task --overrides '{\"containerOverrides\":[{\"name\":\"api\",\"command\":[\"npm\",\"run\",\"migrate\"]}]}'"
  echo "  aws ecs wait tasks-stopped         (assert containers[0].exitCode == 0)"
  echo "the run never proceeds past a failed migration; the running service keeps the old code."
  exit 0
fi

CLUSTER="$(terraform output -raw ecs_cluster_name)"
SERVICE="$(terraform output -raw ecs_service_name)"
TASK_FAMILY="$(terraform output -raw ecs_task_definition_family)"
# The migrate task reuses the SERVICE's network placement (same subnets +
# security group the service tasks use), read via the ECS API.
TASK_DEF_ARN="$(aws ecs describe-services --cluster "${CLUSTER}" --services "${SERVICE}" \
  --query 'services[0].taskDefinition' --output text)"
NET_CONFIG="$(aws ecs describe-services --cluster "${CLUSTER}" --services "${SERVICE}" \
  --query 'services[0].networkConfiguration.awsvpcConfiguration' --output json)"
SUBNETS="$(printf '%s' "${NET_CONFIG}" | jq -r '.subnets | join(",")')"
SECURITY_GROUPS="$(printf '%s' "${NET_CONFIG}" | jq -r '.securityGroups | join(",")')"

RUN_TASK_ARGS=(
  run-task
  --cluster "${CLUSTER}"
  --task-definition "${TASK_DEF_ARN}"
  --launch-type FARGATE
  --network-configuration
  "awsvpcConfiguration={subnets=[${SUBNETS}],securityGroups=[${SECURITY_GROUPS}],assignPublicIp=DISABLED}"
  --overrides "{\"containerOverrides\":[{\"name\":\"api\",\"command\":[\"npm\",\"run\",\"migrate\"]}]}"
)

echo "Running migrations job on ${ENVIRONMENT} (task family ${TASK_FAMILY})..."
TASK_ARN="$(aws ecs "${RUN_TASK_ARGS[@]}" --query 'tasks[0].taskArn' --output text)"

aws ecs wait tasks-stopped --cluster "${CLUSTER}" --tasks "${TASK_ARN}"

EXIT_CODE="$(aws ecs describe-tasks --cluster "${CLUSTER}" --tasks "${TASK_ARN}" \
  --query 'tasks[0].containers[0].exitCode' --output text)"
STOP_REASON="$(aws ecs describe-tasks --cluster "${CLUSTER}" --tasks "${TASK_ARN}" \
  --query 'tasks[0].stoppedReason' --output text)"

if [[ "${EXIT_CODE}" != "0" ]]; then
  echo "migrations FAILED on ${ENVIRONMENT}: exitCode=${EXIT_CODE} (${STOP_REASON})" >&2
  echo "the deploy MUST NOT proceed — the running service keeps serving on the old schema-safe code" >&2
  exit 1
fi

echo "migrations applied cleanly on ${ENVIRONMENT} (task $(basename "${TASK_ARN}"))"
