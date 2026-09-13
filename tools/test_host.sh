#!/bin/bash
# Host-target unit tests (aarch64 test binaries can't execute on x86_64 WSL).
set -o pipefail
export PATH="$HOME/.cargo/bin:$PATH"
cd /mnt/d/codes/youdao/Deepseek/ds-free-api/ds-free-api-0.2.6 || exit 1
cargo test --target x86_64-unknown-linux-gnu \
  --config 'env.CC="gcc"' --config 'env.CXX="g++"' --config 'env.AR="ar"' 2>&1 | tail -80
