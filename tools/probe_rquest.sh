#!/bin/bash
# Dump the full Chrome emulation default-header block from rquest-util.
D=$(ls -d /home/aquavie/.cargo/registry/src/*/rquest-util-2.2.1 2>/dev/null | head -1)
echo "=== macros.rs lines 1-80"
sed -n '1,80p' "$D/src/emulation/device/macros.rs"
echo
echo "=== chrome.rs header_initializer 85-150"
sed -n '85,150p' "$D/src/emulation/device/chrome.rs"
