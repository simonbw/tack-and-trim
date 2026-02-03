# Surface Rendering Data Flow

This document describes the complete data flow for rendering water and terrain surfaces in the game, with special focus on the wave physics and shadow geometry system.

## Overview

The surface rendering system combines multiple GPU compute pipelines and a fullscreen render shader to create realistic water with wave diffraction around terrain.

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              INITIALIZATION (Startup)                           │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  TerrainInfo                                                                    │
│      │                                                                          │
│      │ contours                                                                 │
│      ▼                                                                          │
│  WavePhysicsManager                                                             │
│      │                                                                          │
│      ├─► CoastlineManager (finds height=0 contours)                            │
│      ├─► SilhouetteComputation (finds edge points per wave direction)          │
│      ├─► ShadowGeometry (builds shadow polygons from silhouettes)              │
│      └─► ShadowGeometryBuffers (uploads to GPU)                                │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              RENDER FRAME (Every Frame)                         │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  SurfaceRenderer.onRender()                                                    │
│      │                                                                          │
│      ├─► AnalyticalWaterRenderPipeline.update()                                │
│      │       │                                                                  │
│      │       └─► AnalyticalWaterStateShader (GPU compute)                      │
│      │               ├─ Inputs: shadow buffers, depth texture, wave params     │
│      │               ├─ Computes: per-pixel wave height with diffraction       │
│      │               └─ Output: water height texture (rgba32float)             │
│      │                                                                          │
│      ├─► TerrainRenderPipeline.update()                                        │
│      │       └─► Terrain height texture                                        │
│      │                                                                          │
│      ├─► WetnessRenderPipeline.update()                                        │
│      │       └─► Wetness texture (sand wetness from waves)                     │
│      │                                                                          │
│      └─► SurfaceShader.render() (fullscreen fragment shader)                   │
│              ├─ Samples: water texture, terrain texture, wetness texture       │
│              └─ Composites: water colors, terrain sand, lighting, fresnel      │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

## Part 1: Wave Physics Initialization

### 1.1 Coastline Extraction

**File:** `src/game/wave-physics/CoastlineManager.ts`

The system starts by identifying coastlines from the terrain definition:

```typescript
// Coastlines are height=0 contours (sea level)
for (const contour of terrainDef.contours) {
  if (contour.height === 0) {
    coastlines.push({ contour, bounds: computeBounds(contour) });
  }
}
```

**Output:** `CoastlineInfo[]` - Array of coastline contours with bounding boxes

### 1.2 Silhouette Point Detection

**File:** `src/game/wave-physics/SilhouetteComputation.ts`

For each coastline, find points where the spline tangent is parallel to the wave direction:

```
Silhouette points are where: cross(tangent, waveDir) = 0

For a Catmull-Rom spline segment:
  tangent(t) = 0.5 × (A + B×t + C×t²)

Solve: a×t² + b×t + c = 0
  where a = cross(C, waveDir)
        b = cross(B, waveDir)
        c = cross(A, waveDir)
```

**Visual representation:**

```
              Wave Direction →

                    ↓ silhouette point (tangent ⊥ wave)
                   ╱
    ┌────────────•────────────┐
    │            │            │
    │   ISLAND   │   ISLAND   │
    │            │            │
    └────────────•────────────┘
                   ╲
                    ↑ silhouette point
```

**Output:** `SilhouettePoint[]` - Points marking terrain edges from wave's perspective

### 1.3 Shadow Polygon Construction

**File:** `src/game/wave-physics/ShadowGeometry.ts`

For each island (coastline contour), create a single shadow polygon:

1. **Find extremal silhouettes**: The leftmost and rightmost silhouette points (perpendicular to wave direction)

2. **Sample waveward arc**: 32 points along the coastline between the silhouettes, on the side facing incoming waves

3. **Build polygon vertices**:
   ```
   Vertex 0:    leftOrigin (left silhouette point)
   Vertex 1:    leftOrigin + waveDir × 50000 (extended into shadow)
   Vertex 2:    rightOrigin + waveDir × 50000 (extended into shadow)
   Vertex 3:    rightOrigin (right silhouette point)
   Vertices 4-33: coastlinePoints[1-30] (waveward arc, skipping endpoints)
   ```

**Visual representation:**

```
                     Wave Direction ↓

                 coastline samples (vertices 4-33)
                    ╱‾‾‾‾‾‾‾‾‾‾‾‾‾‾‾╲
                   ╱    WAVEWARD     ╲
                  ╱       ARC         ╲
    vertex 0 → leftOrigin       rightOrigin ← vertex 3
                  │                   │
                  │   SHADOW ZONE     │
                  │   (inside polygon)│
                  ↓                   ↓
    vertex 1 → extended           extended ← vertex 2
                 left               right
                  │___________________|
```

