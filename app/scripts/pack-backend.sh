#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$APP_DIR/backend"

if [ ! -d "$BACKEND_DIR" ]; then
  echo "[pack-backend] backend/ 目录不存在，跳过 ds-free-api 打包" >&2
  exit 0
fi

# 确保二进制有可执行权限（Linux/macOS 构建环境）
chmod +x "$BACKEND_DIR"/linux-*/ds-free-api 2>/dev/null || true

echo "[pack-backend] ds-free-api 后端二进制已就绪"
ls -la "$BACKEND_DIR"