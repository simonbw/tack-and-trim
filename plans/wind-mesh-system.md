# Wind Mesh System — End-to-End Plumbing

## Context

The game's wave system precomputes how ocean waves interact with terrain via wavefront meshes. We want an analogous wind mesh system where terrain affects wind (blocking, funneling, turbulence). The wind query shader already has `influenceSpeedFactor`, `influenceDirectionOffset`, and `influenceTurbulence` params plumbed through — they're just hardcoded to neutral (1.0, 0.0, 0.0). This plan wires up everything end-to-end with a trivial mesh generator (uniform grid, all neutral values) so the interesting physics can be filled in later.

## Design Decisions

- **Integrate into `wavemesh-builder` crate** — shares terrain parsing, contour data, and `StepView` logging. New modules `windmesh.rs` and `windmesh_file.rs`.
- **Simpler than wavemesh** — single mesh per level (not per-source), axis-aligned grid (no rotation), 5 floats/vertex instead of 6.
- **Extend `WindResources`** to hold the packed GPU buffer (no new entity needed).
- **Placeholder buffer for backwards compat** — levels without `.windmesh` files get a placeholder buffer with `hasMesh=0`, shader returns neutral defaults.

## Implementation Steps

### 1. Rust: Wind mesh grid generator

**New file: `pipeline/wavemesh-builder/src/windmesh.rs`**

- `WindMeshData` struct: `vertices: Vec<f32>`, `indices: Vec<u32>`, `vertex_count`, `index_count`, plus grid metadata (cols, rows, min_x, min_y, cell_width, cell_height)
- `WIND_VERTEX_FLOATS = 5` — `[x, y, speedFactor, directionOffset, turbulence]`
- `build_wind_grid(terrain: &TerrainCPUData, grid_spacing: f64) -> WindMeshData`:
  - Compute AABB from terrain's root contours (or use terrain bounds)
  - Add margin (e.g. 500ft)
  - Create regular grid of vertices at `grid_spacing` intervals (e.g. 200ft)
  - All attributes neutral: speedFactor=1.0, directionOffset=0.0, turbulence=0.0
  - Two triangles per grid cell
  - Store grid metadata for the spatial lookup index

### 2. Rust: Wind mesh binary format

**New file: `pipeline/wavemesh-builder/src/windmesh_file.rs`**

Format (simpler than `.wavemesh` — single mesh, no per-source table):

```
Header (16 bytes):
  [0..3]   magic: 0x4d444e57 ("WNDM" LE)
  [4..5]   version: u16 = 1
  [6..7]   reserved: u16
  [8..11]  inputHashHi: u32
  [12..15] inputHashLo: u32

Mesh metadata (32 bytes):
  vertexCount: u32, indexCount: u32,
  gridCols: u32, gridRows: u32,
  gridMinX: f32, gridMinY: f32,
  gridCellWidth: f32, gridCellHeight: f32

Vertex data: vertexCount * 5 * 4 bytes (f32 LE)
Index data: indexCount * 4 bytes (u32 LE)
```

Functions:

- `build_windmesh_buffer(mesh: &WindMeshData, input_hash: [u32; 2]) -> Vec<u8>`
- `compute_wind_input_hash(terrain: &TerrainCPUData) -> [u32; 2]` — hash terrain data only (no wave sources)

### 3. Rust: Public entry point + pipeline integration

**Modify: `pipeline/wavemesh-builder/src/lib.rs`**

- Add `mod windmesh; mod windmesh_file;`
- Add `pub fn build_windmesh_for_level_with_view(level_path, output, view)`:
  - Parse level JSON, build terrain data (reuse existing `level::parse_level_file` + `level::build_terrain_data`)
  - Call `windmesh::build_wind_grid(terrain, GRID_SPACING)`
  - Serialize via `windmesh_file::build_windmesh_buffer()`
  - Write to output path (default: `level_path.replace(".level.json", ".windmesh")`)

**Modify: `pipeline/terrain-import/src/main.rs`**

- In `run_import_for_region()`, add wind mesh build step after wavemesh step
- Call `wavemesh_builder::build_windmesh_for_level_with_view()`

### 4. Asset manifest: Register `.windmesh` files

**Modify: `bin/generate-asset-types.ts`**

- Add `windmesh: "windmesh"` to `extensionToType`
- Add `windmeshFiles` array alongside `wavemeshFiles`
- Add `windmeshes` section to manifest template (same pattern as `wavemeshes`)
- Add to `RESOURCES` export

Then run: `npm run generate-manifest`

### 5. TypeScript: File format + loader

**New file: `src/pipeline/mesh-building/WindmeshFile.ts`**

- `WindMeshFileData` interface: `{ vertices: Float32Array, indices: Uint32Array, vertexCount, indexCount, gridCols, gridRows, gridMinX, gridMinY, gridCellWidth, gridCellHeight }`
- `parseWindmeshBuffer(buffer: ArrayBuffer): WindMeshFileData` — validate magic/version, create typed array views into buffer

**New file: `src/game/wind/WindmeshLoader.ts`**

- `loadWindmeshFromUrl(url: string): Promise<WindMeshFileData>` — fetch + parse (same pattern as `WavemeshLoader.ts`)

### 6. TypeScript: GPU buffer packing

**New file: `src/game/wind/WindMeshPacking.ts`**

Packed buffer layout (single `array<u32>`):