### 1.4 GPU Buffer Upload

**File:** `src/game/wave-physics/ShadowGeometryBuffers.ts`

Four GPU buffers are created and uploaded:

| Buffer             | Content                                                      | Size per Item |
| ------------------ | ------------------------------------------------------------ | ------------- |
| `shadowBoundaries` | Left/right silhouette origins + directions                   | 32 bytes      |
| `shadowPolygons`   | Polygon metadata (boundary indices, bounds, coastline range) | 40 bytes      |
| `shadowParams`     | Boundary count, polygon count, wave direction                | 16 bytes      |
| `coastlinePoints`  | Sampled arc points (vec2 array)                              | 8 bytes       |

**ShadowPolygon GPU struct:**

```wgsl
struct ShadowPolygon {
  leftBoundaryIndex: u32,     // Index into boundaries array
  rightBoundaryIndex: u32,    // Index into boundaries array
  obstacleWidth: f32,         // Distance between silhouettes
  contourIndex: u32,          // Which coastline this is from
  boundsMin: vec2<f32>,       // AABB for early rejection
  boundsMax: vec2<f32>,       // AABB for early rejection
  coastlinePointsStart: u32,  // Start index in coastlinePoints array
  coastlinePointsCount: u32,  // Always 32
}
```

## Part 2: Per-Frame Wave Computation

### 2.1 Shader Binding

**File:** `src/game/surface-rendering/AnalyticalWaterRenderPipeline.ts`

The render pipeline binds all shadow buffers to the compute shader:

```typescript
this.bindGroup = this.shader.createBindGroup({
  // ... other bindings ...
  shadowBoundaries: { buffer: boundariesBuffer },
  shadowPolygons: { buffer: polygonsBuffer },
  shadowParams: { buffer: shadowParamsBuffer },
  coastlinePoints: { buffer: coastlinePointsBuffer },
});
```

### 2.2 Wave Physics Shader

**File:** `src/game/wave-physics/WavePhysicsShader.wgsl.ts`

The GPU compute shader performs per-pixel wave physics:

#### Step 1: Point-in-Polygon Test

```wgsl
fn isPointInShadowPolygon(worldPos, polygon, ...) -> bool {
  // 1. Quick bounds check
  if (outside polygon.bounds) return false;

  // 2. Build polygon from 34 vertices:
  //    - 4 fixed (silhouettes + extended points)
  //    - 30 coastline samples (32 minus 2 endpoints)
  let totalVertices = 4u + (coastlinePointsCount - 2u);

  // 3. Winding number algorithm
  for each edge in polygon:
    count ray crossings from worldPos going +X

  return winding != 0;
}
```

#### Step 2: Fresnel Diffraction

```wgsl
fn computeFresnelEnergy(distToBoundary, distBehind, wavelength) -> f32 {
  // Fresnel parameter: u = x × √(2 / (λ × z))
  let u = distToBoundary * sqrt(2.0 / (wavelength * distBehind));

  // Energy via error function approximation
  return 0.5 * (1.0 - tanh(u * 1.128 * 0.7));
}
```

#### Step 3: Wave Direction Modification (Huygens Principle)

```wgsl
fn computeDiffractedDirection(worldPos, originalDir, shadow, wavelength) {
  // Waves bend around obstacles as if secondary sources at boundaries
  // Weight contributions from left and right boundary points
  // Blend back toward original direction with distance (shadow recovery)
}
```

#### Step 4: Gerstner Wave Integration

```wgsl
fn calculateWaves(worldPos, time) -> vec4<f32> {
  // Get wave modification for swell (λ=200ft) and chop (λ=30ft)
  let swellMod = getAnalyticalWaveModification(worldPos, 200.0);
  let chopMod = getAnalyticalWaveModification(worldPos, 30.0);

  // Apply to each wave component
  for each wave:
    amplitude *= waveMod.energyFactor;
    direction = waveMod.newDirection;
    // Compute Gerstner displacement and height
}
```

### 2.3 Output Texture

The compute shader outputs to an rgba32float texture:

| Channel | Content     | Notes                                     |
| ------- | ----------- | ----------------------------------------- |
| R       | Wave height | Normalized, includes Gerstner + modifiers |
| G       | dH/dt       | Rate of height change (for foam)          |
| B       | Velocity X  | From wake modifiers                       |
| A       | Velocity Y  | From wake modifiers                       |

## Part 3: Surface Rendering

### 3.1 Pipeline Orchestration

**File:** `src/game/surface-rendering/SurfaceRenderer.ts`

