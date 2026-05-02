# Pipeline — Offline Build Tools

`src/pipeline/` contains offline build tooling that runs on the dev machine, never in the browser.

## Overview

1. **`build-level/`** — Rust CLI pipeline that downloads real-world bathymetry data, extracts terrain, and builds meshes.
2. **`mesh-building/`** — Shared `.wavemesh` format/types used by runtime loading and tooling.

The canonical Rust pipeline lives under `pipeline/`:

- `pipeline/build-level/` for terrain download/extract/validation and mesh building
- `pipeline/mesh-builder/` for wave-mesh generation

## File Layout

```
resources/levels/<slug>.level.json      -- Level definition (hand-written, small)
                                           Levels with real-world terrain include a `region` field
                                           with extraction config (bbox, data source, etc.)

static/levels/<slug>.terrain            -- Extracted terrain (generated binary, large)
static/levels/<slug>.wavemesh           -- Prebuilt wave mesh
static/levels/<slug>.windmesh           -- Prebuilt wind mesh
static/levels/<slug>.trees              -- Prebuilt tree positions

assets/terrain/<slug>/tiles/            -- Downloaded elevation tiles (cached)
assets/terrain/<slug>/cache/            -- Merged grid cache
```

## Data Flow

```
NOAA CUDEM GeoTIFF tiles
  ↓  build-level download
assets/terrain/<slug>/tiles/*.tif
  ↓  build-level build-grid  (gdalwarp)
assets/terrain/<slug>/cache/merged.tif
  ↓  build-level extract
     (marching squares → ring assembly → simplification → validation)
static/levels/<slug>.terrain
  ↓  build-level (default command, or build-level --level <name>)
     Level file's `region` field drives the pipeline; mesh builder resolves the terrain
static/levels/<slug>.wavemesh + .windmesh + .trees
  ↓  runtime: GPU upload → WavefrontRasterizer / WaterQueryShader
```

---

## build-level (Rust CLI)

Level-centric build pipeline. Downloads real-world data, extracts terrain contours, and builds wave/wind meshes.

### Entry Points

Use `./bin/build-level` directly as the primary interface.

| Command                                              | Description                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| `./bin/build-level`                                  | Run full pipeline for all levels with regions (default command) |
| `./bin/build-level --level <name>`                   | Run full pipeline for one level                                 |
| `./bin/build-level build [--level <name>]`           | Run full pipeline                                               |
| `./bin/build-level wave-mesh [--level <name>]`       | Build `.wavemesh` only (all levels by default)                  |
| `./bin/build-level wind-mesh [--level <name>]`       | Build `.windmesh` only (all levels by default)                  |
| `./bin/build-level trees [--level <name>]`           | Generate tree positions (all levels by default)                 |
| `./bin/build-level extract [--level <name>]`         | Extract terrain → `.terrain`                                    |
| `./bin/build-level download [--level <name>]`        | Download GeoTIFF tiles                                          |
| `./bin/build-level build-grid [--level <name>]`      | Merge tiles into `merged.tif` via `gdalwarp`                    |
| `./bin/build-level clean [--level <name>]`           | Delete generated outputs while keeping `tiles/`                 |
| `./bin/build-level validate [path] [--level <name>]` | Validate level or terrain file                                  |
| `./bin/build-level list-levels`                      | List available levels                                           |
| `./bin/build-level list-regions`                     | List levels with region config                                  |
| `./bin/build-level completion zsh`                   | Print zsh completion script                                     |

NPM scripts (`download-terrain`, `build-terrain-grid`, `extract-terrain-contours`, `validate-level`, `build-terrain`) are thin wrappers around `./bin/build-level`.

### Configuration

Region configuration is embedded directly in the level file as a `region` field:

```json
{
  "version": 2,
  "name": "Vendovi Island",
  "region": {
    "datasetPath": "wash_bellingham/",
    "bbox": { "minLat": ..., "minLon": ..., "maxLat": ..., "maxLon": ... },
    "interval": 25,
    "simplify": 5,
    "scale": 1,
    "minPerimeter": 1500,
    "minPoints": 4,
    "flipY": true
  },
  "waves": { "sources": [...] },
  "wind": { "sources": [...] }
}
```

Output paths are convention-based: `static/levels/<slug>.terrain`.

### Level File Format (v2)

Region-based terrain (real-world levels):

```json
{
  "version": 2,
  "name": "Vendovi Island",
  "region": {
    "datasetPath": "wash_bellingham/",
    "bbox": {
      "minLat": 48.6,
      "minLon": -122.6,
      "maxLat": 48.62,
      "maxLon": -122.59
    },
    "interval": 25,
    "simplify": 5,
    "scale": 1,
    "minPerimeter": 1500,
    "minPoints": 4,
    "flipY": true
  },
  "waves": {
    "sources": [{ "amplitude": 0.4, "wavelength": 200, "direction": 0.8 }]
  },
  "wind": { "sources": [{ "direction": 0.785 }] }
}
```

Inline terrain (hand-crafted levels):

```json
{
  "version": 2,
  "name": "Bay Islands",
  "defaultDepth": -300,
  "contours": [...],
  "waves": { "sources": [...] },
  "wind": { "sources": [...] }
}
```

### Terrain File Format

Binary `.terrain` format (v2/v3) with magic number `0x4e525254` ("TRRN").

### Rust module layout

- `pipeline/pipeline-core/src/level.rs` — level/region types, JSON parsing, contour tree building
- `pipeline/build-level/src/region.rs` — region config loading (from level files), path helpers
- `pipeline/build-level/src/download.rs` — CUDEM / USACE / EMODnet tile downloads
- `pipeline/build-level/src/build_grid.rs` — `gdalwarp` merge step
- `pipeline/build-level/src/extract.rs` — merged GeoTIFF load + contour extraction + validation
- `pipeline/build-level/src/marching.rs` — marching squares + block index + ring tracer
- `pipeline/build-level/src/simplify.rs` — RDP and ring geometry helpers
- `pipeline/build-level/src/constrained_simplify.rs` — intersection-aware RDP variant
- `pipeline/build-level/src/segment_index.rs` — spatial segment index
- `pipeline/build-level/src/validate.rs` — standalone validator logic

---

## mesh-building/

Only shared `.wavemesh` format helpers remain in TypeScript:

- `MeshBuildTypes.ts` — type definitions for wavefront mesh payloads.
- `WavemeshFile.ts` — binary `.wavemesh` serialization/parsing and input-hash helpers.

All marching/decimation/triangulation logic now lives in `pipeline/mesh-builder/` (Rust).
