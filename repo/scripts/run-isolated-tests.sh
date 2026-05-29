#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

TIMESTAMP="$(date +%Y%m%d_%H%M%S)_$(uuidgen | cut -c1-8 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null | cut -c1-8 || echo $RANDOM)"
TEMP_DB_DIR="$(mktemp -d -t wdc-isolated-test-XXXXXXXXXX)"
TEMP_DB_PATH="${TEMP_DB_DIR}/test_${TIMESTAMP}.db"
export DATABASE_URL="file:${TEMP_DB_PATH}"

cleanup() {
  local exit_code=$?
  echo ""
  echo "=== 清理临时数据库 ==="
  if [ -f "$TEMP_DB_PATH" ]; then
    rm -f "$TEMP_DB_PATH"
    echo "已删除临时数据库: ${TEMP_DB_PATH}"
  fi
  if [ -f "${TEMP_DB_PATH}-journal" ]; then
    rm -f "${TEMP_DB_PATH}-journal"
  fi
  if [ -d "$TEMP_DB_DIR" ]; then
    rmdir "$TEMP_DB_DIR" 2>/dev/null || true
  fi
  exit $exit_code
}

trap cleanup EXIT

echo "=== 隔离测试环境 ==="
echo "临时数据库路径: ${TEMP_DB_PATH}"
echo "DATABASE_URL:     ${DATABASE_URL}"
echo ""

cd "$PROJECT_ROOT"

echo "=== 初始化数据库结构 ==="
npx prisma db push --skip-generate --accept-data-loss 2>&1
echo ""

echo "=== 运行全部测试 ==="
npx vitest run 2>&1