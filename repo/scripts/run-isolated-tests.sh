#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TIMESTAMP="$(date +%Y%m%d%H%M%S)"

if command -v uuidgen >/dev/null 2>&1; then
  UNIQUE_ID="$(uuidgen)"
else
  UNIQUE_ID="$(node -e "console.log(require('node:crypto').randomUUID())")"
fi

DB_FILE="/tmp/webhook-delivery-center-test-${TIMESTAMP}-${UNIQUE_ID}.db"

cleanup() {
  rm -f "$DB_FILE" "${DB_FILE}-journal" "${DB_FILE}-shm" "${DB_FILE}-wal"
}

trap cleanup EXIT

export DATABASE_URL="file:${DB_FILE}"

cd "$REPO_ROOT"

npx prisma db push --skip-generate
npx vitest run --no-file-parallelism
