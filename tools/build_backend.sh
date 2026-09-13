#!/bin/bash
# Cross-compile ds-free-api for aarch64, UPX-compress, and stage into the app.
set -e
export PATH="$HOME/.cargo/bin:$PATH"
cd /mnt/d/codes/youdao/Deepseek/ds-free-api/ds-free-api-0.2.6

echo "=== cargo build --release (aarch64) ==="
cargo build --release

BIN=target/aarch64-unknown-linux-gnu/release/ds-free-api
ls -l "$BIN"

echo "=== upx --lzma ==="
upx --lzma "$BIN" || echo "(upx returned non-zero; AlreadyPackedException is harmless)"
ls -l "$BIN"

echo "=== copy into app ==="
cp -f "$BIN" /mnt/d/codes/youdao/Deepseek/app/backend/linux-aarch64-gnu/ds-free-api
ls -l /mnt/d/codes/youdao/Deepseek/app/backend/linux-aarch64-gnu/ds-free-api
echo "=== DONE ==="
