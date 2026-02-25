# Pipeline — Offline Build Tools

`src/pipeline/` contains code that runs on the **dev machine** (Node.js / worker threads), never in the browser. It has two independent sub-pipelines:

1. **`terrain-import/`** — Downloads real-world bathymetry data and produces `.level.json` files
2. **`mesh-building/`** — Ray-traces wave propagation over terrain and produces `.wavemesh` files

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
  ↓  bin/build-wavemesh.ts  (calls mesh-building/)
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
| `run-all.ts`          | Orchestrates the full pipeline (steps 1–4) via `execSync`                                     |
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

| Module                    | Purpose                                                                               |
| ------------------------- | ------------------------------------------------------------------------------------- |
| `util/region.ts`          | Loads `region.json`, resolves `--region` CLI flag, path helpers                       |
| `util/geo-utils.ts`       | Lat/lon ↔ feet projection, bbox math, CUDEM tile filename parsing                    |
| `util/grid-cache.ts`      | Lists local tiles by bbox, reads GeoTIFF metadata                                     |
| `util/simplify.ts`        | Ramer-Douglas-Peucker for polylines and closed rings, `signedArea`, `ringPerimeter`   |
| `util/segment-index.ts`   | Spatial grid for fast segment intersection queries                                    |
| `util/constrained-simplify.ts` | RDP that refuses to collapse spans crossing already-finalized contours           |

### worker/ — Marching Squares Worker System

| Module                      | Purpose                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `worker/marching-squares.ts`  | `ScalarGrid`, `MarchSegments` types, `buildClosedRings()` ring tracer, `BlockIndex` for fast level-skip      |
| `worker/worker-pool.ts`       | `ContourWorkerPool` — distributes marching squares across worker threads using `SharedArrayBuffer`           |
| `worker/contour-worker.ts`    | Worker thread: computes block index, runs `marchCell()` with full 16-case lookup table + saddle disambiguation |

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

Ray-traces wave propagation over terrain to build pre-computed wavefront meshes. Each vertex stores amplitude, turbulence, phase offset, and blend weight.

### Entry Point

`bin/build-wavemesh.ts` (outside this directory) calls `buildMarchingMesh()` for each wave source, then packs results into a `.wavemesh` binary.

### Core Files

| File                  | Purpose                                                                                                                                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `marchingBuilder.ts`  | **Top-level builder**: `buildMarchingMesh(waveSource, bounds, terrain, tideHeight)` — orchestrates bounds → initial wavefront → march → skirt → decimate → triangulate                                                                                                                                 |
| `marching.ts`         | **Ray tracing core**: `marchWavefronts()` advances rays with Snell's law refraction, energy dissipation (bottom friction, breaking, refraction), turbulence tracking, segment split/merge, and diffraction. Also `generateInitialWavefront()`, `addSkirtRows()`, amplitude/diffraction post-processing |
| `marchingBounds.ts`   | `computeBounds()` — projects terrain contour bboxes onto wave direction, adds asymmetric margins (10λ upwave, 80λ downwave, 20λ crosswave)                                                                                                                                                             |
| `decimation.ts`       | Two-phase decimation: row removal via min-heap scoring, then per-row vertex removal. Both check linear interpolation error against tolerance                                                                                                                                                           |
| `meshOutput.ts`       | `buildMeshData()` — triangulates adjacent wavefront rows via zipper sweep, emits vertex/index arrays, computes coverage quad                                                                                                                                                                           |
| `terrainHeightCPU.ts` | CPU port of the GPU terrain shader: DFS contour tree traversal, winding-number containment, IDW boundary blending, spatial gradient for Snell's law                                                                                                                                                    |
| `MeshBuildTypes.ts`   | Core types: `WavefrontMeshData`, `MeshBuildBounds`, `CoverageQuad`                                                                                                                                                                                                                                     |
| `marchingTypes.ts`    | Marching-specific types: `WavefrontSegment`, `Wavefront`, `WaveBounds`, `VERTEX_FLOATS = 6`                                                                                                                                                                                                            |
| `WavemeshFile.ts`     | `.wavemesh` binary serialization/deserialization, input hash computation for cache validation                                                                                                                                                                                                          |

### Key Constants

- `VERTEX_SPACING = 20 ft` — cross-wave ray spacing
- `STEP_SIZE = 10 ft` — along-wave march step
- `DECIMATION_TOLERANCE = 0.02` — max interpolation error for removing rows/vertices

### Vertex Layout (6 floats)

```
[x, y, amplitude, turbulence, phaseOffset, blendWeight]
```

### The `.wavemesh` Binary Format

```
Header (32 bytes):
  magic "WVMH"  version:u16  waveSourceCount:u16  inputHash:u64  reserved

Per-wave entry table (16 bytes each):
  vertexDataOffset:u32  vertexCount:u32  indexDataOffset:u32  indexCount:u32

Coverage quad table (36 bytes each):
  hasCoverageQuad:u32  corners: 8×f32

Data sections:
  Vertex arrays (Float32Array, 6 f32/vertex)
  Index arrays (Uint32Array)
```

`computeInputHash()` produces a ~64-bit FNV-1a hash over all terrain data + wave source parameters for cache invalidation.

### Physics Summary

Each ray is advanced per step with:

- **Speed**: `c = sqrt(tanh(k · depth))` (deep water = 1, shoreline = 0)
- **Refraction**: Snell's law via depth gradient, clamped ±π/8 per step
- **Energy loss**: bottom friction + wave breaking (depth < 0.07λ) + refraction dissipation
- **Amplitude**: `energy × shoaling × divergence` (linear wave theory)
- **Diffraction**: lateral amplitude diffusion via parabolic approximation, 10 iterations/step
- **Turbulence**: accumulated from energy dissipation, diffused laterally, decays over distance
