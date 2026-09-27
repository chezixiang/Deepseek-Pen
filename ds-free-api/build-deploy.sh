#!/bin/bash
# 构建 ds-free-api：宿主测试 + aarch64 release + upx + 部署到 app/backend
#
# 注意：必须以非 login shell 跑（wsl bash script）时 PATH 不含 ~/.cargo/bin，
# cargo 会 command not found；且下方各步都接了 | tail/grep（管道吞退出码），
# set -e 拦不住——曾静默跳过编译、把旧二进制当新版本拷走（2026-09-25 实证）。
# 这里显式补 PATH，并给关键步骤加 pipefail。
set -e -o pipefail
cd /mnt/g/youdao/Deepseek/ds-free-api
export PATH="$HOME/.cargo/bin:$PATH"

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
