# Wave Physics

Wavefront mesh system for terrain-wave interaction. Builds triangle meshes that encode how each wave source is affected by terrain (energy attenuation, direction bending, phase correction, wave breaking).

## Architecture Overview

```
┌──────────────────────┐     ┌──────────────────────┐
│ WavePhysicsResources │────▶│  WavePhysicsManager  │
│ (singleton entity)   │     │  (owns meshes,       │
│                      │     │   coordinates builds) │
└──────────┬───────────┘     └──────────┬───────────┘
           │                            │
           │                   ┌────────┴────────┐
           │                   ▼                 ▼
           │        ┌──────────────┐   ┌──────────────────┐
           │        │ MeshBuild    │   │ MeshPacking      │
           │        │ Coordinator  │   │ (CPU → GPU)      │
           │        │ (web worker) │   │                  │
           │        └──────────────┘   └──────────────────┘
           │
           ▼
  ┌──────────────────┐
  │ Wavefront        │
  │ Rasterizer       │     ┌───────────────────────────────┐
  │ (GPU render)     │────▶│ rgba16float texture array     │
  └──────────────────┘     │ (one layer per wave source)   │
                           │ Used by: SurfaceRenderer,     │
                           │          WaterQueryShader      │
                           └───────────────────────────────┘
```

## Key Concepts

**Wavefront marching**: For each wave source, rays march from upwave to downwave through the terrain, building a mesh of wavefront steps. At each step, terrain height determines wave amplitude (energy conservation via shoaling), direction (refraction via Snell's law), phase correction, and breaking state.

**Packed mesh buffer**: All mesh data is packed into a single `array<u32>` GPU buffer for both rendering and query shaders. Global header (16 u32s) followed by per-wave mesh data (header + vertices + indices + spatial grid).

## Files

### Top-Level

- **WavePhysicsResources.ts** - Singleton entity owning WavePhysicsManager. Provides packed mesh buffer and rasterizer to SurfaceRenderer and query shaders. Initializes from terrain data on add.
- **WavePhysicsManager.ts** - Manages mesh building lifecycle. Coordinates worker-based builds, owns WavefrontMesh instances, creates packed buffer and rasterizer. Exports `MAX_WAVE_SOURCES = 8`.
- **WavefrontMesh.ts** - Data class holding a single wave source's mesh (vertices, indices, coverage quad, spatial grid for fast lookup).
- **WavefrontRasterizer.ts** - GPU render pipeline that rasterizes meshes to rgba16float 2D texture array. One layer per wave source. Encodes phase correction (cos/sin), coverage, and breaking intensity.
- **MeshPacking.ts** - Packs all wave meshes into a single `array<u32>` buffer. `buildPackedMeshBuffer()` creates the buffer; `createPlaceholderPackedMeshBuffer()` creates an empty one for when wave physics is absent.

### Mesh Building (`mesh-building/`)

Mesh building runs in a **web worker** to avoid blocking the main thread.

- **MeshBuildCoordinator.ts** - Main-thread coordinator. Sends terrain data + wave sources to worker, receives built meshes. Manages worker lifecycle and pending build promises.
- **MeshBuildWorker.ts** - Web worker entry point. Receives terrain data and wave source params, runs marching + decimation + mesh output, posts results back.
- **marchingBuilder.ts** - High-level builder. For each wave source: computes bounds, runs marching, decimates, builds mesh output.
- **marching.ts** - Core marching algorithm. Steps rays from upwave to downwave through terrain. At each step along each ray: samples terrain height, computes depth, applies shoaling (Green's Law), determines breaking state, and tracks direction via refraction.
- **marchingTypes.ts** - Type definitions: `WavePoint` (x, y, t, amplitude, broken), `Wavefront` (array of segments), `WaveBounds`, `MarchConfig`. `VERTEX_FLOATS = 6` (x, y, amplitude, broken, phaseOffset, interior).
- **marchingBounds.ts** - Computes wave-aligned bounding box from root terrain contours. Asymmetric margins: small upwave (10 wavelengths), large downwave (80), medium crosswave (20).
- **decimation.ts** - Reduces vertex count by removing points that don't contribute significantly to the mesh shape. Uses perpendicular distance threshold with caching and binary search.
- **meshOutput.ts** - Converts wavefront steps into triangulated mesh data. Matches segments between adjacent steps by t-range overlap, then triangulates using a t-value sweep.
- **terrainHeight.ts** - CPU port of terrain height computation (1:1 from WGSL shaders). No engine imports, safe for web workers. Uses pre-parsed contour cache (WeakMap) for zero-allocation after warmup.
- **MeshBuildTypes.ts** - Shared types between main thread and worker: `TerrainDataForWorker`, `WavefrontMeshData`, `MeshBuilderType`, etc.
- **terrainHeight.test.ts** - Unit test for CPU terrain height.

## Packed Mesh Buffer Format

```
Global header (16 u32s):
  [numWaveSources, meshOffset[0..7], padding...]

Per-wave mesh (at meshOffset[i]):
  Mesh header (16 u32s):
    [vertexCount, indexCount, vertexDataOffset, indexDataOffset,
     gridMinX, gridMinY, gridMaxX, gridMaxY,
     gridCellSize, gridCols, gridRows, gridDataOffset,
     coverageQuad (4 packed values)]

  Vertex data (6 f32 per vertex):
    [x, y, amplitude, broken, phaseOffset, interior]

  Index data (u32 per index):
    Triangle indices

  Spatial grid (u32 per cell):
    Encoded [startIndex | (count << 16)] for triangle lookup
```

Accessor functions in `world/shaders/mesh-packed.wgsl.ts`: `lookupMeshForWave` with spatial grid + barycentric interpolation.

## Wave Field Texture

The rasterizer outputs to an rgba16float 2D texture array:
- **R**: Phase correction cos component
- **G**: Phase correction sin component
- **B**: Wave coverage (0 = no mesh data at this pixel)
- **A**: Breaking intensity (0-1)

Consumed by both `SurfaceRenderer` (water height compute) and `WaterQueryShader` (CPU query pipeline).

## Mesh Building Pipeline

1. **Main thread**: WavePhysicsManager calls MeshBuildCoordinator with wave sources + serialized terrain data
2. **Worker thread**: For each wave source:
   a. Compute wave-aligned bounds from terrain (marchingBounds)
   b. March rays through terrain (marching) - computes energy, refraction, breaking at each step
   c. Decimate low-information vertices (decimation)
   d. Triangulate adjacent wavefront steps by t-range overlap (meshOutput)
3. **Worker → Main**: Transfer mesh data (vertices, indices as ArrayBuffers)
4. **Main thread**: Build WavefrontMesh instances with spatial grids, pack into GPU buffer, create/update rasterizer
