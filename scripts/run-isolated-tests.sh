#!/bin/bash

set -e

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
UUID=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || echo "$(date +%s%N)")
TEMP_DB_PATH="/tmp/webhook_test_${TIMESTAMP}_${UUID}.db"
DATABASE_URL="file:${TEMP_DB_PATH}"

cleanup() {
  if [ -f "${TEMP_DB_PATH}" ]; then
    echo "Cleaning up temporary database: ${TEMP_DB_PATH}"
    rm -f "${TEMP_DB_PATH}"
    rm -f "${TEMP_DB_PATH}-journal" 2>/dev/null || true
  fi
}

trap cleanup EXIT

echo "Using temporary database: ${DATABASE_URL}"
export DATABASE_URL

echo "Initializing database schema..."
npx prisma db push --skip-generate

echo "Running tests..."
npx vitest run

echo "Tests completed successfully!"
