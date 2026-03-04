# Wave Physics

Runtime wavefront mesh system for terrain-wave interaction. Uses prebuilt triangle meshes that encode how each wave source is affected by terrain (energy attenuation, direction bending, phase correction, wave breaking).

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
           │        │ Wavemesh     │   │ MeshPacking      │
           │        │ Loader       │   │ (CPU → GPU)      │
           │        │ (fetch)      │   │                  │
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

**Wavefront marching**: For each wave source, rays march from upwave to downwave through the terrain, building a mesh of wavefront steps. At each step, terrain height determines wave amplitude (energy conservation via shoaling), direction (refraction via Snell's law), phase correction, and breaking state. The canonical builder runs offline in Rust at `pipeline/wavemesh-builder/`.

**Packed mesh buffer**: All mesh data is packed into a single `array<u32>` GPU buffer for both rendering and query shaders. Global header (16 u32s) followed by per-wave mesh data (header + vertices + indices + spatial grid).

## Files

- **WavePhysicsResources.ts** - Singleton entity owning WavePhysicsManager. Provides packed mesh buffer and rasterizer to SurfaceRenderer and query shaders. Initializes from terrain data on add.
- **WavePhysicsManager.ts** - Manages mesh building lifecycle. Coordinates worker-based builds, owns WavefrontMesh instances, creates packed buffer and rasterizer. Exports `MAX_WAVE_SOURCES = 8`.
- **WavefrontMesh.ts** - Data class holding a single wave source's mesh (vertices, indices, coverage quad, spatial grid for fast lookup).
- **WavefrontRasterizer.ts** - GPU render pipeline that rasterizes meshes to rgba16float 2D texture array. One layer per wave source. Encodes phase correction (cos/sin), coverage, and breaking intensity.
- **MeshPacking.ts** - Packs all wave meshes into a single `array<u32>` buffer. `buildPackedMeshBuffer()` creates the buffer; `createPlaceholderPackedMeshBuffer()` creates an empty one for when wave physics is absent.
- **WavemeshLoader.ts** - Browser-side loader that fetches and parses prebuilt `.wavemesh` binary files.

## Related: Offline Mesh Building

The mesh building pipeline (marching, decimation, triangulation) runs offline via `npm run build-wavemesh`, which executes the Rust builder in `pipeline/wavemesh-builder/` to produce `.wavemesh` files loaded at runtime by `WavemeshLoader.ts`.

## Packed Mesh Buffer Format

```
Global header (16 u32s):
  [numWaveSources, meshOffset[0..7], padding...]

Per-wave mesh (at meshOffset[i]):
  Mesh header (16 u32s):
    [vertexOffset, vertexCount, indexOffset, triangleCount,
     gridOffset, gridCols, gridRows, gridMinX(f32),
     gridMinY(f32), gridCellWidth(f32), gridCellHeight(f32),
     gridCosA(f32), gridSinA(f32), padding...]

  Vertex data (6 f32 per vertex):
    [x, y, amplitude, turbulence, phaseOffset, interior]

  Index data (3 u32 per triangle):
    Triangle vertex indices

  Grid cell headers (2 u32 per cell):
    [triListOffset, triListCount]

  Grid triangle lists (u32 per entry):
    Triangle indices referenced by each cell
```

The spatial grid is built in **wave-aligned (rotated) space** for tighter packing. Grid cells are rectangular, sized to match triangle density and aspect ratio. Triangles are inserted via scanline rasterization (not AABB) for minimal false positives. The GPU shader rotates query points into grid space using `gridCosA`/`gridSinA` before cell lookup.

Accessor functions in `world/shaders/mesh-packed.wgsl.ts`: `lookupMeshForWave` with spatial grid + barycentric interpolation.

## Wave Field Texture

The rasterizer outputs to an rgba16float 2D texture array:

- **R**: Phase correction cos component
- **G**: Phase correction sin component
- **B**: Wave coverage (0 = no mesh data at this pixel)
- **A**: Turbulence (0-1)

Consumed by both `SurfaceRenderer` (water height compute) and `WaterQueryShader` (CPU query pipeline).
