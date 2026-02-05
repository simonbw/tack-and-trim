# Surface Rendering

Renders the ocean and terrain using a multi-pass WebGPU pipeline.

## Architecture

The surface renderer uses three GPU passes for flexibility and profiling:

```
┌─────────────────┐  ┌──────────────────┐  ┌─────────────────────┐
│ WaterResources  │  │ TerrainResources │  │ WavePhysicsResources│
│ (wave data,     │  │ (contour data)   │  │ (shadow texture)    │
│  modifiers)     │  │                  │  │                     │
└────────┬────────┘  └────────┬─────────┘  └──────────┬──────────┘
         │                    │                       │
         ▼                    ▼                       │
┌─────────────────┐  ┌─────────────────┐              │
│ Pass 1: Water   │  │ Pass 2: Terrain │              │
│ Height Compute  │  │ Height Compute  │              │
│ (r32float tex)  │  │ (r32float tex)  │              │
└────────┬────────┘  └────────┬────────┘              │
         │                    │                       │
         └──────────┬─────────┴───────────────────────┘
                    ▼
         ┌─────────────────────┐
         │ Pass 3: Surface     │
         │ Composite (fragment)│
         │ Normals + lighting  │
         └─────────────────────┘
```

## Files

### Shaders
- **WaterHeightShader.ts** - Compute shader for Gerstner waves + modifiers
- **TerrainHeightShader.ts** - Compute shader for contour-based terrain height
- **SurfaceCompositeShader.ts** - Fragment shader for normals + lighting

### Uniforms
- **WaterHeightUniforms.ts** - Params for water height pass
- **TerrainHeightUniforms.ts** - Params for terrain height pass
- **SurfaceCompositeUniforms.ts** - Params for composite pass

### Core
- **SurfaceRenderer.ts** - Entity that orchestrates the three passes

### Legacy (kept for reference)
- **UnifiedSurfaceShader.ts** - Single-pass version (not used)
- **UnifiedSurfaceUniforms.ts** - Uniforms for single-pass (not used)

### Other
- **WetnessRenderPipeline.ts** - Sand wetness tracking (disabled for now)
- **WetnessStateShader.ts** - Compute shader for wetness

## Render Flow

1. **Shadow Texture Update** - WavePhysicsResources renders shadow polygons
2. **Pass 1: Water Height** - Compute Gerstner waves + modifiers → r32float texture
3. **Pass 2: Terrain Height** - Compute contour heights → r32float texture
4. **Pass 3: Surface Composite** - Read height textures, compute normals via finite differences, render with lighting

## GPU Profiling

Each pass has its own GPU timestamp query section:
- `waterHeight` - Water height compute pass
- `terrainHeight` - Terrain height compute pass
- `shadowCompute` - Shadow texture render pass
- `render` - Main render pass (includes composite)

View timings in the Graphics panel of the stats overlay.

## Benefits of Multi-Pass

1. **Per-pass GPU timing** - Identify which computation is expensive
2. **Future: Lower resolution** - Compute heights at 1/4 res, upsample
3. **Future: Temporal caching** - Cache terrain height when camera static
4. **Future: Different update rates** - Update water every frame, terrain less often

## Key Features

- **No recomputation for normals** - Normals computed from height textures via finite differences (cheap texture samples vs expensive height recomputation)
- **Direct resource binding** - Uses existing GPU buffers from resource managers
- **Shadow-based diffraction** - Samples WavePhysicsResources shadow texture
- **Gerstner waves** - Analytical wave computation with tide and modifiers
- **Contour-based terrain** - Catmull-Rom splines with signed distance computation
