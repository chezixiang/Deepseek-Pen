#!/bin/bash
# 构建 ds-free-api：宿主测试 + aarch64 release + upx + 部署到 app/backend
set -e
cd /mnt/g/youdao/Deepseek/ds-free-api

echo "=== host tests ==="
CARGO_TARGET_DIR=target-wsl cargo test --lib --target x86_64-unknown-linux-gnu \
  --config 'env.CC="gcc"' --config 'env.CXX="g++"' --config 'env.AR="ar"' \
  --config 'build.target=""' 2>&1 | grep -E 'test result|^error' | head -5

echo "=== aarch64 release build ==="
cargo build --release 2>&1 | tail -2

echo "=== upx ==="
upx --lzma -f target/aarch64-unknown-linux-gnu/release/ds-free-api 2>&1 | tail -2

echo "=== deploy ==="
cp -f target/aarch64-unknown-linux-gnu/release/ds-free-api /mnt/g/youdao/Deepseek/app/backend/linux-aarch64-gnu/ds-free-api
ls -la /mnt/g/youdao/Deepseek/app/backend/linux-aarch64-gnu/ds-free-api
