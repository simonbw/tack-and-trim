# Rust Pipeline Port Plan

**Status (2026-04-30): completed and superseded.** Every step described
below has been ported to Rust and now lives in `pipeline/build-level/`
(plus `pipeline/mesh-builder/` for the wave mesh and
`pipeline/query-wasm/` for the runtime kernel). The legacy TypeScript
implementation under `src/pipeline/terrain-import/` was deleted long
ago. This document is kept only as historical migration context — do
not treat its priority list as outstanding work.

If you are looking for the current pipeline structure, start at:

- `pipeline/build-level/` — single binary covering download, grid
  build, contour extraction, level validation, and wave mesh build.
  Run as `bin/build-level [--level <name>]`.
- `pipeline/pipeline-core/` — shared library crate.
- `pipeline/mesh-builder/` — wave mesh ray-marcher (still a
  separate crate, invoked from `build-level`).
- `pipeline/query-wasm/` — runtime WASM kernel for world queries.

The remainder of this file is the original plan, preserved verbatim
below.

---

## Original Plan (historical)

This document outlined what TypeScript pipeline code remained to be ported to Rust, and how to structure it to maximize code sharing with the existing `mesh-builder`.

## Current State

The pipeline has one Rust implementation today:

- **`pipeline/mesh-builder/`** — ray-marching wavefront mesh builder. Takes `.level.json` → produces `.wavemesh`.

At the time this plan was written, the remaining TypeScript pipeline lived in `src/pipeline/terrain-import/` and `bin/`:

| Step | TypeScript file | Status |
|------|----------------|--------|
| Download tiles | `download.ts` | **Done** (ported to `pipeline/build-level/src/download.rs`) |
| Merge tiles to grid | `build-grid.ts` | **Done** (ported to `pipeline/build-level/src/build_grid.rs`) |
| Extract contours | `extract-contours.ts` | **Done** (ported to `pipeline/build-level/src/extract.rs` + `marching.rs` + `simplify.rs`) |
| Validate level | `validate-level.ts` | **Done** (ported to `pipeline/build-level/src/validate.rs`) |
| Run full pipeline | `run-all.ts` | **Done** (`build-level` is the unified orchestrator) |
| Build wavemesh | _(npm script)_ | **Done** |
| Generate asset types | `bin/generate-asset-types.ts` | Not applicable (see below) |

---

## What Not to Port

**`bin/generate-asset-types.ts`** — Generates TypeScript `.d.ts` files from the `resources/` folder for use in the TypeScript codebase. This is deeply coupled to the TypeScript/Parcel build system and has no performance bottleneck. It should stay in Node.js.

**`bin/dev-server.ts`** — HTTP proxy that adds COOP/COEP headers. No reason to port.

**`bin/synthesize-sounds.mjs`** — Trivial DSP script, rarely run. No reason to port.

---

## What to Port (and Why)

### Priority 1: Contour Extractor

**Source**: `extract-contours.ts` + `worker/` + `util/simplify.ts` + `util/constrained-simplify.ts` + `util/segment-index.ts`

This is the highest-value port. It is compute-intensive (marching squares runs in workers via `SharedArrayBuffer`), and the output (`.level.json`) feeds directly into the existing Rust mesh-builder. Porting it would:

- Eliminate the Node.js worker thread machinery
- Allow the contour extractor and mesh-builder to eventually be one unified binary
- Naturally share the `ContourTree` and terrain spatial structures already in `mesh-builder`

**Key algorithms to implement in Rust:**

1. **Scalar grid** — 2D elevation grid with bilinear access
2. **Block index** — Fast level-skip optimization for marching squares
3. **Marching squares** — Full 16-case lookup table with saddle disambiguation
4. **Ring tracer** (`buildClosedRings`) — Assembles march segments into closed polygons
5. **Ramer-Douglas-Peucker** — Simplification for closed rings (`simplify.ts`, `constrained-simplify.ts`)
6. **Constrained RDP** — RDP variant that refuses to collapse spans that cross already-finalized contours; uses spatial segment index for intersection queries
7. **Segment index** (`segment-index.ts`) — Spatial grid for O(1) intersection queries (needed by constrained RDP)
8. **Level serializer** — Write `.level.json` with the game's coordinate system (geo feet, CCW winding, centered bbox)

