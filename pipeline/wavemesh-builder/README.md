# wavemesh-builder

Rust pipeline for building wave propagation meshes from terrain data. Replaces the TS mesh-building pipeline with significantly faster execution.

## Building

```sh
npm run build-wavemesh
```

This builds the release binary and runs it against all levels in `resources/levels/`.

## Profiling

### Setup

Install [samply](https://github.com/jlfwong/samply) (sampling profiler for Rust, opens Firefox Profiler UI):

```sh
cargo install samply
```

### Collecting a profile

Debug symbols are always enabled in the release build (`debug = true` in Cargo.toml) so profilers can resolve function names. This has no runtime cost.

```sh
cargo build --release --manifest-path pipeline/wavemesh-builder/Cargo.toml
samply record ./pipeline/wavemesh-builder/target/release/wavemesh-builder
```

This runs the full build under the profiler and opens the Firefox Profiler UI in your browser. The flame graph and call tree tabs show where time is spent; the timeline shows per-thread activity.

To save a profile for later analysis without opening the browser:

```sh
samply record --save-only -o /tmp/wavemesh-profile.json ./pipeline/wavemesh-builder/target/release/wavemesh-builder
samply load /tmp/wavemesh-profile.json  # open it later
```

### Quick summary with `profile.py`

The `profile.py` script captures a macOS `sample` profile during the san-juan-islands build and prints a summary with per-thread utilization and categorized time breakdown:

```sh
# Capture and analyze in one step (requires debug = true in Cargo.toml):
python3 pipeline/wavemesh-builder/profile.py

# Or analyze an existing sample file:
python3 pipeline/wavemesh-builder/profile.py /tmp/wavemesh-sample.txt
```

The script categorizes terrain time into containment (bbox/winding number) vs IDW distance (nearest-edge search), and reports per-thread idle time broken down by cause (sleeping, spinning, mutex contention).

Note: the terrain sub-categories use source line number ranges that may need updating if `terrain.rs` is significantly restructured. See `TERRAIN_CONTAINMENT_LINES` and `TERRAIN_IDW_LINES` in the script.

### Raw profiling with macOS `sample`

For a raw text-based profile (no GUI needed), use macOS's built-in `sample` command:

```sh
# Start the build in the background
./pipeline/wavemesh-builder/target/release/wavemesh-builder &
PID=$!

# Wait for it to reach the hot loop (san-juan-islands), then sample
sleep 20
sample $PID 30 -f /tmp/wavemesh-sample.txt

# The output file has:
# - Call tree with sample counts per function (top of file)
# - Per-thread breakdown showing idle vs working time
# - "Total number in stack" summary at the bottom
```
