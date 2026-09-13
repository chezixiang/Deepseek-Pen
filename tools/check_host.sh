#!/bin/bash
# Host-target cargo check. The repo's .cargo/config.toml pins CC at the aarch64
# cross compiler, which breaks host builds, so override the toolchain env vars.
set -o pipefail
export PATH="$HOME/.cargo/bin:$PATH"
cd /mnt/d/codes/youdao/Deepseek/ds-free-api/ds-free-api-0.2.6 || exit 1
cargo check --target x86_64-unknown-linux-gnu \
  --config 'env.CC="gcc"' --config 'env.CXX="g++"' --config 'env.AR="ar"' 2>&1 | tail -60
