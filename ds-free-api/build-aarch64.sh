#!/bin/bash
# 交叉编译 ds-free-api（aarch64）+ UPX 压缩 + 拷进 app/backend/（供内嵌打包）。
#
# 用法（Windows 侧）：
#   wsl -d Ubuntu-24.04 -- bash -c 'cd /mnt/f/youdao/Deepseek/ds-free-api && bash build-aarch64.sh'
# 随后在 app/ 里跑 npm run build:prod（会自动 node scripts/inline-backend.js 内嵌新二进制）。
#
# UPX 若不在 PATH，可用 UPX_BIN=/path/to/upx 指定（例如 /tmp/upx-4.2.4-amd64_linux/upx）。
set -e
cd "$(dirname "$0")"
export PATH="$HOME/.cargo/bin:$PATH"

echo "=== cargo build --release (aarch64) ==="
cargo build --release

BIN=target/aarch64-unknown-linux-gnu/release/ds-free-api
ls -l "$BIN"

UPX="${UPX_BIN:-$(command -v upx || true)}"
# WSL 的 /tmp 会随会话清理，把 upx 放在 ~/.local/bin 更稳
[ -z "$UPX" ] && [ -x "$HOME/.local/bin/upx" ] && UPX="$HOME/.local/bin/upx"
if [ -n "$UPX" ]; then
  echo "=== upx --lzma ($UPX) ==="
  "$UPX" --lzma -f "$BIN" | tail -2
else
  echo "=== 未找到 upx：跳过压缩（UPX_BIN=/path/to/upx 可指定）；"
  echo "    警告：未压缩的二进制约 14 MB，内嵌后 base64 会让应用包明显变大 ==="
fi
ls -l "$BIN"

echo "=== 复制到 app/backend ==="
cp -f "$BIN" ../app/backend/linux-aarch64-gnu/ds-free-api
ls -l ../app/backend/linux-aarch64-gnu/ds-free-api
echo "=== DONE（接着跑 app/ 下的 npm run build:prod） ==="