```typescript
@on("render")
onRender() {
  // 1. Update water compute
  this.waterPipeline.update(viewport, waterInfo);

  // 2. Update terrain compute
  this.terrainPipeline.update(viewport, time);

  // 3. Update wetness compute
  this.wetnessPipeline.update(viewport, waterTex, terrainTex);

  // 4. Render fullscreen surface
  this.renderSurface(renderPass, waterTex, terrainTex, wetnessTex);
}
```

### 3.2 Final Compositing

**File:** `src/game/surface-rendering/SurfaceShader.ts`

The fullscreen fragment shader combines all textures:

- **Water rendering**: Fresnel reflections, specular highlights, subsurface scattering
- **Terrain rendering**: Sand texturing with depth-based coloring
- **Depth blending**: Smooth transition at shorelines
- **Wetness overlay**: Sand darkening from wave wash

## Data Flow Summary

```
┌────────────────────┐
│ TerrainDefinition  │
│ (contours array)   │
└─────────┬──────────┘
          │ height=0 contours
          ▼
┌────────────────────┐
│ CoastlineManager   │
│ (bounds per coast) │
└─────────┬──────────┘
          │ coastline + waveDir
          ▼
┌────────────────────┐     ┌─────────────────────┐
│ computeSilhouettes │────►│ SilhouettePoint[]   │
│ (tangent ⊥ wave)   │     │ (edges of terrain)  │
└────────────────────┘     └─────────┬───────────┘
                                     │
                                     ▼
                           ┌─────────────────────┐
                           │ buildShadowGeometry │
                           │ (polygon vertices)  │
                           └─────────┬───────────┘
                                     │
          ┌──────────────────────────┼──────────────────────────┐
          │                          │                          │
          ▼                          ▼                          ▼
┌─────────────────┐      ┌───────────────────┐      ┌──────────────────┐
│ boundaries[]    │      │ polygons[]        │      │ coastlinePoints[]│
│ (silhouettes)   │      │ (metadata)        │      │ (32 pts/polygon) │
└────────┬────────┘      └─────────┬─────────┘      └────────┬─────────┘
         │                         │                         │
         └─────────────────────────┼─────────────────────────┘
                                   │ GPU buffer upload
                                   ▼
                          ┌────────────────────┐
                          │ GPU Compute Shader │
                          │ (per-pixel waves)  │
                          └─────────┬──────────┘
                                    │
                                    ▼
                          ┌────────────────────┐
                          │ Water Height Tex   │
                          │ (rgba32float)      │
                          └─────────┬──────────┘
                                    │
                                    ▼
                          ┌────────────────────┐
                          │ SurfaceShader      │
                          │ (fullscreen render)│
                          └────────────────────┘
```

## Key Files Reference

| File                                                             | Purpose                                    |
| ---------------------------------------------------------------- | ------------------------------------------ |
| `src/game/wave-physics/CoastlineManager.ts`                      | Extracts height=0 coastlines               |
| `src/game/wave-physics/SilhouetteComputation.ts`                 | Finds silhouette points on splines         |
| `src/game/wave-physics/ShadowGeometry.ts`                        | Builds shadow polygons from silhouettes    |
| `src/game/wave-physics/ShadowGeometryBuffers.ts`                 | GPU buffer upload for shadow data          |
| `src/game/wave-physics/WavePhysicsShader.wgsl.ts`                | WGSL code for shadow testing + diffraction |
| `src/game/wave-physics/WavePhysicsManager.ts`                    | Orchestrates wave physics initialization   |
| `src/game/world-data/water/webgpu/AnalyticalWaterStateShader.ts` | Complete water compute shader              |
| `src/game/surface-rendering/AnalyticalWaterRenderPipeline.ts`    | Per-frame water compute orchestration      |
| `src/game/surface-rendering/SurfaceRenderer.ts`                  | Main render entity                         |
| `src/game/surface-rendering/SurfaceShader.ts`                    | Fullscreen compositing shader              |

## Known Issues

### Bay Shadow Problem (Current)

The winding number point-in-polygon test is returning incorrect results for shadow regions. Symptoms:

- Debug visualization shows correct polygon shapes (ShadowZonesDebugMode uses CPU data)
- But wave energy shows rectangular shadows (GPU shader polygon test failing)
- Coastline points ARE uploaded correctly (visible as colored dots in debug)
- The `inSimpleRect && !inFullPolygon` debug shows blue for shadow areas

**Likely cause:** The polygon vertex order creates a valid closed polygon, but the winding number algorithm may be counting crossings incorrectly for the specific vertex arrangement (4 fixed corners + 30 coastline samples).

**To investigate:**

1. Check if `coastlinePointsCount` is being read correctly on GPU (should be 32)
2. Verify vertex indexing in `getShadowPolygonVertex()` produces correct positions
3. Test winding algorithm with a known simple polygon to verify correctness
