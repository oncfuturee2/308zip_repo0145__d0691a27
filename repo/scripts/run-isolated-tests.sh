#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

TIMESTAMP=$(date +%s)
UUID=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)
ISOLATED_DB_NAME="test_isolated_${TIMESTAMP}_${UUID}.db"
ISOLATED_DB_PATH="$PROJECT_ROOT/$ISOLATED_DB_NAME"
ISOLATED_DB_URL="file:$ISOLATED_DB_PATH"

cleanup() {
    if [ -n "$ISOLATED_DB_PATH" ] && [ -f "$ISOLATED_DB_PATH" ]; then
        rm -f "$ISOLATED_DB_PATH"
    fi
}

trap cleanup EXIT

cd "$PROJECT_ROOT"

export DATABASE_URL="$ISOLATED_DB_URL"

npx prisma db push --skip-generate --skip-shadow --accept-data-loss

npx vitest run

exit $?