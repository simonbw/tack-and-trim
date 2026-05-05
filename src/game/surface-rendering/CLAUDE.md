# Surface Rendering

Renders the ocean and terrain using a multi-pass WebGPU pipeline.

## Architecture

The surface renderer uses a multi-pass pipeline: terrain tile caching, screen-space compute passes for terrain heights, water heights, and the wind field, optional wetness tracking, and a final fullscreen composite + filter pass.

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
         │ (rgba16float tex)   │
         └────────┬────────────┘
                  │
         ┌────────┴────────────┐
         │ Wetness Update      │
         │ (optional, r32float)│
         └────────┬────────────┘
                  │
         ┌────────┴────────────┐
         │ Pass 3: Terrain +   │
         │ Water Composite     │
         │ (fullscreen frag,   │
         │  normals, lighting) │
         └─────────────────────┘
```

## File Layout

The renderer is split into three files plus the per-pass shader modules:

### Orchestration

- **SurfaceRenderer.ts** — Entity that orchestrates the full pipeline. Owns the per-frame command encoder driving, GPU profiling sections, the `WetnessRenderPipeline`, the `ModifierRasterizer`, and the `BoatAirShader`. Defers shader/uniform/bind-group state to `SurfaceShaders` and texture state to `SurfaceTextures`.
- **SurfaceTextures.ts** — Owns the screen-sized GPU textures used by the pipeline (terrain height, water height, wind field, wave field array, boat-air buffer). Knows how to size them under the Render Resolution and Water Quality settings, and how to recreate them on resize. Pure resource ownership — no per-frame logic.
- **SurfaceShaders.ts** — Owns the surface-rendering compute and fullscreen shaders (terrain screen, water height, wind field, terrain composite, water filter), their uniform buffers and instances, the `LINEAR_CLAMP` sampler, and the bind groups. Provides per-frame `update*` helpers that pack scene state into the uniforms and `ensure*BindGroup` helpers that rebuild bind groups when their source resources change.

### Per-pass shader modules

Each shader module exports both a `*Uniforms` `UniformStruct` definition and a `create*Shader()` factory; the matching `*.wgsl.ts` source lives in `src/game/world/shaders/` for shaders that share helpers with the query pipeline.

- **TerrainTileShader.ts** — Compute shader that renders individual terrain tiles to the atlas on demand.
- **TerrainScreenShader.ts** — Compute shader that samples the tile atlas to produce a screen-space terrain height texture (r32float).
- **WaterHeightShader.ts** — Compute shader for Gerstner waves + modifiers. Samples the wave field texture for per-wave energy factors, phase corrections, and turbulence; outputs height + turbulence to an rgba16float texture.
- **WindFieldShader.ts** — Compute shader that produces the screen-space wind field used by particle and filter passes.
- **TerrainCompositeShader.ts** — Fullscreen fragment shader that composites land/sand and feeds into the water filter.
- **WaterFilterShader.ts** — Fullscreen fragment shader that reads height textures, computes normals via finite differences, and renders the final water surface with lighting, foam, sand wetness, and turbulence-driven foam.
- **BoatAirShader.ts** — Geometric pass that writes per-pixel `airMin` / `airMax` / turbulence into an rgba16float texture; consumed by `WaterFilterShader` to produce the bilge effect.

### Terrain tile caching

- **LODTerrainTileCache.ts** — Multi-LOD manager for extreme zoom ranges (0.02x to 50+x). Selects LOD level based on camera zoom with hysteresis to prevent flickering.
- **TerrainTileCache.ts** — Virtual texture cache for a single LOD level. Direct-mapped cache with GPU texture atlas.

### Modifiers and wetness

- **ModifierRasterizer.ts** — Rasterizes wakes, ripples, currents, and obstacles into a screen-space rgba16float modifier texture sampled by `WaterHeightShader`.
- **WetnessRenderPipeline.ts** — Ping-pong texture pipeline for sand wetness tracking with camera reprojection.
- **WetnessStateShader.ts** — Compute shader that updates wetness over time (fast wetting ~0.2s, slow drying ~20s).

### Tuning / configuration

- **SurfaceConstants.ts** — Layout constants (texture margin, tile sizes, etc.) shared between `SurfaceTextures` and the shaders.
- **WaterQualityState.ts** / **WaterTuning.ts** — Persisted user setting for water-height resolution scale + tunable physics constants.
- **BiomeConfig.ts** — Per-level biome colors and packing helpers for the biome storage buffer.

## Render flow

1. **Terrain tile cache update** — `LODTerrainTileCache` selects LOD, renders any missing tiles to the atlas via `TerrainTileShader`.
2. **Pass 1: Terrain Screen** — Sample tile atlas → screen-space r32float terrain height texture.
3. **Wavefront Rasterization** — `WavePhysicsResources` rasterizes wavefront meshes → rgba16float texture array (one layer per wave source, encoding phase correction, coverage, and turbulence).
4. **Pass 2: Water Height** — Compute Gerstner waves using the wave field texture for per-wave energy/phase/turbulence → rgba16float texture (R = height, G = turbulence).
5. **Wetness update** — Update sand wetness via ping-pong compute (optional).
6. **Pass 3: Composite** — Fullscreen fragment passes (`TerrainCompositeShader` + `WaterFilterShader`) read the height textures, compute normals via finite differences, and render with lighting.

## GPU profiling

Each pass has its own GPU timestamp query section:

- `surface.terrain` — Terrain tile rendering + terrain screen compute
- `surface.rasterize` — Wave field rasterization
- `surface.water` — Water height compute
- `surface.wetness` — Wetness update
- `render` — Main render pass (composite + water filter)

View timings in the Graphics panel of the stats overlay.

## Engine helpers used

- `createUniformBuffer(...)` from `core/graphics/UniformStruct.ts` — single helper that allocates the GPU buffer for a `UniformInstance`.
- `createLinearClampSampler(device)` from `core/graphics/webgpu/Samplers.ts` — shared `LINEAR_CLAMP` sampler used across the surface passes.

## Key design decisions

- **Tile-cached terrain** — Terrain heights are computed once per tile, cached in an atlas. Screen-space pass just samples. Multi-LOD supports extreme zoom.
- **Wave field texture** — Wavefront mesh data is rasterized to a texture array. The water height shader samples this instead of computing per-pixel wave-terrain interaction.
- **Bilinear terrain sampling** — Manually implemented in the composite shader because `r32float` textures are unfilterable in WebGPU.
- **Viewport expansion** — The screen viewport is expanded by `SURFACE_TEXTURE_MARGIN` so finite-difference normal computation has data at screen edges.
- **No recomputation for normals** — Normals are computed from height textures via finite differences (cheap texture samples vs expensive height recomputation).
- **Orchestrator vs. implementation split** — `SurfaceRenderer` is an Entity (lifecycle, render loop). `SurfaceShaders` and `SurfaceTextures` are plain classes that own GPU resources; this keeps the entity small and makes the resource lifecycle testable independently.
