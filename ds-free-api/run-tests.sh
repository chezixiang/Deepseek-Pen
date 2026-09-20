#!/bin/bash
# 宿主目标单测（.cargo/config.toml 强制 aarch64，需覆盖 target 与工具链）
set -e
cd /mnt/g/youdao/Deepseek/ds-free-api
CARGO_TARGET_DIR=target-wsl cargo test --lib \
  --target x86_64-unknown-linux-gnu \
  --config 'env.CC="gcc"' --config 'env.CXX="g++"' --config 'env.AR="ar"' \
  --config 'build.target=""' 2>&1 | grep -E "test result|^error|panicked" | head -8
