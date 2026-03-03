#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY="$SCRIPT_DIR/target/release/wavemesh-builder"
DTRACE_OUT="/tmp/wavemesh-dtrace.out"

# Build release (frame pointers + debug symbols enabled via .cargo/config.toml and Cargo.toml)
cargo build --release --manifest-path "$SCRIPT_DIR/Cargo.toml"

# Run under dtrace:
#   -c: launch command and trace it
#   profile-97: sample at 97 Hz (prime to avoid aliasing)
#   /pid == $target/: only trace our process
#   ustack(200): capture up to 200 userland frames
sudo dtrace -c "$BINARY $*" \
  -n 'profile-97 /pid == $target/ { @[tid, ustack(200)] = count(); }' \
  -o "$DTRACE_OUT" 2>&1

# Summarize with atos -i inline resolution
python3 "$SCRIPT_DIR/profile-dtrace-summary.py" "$DTRACE_OUT"