**Shareable from `mesh-builder`:**
- `level.rs`: `ContourPoint`, `LevelFileJSON`, coordinate helpers
- `terrain.rs`: `ContourTree` and DFS traversal (already built for wavemesh; contour extractor also produces a tree)
- `wavefront.rs` / `bounds.rs`: domain bounds math

---

### Priority 2: Level Validator

**Source**: `validate-level.ts`

Validates a `.level.json` file for logical consistency: contour overlap, nesting/containment invariants, degenerate polygons. Currently TypeScript; should be a fast Rust CLI so it can be called from CI or as part of a unified pipeline binary without Node.js overhead.

**Key logic to implement:**

1. Load and parse `.level.json` (already exists in `level.rs` — just reuse)
2. Winding number / containment checks between polygon pairs
3. Self-intersection detection
4. Nesting validation against contour tree

**Shareable from `mesh-builder`:**
- `level.rs`: deserialization
- `terrain.rs`: `ContainmentGrid`, winding number algorithm, contour tree
- Nearly all of this is a thin CLI wrapper around existing code

---

### Priority 3: Terrain Downloader

**Source**: `download.ts`

Downloads GeoTIFF elevation tiles from NOAA CUDEM, USACE S3, and EMODnet WCS. Currently Node.js with `fetch`. The port is straightforward with `reqwest` and `tokio`, and would enable a fully self-contained Rust pipeline.

**Key functionality:**

1. **NOAA CUDEM** — Scrape directory listing HTML, parse tile filenames, filter by bbox using CUDEM naming convention, download missing tiles
2. **USACE S3** — Fetch `urllist<id>.txt` from S3 bucket, filter by state prefix + bbox, download tiles
3. **EMODnet WCS** — Single WCS `GetCoverage` request, clip to bbox, save GeoTIFF

**Dependencies:**
- `reqwest` (async HTTP)
- `tokio` (async runtime)
- `scraper` or `html5ever` (HTML parsing for CUDEM directory listing)

**Shareable from `mesh-builder`:**
- `util/geo-utils.ts` logic → new `geo.rs` module: lat/lon projection, bbox math, CUDEM filename parsing

---

### Priority 4: Grid Builder (Tile Merger)

**Source**: `build-grid.ts`

Merges downloaded GeoTIFF tiles into a single elevation grid via `gdalwarp`. This is the trickiest step to port because GDAL is a large C library with Rust bindings (`gdal` crate) that add significant build complexity.

**Options:**

1. **Keep calling `gdalwarp`** — Wrap it from Rust using `std::process::Command`, same as today. Simple, no new dependency.
2. **Use `gdal` crate** — Native Rust bindings. Full control, but GDAL must be installed system-wide and the crate has a heavy build.
3. **Implement GeoTIFF reading directly** — The CUDEM tiles are simple single-band float32 GeoTIFFs. A minimal TIFF reader + affine transform + bilinear resampling could replace `gdalwarp` with zero external dependencies.

Option 1 is the pragmatic choice unless build portability becomes a requirement. Option 3 is the most self-contained and worth exploring given the simplicity of the input format.

**Key functionality (if implementing directly):**

1. Read GeoTIFF headers (TIFF tags: image dimensions, strip offsets, geo transform)
2. Parse GeoTIFF metadata: CRS, affine transform, nodata value
3. Reproject + merge overlapping tiles into a single float32 grid
4. Cache merged grid to binary format (currently `grid-cache.ts` binary format)

**Shareable from `mesh-builder`:** minimal (bounds math)

---

### Priority 5: Unified Pipeline Orchestrator

**Source**: `run-all.ts`

