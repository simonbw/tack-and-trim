# Pipeline — Offline Build Tools

`src/pipeline/` contains code that runs on the **dev machine** (Node.js), never in the browser.

## Overview

1. **`terrain-import/`** — Downloads real-world bathymetry data and produces `.level.json` files.
2. **`mesh-building/`** — Shared `.wavemesh` format/types used by runtime loading and tooling.

The canonical wave-mesh builder is the Rust implementation in `pipeline/wavemesh-builder/`.

## Data Flow

```
NOAA CUDEM GeoTIFF tiles
  ↓  terrain-import/download.ts
assets/terrain/<slug>/tiles/*.tif
  ↓  terrain-import/build-grid.ts  (gdalwarp)
assets/terrain/<slug>/cache/merged.tif
  ↓  terrain-import/extract-contours.ts
     (marching squares → ring assembly → simplification → validation)
resources/levels/<slug>.level.json
  ↓  npm run build-wavemesh  (Rust: pipeline/wavemesh-builder)
     (ray tracing → decimation → triangulation → binary packing)
resources/levels/<slug>.wavemesh
  ↓  runtime: GPU upload → WavefrontRasterizer / WaterQueryShader
```

---

## terrain-import/

Imports real-world bathymetric/topographic data from NOAA's CUDEM dataset into `.level.json` level files.

### Entry Points

| File                  | Description                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `run-all.ts`          | Orchestrates the full pipeline (download → grid → contours → wavemesh build)                  |
| `download.ts`         | **Step 1** — Scrapes NOAA directory listing, downloads GeoTIFF tiles matching the region bbox |
| `build-grid.ts`       | **Step 2** — Merges tiles into a single raster via `gdalwarp`                                 |
| `extract-contours.ts` | **Step 3** — Marching squares → ring tracing → constrained simplification → `.level.json`     |
| `validate-level.ts`   | Standalone or programmatic validation of `.level.json` (overlap + containment checks)         |

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

### util/ Support Modules

| Module                         | Purpose                                                                             |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| `util/region.ts`               | Loads `region.json`, resolves `--region` CLI flag, path helpers                     |
| `util/geo-utils.ts`            | Lat/lon ↔ feet projection, bbox math, CUDEM tile filename parsing                  |
| `util/grid-cache.ts`           | Lists local tiles by bbox, reads GeoTIFF metadata                                   |
| `util/simplify.ts`             | Ramer-Douglas-Peucker for polylines and closed rings, `signedArea`, `ringPerimeter` |
| `util/segment-index.ts`        | Spatial grid for fast segment intersection queries                                  |
| `util/constrained-simplify.ts` | RDP that refuses to collapse spans crossing already-finalized contours              |

### worker/ — Marching Squares Worker System

| Module                       | Purpose                                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `worker/marching-squares.ts` | `ScalarGrid`, `MarchSegments` types, `buildClosedRings()` ring tracer, `BlockIndex` for fast level-skip        |
| `worker/worker-pool.ts`      | `ContourWorkerPool` — distributes marching squares across worker threads using `SharedArrayBuffer`             |
| `worker/contour-worker.ts`   | Worker thread: computes block index, runs `marchCell()` with full 16-case lookup table + saddle disambiguation |

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
