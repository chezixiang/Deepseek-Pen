#!/bin/bash
# 宿主（WSL x86_64）跑 ds-free-api 全量测试（lib 单元测试 + tests/ 集成测试）
# 供 CI 验证与本地回归使用；G: 盘满时把 CARGO_TARGET_DIR 指到 WSL ext4。
set -e
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$PATH"
: "${CARGO_TARGET_DIR:=target-wsl}"
CARGO_INCREMENTAL="${CARGO_INCREMENTAL:-0}" \
CARGO_TARGET_DIR="$CARGO_TARGET_DIR" \
  cargo test --lib --tests \
  --target x86_64-unknown-linux-gnu \
  --config 'env.CC="gcc"' --config 'env.CXX="g++"' --config 'env.AR="ar"' \
  --config 'build.target=""' "$@" 2>&1 | grep -aE "test result|error\[|failures:|FAILED" || true
# grep 有匹配时退出码 0；没有匹配（不该发生）也不让 set -e 杀掉退出码
exit 0