Once the above tools exist as Rust library crates, a top-level `terrain-import` (or `pipeline`) binary can orchestrate the full pipeline without Node.js:

```
terrain-import --region san-juan-islands
  → download tiles
  → merge grid (gdalwarp or native)
  → extract contours → .level.json
  → build wavemesh → .wavemesh
```

The mesh-builder's `main.rs` entry point logic (glob levels, run per-source) would be merged or called as a library.

---

## Recommended Repository Structure

Move to a **Cargo workspace** so crates can share code:

```
pipeline/
  Cargo.toml            ← workspace root
  mesh-builder/     ← existing binary crate (unchanged externally)
  pipeline-core/         ← new shared library crate
  terrain-import/       ← new binary crate (steps 1-3 + orchestrator)
  level-validate/       ← new binary crate (or fold into terrain-import)
```

### `pipeline-core` (shared library)

Extract the following from `mesh-builder` into a shared crate:

| Module | What to put there |
|--------|-------------------|
| `level.rs` | `LevelFileJSON`, `ContourData`, `WaveSource`, Catmull-Rom sampling |
| `terrain.rs` (subset) | `ContourTree`, `ContourPoint`, coordinate math, containment/winding |
| `geo.rs` (new) | Lat/lon projection, bbox math, CUDEM filename parsing (from `geo-utils.ts`) |
| `simplify.rs` (new) | RDP for polylines + closed rings, signed area, ring perimeter |
| `segment_index.rs` (new) | Spatial grid for segment intersection queries |
| `wavemesh_file.rs` | Binary format parsing + writing, FNV-1a hashing |

`mesh-builder` would then depend on `pipeline-core` instead of containing these modules directly.

### `terrain-import` (binary)

New crate, depends on `pipeline-core`. Implements:
- `download.rs` — tile fetching (CUDEM, USACE, EMODnet)
- `grid.rs` — tile merging (wraps `gdalwarp` or native reader)
- `grid_cache.rs` — binary grid cache I/O (port of `grid-cache.ts`)
- `marching.rs` — marching squares + block index + ring tracer
- `contrained_simplify.rs` — constrained RDP using `pipeline-core::segment_index`
- `extract.rs` — top-level contour extraction entry point
- `main.rs` — CLI with `clap` (subcommands: `download`, `build-grid`, `extract`, `validate`, or combined `import`)

### `level-validate` (binary or subcommand)

Thin CLI over `pipeline-core`. May just be a subcommand of `terrain-import`.

---

## Migration Strategy

Because this is an offline pipeline (not game runtime), migration can be gradual:

1. **Create workspace** — Add `pipeline/Cargo.toml` workspace, move `mesh-builder` in without changing it.
2. **Extract `pipeline-core`** — Refactor shared modules out of `mesh-builder` into the new library crate. All existing functionality preserved; just a restructure.
3. **Port `level-validate`** — Small, fast win. Reuses `pipeline-core` heavily.
4. **Port `extract-contours`** — High value, no external dependencies. Builds on `pipeline-core`.
5. **Port `download`** — Straightforward async HTTP. New dependency (`reqwest`/`tokio`).
6. **Port `build-grid`** — Wrap `gdalwarp` from Rust to unify the CLI, or implement native reader.
7. **Unify orchestrator** — Single `terrain-import import --region <name>` command runs everything.

npm scripts (`download-terrain`, `build-terrain-grid`, `extract-terrain-contours`, `import-terrain`) can be updated to call Rust binaries rather than Node.js scripts at each step, with no change to the developer interface.

---

## Summary

| Component | Port value | Complexity | Shares with mesh-builder |
|-----------|-----------|------------|-------------------------------|
| Level validator | High | Low | `level.rs`, `terrain.rs` (containment) |
| Contour extractor | High | Medium | `level.rs`, `ContourTree` |
| Terrain downloader | Medium | Low-Medium | geo math → `pipeline-core` |
| Grid builder | Medium | High (GDAL) | minimal |
| Pipeline orchestrator | High (once above done) | Low | all of it |
