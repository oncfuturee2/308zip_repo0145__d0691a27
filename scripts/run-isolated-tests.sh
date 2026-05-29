#!/bin/bash
set -e

# Generate a temporary SQLite DB file path using timestamp and random number
TEMP_DB_NAME="test-$(date +%s)-${RANDOM}.db"
export DATABASE_URL="file:./${TEMP_DB_NAME}"

# Trap to clean up the DB file on exit (success or error)
cleanup() {
    echo "Cleaning up temporary database: ${TEMP_DB_NAME}"
    rm -f "prisma/${TEMP_DB_NAME}" "prisma/${TEMP_DB_NAME}-journal" "prisma/${TEMP_DB_NAME}-wal" "prisma/${TEMP_DB_NAME}-shm"
}

trap cleanup EXIT

echo "Initializing temporary database..."
npx prisma db push --skip-generate

echo "Running tests in isolated environment..."
npx vitest run
