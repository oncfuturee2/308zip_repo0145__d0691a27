#!/bin/bash
set -e

cd /app

export DATABASE_URL="file:./dev.db"

npx prisma db push --skip-generate

exec node dist/index.js
