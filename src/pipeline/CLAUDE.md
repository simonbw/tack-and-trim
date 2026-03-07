# Pipeline — Offline Build Tools

`src/pipeline/` contains offline build tooling that runs on the dev machine, never in the browser.

## Overview

1. **`build-level/`** — Rust CLI pipeline that downloads real-world bathymetry data, extracts terrain, and builds meshes.
2. **`mesh-building/`** — Shared `.wavemesh` format/types used by runtime loading and tooling.

The canonical Rust pipeline lives under `pipeline/`:
- `pipeline/build-level/` for terrain import/validation/mesh building
- `pipeline/wavemesh-builder/` for wave-mesh generation

## File Layout

```
assets/terrain/<slug>/region.json       -- Terrain extraction config (no output field)

resources/levels/<slug>.level.json      -- Level definition (hand-written, small)
resources/levels/<slug>.terrain.json    -- Extracted terrain contours (generated, large)
resources/levels/<slug>.wavemesh        -- Prebuilt wave mesh
resources/levels/<slug>.windmesh        -- Prebuilt wind mesh
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
resources/levels/<slug>.terrain.json
  ↓  build-level (default command, or build-level --level <name>)
     Level file references .terrain.json; mesh builder resolves the reference
resources/levels/<slug>.wavemesh + .windmesh
  ↓  runtime: GPU upload → WavefrontRasterizer / WaterQueryShader
```

---

## build-level (Rust CLI)

Level-centric build pipeline. Downloads real-world data, extracts terrain contours, and builds wave/wind meshes.

### Entry Points

Use `./bin/build-level` directly as the primary interface.

| Command                                              | Description                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ |
| `./bin/build-level`                                  | Build meshes for all levels (default)                                          |
| `./bin/build-level --level <name>`                   | Build meshes for a specific level                                              |
| `./bin/build-level import --region <slug>`           | Full pipeline (download → build-grid → extract → mesh build)                  |
| `./bin/build-level extract --region <slug>`          | Extract terrain → `.terrain.json`                                              |
| `./bin/build-level download --region <slug>`         | Download GeoTIFF tiles                                                         |
| `./bin/build-level build-grid --region <slug>`       | Merge tiles into `merged.tif` via `gdalwarp`                                   |
| `./bin/build-level clean --region <slug>`            | Delete generated outputs while keeping `tiles/`                                |
| `./bin/build-level validate [path]`                  | Validate level or terrain file                                                 |
| `./bin/build-level list-levels`                      | List available levels                                                          |
| `./bin/build-level list-regions`                     | List available regions                                                         |

NPM scripts (`download-terrain`, `build-terrain-grid`, `extract-terrain-contours`, `validate-level`, `import-terrain`) are thin wrappers around `./bin/build-level`.

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
  "flipY": true
}
```

Output paths are convention-based: `resources/levels/<slug>.terrain.json`.

### Level File Format (v2)

Referenced terrain (real-world levels):
```json
{
  "version": 2,
  "name": "Vendovi Island",
  "terrainFile": "vendovi-island",
  "waves": { "sources": [{ "amplitude": 0.4, "wavelength": 200, "direction": 0.8 }] },
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

```json
{
  "version": 1,
  "defaultDepth": -300,
  "contours": [{ "height": 0, "polygon": [[x, y], ...] }]
}
```

### Rust module layout

- `pipeline/build-level/src/region.rs` — region discovery, config loading, path helpers
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

All marching/decimation/triangulation logic now lives in `pipeline/wavemesh-builder/` (Rust).
