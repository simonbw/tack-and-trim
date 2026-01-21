# Surface Rendering

Renders the ocean and terrain as a fullscreen effect using WebGPU.

## Architecture

Two GPU compute pipelines generate per-pixel height data, then a fullscreen
render shader composites them with lighting and effects.

```
┌─────────────────────┐     ┌─────────────────────┐
│ WaterRenderPipeline │     │TerrainRenderPipeline│
│ (wave heights)      │     │ (terrain heights)   │
└─────────┬───────────┘     └──────────┬──────────┘
          │ texture                    │ texture
          └───────────┬────────────────┘
                      ▼
              ┌───────────────┐
              │ SurfaceShader │
              │ (fullscreen   │
              │  render)      │
              └───────────────┘
```

## Files

- **SurfaceRenderer.ts** - Entity that orchestrates the pipelines and manages
  render state (uniforms, bind groups). Runs every frame.
- **WaterRenderPipeline.ts** - GPU compute pipeline for water heights.
  Outputs rgba32float texture with wave + modifier data.
- **TerrainRenderPipeline.ts** - GPU compute pipeline for terrain heights.
  Outputs rgba32float texture with signed terrain elevation.
- **SurfaceShader.ts** - FullscreenShader subclass containing WGSL code.
  Renders water with fresnel/specular/subsurface scattering, terrain with
  sand texturing, and blends them based on water depth.

## Render Flow

1. SurfaceRenderer.onRender() is called each frame
2. WaterRenderPipeline.update() runs GPU compute → water texture
3. TerrainRenderPipeline.update() runs GPU compute → terrain texture
4. Uniforms uploaded (camera, time, viewport)
5. SurfaceShader.render() draws fullscreen quad sampling both textures
