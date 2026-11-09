#!/usr/bin/env bash
# Starts a local MinIO for development when Docker isn't available.
# Prefer `docker compose up -d` (see docker-compose.yml) on a normal dev machine.
set -euo pipefail
cd "$(dirname "$0")/.."
BIN="${MINIO_BIN:-.dev/minio}"
DATA=".dev/minio-data"
mkdir -p "$DATA"
export MINIO_ROOT_USER="${S3_ACCESS_KEY_ID:-loupe-dev-access}"
export MINIO_ROOT_PASSWORD="${S3_SECRET_ACCESS_KEY:-loupe-dev-secret-change-me}"
export MINIO_API_CORS_ALLOW_ORIGIN="${APP_URL:-http://localhost:3000}"
exec "$BIN" server "$DATA" --address :9000 --console-address :9001
