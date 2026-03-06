# Pipeline — Offline Build Tools

`src/pipeline/` contains offline build tooling that runs on the dev machine, never in the browser.

## Overview

1. **`terrain-import/`** — Rust CLI pipeline that downloads real-world bathymetry data and produces `.level.json` files.
2. **`mesh-building/`** — Shared `.wavemesh` format/types used by runtime loading and tooling.

The canonical Rust pipeline lives under `pipeline/`:
- `pipeline/terrain-import/` for terrain import/validation
- `pipeline/wavemesh-builder/` for wave-mesh generation

## Data Flow

```
NOAA CUDEM GeoTIFF tiles
  ↓  terrain-import download
assets/terrain/<slug>/tiles/*.tif
  ↓  terrain-import build-grid  (gdalwarp)
assets/terrain/<slug>/cache/merged.tif
  ↓  terrain-import extract
     (marching squares → ring assembly → simplification → validation)
resources/levels/<slug>.level.json
  ↓  npm run build-wavemesh  (Rust: pipeline/wavemesh-builder)
     (ray tracing → decimation → triangulation → binary packing)
resources/levels/<slug>.wavemesh
  ↓  runtime: GPU upload → WavefrontRasterizer / WaterQueryShader
```

---

## terrain-import (Rust CLI)

Imports real-world bathymetric/topographic data from NOAA's CUDEM dataset into `.level.json` level files.

### Entry Points

Use `./bin/terrain-import` directly as the primary interface (or `terrain-import` if installed on `PATH`).

| Command                                                | Description                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------- |
| `./bin/terrain-import --region <slug>`                | Orchestrates full pipeline (download → build-grid → extract → wavemesh)    |
| `./bin/terrain-import download --region <slug>`       | **Step 1** — Downloads GeoTIFF tiles matching region bbox                  |
| `./bin/terrain-import build-grid --region <slug>`     | **Step 2** — Merges tiles into `merged.tif` via `gdalwarp`                 |
| `./bin/terrain-import extract --region <slug>`        | **Step 3** — Marching squares → constrained simplification → `.level.json` |
| `./bin/terrain-import clean --region <slug>`          | Deletes generated outputs (`cache/`, `.level.json`, `.wavemesh`) while keeping `tiles/` |
| `./bin/terrain-import validate --region <slug>`       | Standalone `.level.json` validator (overlap + containment checks)           |

NPM scripts (`download-terrain`, `build-terrain-grid`, `extract-terrain-contours`, `validate-level`, `import-terrain`) are thin wrappers around `./bin/terrain-import`.

### Configuration

Each region has an `assets/terrain/<slug>/region.json`:

```json
{
  "name": "Vendovi Island",
  "datasetPath": "NCEI_ninth_Topobathy_2014_8483",
  "bbox": { "minLat": ..., "minLon": ..., "maxLat": ..., "maxLon": ... },
  "interval": 3,
  "simplify": 0.0003,
  "scale": 1.0,
  "minPerimeter": 100,
  "minPoints": 4,
  "output": "resources/levels/vendovi-island.level.json"
}
```

### Rust module layout

- `pipeline/terrain-import/src/region.rs` — region discovery, config loading, path helpers
- `pipeline/terrain-import/src/download.rs` — CUDEM / USACE / EMODnet tile downloads
- `pipeline/terrain-import/src/build_grid.rs` — `gdalwarp` merge step
- `pipeline/terrain-import/src/extract.rs` — merged GeoTIFF load + contour extraction + validation
- `pipeline/terrain-import/src/marching.rs` — marching squares + block index + ring tracer
- `pipeline/terrain-import/src/simplify.rs` — RDP and ring geometry helpers
- `pipeline/terrain-import/src/constrained_simplify.rs` — intersection-aware RDP variant
- `pipeline/terrain-import/src/segment_index.rs` — spatial segment index
- `pipeline/terrain-import/src/validate.rs` — standalone validator logic

### The `.level.json` Format

```json
{
  "version": 1,
  "defaultDepth": -30,
  "contours": [
    { "height": -6, "polygon": [[x, y], [x, y], ...] }
  ]
}
```

Coordinates are in game feet, centered on bbox center. Heights are signed (negative = underwater). Polygons are CCW-wound.

---

## mesh-building/

Only shared `.wavemesh` format helpers remain in TypeScript:

- `MeshBuildTypes.ts` — type definitions for wavefront mesh payloads.
- `WavemeshFile.ts` — binary `.wavemesh` serialization/parsing and input-hash helpers.

All marching/decimation/triangulation logic now lives in `pipeline/wavemesh-builder/` (Rust).
