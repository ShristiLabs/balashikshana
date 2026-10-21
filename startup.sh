#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

mkdir -p .pids logs

echo "=== Starting Balashikshana Platform ==="

# 1. Start Backend PostgreSQL-backed Sync API (Port 4000)
# Requires the compose PostgreSQL: docker compose -f docker/docker-compose.yml up -d postgres
if [ -f .pids/api.pid ] && kill -0 "$(cat .pids/api.pid)" 2>/dev/null; then
  echo "[API] Already running (PID $(cat .pids/api.pid))"
else
  PORT=4000 nohup node --no-warnings services/api/server.mjs > logs/api.log 2>&1 &
  echo $! > .pids/api.pid
  echo "[API] Started on http://localhost:4000 (PID $(cat .pids/api.pid))"
fi

# 2. Start Cross-Platform Interactive App Server (Port 4200)
if [ -f .pids/app.pid ] && kill -0 "$(cat .pids/app.pid)" 2>/dev/null; then
  echo "[App] Already running (PID $(cat .pids/app.pid))"
else
  PORT=4200 API_URL="http://localhost:4000" nohup node apps/mobile/server.mjs > logs/app.log 2>&1 &
  echo $! > .pids/app.pid
  echo "[App] Started on http://localhost:4200 (PID $(cat .pids/app.pid))"
fi

echo "=== Balashikshana is running! ==="
echo "  Interactive Learning App : http://localhost:4200"
echo "  Sync & Analytics API     : http://localhost:4000/api/health"
