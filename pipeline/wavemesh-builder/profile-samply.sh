#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY="$SCRIPT_DIR/target/release/wavemesh-builder"
OUTPUT="$SCRIPT_DIR/profile-samply.json"

# Build release (frame pointers + debug symbols enabled via .cargo/config.toml and Cargo.toml)
echo "Building release binary..."
cargo build --release --manifest-path "$SCRIPT_DIR/Cargo.toml"

# Remove stale output
rm -f "$OUTPUT" "${OUTPUT}.gz"

# Run under samply with save-only (no browser UI)
echo "Profiling with samply..."
samply record \
  --save-only \
  --no-open \
  --rate 1000 \
  --unstable-presymbolicate \
  -o "$OUTPUT" \
  -- "$BINARY" "$@"

# samply may produce .json.gz - check both
if [ -f "${OUTPUT}.gz" ]; then
  echo "Decompressing profile..."
  gunzip "${OUTPUT}.gz"
fi

if [ -f "$OUTPUT" ]; then
  echo ""
  echo "Profile saved to: $OUTPUT"
  echo "Size: $(du -h "$OUTPUT" | cut -f1)"
  echo ""
  echo "To view interactively: samply load $OUTPUT"
  echo ""
  # Show a quick summary of the format
  echo "Format preview (first 500 chars):"
  head -c 500 "$OUTPUT"
  echo ""
  echo ""
  echo "Analyzing profile (humanized summary)..."
  python3 "$SCRIPT_DIR/profile-samply-summary.py" "$OUTPUT"
else
  echo "ERROR: No profile output found"
  exit 1
fi
