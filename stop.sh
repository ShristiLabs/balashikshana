#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

echo "=== Stopping Balashikshana Platform ==="

for svc in app api; do
  if [ -f ".pids/${svc}.pid" ]; then
    PID="$(cat ".pids/${svc}.pid")"
    if kill -0 "$PID" 2>/dev/null; then
      kill "$PID" || true
      echo "Stopped ${svc} (PID ${PID})"
    fi
    rm -f ".pids/${svc}.pid"
  fi
done

echo "=== Balashikshana stopped ==="
