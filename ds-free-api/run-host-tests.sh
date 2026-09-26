#!/bin/bash
# 宿主机（x86_64 WSL）跑单测：本仓库 .cargo/config.toml 把默认 target 钉到 aarch64，
# 交叉编译产物在本机跑不了，所以这里显式覆盖 target / linker。
cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.cargo/bin:$PATH"
CARGO_TARGET_DIR=target-wsl cargo test --lib \
  --target x86_64-unknown-linux-gnu \
  --config 'env.CC="gcc"' --config 'env.CXX="g++"' --config 'env.AR="ar"' \
  --config 'build.target=""' "$@"
