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

1. Enable debug symbols in the release build (needed for function names in the profile):

```toml
# pipeline/wavemesh-builder/Cargo.toml
[profile.release]
debug = true  # add this temporarily
```

2. Rebuild and profile:

```sh
cargo build --release --manifest-path pipeline/wavemesh-builder/Cargo.toml
samply record ./pipeline/wavemesh-builder/target/release/wavemesh-builder
```

This runs the full build under the profiler and opens the Firefox Profiler UI in your browser. The flame graph and call tree tabs show where time is spent; the timeline shows per-thread activity.

3. To save a profile for later analysis without opening the browser:

```sh
samply record --save-only -o /tmp/wavemesh-profile.json ./pipeline/wavemesh-builder/target/release/wavemesh-builder
samply load /tmp/wavemesh-profile.json  # open it later
```

4. Remember to remove `debug = true` from Cargo.toml when done.

### Quick text-based profiling with macOS `sample`

For a text-based profile (no GUI needed), use macOS's built-in `sample` command:

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

### What to look for

- **Thread utilization**: Each worker thread's samples split between `_pthread_cond_wait` (idle, waiting for work) and actual computation. Poor utilization means uneven work distribution.
- **Hot functions**: `compute_terrain_height_and_gradient`, `min_dist_with_gradient_grid`, `winding_number_test`, `refine_wavefront`, `post_process_segments` are the key ones.
- **Allocation overhead**: `grow_one` / `realloc` / `_platform_memmove` samples indicate Vec resizing — fix with `with_capacity`.
