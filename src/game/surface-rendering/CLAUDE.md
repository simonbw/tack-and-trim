# Surface Rendering

Renders the ocean and terrain using a multi-pass WebGPU pipeline.

## Architecture

The surface renderer uses a multi-pass pipeline: terrain tile caching, screen-space compute passes for terrain and water heights, optional wetness tracking, and a final composite fragment pass.

```
┌─────────────────┐  ┌──────────────────┐  ┌─────────────────────┐
│ WaterResources  │  │ TerrainResources │  │ WavePhysicsResources│
│ (wave data,     │  │ (contour data)   │  │ (wavefront meshes,  │
│  modifiers)     │  │                  │  │  rasterizer)        │
└────────┬────────┘  └────────┬─────────┘  └──────────┬──────────┘
         │                    │                       │
         │           ┌────────┴─────────┐             │
         │           │ Terrain Tile     │             │
         │           │ Caching (LOD)    │             │
         │           │ → atlas texture  │             │
         │           └────────┬─────────┘             │
         │                    │                       │
         │           ┌────────┴─────────┐    ┌────────┴──────────┐
         │           │ Pass 1: Terrain  │    │ Wavefront         │
         │           │ Screen Compute   │    │ Rasterization     │
         │           │ (r32float tex)   │    │ (rgba16float arr) │
         │           └────────┬─────────┘    └────────┬──────────┘
         │                    │                       │
         └──────────┬─────────┴───────────────────────┘
                    ▼
         ┌─────────────────────┐
         │ Pass 2: Water       │
         │ Height Compute      │
         │ (rg32float tex)     │
         └────────┬────────────┘
                  │
         ┌────────┴────────────┐
         │ Wetness Update      │
         │ (optional, r32float)│
         └────────┬────────────┘
                  │
         ┌────────┴────────────┐
         │ Pass 3: Surface     │
         │ Composite (fragment)│
         │ Normals + lighting  │
         └─────────────────────┘
```

## Files

### Core

- **SurfaceRenderer.ts** - Entity that orchestrates the full pipeline

### Terrain Tile Caching

- **LODTerrainTileCache.ts** - Multi-LOD manager for extreme zoom ranges (0.02x to 50+x). Selects LOD level based on camera zoom with hysteresis to prevent flickering.
- **TerrainTileCache.ts** - Virtual texture cache for a single LOD level. Direct-mapped cache with GPU texture atlas.
- **TerrainTileShader.ts** - Compute shader that renders individual terrain tiles to the atlas on demand.
- **TerrainTileUniforms.ts** - Params for tile rendering.

### Screen-Space Passes

- **TerrainScreenShader.ts** - Compute shader that samples the tile atlas to produce a screen-space terrain height texture (r32float).
- **WaterHeightShader.ts** - Compute shader for Gerstner waves + modifiers. Samples the wave field texture for per-wave energy factors, phase corrections, and breaking intensity.
- **SurfaceCompositeShader.ts** - Fragment shader that reads height textures, computes normals via finite differences, and renders with lighting. Handles water/terrain blending, foam, sand wetness, and breaking waves.

### Uniforms

- **TerrainScreenUniforms.ts** - Params for terrain screen pass (atlas info, viewport)
- **WaterHeightUniforms.ts** - Params for water height pass (wave count, tide, modifiers)
- **SurfaceCompositeUniforms.ts** - Params for composite pass (camera matrix, viewport, thresholds)

### Wetness System

- **WetnessRenderPipeline.ts** - Ping-pong texture pipeline for sand wetness tracking with camera reprojection.
- **WetnessStateShader.ts** - Compute shader that updates wetness over time (fast wetting ~0.2s, slow drying ~20s).

### Legacy (not used)

- **UnifiedSurfaceShader.ts** - Single-pass version (kept for reference)
- **UnifiedSurfaceUniforms.ts** - Uniforms for single-pass
- **TerrainHeightShader.ts** - Old terrain height compute (replaced by tile atlas approach)
- **TerrainHeightUniforms.ts** - Old terrain height params

## Render Flow

1. **Terrain tile cache update** - LODTerrainTileCache selects LOD, renders any missing tiles to atlas
2. **Pass 1: Terrain Screen** - Sample tile atlas → screen-space r32float terrain height texture
3. **Wavefront Rasterization** - WavePhysicsResources rasterizes wavefront meshes → rgba16float texture array (one layer per wave source, encoding phase correction, coverage, and breaking)
4. **Pass 2: Water Height** - Compute Gerstner waves using wave field texture for per-wave energy/phase/breaking → rg32float texture (height + breaking intensity)
5. **Wetness Update** - Update sand wetness via ping-pong compute (optional)
6. **Pass 3: Surface Composite** - Read height textures, compute normals via finite differences, render with lighting

## GPU Profiling

Each pass has its own GPU timestamp query section:

- `terrain.tile` - Terrain tile rendering
- `terrain.screen` - Terrain screen compute
- `waveField.rasterize` - Wave field rasterization
- `waterHeight` - Water height compute
- `wetness` - Wetness update
- `render` - Main render pass (composite)

View timings in the Graphics panel of the stats overlay.

## Key Design Decisions

- **Tile-cached terrain** - Terrain heights computed once per tile, cached in atlas. Screen-space pass just samples. Supports extreme zoom via multi-LOD.
- **Wave field texture** - Wavefront mesh data rasterized to texture array. Water height shader samples this instead of computing per-pixel wave-terrain interaction.
- **Bilinear terrain sampling** - Manually implemented in composite shader because `r32float` textures are unfilterable in WebGPU.
- **Viewport expansion** - Screen viewport expanded by 10% margin so finite-difference normal computation has data at screen edges.
- **No recomputation for normals** - Normals computed from height textures via finite differences (cheap texture samples vs expensive height recomputation).