```
HEADER (16 u32s):
  [0]  hasMesh (0 or 1)
  [1]  vertexOffset    [2]  vertexCount
  [3]  indexOffset      [4]  triangleCount
  [5]  gridOffset       [6]  gridCols       [7]  gridRows
  [8]  gridMinX (f32)   [9]  gridMinY (f32)
  [10] gridCellWidth    [11] gridCellHeight
  [12..15] padding

VERTEX DATA (5 f32-as-u32 per vertex)
INDEX DATA (3 u32 per triangle)
GRID CELL HEADERS (2 u32 per cell: triListOffset, triListCount)
GRID TRIANGLE LISTS (u32 per entry)
```

Functions:

- `buildPackedWindMeshBuffer(device: GPUDevice, mesh: WindMeshFileData): GPUBuffer` — build spatial grid (scanline rasterization, axis-aligned so no rotation needed), pack everything into GPU buffer
- `createPlaceholderPackedWindMeshBuffer(device: GPUDevice): GPUBuffer` — hasMesh=0, minimal buffer

Pattern to follow: `src/game/wave-physics/MeshPacking.ts` (reuse `floatToU32`, grid building logic, but simplified — no rotation, no per-wave-source loop)

### 7. WGSL: Wind mesh shader accessors

**New file: `src/game/world/shaders/wind-mesh-packed.wgsl.ts`**

Shader modules following pattern in `mesh-packed.wgsl.ts`:

- `struct_WindMeshLookupResult` — `{ speedFactor: f32, directionOffset: f32, turbulence: f32, found: bool }`
- `fn_lookupWindMesh(worldPos, packed)` — reads header, checks `hasMesh`, does axis-aligned grid cell lookup, barycentric interpolation of 3 attributes. Returns neutral defaults when `hasMesh=0` or point is outside grid.

Reuse `fn_barycentric` from `mesh-packed.wgsl.ts` (add as dependency).

### 8. Modify wind query shader

**Modify: `src/game/world/wind/WindQueryShader.ts`**

- Add `packedWindMesh: { type: "storage", wgslType: "array<u32>" }` to bindings
- Add `fn_lookupWindMesh` as dependency
- In compute main: call `lookupWindMesh()`, use result to replace hardcoded influence values:
  ```wgsl
  let meshResult = lookupWindMesh(queryPoint, &packedWindMesh);
  let speedFactor = select(params.influenceSpeedFactor, meshResult.speedFactor, meshResult.found);
  let dirOffset = select(params.influenceDirectionOffset, meshResult.directionOffset, meshResult.found);
  let turb = select(params.influenceTurbulence, meshResult.turbulence, meshResult.found);
  ```

### 9. Extend WindResources

**Modify: `src/game/world/wind/WindResources.ts`**

- Add constructor param: `windMeshData?: WindMeshFileData`
- In `onAdd()`: if data provided, call `buildPackedWindMeshBuffer(device, data)`, else create placeholder
- Add `getPackedWindMeshBuffer(): GPUBuffer` getter

### 10. Update WindQueryManager

**Modify: `src/game/world/wind/WindQueryManager.ts`**

- In `dispatchCompute()`:
  - Get packed wind mesh buffer from `WindResources`
  - Add `packedWindMesh: { buffer: windMeshBuffer }` to bind group

### 11. Wire up level loading

**Modify: `src/editor/io/LevelLoader.ts`**

- Import `WindMeshFileData` and `loadWindmeshFromUrl`
- Add `windmeshData?: WindMeshFileData` to `LoadedLevel`
- In `loadLevel()`, look up `RESOURCES.windmeshes[levelName]`, fetch and parse if available (same try/catch pattern as wavemesh)

**Modify: `src/game/GameController.ts`**

- Pass `windmeshData` to `WindResources` constructor:
  ```typescript
  this.game.addEntity(new WindResources(windmeshData));
  ```

## Files Summary

| Action | File                                              |
| ------ | ------------------------------------------------- |
| New    | `pipeline/wavemesh-builder/src/windmesh.rs`       |
| New    | `pipeline/wavemesh-builder/src/windmesh_file.rs`  |
| Modify | `pipeline/wavemesh-builder/src/lib.rs`            |
| Modify | `pipeline/terrain-import/src/main.rs`             |
| Modify | `bin/generate-asset-types.ts`                     |
| New    | `src/pipeline/mesh-building/WindmeshFile.ts`      |
| New    | `src/game/wind/WindmeshLoader.ts`                 |
| New    | `src/game/wind/WindMeshPacking.ts`                |
| New    | `src/game/world/shaders/wind-mesh-packed.wgsl.ts` |
| Modify | `src/game/world/wind/WindQueryShader.ts`          |
| Modify | `src/game/world/wind/WindResources.ts`            |
| Modify | `src/game/world/wind/WindQueryManager.ts`         |
| Modify | `src/editor/io/LevelLoader.ts`                    |
| Modify | `src/game/GameController.ts`                      |

## Verification

1. **Rust pipeline**: `cd pipeline && cargo build --release` — should compile clean
2. **Generate wind mesh**: Run `terrain-import import` for a level — should produce `.windmesh` alongside `.wavemesh`
3. **Asset manifest**: `npm run generate-manifest` — `resources.ts` should include `windmeshes` section
4. **Type check**: `npm run tsgo` — no errors
5. **Runtime**: Load a level in the browser. Wind behavior should be unchanged (all neutral values). Console should log "Loaded prebuilt windmesh". No GPU errors.
6. **Without windmesh**: Delete `.windmesh` file, reload — should fall back to placeholder buffer gracefully
