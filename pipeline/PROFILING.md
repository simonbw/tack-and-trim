# Profiling Rust Pipeline Crates

The `profile-samply.sh` script profiles any Rust crate in the pipeline workspace using [samply](https://github.com/jlfwong/samply), which records a sampling profile and opens it in Firefox Profiler.

## Setup

```sh
cargo install samply
```

## Usage

```sh
# Profile build-level (default crate):
./pipeline/profile-samply.sh

# Profile wavemesh-builder:
./pipeline/profile-samply.sh -p wavemesh-builder

# Pass arguments to the binary after --:
./pipeline/profile-samply.sh -p wavemesh-builder -- --level resources/levels/san-juan-islands.level.json

# See help:
./pipeline/profile-samply.sh -h
```

npm shortcuts:

```sh
npm run profile-terrain:samply
npm run profile-wavemesh:samply
npm run profile-wavemesh:samply-view   # open last saved profile in Firefox Profiler
```

## What it does

1. Builds the crate in release mode (with debug symbols and frame pointers for stack walking)
2. Runs it under `samply record` at 1kHz sampling rate
3. Saves the profile to `pipeline/profile-samply.json`
4. Runs `profile-samply-summary.py` to print a categorized summary with:
   - Thread utilization and effective core count
   - Worker timeline and idle-overlap attribution
   - Time breakdown by category (terrain, marching, decimation, etc.)
   - Top functions by self-time and de-wrapped self-time
   - Project ownership (first project frame on stack)

## Viewing profiles interactively

```sh
samply load pipeline/profile-samply.json
```

This opens the Firefox Profiler UI with flame graphs, call trees, and per-thread timelines.

## Files produced

| File | Description |
|------|-------------|
| `profile-samply.json` | Firefox Profiler JSON (gitignored) |
| `profile-samply.syms.json` | Symbol sidecar from `--unstable-presymbolicate` |
| `profile-samply.meta.json` | Wall-clock timing and binary metadata |
| `profile-samply.atos-cache.<binary>.json` | Cached `atos -i` inline resolution results (macOS) |

All output files live in `pipeline/` and are gitignored.
