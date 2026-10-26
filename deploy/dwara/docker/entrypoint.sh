#!/bin/sh
# balashikshana edge gateway entrypoint (issue #65). Bridges the two
# secret-injection conventions:
#
#   - ECS injects SecureString secrets from SSM as ENVIRONMENT variables
#     (Terraform `secrets` blocks — the #64 doctrine: no values in tf
#     source, none in the image).
#   - Dwara reads TLS material from FILES and credential values from
#     ${ENV_NAME} config references.
#
# This script writes the PEM material the task received as env into
# /etc/dwara/certs/ (tmpfs-backed task storage, never the image), then
# execs the gateway as PID 1. ${ENV} credential references resolve
# directly from the task environment — nothing to do for them here.
#
# Required env (all provisioned by infra/modules/gateway via SSM):
#   EDGE_TLS_CERT / EDGE_TLS_KEY         public listener pair
#   EDGE_TLS_CLIENT_CA                   admin API client CA bundle
#   BALASHIKSHANA_EDGE_KEY_PARENT        consumer class keys (read by
#   BALASHIKSHANA_EDGE_KEY_CHILD_DEVICE  dwara.yaml ${...} references,
#   BALASHIKSHANA_EDGE_KEY_PORTAL        never written to disk)
set -eu

CERT_DIR=/etc/dwara/certs
mkdir -p "$CERT_DIR" /var/lib/dwara

write_pem() { # name varname
  # Trailing newlines are normalized: PEM tools accept one; Dwara requires
  # the file be readable at config-compile time and rejects garbage.
  value=$(eval "printf '%s' \"\$$2\"")
  if [ -z "$value" ]; then
    echo "entrypoint: missing required env $2" >&2
    exit 1
  fi
  printf '%s\n' "$value" > "$CERT_DIR/$1"
  chmod 600 "$CERT_DIR/$1"
}

write_pem server.crt EDGE_TLS_CERT
write_pem server.key EDGE_TLS_KEY
write_pem client-ca.crt EDGE_TLS_CLIENT_CA

# Quota counters (consumer daily/monthly caps) need a state store; task
# storage keeps them per-task (documented limitation: counters reset on
# task replacement — docs/gateway.md).
export DWARA_STATE_DB="${DWARA_STATE_DB:-/var/lib/dwara/state.db}"

exec /usr/local/bin/dwara
