# World Rendering System Architecture

## Purpose of This Document

This documentation is part of a deliberate refactoring strategy. Over time, the world rendering and data systems accumulated complexity and vestiges of abandoned approaches. Rather than incrementally cleaning up the existing code, we're taking a different approach:

1. **Document thoroughly** - Capture everything the current system does, how it works, and why. This document is that comprehensive reference.

2. **Delete the existing code** - With the system fully documented and the old code safely preserved in git, we can delete the existing implementation entirely.

3. **Design fresh** - Using this documentation as a specification, design a cleaner architecture that incorporates lessons learned but without the accumulated cruft.

4. **Rebuild from scratch** - Implement the new design with consistent patterns and cleaner code, using this document to ensure we don't lose important functionality.

This approach trades the risk of a rewrite for the benefit of a coherent architecture built with full knowledge of the problem space. The old code remains available in git if we need to reference specific implementation details.

---

## Systems Covered

This document provides comprehensive technical documentation for the world rendering and data systems in Tack & Trim. It covers three interconnected systems:

1. **Surface Rendering** - GPU pipelines for rendering water, terrain, and wetness
2. **Wave Physics** - Shadow-based wave diffraction computation
3. **World Data** - Spatial data providers (wind, water, terrain) with GPU/CPU hybrid queries

This documentation is intended to serve as a complete reference for understanding, maintaining, or reimplementing these systems.

---

# Table of Contents

## Part 1: Surface Rendering System

- [Architecture Overview](#architecture-overview)
- [System Flow](#system-flow)
- [File Documentation](#file-by-file-documentation)
- [Texture Pipeline](#texture-pipeline)
- [Shader Analysis](#shader-code-analysis)
- [Uniforms and Data Structures](#uniforms-and-data-structures)
- [GPU Pipeline Details](#gpu-pipeline-details)
- [Configuration and Tuning](#configuration-and-tuning)

## Part 2: Wave Physics System

- [System Overview](#system-overview)
- [Architecture & Data Flow](#architecture--data-flow)
- [Core Components](#core-components)
- [Key Algorithms](#key-algorithms)
- [Data Structures](#data-structures)
- [GPU/CPU Integration](#gpucpu-integration)

## Part 3: World Data System

- [DataTile Abstraction](#datatile-abstraction)
- [Data Providers](#data-providers)
- [Wind System](#wind-system)
- [Water System](#water-system)
- [Terrain System](#terrain-system)
- [Influence Fields](#influence-fields)
- [Weather State](#weather-state)
- [Integration Patterns](#integration-patterns)

---

# Part 1: Surface Rendering

# Surface Rendering System - Comprehensive Technical Documentation

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [System Flow](#system-flow)
3. [File-by-File Documentation](#file-by-file-documentation)
4. [Texture Pipeline](#texture-pipeline)
5. [Shader Code Analysis](#shader-code-analysis)
6. [Uniforms and Data Structures](#uniforms-and-data-structures)
7. [GPU Pipeline Details](#gpu-pipeline-details)
8. [Configuration and Tuning](#configuration-and-tuning)
9. [External Dependencies](#external-dependencies)
10. [Key Patterns and Implementation Notes](#key-patterns-and-implementation-notes)

---

## Architecture Overview

The surface-rendering system is a GPU-accelerated fullscreen effect that renders water and terrain using a multi-stage pipeline. It consists of three main components:

```
┌──────────────────────────────────┐
│     SurfaceRenderer (Entity)      │  Orchestrator
│  - Frame lifecycle management     │  - Uniforms
│  - Texture/bind group caching     │  - Pipeline coordination
└────────────────┬─────────────────┘
                 │
     ┌───────────┼───────────┐
     │           │           │
     ▼           ▼           ▼
┌──────────┐ ┌──────────┐ ┌──────────┐
│ Water    │ │ Terrain  │ │ Wetness  │ GPU Compute Pipelines
│ Pipeline │ │ Pipeline │ │ Pipeline │ - Generate per-pixel data
└────┬─────┘ └────┬─────┘ └────┬─────┘ - Output to textures
     │            │            │
     └────────┬───┴────────┬───┘
              │            │
              ▼            ▼
         ┌─────────────────────────┐
         │   SurfaceShader         │  Fullscreen Render
         │  (displays final image) │  - Composites all textures
         └─────────────────────────┘  - Applies lighting & effects
```

### Design Principles

1. **Separation of Concerns**: Each pipeline handles one data type
2. **Texture-Based Composition**: Data flows through GPU textures, not CPU
3. **Viewport-Driven**: All compute is relative to camera viewport
4. **Configurable Resolution**: Texture scales are independently configurable
5. **Fallback Graceful**: Works with missing pipelines (shows deep water/no terrain)

---

## System Flow

### Frame Lifecycle

```
SurfaceRenderer.onRender(dt, draw)
├─ Ensure all systems initialized
├─ Configure water pipeline (once) with depth/shadow textures
├─ Update water pipeline
│  └─ AnalyticalWaterRenderPipeline.update(viewport)
│     └─ GPU compute shader → water texture
├─ Update terrain pipeline (if terrain exists)
│  └─ TerrainRenderPipeline.update(viewport)
│     └─ GPU rasterize shader → terrain texture
├─ Update shadow texture (for wave diffraction)
├─ Update wetness pipeline (if terrain + water exist)
│  └─ WetnessRenderPipeline.update(viewport)
│     └─ GPU compute shader → wetness texture (ping-pong)
├─ Update uniforms
│  └─ Camera matrix, time, viewport bounds, texture dimensions
├─ Render surface (fullscreen)
│  └─ SurfaceShader samples all textures, composites to screen
└─ (Debug) Draw terrain contours if renderMode == 1
```

### Key Synchronization Points

1. **Influence Fields**: `onInfluenceFieldsReady()` event - configures depth/shadow textures
2. **Terrain Updates**: Version checking prevents redundant GPU uploads
3. **Viewport Consistency**: Expanded viewport with margin used for all compute pipelines
4. **Wetness Reprojection**: Snapped viewport ensures 1:1 texel mapping across frames

---

## File-by-File Documentation

### 1. SurfaceRenderer.ts (Orchestrator Entity)

**Purpose**: Main game entity that orchestrates all surface rendering. Runs every frame in the `render` event.

**Lifecycle**:

- `onAdd()` - Initializes all GPU resources (async)
- `onInfluenceFieldsReady()` - Configures water pipeline with terrain influence
- `onRender()` - Updates pipelines and renders surface
- `onDestroy()` - Cleans up all GPU resources

**Key Class Members**:

```typescript
class SurfaceRenderer extends BaseEntity {
  // Configuration
  config: Required<SurfaceRendererConfig>;

  // Pipelines
  waterPipeline: AnalyticalWaterRenderPipeline;
  terrainPipeline: TerrainRenderPipeline;
  wetnessPipeline: WetnessRenderPipeline;
  shader: SurfaceShader;

  // GPU Resources
  uniformBuffer: GPUBuffer;      // Uniform struct for shader
  sampler: GPUSampler;           // Linear sampler for texture reads
  bindGroup: GPUBindGroup;       // Cached bind group

  // Placeholder textures (for when pipelines not ready)
  placeholderTerrainTexture: GPUTexture;    // 1×1, deep water (-50)
  placeholderWetnessTexture: GPUTexture;    // 1×1, dry (0)

  // Computed dimensions
  waterTexWidth/Height: number;
  terrainTexWidth/Height: number;
  wetnessTexWidth/Height: number;

  // State tracking
  initialized: boolean;
  lastTerrainVersion: number;    // For version checking
  influenceConfigured: boolean;  // Depth/shadow textures set?
  renderMode: number;            // 0 = normal, 1 = debug terrain
}
```

**Key Methods**:

| Method                        | Purpose                                                   |
| ----------------------------- | --------------------------------------------------------- |
| `ensureInitialized()`         | Async init of all GPU resources, called on `onAdd()`      |
| `tryConfigureWaterPipeline()` | Configures water pipeline with depth/shadow once per game |
| `getExpandedViewport(margin)` | Returns camera viewport expanded by percentage            |
| `setCameraMatrix(matrix)`     | Updates inverse camera matrix for screen→world transform  |
| `renderSurface()`             | Executes fullscreen shader render with current textures   |
| `setRenderMode(mode)`         | Sets debug visualization mode                             |

**Viewport Handling**:

```typescript
// Render viewport: used for water/terrain compute
const expandedViewport = this.getExpandedViewport(RENDER_VIEWPORT_MARGIN); // 0.1 = 10%

// Wetness viewport: larger margin for better temporal coherence
const wetnessViewport = this.getExpandedViewport(WETNESS_VIEWPORT_MARGIN); // 0.5 = 50%

// Snapped wetness viewport: aligned to texel grid (from pipeline)
const snappedWetnessViewport = this.wetnessPipeline.getSnappedViewport();
```

**Placeholder Textures**:

- Terrain: 1×1 RGBA32F, value `(-50, 0, 0, 1)` = deep water, no terrain
- Wetness: 1×1 R32F, value `0` = dry sand
- Used when pipelines not yet initialized or terrain missing

**Configuration**:

```typescript
interface SurfaceRendererConfig {
  textureScale?: number; // Default: 0.5 (half resolution)
  waterTextureScale?: number; // Override for water only
  terrainTextureScale?: number; // Override for terrain only
  wetnessTextureScale?: number; // Override for wetness only
}

// Applied as: texWidth = Math.ceil(screenWidth * scale)
```

---

### 2. SurfaceUniforms.ts (Type-Safe Uniform Struct)

**Purpose**: Type-safe definition of the uniform buffer passed to the surface shader.

**Uniform Struct Layout** (48 bytes of padding due to mat3x3):

```typescript
export const SurfaceUniforms = defineUniformStruct("Uniforms", {
  cameraMatrix: mat3x3, // 48 bytes (3×3 matrix + padding)
  time: f32, // 4 bytes (elapsed time)
  renderMode: f32, // 4 bytes (0=normal, 1=terrain debug)
  screenWidth: f32, // 4 bytes
  screenHeight: f32, // 4 bytes
  viewportLeft: f32, // 4 bytes (render viewport bounds)
  viewportTop: f32, // 4 bytes
  viewportWidth: f32, // 4 bytes
  viewportHeight: f32, // 4 bytes
  colorNoiseStrength: f32, // 4 bytes (currently unused)
  hasTerrainData: i32, // 4 bytes (0 or 1)
  shallowThreshold: f32, // 4 bytes (1.5 world units)
  waterTexWidth: f32, // 4 bytes (texture dimensions)
  waterTexHeight: f32, // 4 bytes
  terrainTexWidth: f32, // 4 bytes
  terrainTexHeight: f32, // 4 bytes
  wetnessTexWidth: f32, // 4 bytes
  wetnessTexHeight: f32, // 4 bytes
  _padding1: f32, // 4 bytes (alignment)
  _padding2: f32, // 4 bytes (alignment)
  wetnessViewportLeft: f32, // 4 bytes (wetness viewport bounds)
  wetnessViewportTop: f32, // 4 bytes
  wetnessViewportWidth: f32, // 4 bytes
  wetnessViewportHeight: f32, // 4 bytes
});
```

**Total Size**: 160+ bytes (with WebGPU padding rules)

**Usage in Shader**:

```wgsl
@group(0) @binding(0) var<uniform> uniforms: Uniforms;

// In fragment shader:
let screenPos = (clipPosition * 0.5 + 0.5) * vec2<f32>(uniforms.screenWidth, uniforms.screenHeight);
let worldPos = (uniforms.cameraMatrix * vec3<f32>(screenPos, 1.0)).xy;
let dataUV = (worldPos - vec2<f32>(uniforms.viewportLeft, uniforms.viewportTop)) /
             vec2<f32>(uniforms.viewportWidth, uniforms.viewportHeight);
```

---

### 3. SurfaceShader.ts (Fullscreen Render Shader)

**Purpose**: Fullscreen shader that composites water, terrain, and wetness textures with realistic lighting and effects.

**Extends**: `FullscreenShader<T>` - Base class handling pipeline boilerplate

**Bindings**:

```typescript
const bindings = {
  uniforms: { type: "uniform" }, // SurfaceUniforms struct
  waterSampler: { type: "sampler" }, // Linear sampler
  waterDataTexture: { type: "texture" }, // RGBA32F from AnalyticalWaterRenderPipeline
  terrainDataTexture: { type: "texture" }, // RGBA32F from TerrainRenderPipeline
  wetnessTexture: { type: "texture" }, // R32F from WetnessRenderPipeline
} as const;
```

**Fragment Shader Algorithm**:

```wgsl
Main Steps:
1. Convert clip space to screen position
2. Transform screen → world position using inverse camera matrix
3. Map world position to data texture UV (render viewport)
4. Sample water height (normalized, [0, 1])
5. Sample terrain height (signed, underwater negative)
6. Calculate water depth = (waterHeight - 0.5) * WATER_HEIGHT_SCALE - terrainHeight
7. Calculate normals (per-pixel gradients)
   - Water normal: 4-tap sample gradient
   - Terrain normal: 4-tap sample gradient
   - Blend normals based on water depth
8. Sample wetness (with 5-tap cross blur)
9. Render based on depth:
   - waterDepth < 0: Render sand with wetness
   - 0 < waterDepth < threshold: Blend sand/water, add foam
   - waterDepth >= threshold: Render deep water
10. Apply lighting (Fresnel, subsurface scattering, specular)
```

**Height Sampling**:

```wgsl
fn sampleTerrain(uv: vec2<f32>) -> f32 {
  let clampedUV = clamp(uv, vec2<f32>(0.0), vec2<f32>(1.0));
  return textureSampleLevel(terrainDataTexture, waterSampler, clampedUV, 0.0).r;
}

// Water: raw height = waterData.r (normalized [0, 1])
// Water height (world units) = (rawHeight - 0.5) * WATER_HEIGHT_SCALE
// WATER_HEIGHT_SCALE = 5.0 → range [-2.5, 2.5] world units
```

**Normal Calculation**:

```wgsl
// Separate texel sizes for non-square textures
let waterTexelSizeX = 1.0 / uniforms.waterTexWidth;
let waterTexelSizeY = 1.0 / uniforms.waterTexHeight;

// 4-tap cross pattern for finite differences
let heightL = textureSample(..., dataUV + vec2<f32>(-waterTexelSizeX, 0.0)).r;
let heightR = textureSample(..., dataUV + vec2<f32>(waterTexelSizeX, 0.0)).r;
let heightD = textureSample(..., dataUV + vec2<f32>(0.0, -waterTexelSizeY)).r;
let heightU = textureSample(..., dataUV + vec2<f32>(0.0, waterTexelSizeY)).r;

let waterNormal = normalize(vec3<f32>(
  (heightL - heightR) * heightScale,  // X gradient (inverted for normal facing up)
  (heightD - heightU) * heightScale,  // Y gradient
  1.0
));
```

**Rendering Functions**:

```wgsl
fn renderSand(height: f32, normal: vec3<f32>, worldPos: vec2<f32>, wetness: f32) -> vec3<f32> {
  let drySand = vec3<f32>(0.96, 0.91, 0.76);     // Light beige
  let wetSand = vec3<f32>(0.76, 0.70, 0.50);     // Dark tan
  let visualWetness = pow(wetness, 2.5);         // Non-linear blend
  return mix(drySand, wetSand, visualWetness);
}

fn renderWater(rawHeight: f32, normal: vec3<f32>, worldPos: vec2<f32>, waterDepth: f32) -> vec3<f32> {
  // Base colors
  let shallowWater = vec3<f32>(0.15, 0.55, 0.65);  // Light blue-green
  let deepWater = vec3<f32>(0.08, 0.32, 0.52);     // Darker blue

  // Depth-based color (deeper = darker)
  let depthFactor = smoothstep(0.0, 10.0, waterDepth);
  var baseColor = mix(shallowWater, deepWater, depthFactor);

  // Apply lighting:
  // - Fresnel effect: edge-on reflection
  // - Subsurface scattering: sun penetrating water
  // - Diffuse: sun hitting surface
  // - Specular: sun reflection
  // - Fine noise: high-frequency detail

  return color;
}
```

**Depth-Based Blending**:

```wgsl
if (waterDepth < 0.0) {
  // Above water - render sand
  let sandColor = renderSand(terrainHeight, normal, worldPos, wetness);
  return vec4<f32>(sandColor, 1.0);
} else if (waterDepth < uniforms.shallowThreshold) {
  // Shallow water - blend sand and water
  let rawBlend = smoothstep(0.0, uniforms.shallowThreshold, waterDepth);
  let minWaterBlend = 0.35;  // Always show some water
  let blendFactor = mix(minWaterBlend, 1.0, rawBlend);

  let sandColor = renderSand(terrainHeight, normal, worldPos, wetness);
  let waterColor = renderWater(rawHeight, normal, worldPos, waterDepth);
  var blendedColor = mix(sandColor, waterColor, blendFactor);

  // Add foam at water's edge
  let foamThreshold = 0.15;
  let foamIntensity = smoothstep(foamThreshold, 0.02, waterDepth);
  let foamNoise = hash21(worldPos * 5.0);
  let foam = foamIntensity * smoothstep(0.15, 0.4, foamNoise);
  blendedColor = mix(blendedColor, vec3<f32>(0.95, 0.98, 1.0), foam * 0.7);

  return vec4<f32>(blendedColor, 1.0);
} else {
  // Deep water
  let color = renderWater(rawHeight, normal, worldPos, waterDepth);
  return vec4<f32>(color, 1.0);
}
```

**Wetness Sampling** (with blur):

```wgsl
// Map world position to wetness viewport UV (may differ from render viewport)
let wetnessUV = (worldPos - vec2<f32>(uniforms.wetnessViewportLeft, uniforms.wetnessViewportTop)) /
                vec2<f32>(uniforms.wetnessViewportWidth, uniforms.wetnessViewportHeight);

// 5-tap cross pattern blur to soften edges
let wetnessTexelSizeX = 1.0 / uniforms.wetnessTexWidth;
let wetnessTexelSizeY = 1.0 / uniforms.wetnessTexHeight;
let clampedUV = clamp(wetnessUV, vec2<f32>(0.0), vec2<f32>(1.0));
let wetness = (
  textureSampleLevel(wetnessTexture, waterSampler, clampedUV, 0.0).r * 0.4 +
  textureSampleLevel(wetnessTexture, waterSampler, clampedUV + vec2<f32>(wetnessTexelSizeX, 0.0), 0.0).r * 0.15 +
  textureSampleLevel(wetnessTexture, waterSampler, clampedUV + vec2<f32>(-wetnessTexelSizeX, 0.0), 0.0).r * 0.15 +
  textureSampleLevel(wetnessTexture, waterSampler, clampedUV + vec2<f32>(0.0, wetnessTexelSizeY), 0.0).r * 0.15 +
  textureSampleLevel(wetnessTexture, waterSampler, clampedUV + vec2<f32>(0.0, -wetnessTexelSizeY), 0.0).r * 0.15
);
```

**Debug Mode** (renderMode == 1):

```wgsl
// Visualize terrain heights as colored gradient
if (terrainHeight < 0.0) {
  // Underwater: dark blue (-50) → light blue (0)
  let depthFactor = clamp(-terrainHeight / 50.0, 0.0, 1.0);
  debugColor = mix(lightBlue, darkBlue, depthFactor);
} else {
  // Above water: dark brown (0) → light brown (MAX_TERRAIN_HEIGHT)
  let heightFactor = clamp(terrainHeight / MAX_TERRAIN_HEIGHT, 0.0, 1.0);
  debugColor = mix(darkBrown, lightBrown, heightFactor);
}
```

---

### 4. AnalyticalWaterRenderPipeline.ts (Water Compute Pipeline)

**Purpose**: Computes analytical wave heights using Gerstner wave model with shadow-based diffraction and depth-based damping.

**Pipeline Type**: GPU Compute Shader → Output Texture

**Input Sources**:

- `AnalyticalWaterStateShader` - Compute shader implementing wave math
- Depth texture from `InfluenceFieldManager` - For shoaling/damping
- Shadow texture from `WavePhysicsManager` - For diffraction
- Wake segments from `WaterInfo` - Local disturbances

**Output**:

- RGBA32F texture with:
  - **R** (red): Normalized combined wave height [0, 1]
  - **G** (green): Normalized height velocity dh/dt [0, 1]
  - **B, A**: Reserved/unused

**Class Members**:

```typescript
class AnalyticalWaterRenderPipeline {
  // Shader and execution
  shader: AnalyticalWaterStateShader;
  buffers: WaterComputeBuffers; // Params, wave data, segments
  bindGroup: GPUBindGroup;

  // Output
  outputTexture: GPUTexture; // RGBA32F
  outputTextureView: GPUTextureView;

  // Configuration
  analyticalConfig: AnalyticalRenderConfig | null;

  // Fallback resources (when config not available)
  fallbackDepthTexture: GPUTexture; // 1×1, -100 (deep water)
  fallbackDepthSampler: GPUSampler;
  fallbackShadowTexture: GPUTexture; // 1×1, 0 (no shadow)
  fallbackShadowDataBuffer: GPUBuffer;
}
```

**Configuration Structure**:

```typescript
interface AnalyticalRenderConfig {
  depthTexture: GPUTexture; // From InfluenceFieldManager
  depthSampler: GPUSampler; // Matches depth texture
  depthGridConfig: DepthGridConfig; // Origin, cell size, dimensions
  shadowTextureView: GPUTextureView; // From WavePhysicsManager
  shadowDataBuffer: GPUBuffer; // Shadow polygon data
  waveSourceDirection: number; // WAVE_COMPONENTS[0][2]
}

interface DepthGridConfig {
  originX: number;
  originY: number;
  cellSize: number;
  cellsX: number;
  cellsY: number;
}
```

**Update Flow**:

```typescript
update(viewport: Viewport, waterInfo: WaterInfo, gpuProfiler?: GPUProfiler): void {
  // Return early if analytical config not set
  if (!this.analyticalConfig) return;

  // Collect wake segment data (local wave modifiers)
  const segments = waterInfo.collectShaderSegmentData(viewport);
  const segmentCount = this.buffers.updateSegments(segments);

  // Build params buffer with viewport and grid info
  const paramsData = new Float32Array(16);
  paramsData[0] = time;
  paramsData[1] = viewport.left;
  paramsData[2] = viewport.top;
  paramsData[3] = viewport.width;
  paramsData[4] = viewport.height;
  paramsData[5] = this.textureWidth;
  paramsData[6] = this.textureHeight;
  paramsData[7] = segmentCount;      // Packed as uint32
  paramsData[8] = depthConfig.originX;
  paramsData[9] = depthConfig.originY;
  paramsData[10] = depthConfig.cellsX * depthConfig.cellSize;  // Width
  paramsData[11] = depthConfig.cellsY * depthConfig.cellSize;  // Height
  paramsData[12] = config.waveSourceDirection;
  paramsData[13] = waterInfo.getTideHeight();
  paramsData[14-15] = padding;

  device.queue.writeBuffer(this.buffers.paramsBuffer, 0, paramsData);

  // Dispatch compute shader
  const commandEncoder = device.createCommandEncoder();
  const computePass = commandEncoder.beginComputePass();
  this.shader.dispatch(computePass, this.bindGroup, width, height);
  computePass.end();
  device.queue.submit([commandEncoder.finish()]);
}
```

**Fallback Behavior**:

- When `analyticalConfig` is null, the pipeline doesn't render
- Fallback textures are created but not used
- `SurfaceRenderer` displays placeholder texture instead

---

### 5. TerrainRenderPipeline.ts (Terrain Rasterize Pipeline)

**Purpose**: Rasterizes terrain contours to a height texture using GPU triangle rasterization.

**Pipeline Type**: GPU Render Pass (not compute)

**Architecture**: Two-pass rendering on render target:

1. **Ocean pass**: Background (fullscreen quad) with default depth
2. **Contour pass**: Triangle mesh with depth testing

**Depth Representation**:

- **Negative** (< 0): Underwater terrain, absolute value = depth below sea level
- **Zero** (= 0): Sea level / shoreline
- **Positive** (> 0): Land above sea level, value = height in world units
- **Default** (-50): Deep ocean (no terrain)

**Class Members**:

```typescript
class TerrainRenderPipeline {
  // Shader and execution
  shader: TerrainStateShader;
  buffers: TerrainComputeBuffers;
  bindGroup: GPUBindGroup;

  // Output (render target)
  outputTexture: GPUTexture; // RGBA32F
  depthTexture: GPUTexture; // Depth32F (for rasterization)
  outputTextureView: GPUTextureView;

  // Geometry
  vertexBuffer: GPUBuffer; // Combined vertices (3x float per vertex)
  indexBuffer: GPUBuffer; // Uint32 indices
  indexCount: number; // Total indices to draw

  // Definition tracking
  currentDefinition: TerrainDefinition | null;
}
```

**Tessellation Pipeline**:

```typescript
setTerrainDefinition(definition: TerrainDefinition): void {
  this.buffers.updateTerrainData(definition);  // Upload to GPU
  this.updateTerrainGeometry(definition);      // Tessellate & create geometry
}

private updateTerrainGeometry(definition: TerrainDefinition): void {
  // For each contour:
  const tessellated = tessellateContour(
    controlPointsData,     // B-spline control points
    pointStart,            // Offset in control points buffer
    pointCount,            // Number of points for this contour
    contourIndex
  );
  // Returns: { vertices: Float32Array, indices: Uint32Array }

  // Combine all contours into single vertex/index buffer
  const combinedVertices = new Float32Array(totalVertexCount * 3);
  const combinedIndices = new Uint32Array(totalIndexCount);

  // Create GPU buffers
  device.queue.writeBuffer(vertexBuffer, 0, combinedVertices);
  device.queue.writeBuffer(indexBuffer, 0, combinedIndices);
}
```

**Render Pass**:

```wgsl
// Two separate pipelines in TerrainStateShader:

// 1. Ocean Pipeline: Fullscreen quad background
renderPass.setPipeline(oceanPipeline);
renderPass.draw(6);  // 2 triangles (fullscreen quad)

// 2. Contour Pipeline: Tessellated contours with depth testing
renderPass.setPipeline(contourPipeline);
renderPass.setVertexBuffer(0, vertexBuffer);
renderPass.setIndexBuffer(indexBuffer, "uint32");
renderPass.drawIndexed(indexCount);
```

**Params Buffer** (per frame):

```typescript
buffers.updateParams({
  time: number,
  viewportLeft: number,
  viewportTop: number,
  viewportWidth: number,
  viewportHeight: number,
  textureSizeX: number,
  textureSizeY: number,
  contourCount: number,
  defaultDepth: number, // Value to clear with (-50)
  maxDepth: number, // For normalization
});
```

**Depth Semantics**:

- Render target clears to `defaultDepth` (ocean color in output)
- Ocean pipeline writes `defaultDepth` at z=1.0 (farthest)
- Contour pipeline writes terrain heights at z=0 (nearest)
- Depth test prevents ocean from overwriting terrain

---

### 6. WetnessRenderPipeline.ts (Wetness Compute Pipeline)

**Purpose**: Tracks sand wetness over time with temporal smoothing and camera reprojection.

**Pipeline Type**: GPU Compute Shader with Ping-Pong Textures

**Core Concept**: Persistent state texture that evolves based on water depth:

- When waves wash over sand: wetness increases rapidly
- When water recedes: wetness decreases slowly (natural drying)
- When camera moves: reprojection maintains coherent state

**Class Members**:

```typescript
class WetnessRenderPipeline {
  // Shader
  shader: WetnessStateShader;

  // Ping-pong textures (persistent state)
  wetnessTextureA: GPUTexture; // R32F
  wetnessTextureB: GPUTexture; // R32F
  wetnessTextureViewA: GPUTextureView;
  wetnessTextureViewB: GPUTextureView;

  // Bind groups for ping-pong
  bindGroupAtoB: GPUBindGroup; // Read A → write B
  bindGroupBtoA: GPUBindGroup; // Read B → write A
  currentReadTexture: "A" | "B"; // Alternates each frame

  // Params
  paramsBuffer: GPUBuffer; // Params struct
  sampler: GPUSampler;

  // Viewport tracking (for reprojection)
  prevViewport: Viewport | null;
  lastSnappedViewport: Viewport | null;

  // Configuration
  wettingRate: number; // How fast to wet (default 4.0)
  dryingRate: number; // How fast to dry (default 0.15)
}
```

**Ping-Pong Mechanism**:

```
Frame N:
  Read: currentReadTexture = "A" (wetnessTextureA)
  Write: wetnessTextureB
  Dispatch compute shader
  Swap: currentReadTexture = "B"

Frame N+1:
  Read: currentReadTexture = "B" (wetnessTextureB)
  Write: wetnessTextureA
  Dispatch compute shader
  Swap: currentReadTexture = "A"

Output (for display): currentReadTexture texture
```

**Viewport Snapping**:

```typescript
private snapViewportToGrid(viewport: Viewport): Viewport {
  // Snap to texel boundaries to ensure 1:1 texel mapping between frames
  // Prevents blur from sub-pixel sampling during reprojection

  const texelWorldSizeX = viewport.width / this.textureWidth;
  const texelWorldSizeY = viewport.height / this.textureHeight;

  return {
    left: Math.floor(viewport.left / texelWorldSizeX) * texelWorldSizeX,
    top: Math.floor(viewport.top / texelWorldSizeY) * texelWorldSizeY,
    width: viewport.width,
    height: viewport.height,
  };
}
```

**Update Flow**:

```typescript
update(
  wetnessViewport: Viewport,    // Larger margin (0.5)
  renderViewport: Viewport,     // Smaller margin (0.1) for water/terrain
  waterTextureView: GPUTextureView,
  terrainTextureView: GPUTextureView,
  dt: number,
  gpuProfiler?: GPUProfiler
): void {
  // Snap wetness viewport to texel grid
  const snappedViewport = this.snapViewportToGrid(wetnessViewport);
  this.lastSnappedViewport = snappedViewport;

  // Use current snapped as prev if first frame
  const prevViewport = this.prevViewport ?? snappedViewport;

  // Update params buffer
  paramsData[0] = dt;
  paramsData[1] = this.wettingRate;
  paramsData[2] = this.dryingRate;
  paramsData[3-4] = textureSize;
  paramsData[5-8] = snappedViewport;      // Current wetness viewport
  paramsData[9-12] = prevViewport;        // Previous wetness viewport
  paramsData[13-16] = renderViewport;     // For sampling water/terrain

  // Select correct bind group (alternates with ping-pong)
  const bindGroup = currentReadTexture === "A" ? bindGroupAtoB : bindGroupBtoA;

  // Dispatch compute
  device.queue.submit([commandEncoder.finish()]);

  // Swap textures for next frame
  currentReadTexture = currentReadTexture === "A" ? "B" : "A";
  prevViewport = snappedViewport;  // For next frame's reprojection
}
```

**Key Design Points**:

- Two separate viewports: wetness (large, for coherence) vs render (small, for efficiency)
- Reprojection: converts old wetness from previous viewport to current viewport
- Snapping: ensures clean 1:1 texel mapping (no interpolation blur)
- Border handling: new areas entering viewport initialized from current water depth

---

### 7. WetnessStateShader.ts (Wetness Compute Shader)

**Purpose**: Compute shader that evolves wetness state based on water depth.

**Extends**: `ComputeShader<T>` - Base class for compute shaders

**Workgroup Size**: [8, 8] (64 threads per workgroup)

**Parameters Struct**:

```wgsl
struct Params {
  dt: f32,                          // Delta time
  wettingRate: f32,                 // Default 4.0 (reach 1.0 in ~0.25s)
  dryingRate: f32,                  // Default 0.15 (dry in ~6-7s)
  textureSizeX: f32,                // Texture dimensions
  textureSizeY: f32,
  currentViewportLeft: f32,         // Current wetness viewport
  currentViewportTop: f32,
  currentViewportWidth: f32,
  currentViewportHeight: f32,
  prevViewportLeft: f32,            // Previous wetness viewport (for reprojection)
  prevViewportTop: f32,
  prevViewportWidth: f32,
  prevViewportHeight: f32,
  renderViewportLeft: f32,          // Render viewport (water/terrain texture space)
  renderViewportTop: f32,
  renderViewportWidth: f32,
  renderViewportHeight: f32,
}
```

**Bindings**:

```wgsl
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var prevWetnessTexture: texture_2d<f32>;     // Read from previous
@group(0) @binding(2) var waterTexture: texture_2d<f32>;           // From AnalyticalWaterRenderPipeline
@group(0) @binding(3) var terrainTexture: texture_2d<f32>;         // From TerrainRenderPipeline
@group(0) @binding(4) var textureSampler: sampler;
@group(0) @binding(5) var outputTexture: texture_storage_2d<r32float, write>;
```

**Compute Kernel**:

```wgsl
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
  // Boundary check
  if (f32(globalId.x) >= params.textureSizeX || f32(globalId.y) >= params.textureSizeY) {
    return;
  }

  // Step 1: Convert texel coordinates to UV in current viewport
  let uv = vec2<f32>(f32(globalId.x) + 0.5, f32(globalId.y) + 0.5) /
           vec2<f32>(params.textureSizeX, params.textureSizeY);

  // Step 2: Convert UV to world position (current viewport)
  let worldPos = uvToWorld(uv, params.currentViewportLeft, ...);

  // Step 3: Convert world to UV in previous viewport (reprojection)
  let prevUV = worldToUV(worldPos, params.prevViewportLeft, ...);

  // Step 4: Convert world to UV in render viewport (for sampling water/terrain)
  let renderUV = worldToUV(worldPos, params.renderViewportLeft, ...);

  // Step 5: Sample water and terrain at render UV
  let waterData = textureSampleLevel(waterTexture, textureSampler, renderUV, 0.0);
  let terrainData = textureSampleLevel(terrainTexture, textureSampler, renderUV, 0.0);

  // Step 6: Calculate water depth
  let waterSurfaceHeight = (waterData.r - 0.5) * WATER_HEIGHT_SCALE;
  let terrainHeight = terrainData.r;
  let waterDepth = waterSurfaceHeight - terrainHeight;

  // Step 7: Get previous wetness with reprojection
  var prevWetness: f32;
  if (inBounds(prevUV)) {
    prevWetness = textureSampleLevel(prevWetnessTexture, textureSampler, prevUV, 0.0).r;
  } else {
    // New area entering viewport
    if (waterDepth > 0.0) {
      prevWetness = 1.0;  // Underwater = immediately wet
    } else {
      prevWetness = 0.0;  // Exposed = dry
    }
  }

  // Step 8: Update wetness based on water depth
  var newWetness: f32;
  if (waterDepth > 0.0) {
    // Underwater - rapidly wet
    newWetness = min(1.0, prevWetness + params.wettingRate * params.dt);
  } else {
    // Exposed - slowly dry
    newWetness = max(0.0, prevWetness - params.dryingRate * params.dt);
  }

  // Step 9: Write output
  textureStore(outputTexture, vec2<i32>(globalId.xy), vec4<f32>(newWetness, 0.0, 0.0, 1.0));
}
```

**Key Constants**:

```typescript
export const DEFAULT_WETTING_RATE = 4.0; // per second
export const DEFAULT_DRYING_RATE = 0.15; // per second

// Time to reach full wetness: 1.0 / 4.0 = 0.25 seconds
// Time to dry from full: 1.0 / 0.15 = 6.67 seconds
```

**Coordinate Conversion Functions**:

```wgsl
fn uvToWorld(uv: vec2<f32>, viewportLeft: f32, viewportTop: f32,
             viewportWidth: f32, viewportHeight: f32) -> vec2<f32> {
  return vec2<f32>(
    viewportLeft + uv.x * viewportWidth,
    viewportTop + uv.y * viewportHeight
  );
}

fn worldToUV(worldPos: vec2<f32>, viewportLeft: f32, viewportTop: f32,
             viewportWidth: f32, viewportHeight: f32) -> vec2<f32> {
  return vec2<f32>(
    (worldPos.x - viewportLeft) / viewportWidth,
    (worldPos.y - viewportTop) / viewportHeight
  );
}

fn inBounds(uv: vec2<f32>) -> bool {
  return uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0;
}
```

---

## Texture Pipeline

### Data Flow

```
┌─────────────────────────────────────────┐
│ Frame N: onRender(dt, draw)             │
└──────────────────┬──────────────────────┘
                   │
        ┌──────────┴──────────┐
        │                     │
        ▼                     ▼
┌──────────────┐      ┌─────────────┐
│ Water Update │      │ Terrain     │
│ (compute)    │      │ Update      │
│              │      │ (rasterize) │
└────┬─────────┘      └──────┬──────┘
     │                       │
     ▼                       ▼
┌──────────────────┐  ┌──────────────────┐
│ waterTexture     │  │ terrainTexture   │
│ RGBA32F          │  │ RGBA32F          │
│ [height, dh/dt]  │  │ [signedHeight]   │
└────┬─────────────┘  └────────┬─────────┘
     │                         │
     │  (optional with terrain)│
     └──────────────┬──────────┘
                    │
                    ▼
         ┌──────────────────┐
         │ Wetness Update   │
         │ (compute, ping   │
         │  pong, reproj)   │
         └────────┬─────────┘
                  │
                  ▼
         ┌──────────────────┐
         │ wetnessTexture   │
         │ R32F             │
         │ [wetness]        │
         └────────┬─────────┘
                  │
        ┌─────────┴─────────────────┐
        │                           │
        ▼                           ▼
    ┌──────────┐            ┌──────────────┐
    │ Uniforms │            │ SurfaceShader│
    │ (upload) │            │ (fullscreen  │
    └────┬─────┘            │  render)     │
         │                  └──────┬───────┘
         └──────────┬──────────────┘
                    │
                    ▼
            ┌──────────────┐
            │ Screen Color │
            │ Output       │
            └──────────────┘
```

### Texture Formats and Semantics

| Texture | Format  | Channel | Meaning         | Range       | Notes                              |
| ------- | ------- | ------- | --------------- | ----------- | ---------------------------------- |
| Water   | RGBA32F | R       | Combined height | [0, 1] norm | (raw - 0.5) \* 5.0 = world units   |
| Water   | RGBA32F | G       | Height velocity | [0, 1] norm | dh/dt, for motion                  |
| Terrain | RGBA32F | R       | Height          | [-50, +20]  | Negative underwater, positive land |
| Terrain | RGBA32F | G       | Unused          | -           | Reserved                           |
| Wetness | R32F    | R       | Wetness         | [0, 1]      | 0=dry, 1=fully wet                 |

### Viewport Relationships

```
Screen ─ camera ─→ World
         matrix    coordinates
           ↓
         Render Viewport (0.1 margin)
           │
           ├─→ Water Texture UV
           ├─→ Terrain Texture UV
           │
         Wetness Viewport (0.5 margin)
           │
           └─→ Wetness Texture UV (snapped to grid)
```

**Margins**:

- **Render Viewport Margin** (0.1 = 10%): Used for water and terrain compute
- **Wetness Viewport Margin** (0.5 = 50%): Larger to maintain coherence as camera moves
- **Snapped Viewport**: Wetness viewport rounded to texel boundaries

---

## Shader Code Analysis

### Gerstner Wave Analysis (from AnalyticalWaterStateShader, external)

The water texture is generated by `AnalyticalWaterStateShader` which implements:

```
For each pixel (world position P):
  height = sum over all waves of:
    A * sin(k·P - ωt + φ)  [sinusoidal component]
    + (k/ω) * A * cos(...)  [Gerstner trochoid correction]

  With modifications:
    - Shadow texture sampling for wave diffraction
    - Depth texture sampling for shoaling (amplitude reduction in shallow water)
    - Wake segment contributions (local modifiers)
    - Tidal offset
```

**Wave Components** (from WaterConstants):

```typescript
WAVE_COMPONENTS = [
  [0.4, 200, 0.8, 0.0, 1.0, 1e10, 0, 0], // Large swell
  [0.15, 20, 0.8, 0.0, 1.0, 1e10, 0, 0], // Wind chop
];
// [amplitude, wavelength, direction, phaseOffset, speedMult, sourceDist, sourceOffsetX, sourceOffsetY]
```

**Key Constants**:

- `WATER_HEIGHT_SCALE = 5.0`: Maps [0, 1] texture range to [-2.5, 2.5] world units
- `GERSTNER_STEEPNESS = 0.7`: Affects wave shape curvature

### Surface Normal Calculation

**Method**: Finite differences from normalized height map

```wgsl
// For water:
let heightL = sample(..., uv + vec2(-dx, 0));
let heightR = sample(..., uv + vec2(dx, 0));
let heightD = sample(..., uv + vec2(0, -dy));
let heightU = sample(..., uv + vec2(0, dy));

let normal = normalize(vec3(
  (heightL - heightR) * scale,    // ∂h/∂x
  (heightD - heightU) * scale,    // ∂h/∂y
  1.0                             // ∂z/∂z (up)
));

// Semantics: Normal points away from surface
// (gradients are inverted: left-right instead of right-left)
```

**Texel Size Calculation**:

```wgsl
let texelSizeX = 1.0 / textureWidth;      // Single texel width in UV space
let texelSizeY = 1.0 / textureHeight;     // Single texel height in UV space
```

### Lighting Model

**Fixed Sunlight Direction**:

```wgsl
let sunDir = normalize(vec3<f32>(0.3, 0.2, 0.9));  // Roughly southwest, slightly overhead
```

**Contributions**:

1. **Ambient**: Base color at 0.75 intensity
2. **Diffuse**: max(dot(normal, sunDir), 0.0) × baseColor × 0.15
3. **Specular**: pow(max(dot(viewDir, reflectDir), 0.0), 64.0) × sunColor × 0.08
4. **Fresnel**: pow(1 - dot(normal, viewDir), 4.0) × 0.15 (edge reflection)
5. **Subsurface**: scatter × 0.1 (sun penetrating water)
6. **Noise**: Fine-grained hash21 detail

### Blending Logic

```
if (waterDepth < 0) {
  // Underwater terrain (exposed)
  render = sand(wetness)
} else if (waterDepth < 1.5) {
  // Shallow water / shore
  render = blend(sand, water, smoothstep(0, 1.5, waterDepth))
  render += foam (noisy at edges)
} else {
  // Deep water
  render = water()
}
```

**Shallow Water Threshold**: `SHALLOW_WATER_THRESHOLD = 1.5` (world units)

---

## Uniforms and Data Structures

### SurfaceUniforms Struct

See detailed breakdown in [SurfaceUniforms.ts](#2-surfaceuniforms-ts-type-safe-uniform-struct) section.

**Key Fields**:

| Field                | Type   | Purpose                  | Range                    |
| -------------------- | ------ | ------------------------ | ------------------------ |
| `cameraMatrix`       | mat3x3 | Screen → world transform | Inverse of camera matrix |
| `time`               | f32    | Elapsed time             | Game seconds             |
| `renderMode`         | f32    | Debug visualization      | 0=normal, 1=terrain      |
| `screenWidth/Height` | f32    | Frame dimensions         | Pixels                   |
| `viewport*`          | f32    | Render viewport bounds   | World units              |
| `hasTerrainData`     | i32    | Terrain exists           | 0 or 1                   |
| `shallowThreshold`   | f32    | Depth blend cutoff       | 1.5 world units          |
| `*TexWidth/Height`   | f32    | Texture dimensions       | Texels                   |
| `wetnessViewport*`   | f32    | Wetness viewport bounds  | World units              |

### WetnessStateShader Params

See [WetnessStateShader.ts](#7-wetnesssttateshader-ts-wetness-compute-shader) for full struct definition.

**Key Fields**:

- `dt`: Delta time (seconds)
- `wettingRate`: How fast sand gets wet (default 4.0)
- `dryingRate`: How fast sand dries (default 0.15)
- `currentViewport*`: Wetness viewport (snapped to grid)
- `prevViewport*`: Previous frame's viewport (for reprojection)
- `renderViewport*`: Where water/terrain textures map from

---

## GPU Pipeline Details

### Pipeline Types

**1. Analytical Water (Compute)**

- Shader type: Compute
- Dispatch: grid covering texture dimensions
- Invocations: Width × Height (one per texel)
- Output binding: Storage texture (write-only)
- Sampling: Depth texture, shadow texture, wake segments buffer
- Time: ~0.5-1.0ms per frame (1024×512 texture)

**2. Terrain (Render/Rasterize)**

- Shader type: Render
- Two pipelines:
  - Ocean (fullscreen quad background)
  - Contour (indexed triangle mesh)
- Vertex input: 3D positions from tessellated contours
- Render target: RGBA32F color texture
- Depth attachment: Depth32F for occlusion
- Time: ~0.2-0.5ms per frame (512×256 texture)

**3. Wetness (Compute)**

- Shader type: Compute
- Dispatch: grid covering texture dimensions
- Invocations: Width × Height (one per texel)
- Input textures: Previous wetness, current water, current terrain
- Output binding: Storage texture (ping-pong)
- Time: ~0.1-0.2ms per frame (256×128 texture)

**4. Surface Render (Fullscreen)**

- Shader type: Render
- Input: Fullscreen quad (2 triangles)
- Sampling: 3 textures (water, terrain, wetness)
- Output: Screen framebuffer
- Time: ~0.5-1.0ms per frame
- Dependent texture reads: ~20 texel fetches (gradients + blur)

### Compute Dispatch Pattern

```typescript
// Standard dispatch for texture of size (width, height)
shader.dispatch(computePass, bindGroup, width, height);

// Implementation typically:
const workgroupsX = Math.ceil(width / 8); // Assuming 8×8 workgroup
const workgroupsY = Math.ceil(height / 8);
computePass.dispatchWorkgroups(workgroupsX, workgroupsY);
```

### Memory Layout

**Uniform Buffers**:

- `SurfaceUniforms`: 160+ bytes (std140 padding rules)
- `WetnessParams`: 80 bytes (5×16 byte rows)
- `TerrainParams`: ~64 bytes

**Storage Textures**:

- Water: Width × Height × 4 floats = 4 × width × height bytes
- Terrain: Width × Height × 4 floats = 4 × width × height bytes
- Wetness A/B: Width × Height × 1 float = width × height bytes each

**Example sizes (512×256 render viewport)**:

- Water texture (256×128): 131 KB
- Terrain texture (256×128): 131 KB
- Wetness textures A+B (256×128): 65 KB each
- Total texture memory: ~400 KB

---

## Configuration and Tuning

### Resolution Control

```typescript
interface SurfaceRendererConfig {
  textureScale: number; // Global default (0.5 = 50% resolution)
  waterTextureScale?: number; // Per-pipeline overrides
  terrainTextureScale?: number;
  wetnessTextureScale?: number;
}

// Usage:
const renderer = new SurfaceRenderer({
  textureScale: 0.5, // All at half resolution
  waterTextureScale: 0.75, // Water at 75%
  terrainTextureScale: 0.5, // Terrain at 50%
  wetnessTextureScale: 0.25, // Wetness at 25%
});
```

**Performance Trade-offs**:
| Scale | Resolution | Quality | Performance |
|-------|-----------|---------|-------------|
| 0.25 | 256×144 | Low | Very Fast |
| 0.5 | 512×288 | Medium | Good |
| 0.75 | 768×432 | High | Acceptable |
| 1.0 | 1024×576 | Maximum | Slow |

### Viewport Margins

```typescript
const RENDER_VIEWPORT_MARGIN = 0.1; // 10% expansion
const WETNESS_VIEWPORT_MARGIN = 0.5; // 50% expansion
```

**Effects**:

- Larger margin = more GPU work, but smoother transitions as camera moves
- Smaller margin = less GPU work, but visible popping at edges

### Wetness Rates

```typescript
export const DEFAULT_WETTING_RATE = 4.0; // Reach 1.0 in 0.25s
export const DEFAULT_DRYING_RATE = 0.15; // Dry in 6.67s

// Dynamically adjust:
wetnessPipeline.setWetnessRates(6.0, 0.1); // Wetter, slower drying
```

### Depth Thresholds

```typescript
const SHALLOW_WATER_THRESHOLD = 1.5; // World units

// Sets where sand/water blending stops (deeper than 1.5 units = pure water)
```

### Normal Scaling

```wgsl
let heightScale = 3.0;  // In SurfaceShader fragment shader
let waterNormal = normalize(vec3(
  (heightL - heightR) * heightScale,
  (heightD - heightU) * heightScale,
  1.0
));
```

**Higher scale = more pronounced waves, exaggerated lighting**

### Sand Colors

```wgsl
let drySand = vec3<f32>(0.96, 0.91, 0.76);     // Light beige
let wetSand = vec3<f32>(0.76, 0.70, 0.50);     // Dark tan
let visualWetness = pow(wetness, 2.5);         // Non-linear blend curve
```

**The pow(2.5) curve**:

- High wetness (0.8-1.0) drops visual wetness quickly → sand appears mostly dry
- Low wetness (0-0.2) maintains visible wetness long → wet shine lingers

---

## External Dependencies

### Imports by File

**SurfaceRenderer.ts**:

- `BaseEntity`, `@on` handler - Entity system
- `Draw` - 2D drawing API (for debug contours)
- `Matrix3` - Linear algebra
- `UniformInstance` - GPU uniform type-safety
- `getWebGPU()` - WebGPU device access
- `TimeOfDay` - Global time source
- `InfluenceFieldManager` - Depth/shadow textures
- `WaterInfo` - Wave physics and segments
- `TerrainInfo` - Terrain definition and versioning
- `WAVE_COMPONENTS` - Wave configuration

**SurfaceShader.ts**:

- `FullscreenShader<T>` - Base shader class
- `WATER_HEIGHT_SCALE` - Normalization constant

**AnalyticalWaterRenderPipeline.ts**:

- `GPUProfiler` - Performance profiling
- `getWebGPU()` - WebGPU device
- `TimeOfDay` - Time source
- `DepthGridConfig` - Influence field types
- `WaterInfo` - Wake segments and tide
- `WaterComputeBuffers` - GPU buffer management
- `AnalyticalWaterStateShader` - Compute shader code
- `WAVE_COMPONENTS` - Wave data

**TerrainRenderPipeline.ts**:

- `getWebGPU()` - WebGPU device
- `tessellateContour()` - Geometry generation
- `TerrainDefinition`, `buildTerrainGPUData()` - Terrain data structures
- `TerrainComputeBuffers` - GPU buffer management
- `TerrainStateShader` - Render shader code

**WetnessRenderPipeline.ts**:

- `getWebGPU()` - WebGPU device
- `WetnessStateShader` - Compute shader code
- `DEFAULT_WETTING_RATE`, `DEFAULT_DRYING_RATE` - Constants

### Key External Classes

| Class                   | File                                                  | Purpose                       |
| ----------------------- | ----------------------------------------------------- | ----------------------------- |
| `BaseEntity`            | `src/core/entity/BaseEntity`                          | Base for all game objects     |
| `FullscreenShader<T>`   | `src/core/graphics/webgpu/FullscreenShader`           | Base for fullscreen shaders   |
| `ComputeShader<T>`      | `src/core/graphics/webgpu/ComputeShader`              | Base for compute shaders      |
| `UniformInstance<T>`    | `src/core/graphics/UniformStruct`                     | Type-safe uniform buffers     |
| `WaterInfo`             | `src/game/world-data/water/WaterInfo`                 | Wave physics provider         |
| `TerrainInfo`           | `src/game/world-data/terrain/TerrainInfo`             | Terrain data provider         |
| `InfluenceFieldManager` | `src/game/world-data/influence/InfluenceFieldManager` | Depth/shadow texture provider |
| `TimeOfDay`             | `src/game/time/TimeOfDay`                             | Time source                   |

---

## Key Patterns and Implementation Notes

### 1. Lazy Initialization Pattern

```typescript
async ensureInitialized(): Promise<void> {
  if (this.initialized) return;
  // ... create GPU resources
  this.initialized = true;
}

@on("add")
onAdd() {
  this.ensureInitialized();  // Called once on entity add
}
```

**Why**: GPU resources may not be available until game fully initialized.

### 2. Version Checking for Terrain

```typescript
private lastTerrainVersion = -1;

@on("render")
onRender() {
  const terrainInfo = TerrainInfo.maybeFromGame(this.game);
  if (terrainInfo) {
    const currentVersion = terrainInfo.getVersion();
    if (currentVersion !== this.lastTerrainVersion) {
      // Terrain changed, sync to GPU
      this.terrainPipeline.setTerrainDefinition(terrainInfo.getContours());
      this.lastTerrainVersion = currentVersion;
    }
  }
}
```

**Why**: Avoids redundant GPU uploads when terrain hasn't changed.

### 3. Placeholder Textures for Missing Data

```typescript
const effectiveTerrainView = terrainTextureView ?? this.placeholderTerrainView;
this.setHasTerrainData(!!terrainTextureView);
```

**Why**: Allows system to function with missing pipelines (graceful degradation).

### 4. Bind Group Caching with Invalidation

```typescript
if (
  !this.bindGroup ||
  this.lastWaterTexture !== waterTextureView ||
  this.lastTerrainTexture !== effectiveTerrainView ||
  this.lastWetnessTexture !== effectiveWetnessView
) {
  this.bindGroup = this.shader.createBindGroup({
    /* ... */
  });
  this.lastWaterTexture = waterTextureView;
  // ... track others
}
```

**Why**: Bind groups immutable after creation; recreate when textures change.

### 5. Viewport Expansion with Margin

```typescript
private getExpandedViewport(margin: number): Viewport {
  const worldViewport = camera.getWorldViewport();
  const marginX = worldViewport.width * margin;
  const marginY = worldViewport.height * margin;

  return {
    left: worldViewport.left - marginX,
    top: worldViewport.top - marginY,
    width: worldViewport.width + marginX * 2,
    height: worldViewport.height + marginY * 2,
  };
}
```

**Why**:

- Margin > 0 prevents edge artifacts
- Different margins for different pipelines (wetness needs larger margin for coherence)

### 6. Snapped Viewport for Reprojection

```typescript
private snapViewportToGrid(viewport: Viewport): Viewport {
  const texelWorldSizeX = viewport.width / this.textureWidth;
  const texelWorldSizeY = viewport.height / this.textureHeight;

  return {
    left: Math.floor(viewport.left / texelWorldSizeX) * texelWorldSizeX,
    top: Math.floor(viewport.top / texelWorldSizeY) * texelWorldSizeY,
    width: viewport.width,
    height: viewport.height,
  };
}
```

**Why**: Ensures 1:1 texel mapping between frames during reprojection (prevents blur).

### 7. Ping-Pong Textures for Persistent State

```typescript
// Frame N
const bindGroup = currentReadTexture === "A" ? bindGroupAtoB : bindGroupBtoA;
dispatch(bindGroup); // Read A → Write B
currentReadTexture = "B"; // Swap for next frame

// Frame N+1: Read from B → Write to A
```

**Why**: GPU compute can't read and write same texture in single dispatch.

### 8. Coordinate Space Conversions

```wgsl
// Shader has three coordinate systems:
// 1. Clip space: [-1, 1] from vertex shader
// 2. Screen space: [0, screenWidth] × [0, screenHeight]
// 3. World space: Game world units
// 4. Texture UV: [0, 1] relative to viewport

// Example chain:
let screenPos = (clipPos * 0.5 + 0.5) * vec2(screenWidth, screenHeight);
let worldPos = (cameraMatrix * vec3(screenPos, 1.0)).xy;
let dataUV = (worldPos - vec2(viewportLeft, viewportTop)) /
             vec2(viewportWidth, viewportHeight);
```

**Why**: Each space is natural for different operations (rasterization, physics, texture sampling).

### 9. Fallback for Missing Influence Fields

```typescript
// Try to configure with real depth/shadow
if (!this.tryConfigureWaterPipeline()) {
  // Still renders, but without diffraction/shoaling
  return;
}
```

**Why**: InfluenceFieldManager initializes asynchronously; system works before it's ready.

### 10. Frame-Latency for GPU Readback

The system doesn't read water/terrain textures on CPU (would stall GPU pipeline). Instead:

- Compute happens frame N
- Texture available for display frame N+1
- This 1-frame latency is acceptable for rendering

**Why**: Async design prevents GPU pipeline stalls.

---

## Implementation Checklist for Reimplementation

To reimplement this system from scratch:

- [ ] Create `BaseEntity` subclass for orchestration
- [ ] Implement `UniformStruct` definition for shader parameters
- [ ] Create `FullscreenShader<T>` subclass for final composition
- [ ] Implement `AnalyticalWaterRenderPipeline` (compute shader pipeline)
- [ ] Implement `TerrainRenderPipeline` (rasterize shader pipeline)
- [ ] Implement `WetnessRenderPipeline` (compute with ping-pong)
- [ ] Write water state shader (Gerstner waves + diffraction)
- [ ] Write terrain state shader (rasterize contours)
- [ ] Write wetness state shader (depth-based wetting/drying)
- [ ] Write surface shader (composite + lighting)
- [ ] Handle async initialization of GPU resources
- [ ] Implement viewport margin expansion
- [ ] Add snapped viewport for reprojection
- [ ] Cache bind groups with invalidation
- [ ] Create placeholder textures for missing data
- [ ] Implement debug visualization mode
- [ ] Add performance profiling hooks

---

This concludes the comprehensive technical documentation of the surface-rendering system. The system is well-architected for GPU-accelerated 2D rendering with proper separation of concerns, efficient texture pipelines, and graceful degradation when components aren't yet available."}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3709,"cache_creation_input_tokens":2479,"cache_read_input_tokens":44994,"cache_creation":{"ephemeral_5m_input_tokens":2479,"ephemeral_1h_input_tokens":0},"output_tokens":4,"service_tier":"standard"}},"requestId":"req_011CXWbv32SsjRYR7XViSdLg","type":"assistant","uuid":"e1a9aa5d-c1ac-4bef-ad64-df8588c44793","timestamp":"2026-01-26T20:16:56.460Z"}

---

# Part 2: Wave Physics

## Wave Physics System - Comprehensive Technical Documentation

This document describes the texture-based wave shadow system implemented in `/Users/simon/projects/tack-and-trim/src/game/wave-physics/`. The system computes and renders terrain shadows for Fresnel diffraction calculations in analytical wave physics.

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Architecture & Data Flow](#architecture--data-flow)
3. [Core Components](#core-components)
4. [Key Algorithms](#key-algorithms)
5. [Data Structures](#data-structures)
6. [File Interactions](#file-interactions)
7. [GPU/CPU Integration](#gpucpu-integration)
8. [Implementation Details](#implementation-details)

---

## System Overview

### Purpose

The wave physics system implements **texture-based shadow rendering** to efficiently determine where waves are blocked by terrain. Waves encountering islands don't pass directly through; instead, they diffract around obstacles. The shadows represent the "blocked" regions where waves are damped due to diffraction effects.

### Key Features

- **Geometric computation**: Identifies silhouette points where coastlines block waves
- **Texture-based rendering**: Rasterizes shadow polygons to a GPU texture for O(1) per-pixel lookups
- **Analytical wave integration**: Provides shadow data to the water shader for Fresnel diffraction calculations
- **Viewport-aware**: Updates shadow texture each frame based on camera viewport
- **Efficient data passing**: Uses uniform buffers to communicate polygon positions to wave shader

### Design Rationale

A naive approach would compute point-in-polygon tests for every wave sample in the shader. Instead, this system:

1. Pre-computes geometric shadow regions once during terrain load
2. Rasterizes them to a texture each frame (fast GPU operation)
3. Uses the texture for instant per-pixel shadow queries

This trades one-time geometric computation and per-frame rasterization for efficient shader queries.

---

## Architecture & Data Flow

### High-Level Pipeline

```
Terrain Definition
    ↓
[CoastlineManager] ← extracts height=0 contours
    ↓ (coastlines)
[SilhouetteComputation] ← finds where tangent ∥ wave direction
    ↓ (silhouette points)
[ShadowGeometry] ← builds polygons from silhouette pairs
    ↓ (shadow polygons with vertices)
[ShadowTextureRenderer] ← rasterizes to GPU texture
    ↓ (r8uint shadow texture)
[Water Shader] ← reads texture + uniform buffer for diffraction
```

### Initialization Flow

```typescript
// At game startup with terrain data:
const manager = new WavePhysicsManager();
await manager.initialize(terrainDefinition);

// manager.initialize() executes:
// 1. coastlineManager.initialize(terrainDef)
//    - Finds all height=0 contours
//    - Computes bounding boxes
// 2. computeAllSilhouettePoints(coastlines, waveDirection)
//    - For each coastline spline
//      - Find parameter values where tangent ∥ waveDir
//      - Solve quadratic equation on tangent vector
//      - Classify as shadow-casting or shadow-ending
// 3. buildShadowPolygonsForRendering(silhouettePoints, coastlines, waveDir)
//    - Group silhouette points by contour
//    - For each contour: find leftmost/rightmost silhouette points
//    - Build polygon vertices (quadrilateral + sampled coastline)
// 4. Create ShadowTextureRenderer
// 5. Create shadow data uniform buffer
```

### Per-Frame Update Flow

```typescript
// Each render frame:
manager.updateShadowTexture(viewport);

// This executes:
// 1. shadowRenderer.render(viewport, shadowPolygons)
//    - Build vertex data by triangulating polygons
//    - Upload to vertex buffer
//    - Rasterize triangles to shadow texture
//    - Each pixel receives polygon index (0 = no shadow, 1+ = polygon ID)
// 2. updateShadowDataBuffer(viewport)
//    - Pack polygon silhouette positions + obstacle width
//    - Upload to uniform buffer
```

### Usage in Water Shader

The water shader reads two key resources:

```glsl
@binding(shadowTexture) texture_2d<u32> shadowMask;
@binding(shadowDataBuffer) uniform ShadowData shadowData;

// Pseudocode in water shader:
fn getShadowAtPosition(worldPos: vec2<f32>) -> ShadowInfo {
  let texCoord = worldPosToTexCoord(worldPos, shadowData.viewport);
  let shadowIndex = textureSample(shadowMask, texCoord);
  if (shadowIndex > 0) {
    let polygon = shadowData.polygons[shadowIndex - 1];
    // Compute diffraction based on polygon geometry
  }
}
```

---

## Core Components

### 1. WavePhysicsManager (WavePhysicsManager.ts)

**Responsibility**: Orchestrates the entire shadow system. Coordinates geometry computation, texture rendering, and data buffer updates.

**Key State**:

```typescript
export class WavePhysicsManager {
  private coastlineManager = new CoastlineManager();
  private shadowRenderer: ShadowTextureRenderer | null = null;
  private shadowDataBuffer: GPUBuffer | null = null;
  private shadowPolygons: ShadowPolygonRenderData[] = [];
  private waveDirection: V2d;
  private initialized = false;
}
```

**Key Methods**:

| Method                          | Purpose                                              |
| ------------------------------- | ---------------------------------------------------- |
| `initialize(terrainDef)`        | Initialize with terrain; compute all shadow geometry |
| `updateShadowTexture(viewport)` | Per-frame: render shadows and update uniform buffer  |
| `getShadowTextureView()`        | Get texture view for water shader binding            |
| `getShadowDataBuffer()`         | Get uniform buffer for water shader binding          |
| `getShadowPolygons()`           | Get render-ready polygon data (for debugging)        |
| `recompute(terrainDef)`         | Recompute geometry if terrain changes                |
| `destroy()`                     | Clean up GPU resources                               |

**Key Constants**:

```typescript
// Shadow data buffer: 32 bytes header + 32 bytes per polygon
const SHADOW_DATA_BUFFER_SIZE = 32 + MAX_SHADOW_POLYGONS * 32;
```

**Wave Direction Computation**:

```typescript
constructor() {
  // Extract wave direction from WAVE_COMPONENTS (all waves share same direction)
  const angle = WAVE_COMPONENTS[0][2]; // direction index
  this.waveDirection = V(Math.cos(angle), Math.sin(angle));
}
```

The manager uses the first wave component's direction as the "wave source direction" - the direction waves travel from their source toward the coast.

---

### 2. CoastlineManager (CoastlineManager.ts)

**Responsibility**: Extract and manage coastline contours from terrain definition.

**Conceptual Role**: A coastline is where terrain height = 0. These contours separate water from land.

**Key State**:

```typescript
export class CoastlineManager {
  private coastlines: CoastlineInfo[] = [];
  private coastlineIndices: number[] = [];
}

export interface CoastlineInfo {
  contourIndex: number; // Index in original terrain.contours
  contour: TerrainContour; // The spline control points
  bounds: AABB; // Bounding box for early rejection
}
```

**Key Methods**:

| Method                                  | Purpose                                    |
| --------------------------------------- | ------------------------------------------ |
| `initialize(terrainDef)`                | Extract all height=0 contours from terrain |
| `getCoastlines()`                       | Return all coastline info                  |
| `getPotentialCoastlines(point, margin)` | AABB-based early rejection                 |
| `getCombinedBounds()`                   | Overall bounding box of all coastlines     |
| `getCoastlineCount()`                   | Number of coastlines found                 |

**Bounding Box Computation**:

Sampling the spline at multiple points ensures accurate bounds:

```typescript
private computeBounds(controlPoints: readonly V2d[]): AABB {
  const sampledPoints = sampleClosedSpline(controlPoints, 8);
  // Min/max across sampled points
}
```

The manager uses Catmull-Rom spline sampling (8 samples per segment) to capture the true bounds of curved coastlines.

---

### 3. SilhouetteComputation (SilhouetteComputation.ts)

**Responsibility**: Find points on coastlines where the terrain silhouette edges (perpendicular to wave direction) occur.

**Core Concept**: A silhouette point is where the coastline's tangent is **parallel to the wave direction**. These are the "edges" of the terrain from the wave's perspective.

```
        Wave travels this way (→)

        Coastal tangent is horizontal (→)
        at these two locations ← SILHOUETTE POINTS

        ╱╲
       ╱  ╲
      ╱    ╲
     ╱      ╲
    ╱________╲
   ↑        ↑
   LEFT     RIGHT silhouette points
```

**Key Data Structure**:

```typescript
export interface SilhouettePoint {
  position: V2d; // World position on coastline
  contourIndex: number; // Which coastline this is from
  segmentIndex: number; // Which spline segment (0 to n-1)
  t: number; // Parameter within segment [0, 1)
  isShadowCasting: boolean; // Is this the left (true) or right (false) edge?
  tangent: V2d; // Normalized tangent at this point
  shadowNormal: V2d; // Points into shadow region
}
```

**Key Algorithm**: Solving the Silhouette Equation

The tangent of a Catmull-Rom spline is:

```
tangent(t) = 0.5 * (A + B*t + C*t²)

where:
  A = p₂ - p₀
  B = 2*(2*p₀ - 5*p₁ + 4*p₂ - p₃)
  C = 3*(-p₀ + 3*p₁ - 3*p₂ + p₃)
```

We want the tangent parallel to wave direction, so:

```
cross(tangent, waveDir) = 0
tangent.x * waveDir.y - tangent.y * waveDir.x = 0
```

Substituting the tangent formula:

```
cross(A, waveDir) + cross(B, waveDir)*t + cross(C, waveDir)*t² = 0
a*t² + b*t + c = 0  (quadratic equation)

where:
  a = cross(C, waveDir)
  b = cross(B, waveDir)
  c = cross(A, waveDir)
```

**Implementation**:

```typescript
export function computeSilhouettePoints(
  contour: TerrainContour,
  contourIndex: number,
  waveDir: V2d,
): SilhouettePoint[] {
  const points = contour.controlPoints;
  const silhouettePoints: SilhouettePoint[] = [];

  // For each spline segment
  for (let i = 0; i < points.length; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const p3 = points[(i + 2) % n];

    // Compute Catmull-Rom coefficients
    const A = V(p2.x - p0.x, p2.y - p0.y);
    const B = V(
      2 * (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x),
      2 * (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y),
    );
    const C = V(
      3 * (-p0.x + 3 * p1.x - 3 * p2.x + p3.x),
      3 * (-p0.y + 3 * p1.y - 3 * p2.y + p3.y),
    );

    // 2D cross product
    const cross = (v: V2d) => v.x * waveDir.y - v.y * waveDir.x;

    const a = cross(C);
    const b = cross(B);
    const c = cross(A);

    // Solve quadratic
    const roots = solveQuadratic(a, b, c);

    for (const t of roots) {
      if (t < 0 || t >= 1) continue; // Only interior of segment

      const position = catmullRomPoint(p0, p1, p2, p3, t);
      const tangent = catmullRomTangent(p0, p1, p2, p3, t);

      // Classify as shadow-casting or shadow-ending
      const tangentDerivative = computeTangentDerivative(p0, p1, p2, p3, t);
      const crossDerivative =
        tangentDerivative.x * waveDir.y - tangentDerivative.y * waveDir.x;
      const isShadowCasting = crossDerivative < 0;

      // Compute shadow normal
      const perpRight = V(waveDir.y, -waveDir.x);
      const shadowNormal = isShadowCasting ? perpRight : perpRight.mul(-1);

      silhouettePoints.push({
        position,
        contourIndex,
        segmentIndex: i,
        t,
        isShadowCasting,
        tangent: normalizedTangent,
        shadowNormal,
      });
    }
  }

  return silhouettePoints;
}
```

**Shadow Casting Classification**:

The derivative of the cross product tells us if the tangent is rotating (curving):

```
d/dt[cross(tangent, waveDir)]

If positive:  tangent rotating counter-clockwise (left edge of shadow)
If negative:  tangent rotating clockwise (right edge of shadow)
```

```typescript
const tangentDerivative = computeTangentDerivative(p0, p1, p2, p3, t);
// tangent derivative = 0.5 * (B + 2*C*t)
```

---

### 4. ShadowGeometry (ShadowGeometry.ts)

**Responsibility**: Build shadow polygons from silhouette points. Creates the actual geometry that will be rasterized.

**Key Insight**: Each coastline creates **exactly one shadow polygon** defined by:

- The **leftmost** silhouette point (perpendicular to wave direction)
- The **rightmost** silhouette point (perpendicular to wave direction)
- The **coastline arc** between them (leeward side - the side facing the shadows)
- **Extended shadow boundaries** extending far behind

**Primary Data Structure**:

```typescript
export interface ShadowPolygonRenderData {
  vertices: V2d[]; // All polygon vertices for rasterization
  coastlineVertices: V2d[]; // Sampled coastline points (right→left)
  polygonIndex: number;
  leftSilhouette: V2d; // Left extremal point
  rightSilhouette: V2d; // Right extremal point
  obstacleWidth: number; // Distance between silhouettes (perpendicular to wave)
  contourIndex: number;
}
```

**Key Algorithm**: Finding Left/Right Extremal Points

We need to identify which silhouette points are the "left" and "right" edges. This is done by projecting into a coordinate frame where the wave direction is the Y-axis:

```typescript
// Rotate each point into wave-direction coordinate frame
// rotatedX = cross(waveDir, point) = waveDir.x*point.y - waveDir.y*point.x
// (negative = left of wave, positive = right of wave)

let leftPoint: SilhouettePoint | null = null;
let rightPoint: SilhouettePoint | null = null;
let minRotatedX = Infinity;
let maxRotatedX = -Infinity;

for (const point of points) {
  const rotatedX = point.position.x * waveDir.y - point.position.y * waveDir.x;

  if (rotatedX < minRotatedX) {
    minRotatedX = rotatedX;
    leftPoint = point;
  }
  if (rotatedX > maxRotatedX) {
    maxRotatedX = rotatedX;
    rightPoint = point;
  }
}

// Obstacle width = perpendicular span
const obstacleWidth = maxRotatedX - minRotatedX;
```

**Coastline Arc Selection Algorithm**:

The leeward side is the side of the island facing **away** from incoming waves (the shadow-facing side). To determine which arc between the two silhouette points is leeward:

```typescript
function sampleLeewardCoastlineArc(
  contour: TerrainContour,
  rightPoint: SilhouettePoint,
  leftPoint: SilhouettePoint,
  waveDir: V2d,
): V2d[] {
  // Calculate parameters along the spline for each silhouette point
  const rightParam = rightPoint.segmentIndex + rightPoint.t;
  const leftParam = leftPoint.segmentIndex + leftPoint.t;

  // Two possible arcs: forward traversal and backward traversal
  // Sample the midpoint of each arc
  const forwardMidPoint = sampleMidpoint(contour, rightParam, leftParam, true);
  const backwardMidPoint = sampleMidpoint(
    contour,
    rightParam,
    leftParam,
    false,
  );

  // The leeward arc is the one whose midpoint is further along wave direction
  // (i.e., has larger dot product with waveDir)
  const forwardDot = forwardMid.dot(waveDir);
  const backwardDot = backwardMid.dot(waveDir);

  const goBackward = backwardDot > forwardDot;

  // Sample COASTLINE_POLYGON_SAMPLES (32) points along the chosen arc
  return sampleArc(contour, rightParam, leftParam, goBackward);
}
```

**Polygon Vertex Construction**:

The final polygon is a quadrilateral + sampled coastline:

```
    extendedLeft ←─────────────┐
         │                     │
         ├──────────────────────┤
         │  SHADOW REGION       │
         │  (extends to horizon) │
         ├──────────────────────┤
    extendedRight ←────────────┐
         ↑
         │
    rightSilhouette ←────┐
         │                │
         └─coastlineArc──→
                        leftSilhouette
```

```typescript
const extendedLeft = leftPoint.position.add(
  waveDir.mul(SHADOW_EXTEND_DISTANCE),
);
const extendedRight = rightPoint.position.add(
  waveDir.mul(SHADOW_EXTEND_DISTANCE),
);

const vertices: V2d[] = [
  rightPoint.position,
  ...coastlineVertices.slice(1), // Skip first (same as right)
  extendedLeft,
  extendedRight,
];
```

This creates a polygon that covers the entire shadow region in a CCW winding order.

---

### 5. ShadowTextureRenderer (ShadowTextureRenderer.ts)

**Responsibility**: Rasterize shadow polygons to a GPU texture each frame.

**Overview**: Uses the GPU's native triangle rasterizer to answer "is this pixel in shadow?" queries.

**Key GPU Resources**:

```typescript
export class ShadowTextureRenderer {
  private texture: GPUTexture; // r8uint, 256x256 or custom
  private textureView: GPUTextureView;
  private renderPipeline: GPURenderPipeline;
  private vertexBuffer: GPUBuffer; // Polygon vertices
  private uniformBuffer: GPUBuffer; // Viewport transform params
  private bindGroup: GPUBindGroup;
}
```

**Texture Format**: `r8uint` (red channel only, 8-bit unsigned integer)

- Value `0` = pixel is not in shadow
- Value `1+` = pixel is in shadow; value is polygon index + 1

**Vertex Buffer Layout**:

Each vertex has 12 bytes:

```glsl
struct Vertex {
  position: vec2<f32>,     // 8 bytes
  polygonIndex: u32,       // 4 bytes
}
```

**Uniform Buffer** (16 bytes):

```glsl
struct Uniforms {
  viewportLeft: f32,       // World X of left edge
  viewportTop: f32,        // World Y of top edge
  viewportWidth: f32,      // World units width
  viewportHeight: f32,     // World units height
}
```

**Rendering Pipeline**:

1. **Clear texture** to 0 (no shadows)
2. **Build vertex data**:
   - For each shadow polygon:
     - Use pre-computed vertices from `ShadowPolygonRenderData`
     - Triangulate using ear-clip algorithm (handles concave polygons)
     - Output triangles: [x, y, polyIndex, x, y, polyIndex, ...]
3. **Upload vertices** to GPU
4. **Render pass**:
   - Bind viewport uniforms
   - Rasterize all triangles
   - Fragment shader outputs `polygonIndex + 1`
5. **Result**: Shadow mask texture ready for water shader

**Per-Vertex Transformation** (in vertex shader):

```wgsl
// World → Normalized coords [0, 1]
let normalizedX = (position.x - viewportLeft) / viewportWidth;
let normalizedY = (position.y - viewportTop) / viewportHeight;

// Normalized → Clip space [-1, 1]
// Note: Y is flipped so low world Y = bottom of texture
let clipX = normalizedX * 2.0 - 1.0;
let clipY = 1.0 - normalizedY * 2.0;
```

---

### 6. ShadowTextureShader (ShadowTextureShader.ts)

**Responsibility**: WGSL shader code for rendering shadow polygons.

**Vertex Shader**:

```wgsl
@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  let normalizedX = (position.x - uniforms.viewportLeft) / uniforms.viewportWidth;
  let normalizedY = (position.y - uniforms.viewportTop) / uniforms.viewportHeight;

  let clipX = normalizedX * 2.0 - 1.0;
  let clipY = 1.0 - normalizedY * 2.0;

  output.clipPosition = vec4<f32>(clipX, clipY, 0.0, 1.0);
  output.polygonIndex = input.polygonIndex;
  return output;
}
```

**Fragment Shader**:

```wgsl
@fragment
fn fs_main(input: FragmentInput) -> @location(0) u32 {
  return input.polygonIndex + 1u;
}
```

The fragment shader is trivial because the polygon index is already computed and interpolated per vertex.

---

## Key Algorithms

### Algorithm 1: Silhouette Point Computation

**Input**: Coastline spline, wave direction

**Output**: Points where coastline edges are perpendicular to waves

**Steps**:

1. For each spline segment:
   - Get control points p₀, p₁, p₂, p₃
   - Compute Catmull-Rom tangent coefficients A, B, C
   - Solve `cross(A + B*t + C*t², waveDir) = 0` as quadratic
   - For each root t ∈ [0, 1):
     - Evaluate position and tangent
     - Compute tangent derivative
     - Classify as shadow-casting/ending
     - Store as `SilhouettePoint`

**Complexity**: O(n) per contour, where n = number of control points
Each spline segment is a quadratic solve, so ~2 roots per segment.

---

### Algorithm 2: Left/Right Extremal Point Selection

**Input**: Silhouette points for one contour, wave direction

**Output**: The leftmost and rightmost points perpendicular to wave direction

**Key Insight**: Rotate into wave-direction coordinate system using cross product

```typescript
for each point in silhouettePoints:
  rotatedX = point.position.x * waveDir.y - point.position.y * waveDir.x
  track minimum and maximum rotatedX

leftPoint = point with minimum rotatedX
rightPoint = point with maximum rotatedX
obstacleWidth = max - min
```

**Why This Works**: The cross product gives the signed perpendicular distance from the wave direction line. Points with the most negative cross product are furthest left; most positive are furthest right.

---

### Algorithm 3: Leeward Arc Selection

**Input**: Right and left silhouette points on a coastline, wave direction

**Output**: Points along the coastline arc that faces the shadow

**Problem**: Given two points on a circular spline, there are two ways to traverse between them. We need the leeward arc (the one facing away from incoming waves).

**Solution**:

```typescript
// Calculate parameters: rightParam and leftParam are positions along spline

// Sample midpoint of forward arc (right → left increasing)
forwardMid = sample spline at (rightParam + leftParam) / 2

// Sample midpoint of backward arc (right ← left decreasing)
backwardMid = sample spline at (rightParam - (leftParam - rightParam) / 2)

// Leeward arc is the one whose midpoint is further along wave direction
forwardDot = forwardMid · waveDir
backwardDot = backwardMid · waveDir

goBackward = (backwardDot > forwardDot)

// Sample COASTLINE_POLYGON_SAMPLES points along the selected arc
```

**Why This Works**: The leeward side (facing the shadow) points more in the direction waves travel. A simple dot product tells us which arc is leeward.

---

### Algorithm 4: Polygon Triangulation for Rasterization

**Input**: Shadow polygon vertices (possibly concave)

**Output**: Triangle indices for rasterization

**Method**: Ear-clipping triangulation (`earClipTriangulate`)

- Handles concave polygons
- Ensures valid winding order for rasterization
- Generates triangle indices that reference the original vertices

```typescript
const indices = earClipTriangulate(polygon.vertices);
// indices = [i0, i1, i2, i3, i4, i5, ...] (triples form triangles)

for (let i = 0; i < indices.length; i += 3) {
  const v0 = vertices[indices[i]];
  const v1 = vertices[indices[i + 1]];
  const v2 = vertices[indices[i + 2]];
  // Output triangle v0, v1, v2
}
```

---

## Data Structures

### Coastline Information

```typescript
// From CoastlineManager.ts
export interface CoastlineInfo {
  contourIndex: number; // Original terrain contour index
  contour: TerrainContour; // Spline control points
  bounds: AABB; // Bounding box
}

export interface AABB {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}
```

### Silhouette Point

```typescript
// From SilhouetteComputation.ts
export interface SilhouettePoint {
  position: V2d; // World position on coastline
  contourIndex: number; // Which coastline
  segmentIndex: number; // Spline segment [0, n-1]
  t: number; // Parameter within segment [0, 1)
  isShadowCasting: boolean; // Left (true) or right (false) edge
  tangent: V2d; // Normalized tangent direction
  shadowNormal: V2d; // Points into shadow region
}
```

### Shadow Polygon Render Data

```typescript
// From ShadowGeometry.ts
export interface ShadowPolygonRenderData {
  vertices: V2d[]; // Polygon vertices in world space
  coastlineVertices: V2d[]; // Sampled coastline arc (32 points)
  polygonIndex: number; // ID for this polygon
  leftSilhouette: V2d; // Left extremal point position
  rightSilhouette: V2d; // Right extremal point position
  obstacleWidth: number; // Perpendicular span of obstacle
  contourIndex: number; // Source coastline index
}
```

### Shadow Data Uniform Buffer

```
Layout (36 floats = 144 bytes):
  Offset  Type        Field
  0       float       waveDirection.x
  1       float       waveDirection.y
  2       u32         polygonCount
  3       float       shadowViewportLeft
  4       float       shadowViewportTop
  5       float       shadowViewportWidth
  6       float       shadowViewportHeight
  7       float       padding

  8..35   (per polygon, 8 floats each)
  [0]     float       leftSilhouette.x
  [1]     float       leftSilhouette.y
  [2]     float       rightSilhouette.x
  [3]     float       rightSilhouette.y
  [4]     float       obstacleWidth
  [5-7]   float       padding
```

Maximum 16 polygons (MAX_SHADOW_POLYGONS).

---

## File Interactions

### Dependency Graph

```
WavePhysicsManager
  ├─ CoastlineManager
  │  └─ Uses: sampleClosedSpline from Spline util
  │
  ├─ SilhouetteComputation
  │  └─ Uses: catmullRomPoint, catmullRomTangent from Spline util
  │
  ├─ ShadowGeometry
  │  ├─ Uses: catmullRomPoint from Spline util
  │  └─ Uses: groupSilhouettePointsByContour from SilhouetteComputation
  │
  └─ ShadowTextureRenderer
     ├─ Uses: earClipTriangulate from Triangulate util
     └─ Uses: ShadowTextureShader (WGSL code)
```

### Data Flow Between Components

| From                  | To                    | Data                            | Frequency                      |
| --------------------- | --------------------- | ------------------------------- | ------------------------------ |
| CoastlineManager      | SilhouetteComputation | Coastline contours, indices     | Once (init)                    |
| SilhouetteComputation | ShadowGeometry        | Silhouette points               | Once (init)                    |
| ShadowGeometry        | ShadowTextureRenderer | Shadow polygon vertices         | Once per frame (render)        |
| ShadowGeometry        | WavePhysicsManager    | Shadow polygon data             | Once per frame (buffer update) |
| WavePhysicsManager    | Water Shader          | Shadow texture + uniform buffer | Once per frame (bind)          |

### External Dependencies

**Math Utilities** (`src/core/util/` and `src/core/Vector.ts`):

- `V2d` - 2D vector class
- `V()` - Vector constructor
- `catmullRomPoint()` - Evaluate Catmull-Rom spline at parameter t
- `catmullRomTangent()` - Evaluate spline tangent vector
- `sampleClosedSpline()` - Sample spline at multiple points
- `earClipTriangulate()` - Polygon triangulation

**WebGPU Utilities** (`src/core/graphics/webgpu/`):

- `getWebGPU()` - Get WebGPU device
- GPU buffer/texture creation
- Render pipeline creation

**Terrain Data** (`src/game/world-data/terrain/LandMass.ts`):

- `TerrainDefinition` - Contains terrain contours
- `TerrainContour` - Single height contour with control points

**Water Constants** (`src/game/world-data/water/WaterConstants.ts`):

- `WAVE_COMPONENTS` - Wave direction (index 2 of first wave)
- `MAX_SHADOW_POLYGONS` - Maximum polygons (from AnalyticalWaterStateShader)

---

## GPU/CPU Integration

### GPU Resources Created

**Per WavePhysicsManager instance**:

1. **Shadow Texture** (r8uint, 256×256 pixels)
   - Format: r8uint (red channel = polygon index)
   - Usage: RENDER_ATTACHMENT | TEXTURE_BINDING
   - Updated each frame via rasterization

2. **Vertex Buffer** (MAX_POLYGONS × MAX_VERTICES_PER_POLYGON × 3 × 12 bytes)
   - Contains: position (vec2f32) + polygonIndex (u32)
   - Updated each frame before render pass

3. **Uniform Buffers**:
   - **Shadow Texture Uniform** (16 bytes): viewport transform parameters
   - **Shadow Data Buffer** (144 bytes): wave direction, polygon data

4. **Render Pipeline**:
   - Vertex shader: World → clip space transformation
   - Fragment shader: Output polygon index + 1

### Async Operations

**Initialization**:

```typescript
async initialize(terrainDef: TerrainDefinition): Promise<void> {
  // Synchronous geometry computation
  computeAllSilhouettePoints(...);
  buildShadowPolygonsForRendering(...);

  // Async GPU resource creation
  await this.shadowRenderer.init();
}
```

**Per-Frame Update**:

```typescript
updateShadowTexture(viewport: Viewport): void {
  // Immediate GPU submission (no awaiting)
  this.shadowRenderer.render(viewport, this.shadowPolygons);
  this.updateShadowDataBuffer(viewport);
}
```

### Memory Usage

**CPU**:

- Shadow polygons: ~500 bytes per polygon (32 vertices × 8 bytes + metadata)
- Silhouette points: ~80 bytes per point

**GPU**:

- Shadow texture: 256×256 × 1 byte = 64 KB
- Vertex buffer: ~46 KB (max capacity)
- Uniform buffers: ~16 bytes + ~144 bytes = 160 bytes

Total GPU: ~110 KB per manager instance

---

## Implementation Details

### Catmull-Rom Spline Internals

The system uses Catmull-Rom splines for coastlines. Given four control points p₀, p₁, p₂, p₃:

```
Point at parameter t ∈ [0, 1]:
P(t) = 0.5 * (
  2*p₁ +
  (-p₀ + p₂)*t +
  (2*p₀ - 5*p₁ + 4*p₂ - p₃)*t² +
  (-p₀ + 3*p₁ - 3*p₂ + p₃)*t³
)

Tangent (derivative):
P'(t) = 0.5 * (
  (-p₀ + p₂) +
  (2*p₀ - 5*p₁ + 4*p₂ - p₃)*2*t +
  (-p₀ + 3*p₁ - 3*p₂ + p₃)*3*t²
) = 0.5 * (A + B*t + C*t²)
```

### Numeric Stability

**Quadratic Solving**:

```typescript
function solveQuadratic(a: number, b: number, c: number): number[] {
  const EPSILON = 1e-10;

  // Handle near-zero leading coefficient (linear case)
  if (Math.abs(a) < EPSILON) {
    if (Math.abs(b) < EPSILON) return [];
    return [-c / b];
  }

  // Standard quadratic formula with discriminant check
  const discriminant = b * b - 4 * a * c;
  if (discriminant < -EPSILON) return [];
  if (discriminant < EPSILON) return [-b / (2 * a)];

  const sqrtD = Math.sqrt(discriminant);
  return [(-b - sqrtD) / (2 * a), (-b + sqrtD) / (2 * a)];
}
```

Uses epsilon comparisons to handle floating-point error.

### Viewport Coordinate Transformation

The system must convert from world space to shadow texture coordinates:

```typescript
// In ShadowTextureRenderer.render():
const uniformData = new Float32Array([
  viewport.left, // World X of left edge
  viewport.top, // World Y of top edge
  viewport.width, // World units per texture width
  viewport.height, // World units per texture height
]);

// In vertex shader:
let normalizedX = (worldX - viewportLeft) / viewportWidth;
let normalizedY = (worldY - viewportTop) / viewportHeight;
let clipX = normalizedX * 2.0 - 1.0;
let clipY = 1.0 - normalizedY * 2.0; // Y flip
```

The Y-flip ensures that increasing world Y maps to increasing texture Y (top of texture = high world Y).

### Max Polygon Constraints

```typescript
// From WavePhysicsManager
const MAX_SHADOW_POLYGONS = 16;  // Maximum islands/coastlines

// From ShadowTextureRenderer
const MAX_POLYGONS = 16;
const MAX_VERTICES_PER_POLYGON = 64;
const MAX_TOTAL_VERTICES = 16 * 64 * 3 = 3072;  // After triangulation
const BYTES_PER_VERTEX = 12;
const MAX_VERTEX_DATA = 3072 * 12 = 36,864 bytes
```

If more polygons are needed, increase `MAX_SHADOW_POLYGONS` in `AnalyticalWaterStateShader.ts`.

---

## Key Constants

| Constant                    | Value       | Purpose                                              |
| --------------------------- | ----------- | ---------------------------------------------------- |
| `SHADOW_EXTEND_DISTANCE`    | 50,000      | How far to extend shadow boundaries behind obstacles |
| `COASTLINE_POLYGON_SAMPLES` | 32          | Number of points sampled along coastline arc         |
| `MAX_SHADOW_POLYGONS`       | 16          | Maximum number of separate shadow regions            |
| `SHADOW_DATA_BUFFER_SIZE`   | 32 + 16\*32 | Uniform buffer size in bytes                         |

---

## Usage Example

### Basic Initialization

```typescript
// In game initialization:
const wavePhysicsManager = new WavePhysicsManager();
await wavePhysicsManager.initialize(terrainDefinition);

// Get resources for binding to water shader
const shadowTexture = wavePhysicsManager.getShadowTextureView();
const shadowDataBuffer = wavePhysicsManager.getShadowDataBuffer();
```

### Per-Frame Update

```typescript
// In render loop:
wavePhysicsManager.updateShadowTexture(viewport);

// Then bind shadowTexture and shadowDataBuffer to water shader
bindGroup.setResource("shadowTexture", shadowTexture);
bindGroup.setResource("shadowDataBuffer", shadowDataBuffer);
```

### Debugging

```typescript
// Get polygon count
const polygonCount = wavePhysicsManager.getPolygonCount();

// Get polygon data for visualization
const polygons = wavePhysicsManager.getShadowPolygons();
for (const polygon of polygons) {
  // Render polygon.vertices for debugging
  renderDebugPolygon(polygon.vertices);
}

// Get statistics
const stats = wavePhysicsManager.getStats();
console.log(
  `Coastlines: ${stats.coastlineCount}, Polygons: ${stats.polygonCount}`,
);
```

---

## Error Handling & Edge Cases

### Empty Terrain

If terrain has no height=0 contours:

- `CoastlineManager.getCoastlines()` returns empty array
- `SilhouetteComputation` produces no points
- `ShadowGeometry` creates no polygons
- Shadow texture is cleared (all zeros)

### Degenerate Coastlines

If a coastline has < 3 control points:

- Skipped during silhouette computation
- Returns empty array

If silhouette computation finds < 2 points on a contour:

- No shadow polygon created for that contour

### Numerical Issues

- Tangent with magnitude < 1e-6 is skipped
- Quadratic discriminant checked with epsilon (1e-10)
- Handles linear equations (a ≈ 0)

### Large Viewport

If viewport is very large (> 50,000 units):

- Shadow texture still 256×256 pixels
- Pixel size in world units becomes large
- Shadow boundaries extended to 50,000 units
- May see "pixelated" shadow edges at extreme zoom

---

## Performance Characteristics

| Operation                    | Complexity | Frequency               |
| ---------------------------- | ---------- | ----------------------- |
| Silhouette computation       | O(n × q)   | Once per initialization |
| Shadow polygon building      | O(p × c)   | Once per initialization |
| Shadow texture rasterization | O(pixels)  | Every frame             |
| Uniform buffer update        | O(p)       | Every frame             |
| Viewport transformation      | O(1)       | Every frame             |

where:

- n = number of control points per contour
- q = average roots per quadratic (≤ 2)
- p = number of shadow polygons
- c = samples per coastline (32)

**Typical costs**:

- Initialization: 1-10ms (geometry computation)
- Per-frame: 0.1-1ms (GPU rasterization + buffer updates)

---

## Recreating This System

To reimplement from scratch:

1. **Coastline Extraction** (`CoastlineManager`):
   - Filter terrain contours by height = 0
   - Sample each to get AABB
   - Store as `CoastlineInfo`

2. **Silhouette Computation** (`SilhouetteComputation`):
   - For each spline segment:
     - Solve `cross(tangent(t), waveDir) = 0` as quadratic
     - Evaluate position and tangent at roots
     - Compute tangent derivative for classification
   - Store as `SilhouettePoint`

3. **Shadow Geometry** (`ShadowGeometry`):
   - Group silhouette points by contour
   - For each contour: find extremal points by cross product
   - Sample leeward coastline arc (32 points)
   - Build polygon vertices (right silhouette + arc + extended boundaries)
   - Create `ShadowPolygonRenderData`

4. **Texture Rendering** (`ShadowTextureRenderer`):
   - Create r8uint texture
   - Triangulate polygons (ear-clip algorithm)
   - Build vertex buffer (position + polygon index)
   - Render with simple rasterization shader
   - Output polygon indices

5. **Integration** (`WavePhysicsManager`):
   - Orchestrate above steps
   - Manage GPU resources
   - Update shadow data uniform buffer
   - Provide texture/buffer views to water shader

---

This completes the comprehensive technical documentation for the wave physics system. All files, data structures, algorithms, and interactions are fully detailed with code examples and conceptual explanations."}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1544,"cache_creation_input_tokens":2398,"cache_read_input_tokens":36576,"cache_creation":{"ephemeral_5m_input_tokens":2398,"ephemeral_1h_input_tokens":0},"output_tokens":4,"service_tier":"standard"}},"requestId":"req_011CXWbv6DwEgjdCUWdgdWYS","type":"assistant","uuid":"ecc0743d-7ff5-4849-8377-fdc64ca2ff74","timestamp":"2026-01-26T20:16:18.682Z"}

---

# Part 3: World Data

# WORLD-DATA SYSTEM - COMPREHENSIVE TECHNICAL DOCUMENTATION

## Table of Contents

1. [System Overview](#system-overview)
2. [DataTile Abstraction](#datatile-abstraction)
3. [Data Providers](#data-providers)
4. [GPU/CPU Hybrid Pattern](#gpucpu-hybrid-pattern)
5. [Wind System](#wind-system)
6. [Water System](#water-system)
7. [Terrain System](#terrain-system)
8. [Influence Fields](#influence-fields)
9. [Weather State](#weather-state)
10. [Integration Patterns](#integration-patterns)

---

## System Overview

The world-data system provides **real-time spatial queries** for physics simulations (boat, particles, etc.) by combining:

- **GPU-accelerated tile computation** for in-viewport data
- **CPU fallback** for out-of-viewport queries
- **Pre-computed influence fields** for terrain effects
- **Demand-based tile scheduling** using query forecasts

### Architecture Diagram

```
Game Entities (Boat, Particles, etc.)
         |
         | Query forecasts + queries
         v
┌────────────────────────────────────────┐
│  Data Providers (Wind/Water/Terrain)   │
├────────────────────────────────────────┤
│  GPU Path (active tiles)                │
│  CPU Path (fallback)                    │
└────────────────────────────────────────┘
         |
    ┌────┴─────┐
    v          v
[GPU Tiles] [CPU Compute]
```

### Key Design Principles

1. **Demand-Driven Scheduling**: Tiles computed based on query locations, not camera view
2. **Async GPU Readback**: Non-blocking data transfer prevents frame stalls
3. **Consistent CPU Fallback**: Same algorithms on CPU ensure consistent results
4. **Lazy Initialization**: Expensive operations (influence fields) run asynchronously at startup
5. **No Texture Overwrites**: One compute instance per tile slot prevents mid-flight texture corruption

---

## DataTile Abstraction

### Core Concept

Data tiles are a **shared abstraction** for all three data systems (wind, water, terrain). Each tile represents a rectangular region of world space that can be computed to a texture and read back asynchronously.

### Key Types

**File**: `datatiles/DataTileTypes.ts`

```typescript
// Unique identifier for a tile at grid coordinates
export type DataTileId = `${number},${number}`; // Format: "x,y"

// Configuration for the tile grid
export interface DataTileGridConfig {
  tileSize: number; // World space size (e.g., 64 ft)
  tileResolution: number; // Texture resolution (e.g., 256x256)
  maxTilesPerFrame: number; // Max tiles to compute per frame
  minScoreThreshold: number; // Minimum score to queue for compute
}

// A single tile in the grid
export interface DataTile {
  id: DataTileId; // Unique identifier "x,y"
  gridX: number; // Grid coordinate
  gridY: number; // Grid coordinate
  bounds: AABB; // World-space bounding box
  score: number; // Demand score (higher = more important)
  lastComputedTime: number; // Timestamp of last compute
  bufferIndex: number; // Slot in readback buffer pool (-1 = not active)
}

// Forecast of where an entity will query this frame
export interface QueryForecast {
  aabb: Readonly<AABB>; // Bounding box of expected queries
  queryCount: number; // Expected number of queries
}

// Viewport for a GPU compute pass
export interface ReadbackViewport {
  left: number; // World X of viewport left
  top: number; // World Y of viewport top
  width: number; // Viewport width
  height: number; // Viewport height
  time: number; // Game time used for compute
}
```

### DataTileManager

**File**: `datatiles/DataTileManager.ts`

Manages tile scoring and selection. Fresh scores are computed each frame from forecasts.

```typescript
// Core methods
selectTilesFromForecasts(forecasts: Iterable<QueryForecast>, time: number): DataTile[]
// Scores all overlapping tiles from all forecasts, returns top K tiles

findTileForPoint(worldX: number, worldY: number): DataTile | null
// Finds active tile containing a point (null if not active)

isPointInActiveTile(worldX: number, worldY: number): boolean
// Fast check if point is in any active tile

// Utility methods
getActiveTiles(): readonly DataTile[]
getActiveTileCount(): number
getConfig(): DataTileGridConfig
```

**Scoring Algorithm**:

```
For each forecast:
  Find all tiles overlapping the forecast AABB
  Distribute forecast.queryCount equally among overlapping tiles
  Add to tile's accumulated score

Select: Top K tiles (limited by maxTilesPerFrame)
Sort by: score (descending)
Return: Only tiles above minScoreThreshold
```

### DataTileComputePipeline

**File**: `datatiles/DataTileComputePipeline.ts`

Generic orchestrator for GPU computation and async readback. Uses the **factory pattern** to create domain-specific compute instances.

```typescript
// Generic interface for domain-specific compute
export interface DataTileCompute {
  init(): Promise<void>;
  getOutputTexture(): GPUTexture | null;
  destroy(): void;
}

// Factory function
export type DataTileComputeFactory<TCompute extends DataTileCompute> = (
  resolution: number,
) => TCompute;

// Configuration
export interface DataTilePipelineConfig<
  TSample,
  TCompute extends DataTileCompute,
> {
  id: string; // Entity ID
  gridConfig: DataTileGridConfig; // Tile grid config
  readbackConfig: DataTileReadbackConfig<TSample>; // Readback format
  computeFactory: DataTileComputeFactory<TCompute>; // Create compute instances
  getQueryForecasts: () => Iterable<QueryForecast>; // Callback to collect forecasts
  runCompute: (compute: TCompute, viewport: ReadbackViewport) => void; // Run domain compute
  shouldCompute?: (tile: DataTile) => boolean; // Optional: skip compute
  onComputed?: (tile: DataTile) => void; // Optional: post-compute hook
}
```

**Lifecycle**:

```
Constructor
  ↓ (createspipeline, stores config)
afterAdded
  ↓ (initializes GPU resources - creates one compute instance per tile slot)
tick
  ↓ (completes pending readbacks from previous frame via async promises)
afterPhysics
  ↓ (main compute phase)
  1. Collect forecasts from all entities with proper tags
  2. Select tiles to compute (via DataTileManager)
  3. Assign readback buffers to tiles
  4. Run domain-specific compute for each tile
  5. Initiate async readback to CPU
destroy
  ↓ (cleanup GPU resources)
```

**Key Properties**:

- One compute instance per tile slot (e.g., 64 computes for 64 max tiles/frame)
- One readback buffer per tile slot (double-buffered for async)
- Async readback prevents GPU stalls (one frame latency)
- Domain code provides compute logic via `runCompute` callback

---

### DataTileReadbackBuffer

**File**: `datatiles/DataTileReadbackBuffer.ts`

Handles **GPU-to-CPU data transfer** with double buffering and bilinear interpolation.

```typescript
export interface DataTileReadbackConfig<TSample> {
  channelCount: number; // Channels per pixel
  bytesPerPixel: number; // Bytes per pixel
  label: string; // GPU resource label
  isFloat16?: boolean; // Format (requires f16->f32 conversion)
  texelToSample(channels: Float32Array): TSample; // Texel → sample conversion
  denormalize(sample: TSample): TSample; // Denormalize from [0,1] to world values
}
```

**Double Buffering Strategy**:

```
Frame N-1: Readback texel data → GPU staging buffer
Frame N:   CPU completes readback from staging buffer → CPU data buffer
           Swap buffers (staging ↔ data)
           GPU begins new readback for Frame N → new staging buffer
Frame N+1: CPU completes Frame N readback
```

**Key Methods**:

```typescript
// Called at end of tick after GPU compute
initiateReadback(
  outputTexture: GPUTexture,
  viewport: ReadbackViewport,
  gpuProfiler?: GPUProfiler | null
): void

// Called at start of next tick to complete async transfer
completeReadback(): Promise<boolean>

// Sample at world position with bilinear interpolation
sampleAt(worldX: number, worldY: number): TSample | null
// Returns null if point is outside computed viewport

// Query utilities
isInViewport(worldX: number, worldY: number): boolean
isReady(): boolean
getComputedTime(): number | null
getViewport(): ReadbackViewport | null
```

**Sampling Algorithm** (bilinear interpolation):

```
1. Convert world coords to UV: u = (worldX - viewport.left) / viewport.width
2. Check bounds: if u < 0 or u > 1, return null
3. Convert to texel coords: texX = u * (textureSize - 1)
4. Get 4 corner texels: (x0,y0), (x1,y0), (x0,y1), (x1,y1)
5. Bilinear interpolate between corners
6. Denormalize from [0,1] to world values
7. Return sample
```

**GPU Readback Details**:

```
// Padded row calculation (WebGPU requires multiple of 256 bytes)
paddedBytesPerRow = ceil(textureSize * bytesPerPixel / 256) * 256

// Float16 handling
if isFloat16:
  Read as Uint16Array
  Convert each value: float16ToFloat32(uint16) → float32

// Float32 handling
Read as Float32Array
Handle GPU padding (row-by-row copy if padded)
```

---

## Data Providers

Each data provider (Wind, Water, Terrain) follows the same pattern:

1. **Entity Interface**: Extends `BaseEntity`, implements entity lifecycle
2. **Static Access**: `fromGame(game)` and `maybeFromGame(game)` methods
3. **Querier Tags**: Entities can implement `*Querier` interfaces
4. **Query Forecasts**: Entities provide expected query bounds/counts
5. **Dual Computation**: GPU tile path + CPU fallback path
6. **Shared Pipeline**: Uses `DataTileComputePipeline<TSample, TCompute>`

---

## Wind System

### WindInfo Entity

**File**: `wind/WindInfo.ts`

Provides wind velocity at any world position.

```typescript
// Wind velocity sample from GPU
export interface WindPointData {
  velocityX: number;
  velocityY: number;
}

// Wind state returned to queries
export interface WindState {
  velocity: V2d;
}

class WindInfo extends BaseEntity {
  // Get from game
  static fromGame(game: Game): WindInfo;
  static maybeFromGame(game: Game): WindInfo | undefined;

  // Wind control (in ft/s and radians)
  setVelocity(velocity: V2d): void;
  setFromAngleAndSpeed(angle: number, speed: number): void;
  getSpeed(): number;
  getAngle(): number;

  // Query interface
  getVelocityAtPoint(point: V2d): V2d;
  getBaseVelocityAtPoint(point: V2d): V2d;

  // Modifiers (for sail wind effects)
  getModifiers(): readonly WindModifier[];

  // Stats
  getTileStats(): { activeTiles; maxTiles; tileHits; cpuFallbacks };
}
```

### WindQuerier Interface

**File**: `wind/WindQuerier.ts`

Entities with the `"windQuerier"` tag must implement:

```typescript
export interface WindQuerier {
  getWindQueryForecast(): QueryForecast | null;
}

// Example: boat implements this
class Boat extends BaseEntity {
  tags = ["windQuerier"];

  getWindQueryForecast(): QueryForecast | null {
    return {
      aabb: { minX: ..., maxX: ..., minY: ..., maxY: ... },
      queryCount: 10  // 10 queries expected this frame
    };
  }

  onTick() {
    const wind = WindInfo.fromGame(this.game);
    const velocity = wind.getVelocityAtPoint(this.position);
  }
}
```

### Wind Configuration

**File**: `wind/WindConstants.ts`

```typescript
// Tile grid config
const WIND_TILE_CONFIG: DataTileGridConfig = {
  tileSize: 64, // 64 ft per tile
  tileResolution: 256, // 256x256 texture
  maxTilesPerFrame: 64, // Up to 64 tiles per frame
  minScoreThreshold: 1,
};

// Noise configuration
const WIND_NOISE_SPATIAL_SCALE = 0.005; // How quickly varies across space
const WIND_NOISE_TIME_SCALE = 0.15; // How quickly varies over time
const WIND_SPEED_VARIATION = 0.5; // ±50% variation
const WIND_ANGLE_VARIATION = 0.17; // ±10° variation

// Velocity encoding
const WIND_VELOCITY_SCALE = 100.0; // Maps -50..+50 ft/s to normalized [0..1]
```

### CPU Wind Computation

**File**: `wind/cpu/WindComputeCPU.ts`

Pure CPU implementation matching GPU shader exactly.

```typescript
export interface WindComputeParams {
  time: number;
  baseVelocity: V2d;
  speedNoise: NoiseFunction3D; // Simplex noise
  angleNoise: NoiseFunction3D; // Simplex noise
  influenceSpeedFactor: number; // 1.0 = no terrain effect
  influenceDirectionOffset: number; // Radians
  influenceTurbulence: number; // Extra noise booster
}

// Core computation
function computeBaseWindAtPoint(
  x: number,
  y: number,
  params: WindComputeParams,
): WindVelocityData {
  // 1. Sample noise for temporal variation
  const t = time * WIND_NOISE_TIME_SCALE;
  const sx = x * WIND_NOISE_SPATIAL_SCALE;
  const sy = y * WIND_NOISE_SPATIAL_SCALE;

  // 2. Compute speed multiplier (noise + terrain influence)
  const turbulenceBoost = 1 + influenceTurbulence * 0.5;
  const speedScale =
    (1 + speedNoise(sx, sy, t) * WIND_SPEED_VARIATION * turbulenceBoost) *
    influenceSpeedFactor;

  // 3. Compute angle offset (noise + terrain direction deflection)
  const totalAngleOffset =
    angleNoise(sx, sy, t) * WIND_ANGLE_VARIATION + influenceDirectionOffset;

  // 4. Apply speed scale and rotation
  const scaledX = baseVelocity.x * speedScale;
  const scaledY = baseVelocity.y * speedScale;

  const cos = Math.cos(totalAngleOffset);
  const sin = Math.sin(totalAngleOffset);
  const velocityX = scaledX * cos - scaledY * sin;
  const velocityY = scaledX * sin + scaledY * cos;

  return { velocityX, velocityY };
}
```

### GPU Wind Computation

**File**: `wind/webgpu/WindTileCompute.ts`

```typescript
export class WindTileCompute implements DataTileCompute {
  // Set before calling runCompute
  setBaseWind(x: number, y: number): void;
  setInfluence(
    speedFactor: number,
    directionOffset: number,
    turbulence: number,
  ): void;

  // Run compute shader for a tile viewport
  runCompute(
    time: number,
    left: number, // World X of viewport
    top: number, // World Y of viewport
    width: number, // Viewport width (in world units)
    height: number, // Viewport height
  ): void;

  getOutputTexture(): GPUTexture | null; // For readback
}
```

The GPU shader implements the same algorithm as CPU but parallelized:

- Dispatches one thread per pixel
- Outputs `rg32float` texture (2 channels: velocityX, velocityY)

---

## Water System

### WaterInfo Entity

**File**: `water/WaterInfo.ts`

Provides wave heights, velocities, and dh/dt at any position.

```typescript
// Water sample from GPU (4 channels)
export interface WaterPointData {
  height: number; // Wave surface displacement (ft)
  dhdt: number; // Rate of height change (ft/s)
  velocityX: number; // Surface velocity X (ft/s)
  velocityY: number; // Surface velocity Y (ft/s)
}

// Water state returned to queries
export interface WaterState {
  velocity: V2d; // Current + wave velocity
  surfaceHeight: number; // Total height (waves + tide)
  surfaceHeightRate: number; // dh/dt
}

class WaterInfo extends BaseEntity {
  static fromGame(game: Game): WaterInfo;
  static maybeFromGame(game: Game): WaterInfo | undefined;

  // Main query interface
  getStateAtPoint(point: V2d): WaterState;

  // Modifiers (wakes, splashes)
  getTideHeight(): number;

  // Wave physics integration
  getWavePhysicsManager(): WavePhysicsManager; // Shadow-based diffraction

  // Stats
  getTileStats(): { activeTiles; maxTiles; tileHits; cpuFallbacks };
}
```

### WaterQuerier Interface

**File**: `water/WaterQuerier.ts`

```typescript
export interface WaterQuerier {
  getWaterQueryForecast(): QueryForecast | null;
}
```

### Wave Constants

**File**: `water/WaterConstants.ts`

```typescript
// Gerstner wave physics
const GERSTNER_STEEPNESS = 0.7;
const GRAVITY_FT_PER_S2 = 9.8 * 3.28084;  // ~32.2 ft/s²

// Wave components: [amplitude, wavelength, direction, phaseOffset, speedMult, ...]
export const WAVE_COMPONENTS: readonly [...] = [
  // Swell: large, long-period waves from distant weather
  [0.4, 200, 0.8, 0.0, 1.0, 1e10, 0, 0],
  // Chop: small, wind-driven local waves
  [0.15, 20, 0.8, 0.0, 1.0, 1e10, 0, 0],
];

const SWELL_WAVE_COUNT = 1;  // First N waves are swell

// Normalization scales for texture encoding
const WATER_HEIGHT_SCALE = 5.0;      // ±2.5 ft → [0, 1]
const WATER_VELOCITY_SCALE = 10.0;   // ±5 ft/s → [0, 1]

// Shoaling and damping (depth effects)
const DEEP_WATER_DEPTH = 50.0;  // Reference depth
const DEEP_THRESHOLD = 10.0;     // No damping above this
const SHALLOW_THRESHOLD = 2.0;   // Heavy damping below this
const MIN_DAMPING = 0.2;         // Min damping factor
```

### CPU Water Computation

**File**: `water/cpu/WaterComputeCPU.ts`

Pure CPU Gerstner wave implementation.

```typescript
export interface WaterComputeParams {
  time: number;
  waveAmpModNoise: NoiseFunction3D;      // Wave grouping
  surfaceNoise: NoiseFunction3D;         // Turbulence
  swellEnergyFactor: number;             // 0-1, from terrain
  chopEnergyFactor: number;              // 0-1, from terrain
  fetchFactor: number;                   // 0-1, from terrain
  swellDirectionOffset: number;          // Radians, from diffraction
  chopDirectionOffset: number;           // Radians, from diffraction
  depth: number;                         // Terrain height (+ = land, - = water)
}

// Two-pass Gerstner algorithm
function computeWaveDataAtPoint(
  x: number,
  y: number,
  params: WaterComputeParams
): WaveData {
  // Pass 1: Compute Gerstner horizontal displacement
  let dispX = 0, dispY = 0;
  for each wave {
    Q = steepness / (k * amplitude * numWaves);
    cosPhase = cos(k*distance - omega*time);
    dispX += Q * amplitude * direction.x * cosPhase;
    dispY += Q * amplitude * direction.y * cosPhase;
  }

  // Pass 2: Compute height and dh/dt at displaced position
  const sampleX = x - dispX;
  const sampleY = y - dispY;
  let height = 0, dhdt = 0;

  for each wave {
    // Apply terrain influence
    if i < SWELL_WAVE_COUNT {
      amplitude *= swellEnergyFactor;
      direction += swellDirectionOffset;
    } else {
      amplitude *= chopEnergyFactor * fetchFactor;
      direction += chopDirectionOffset;
    }

    sinPhase = sin(phase);
    cosPhase = cos(phase);
    height += amplitude * sinPhase;
    dhdt += -amplitude * omega * cosPhase;
  }

  // Apply shoaling and damping based on depth
  const shoalingFactor = computeShoalingFactor(depth);  // Green's law
  const dampingFactor = computeDampingFactor(depth);    // Bottom friction
  const depthModifier = shoalingFactor * dampingFactor;

  height *= depthModifier;
  dhdt *= depthModifier;

  return { height, dhdt };
}

// Shoaling: waves grow taller as depth decreases
function computeShoalingFactor(depth: number): number {
  if (depth >= 0) return 0;  // On land
  const effectiveDepth = Math.max(-depth, MIN_DEPTH);
  return Math.pow(DEEP_WATER_DEPTH / effectiveDepth, 0.25);
}

// Damping: bottom friction attenuates shallow water waves
function computeDampingFactor(depth: number): number {
  if (depth >= 0) return 0;
  const effectiveDepth = -depth;
  if (effectiveDepth >= DEEP_THRESHOLD) return 1.0;
  if (effectiveDepth <= SHALLOW_THRESHOLD) return MIN_DAMPING;
  return MIN_DAMPING + (1-MIN_DAMPING) * (effectiveDepth - SHALLOW_THRESHOLD) /
         (DEEP_THRESHOLD - SHALLOW_THRESHOLD);
}
```

**Key Algorithm Details**:

1. **Two-Pass Gerstner**: First computes surface displacement, then evaluates height at displaced position (trochoid surface)
2. **Amplitude Modulation**: Slow noise for wave grouping effect
3. **Shoaling**: Waves amplify in shallow water (Green's Law: √(d₀/d₁))
4. **Damping**: Bottom friction attenuates short-wavelength energy in shallow water
5. **Depth Effects**: Combined shoaling×damping multiplier applied to height and dh/dt
6. **Terrain Influence**: Swell vs chop treated separately, each with own energy/direction modifications

### GPU Water Computation

**File**: `water/webgpu/AnalyticalWaterDataTileCompute.ts`

Uses analytical physics with texture-based shadow diffraction.

```typescript
export interface AnalyticalWaterConfig {
  depthTexture: GPUTexture; // From InfluenceFieldManager
  depthSampler: GPUSampler;
  depthGridConfig: DepthGridConfig; // For UV mapping
  waveSourceDirection: number; // Base swell direction
}

export interface ShadowResources {
  shadowTextureView: GPUTextureView; // From WavePhysicsManager
  shadowDataBuffer: GPUBuffer; // Shadow metadata
}

class AnalyticalWaterDataTileCompute implements DataTileCompute {
  setConfig(config: AnalyticalWaterConfig): void;
  setShadowResources(resources: ShadowResources): void;
  setSegments(segments: WakeSegmentData[]): void; // Wake particles
  setTideHeight(tideHeight: number): void;

  runCompute(
    time: number,
    left: number,
    top: number,
    width: number,
    height: number,
  ): void;

  getOutputTexture(): GPUTexture | null; // rgba32float
}
```

The GPU shader:

- Outputs `rgba32float` (4 channels: height, dhdt, velocityX, velocityY)
- Samples depth texture for shoaling/damping
- Uses shadow texture for diffraction
- Computes wakes from segment data

---

## Terrain System

### TerrainInfo Entity

**File**: `terrain/TerrainInfo.ts`

Provides terrain height at any world position.

```typescript
export interface TerrainPointData {
  height: number; // World units (+ = above water, - = below water)
}

class TerrainInfo extends BaseEntity {
  static fromGame(game: Game): TerrainInfo;
  static maybeFromGame(game: Game): TerrainInfo | undefined;

  // Main interface
  getHeightAtPoint(point: V2d): number;
  getShoreDistance(point: V2d): number; // Signed distance to coastline

  // Terrain modification (dynamic)
  setTerrainDefinition(definition: TerrainDefinition): void;
  addContour(contour: TerrainContour): void;

  // Query
  getContours(): readonly TerrainContour[];
  getTerrainDefinition(): TerrainDefinition;
  getVersion(): number; // Increments when terrain changes

  // Stats
  getTileStats(): { activeTiles; maxTiles; tileHits; cpuFallbacks };
}
```

### TerrainQuerier Interface

**File**: `terrain/TerrainQuerier.ts`

```typescript
export interface TerrainQuerier {
  getTerrainQueryForecast(): QueryForecast | null;
}
```

### Terrain Definition

**File**: `terrain/LandMass.ts`

Terrain is defined by **closed contours** (Catmull-Rom splines) at specific heights.

```typescript
export interface TerrainContour {
  controlPoints: readonly V2d[]; // Closed loop of control points
  height: number; // Height of this contour (ft)
}

export interface TerrainDefinition {
  contours: TerrainContour[];
  defaultDepth?: number; // Deep ocean baseline (-50 ft default)
}

// Helper functions
function createContour(controlPoints: V2d[], height: number): TerrainContour;
function isContourCCW(contour: TerrainContour): boolean; // Counter-clockwise check
function ensureContourCCW(contour: TerrainContour): TerrainContour;
function normalizeTerrainWinding(
  definition: TerrainDefinition,
): TerrainDefinition;
```

**Contour Hierarchy**:

A **containment tree** is built from contours to represent parent-child relationships:

```
Forest structure:
  Root: Ocean (contains all root-level contours)
    ├─ Contour A (height=0, island perimeter)
    │  └─ Contour B (height=10, hill inside island)
    │     └─ Contour C (height=20, peak inside hill)
    └─ Contour D (height=0, another island)

Height at point = determined by deepest containing contour +
                  IDW blend with children
```

```typescript
export interface ContourTreeNode {
  contourIndex: number; // Index into contours array
  parentIndex: number; // Parent (-1 if root)
  depth: number; // Tree depth
  children: number[]; // Child indices
}

export interface ContourTree {
  nodes: ContourTreeNode[]; // One per contour
  childrenFlat: number[]; // Flat array for GPU
  maxDepth: number;
}

// Build tree from contours
function buildContourTree(contours: TerrainContour[]): ContourTree;
```

### CPU Terrain Computation

**File**: `terrain/cpu/TerrainComputeCPU.ts`

Tree-based height computation with inverse-distance weighting (IDW).

```typescript
class TerrainComputeCPU {
  computeHeightAtPoint(point: V2d, definition: TerrainDefinition): number {
    // 1. Find deepest contour containing the point
    const containing = this.findDeepestContainingContour(point, contours);

    // 2. Compute height from tree
    if (!containing) {
      // In ocean: IDW blend between root contours
      return this.computeOceanHeight(point, tree);
    }

    if (containing.children.length === 0) {
      // Leaf node: just return height
      return containing.height;
    }

    // Interior node: IDW blend parent + all children
    return this.computeIDWHeight(point, containing, children);
  }
}

// IDW algorithm (used for both ocean and interior nodes)
// weight[i] = 1 / distance[i]
// height = Σ(height[i] * weight[i]) / Σ(weight[i])
```

**Signed Distance Computation**:

```typescript
// Point-to-polyline distance using winding number
// Negative distance = inside, Positive = outside

function signedDistanceToPolyline(point: V2d, vertices: V2d[]): number {
  let minDist = Infinity;
  let windingNumber = 0;

  for each edge:
    minDist = min(distance to edge)
    windingNumber += windingContribution(edge)

  inside = (windingNumber !== 0);
  return inside ? -minDist : minDist;
}

// Spline subdivision (Catmull-Rom)
function subdivideSpline(controlPoints: V2d[]): V2d[] {
  // Convert control points to polyline segments
  // Evaluate Catmull-Rom at multiple points per segment
  // Closed loop: wrap indices
}

function catmullRomPoint(p0, p1, p2, p3, t): V2d {
  // Standard Catmull-Rom cubic interpolation
  // t in [0,1] interpolates between p1 and p2
}
```

### GPU Terrain Computation

**File**: `terrain/webgpu/TerrainDataTileCompute.ts`

Dispatches compute shader threads to evaluate terrain height.

```typescript
class TerrainDataTileCompute implements DataTileCompute {
  constructor(buffers: TerrainComputeBuffers, textureSize: number);

  updateTerrainGeometry(definition: TerrainDefinition): void;

  runCompute(
    time: number,
    left: number,
    top: number,
    width: number,
    height: number,
  ): void;

  getOutputTexture(): GPUTexture | null; // rgba32float
}
```

Output texture: `rgba32float` with height in R channel.

### GPU Data Layout

**File**: `terrain/LandMass.ts` - `buildTerrainGPUData()`

Converts terrain definition to GPU-ready buffers:

```
// Control Points Array (Float32Array)
Flat array: [x0, y0, x1, y1, x2, y2, ...]
Each point is 2 floats

// Contour Metadata Array (with DataView for mixed types)
Per contour (36 bytes = 9 floats with padding):
  0-3:   pointStartIndex (u32)
  4-7:   pointCount (u32)
  8-11:  height (f32)
  12-15: parentIndex (i32, -1 if root)
  16-19: depth (u32)
  20-23: childStartIndex (u32)
  24-27: childCount (u32)
  28-31: isCoastline (u32, 1 if height==0)
  32-35: padding

// Children Array (Uint32Array)
Flat list of all child indices
childrenFlat[i] = contour index of i-th child

// Coastline Indices (Uint32Array)
Indices of all contours with height == 0
```

---

## Influence Fields

### Purpose

Pre-computed grids that capture **how terrain affects wind**. Computed once at startup, sampled per-frame at runtime.

### InfluenceFieldManager

**File**: `influence/InfluenceFieldManager.ts`

```typescript
class InfluenceFieldManager extends BaseEntity {
  static fromGame(game: Game): InfluenceFieldManager;
  static maybeFromGame(game: Game): InfluenceFieldManager | undefined;

  // Wait for async initialization
  waitForInitialization(): Promise<void>;
  isInitialized(): boolean;

  // Query interface
  sampleWindInfluence(
    worldX: number,
    worldY: number,
    windDirection: number,
  ): WindInfluence;

  // GPU resources
  getDepthTexture(): GPUTexture | null; // For water shader
  getDepthGridConfig(): DepthGridConfig | null;
  getDepthGrid(): Float32Array | null;

  // Async computation
  getProgress(): TaskProgress; // { wind: 0..1 }
  recompute(): Promise<void>; // Recompute for updated terrain
}
```

### Wind Influence Grid

Internal 3D grid structure:

```typescript
// Layout: [direction][y][x][channel]
// 4 floats per cell: [speedFactor, directionOffset, turbulence, unused]

class WindInfluenceGrid {
  sample(worldX: number, worldY: number, direction: number): Float32Array {
    // Trilinear interpolation in (x, y, direction) space
    // Handles direction wraparound (wraps at 2π)
    return interpolated [speedFactor, directionOffset, turbulence, ...]
  }
}
```

**Configuration**:

```typescript
const WIND_FIELD_RESOLUTION = {
  cellSize: 50, // 50 ft per cell
  directionCount: 16, // 16 directions (22.5° increments)
};

const WIND_PROPAGATION_CONFIG = {
  directFlowFactor: 0.8, // How much wind moves toward terrain
  lateralSpreadFactor: 0.2, // Spreading to sides
  decayFactor: 0.98, // Per-iteration damping
  maxIterations: 50, // Max propagation steps
  convergenceThreshold: 0.01, // Stop when deltas < this
};
```

### Depth Grid

Separate higher-resolution depth texture for water shader sampling:

```typescript
// Computed from terrain via TerrainRenderPipeline (GPU-based rasterization)
// Stored as r32float texture
// Used for shoaling/damping calculations in water shader
```

### Async Initialization

```
onAfterAdded()
  ↓
computeAsync()
  ├─ Compute terrain bounds from contours
  ├─ Generate depth grid using TerrainRenderPipeline
  │  └─ GPU rasterization → readback Float32Array
  ├─ Create wind worker pool
  ├─ Compute wind influence fields for all directions
  │  └─ Each direction computed by a worker (distributes work)
  └─ Dispatch "influenceFieldsReady" event

// Meanwhile, wind/water systems use CPU fallback
```

### Wind Propagation Algorithm

Uses **iterative ray-marching** from terrain to compute influence values.

**Worker Interface**:

```typescript
interface WindWorkerRequest {
  type: "compute";
  batchId: number;
  directions: number[]; // Batch of direction indices
  gridConfig: SerializableGridConfig;
  propagationConfig: SerializablePropagationConfig;
  depthGrid: Float32Array; // Terrain depth
  depthGridConfig: SerializableDepthGridConfig;
  sourceAngles: number[]; // Angle for each direction
}

interface WindWorkerResult {
  directions: number[];
  windData: Float32Array; // [speedFactor, directionOffset, turbulence, ...]
}
```

**Algorithm**:

```
For each source direction:
  Initialize grid: all cells = default influence (1.0, 0, 0)

  For iteration 1 to maxIterations:
    For each cell:
      // Sample local terrain
      if terrain blocks this direction:
        Reduce speedFactor (shadow)
        Add directionOffset (deflection)
        Add turbulence (wake)

      // Spread to neighbors
      Blend with neighboring cells using directFlowFactor, lateralSpreadFactor

    // Check convergence
    if all deltas < convergenceThreshold:
      break

  Store final grid values
```

---

## Weather State

**File**: `weather/WeatherState.ts`

Global atmospheric and oceanic conditions that drive the wind/wave system.

```typescript
export interface WindState {
  direction: number;     // Radians (0=from east, π/2=from north)
  speed: number;         // ft/s
  gustFactor: number;    // Gust intensity multiplier
}

export interface SwellState {
  direction: number;     // Radians
  amplitude: number;     // Significant wave height (ft)
  period: number;        // Wave period (seconds)
}

export interface TideState {
  phase: number;         // 0=low, 0.5=high, 1=low
  range: number;         // Tidal range (ft)
}

export interface WeatherState {
  wind: WindState;
  swell: SwellState;
  secondarySwell?: SwellState;
  tide: TideState;
}

// Defaults and builders
const DEFAULT_WIND = { direction: 0, speed: 15, gustFactor: 0.15 };
const DEFAULT_SWELL = { direction: 0.5, amplitude: 0.5, period: 8 };
const DEFAULT_TIDE = { phase: 0.25, range: 4 };

function createDefaultWeather(): WeatherState
function createWeather(overrides: Partial<...>): WeatherState

// Wave physics utilities
function wavelengthFromPeriod(periodSeconds: number): number
function periodFromWavelength(wavelengthFt: number): number
```

These constants configure `WAVE_COMPONENTS` in `WaterConstants.ts`.

---

## Integration Patterns

### Query Forecasting

Entities that query data must:

1. **Tag themselves** with the appropriate querier tag
2. **Implement the interface** with `getXxxQueryForecast()` method
3. **Return realistic forecasts** based on expected queries

```typescript
class Boat extends BaseEntity {
  tags = ["windQuerier", "waterQuerier", "terrainQuerier"];

  getWindQueryForecast(): QueryForecast | null {
    // Return AABB of where we'll query wind + expected query count
    const sailBounds = this.computeSailBounds();
    return {
      aabb: sailBounds,
      queryCount: this.sails.length * 2, // 2 queries per sail
    };
  }

  getWaterQueryForecast(): QueryForecast | null {
    const hull = this.getHullBounds();
    return {
      aabb: hull,
      queryCount: this.hull.points.length, // One query per hull point
    };
  }

  getTerrainQueryForecast(): QueryForecast | null {
    const vicinity = this.getVicinityBounds();
    return {
      aabb: vicinity,
      queryCount: 4, // Corner points
    };
  }

  @on("tick")
  onTick() {
    const wind = WindInfo.fromGame(this.game);
    for (const sail of this.sails) {
      const windVel = wind.getVelocityAtPoint(sail.position);
      // ... sail physics ...
    }

    const water = WaterInfo.fromGame(this.game);
    const waterState = water.getStateAtPoint(this.position);
    // ... hull physics ...
  }
}
```

### GPU Path vs CPU Fallback

**GPU Path** (fast):

1. Entity provides forecast to data provider
2. Data provider selects tiles based on demand
3. GPU computes tile to texture
4. Readback buffer provides CPU-side data
5. Sample from buffer → instant result

**CPU Path** (slower, fallback):

1. Point is outside computed tiles
2. Data provider calls CPU fallback function
3. CPU computes result from scratch
4. Return immediately

```typescript
// In WindInfo.getVelocityAtPoint()
const result = this.pipeline.sampleAtWorldPoint(point);
if (result) {
  return V(result.velocityX, result.velocityY); // GPU path
}

// CPU fallback
const velocity = this.computeCPUBaseWind(point); // CPU path
```

### Waiting for Influence Fields

Influence fields initialize asynchronously:

```typescript
// Option 1: Wait explicitly
class WaveVisualizer extends BaseEntity {
  @on("add")
  async onAdd() {
    const influenceManager = InfluenceFieldManager.fromGame(this.game);
    await influenceManager.waitForInitialization();
    // Now safe to use influence data
  }
}

// Option 2: Listen for event
class GameController extends BaseEntity {
  @on("influenceFieldsReady")
  onInfluenceFieldsReady() {
    // Add visual entities that depend on influence data
    this.addChild(new WaveVisualsVisualization());
  }
}
```

### Stats Monitoring

Each data provider tracks performance:

```typescript
const windStats = windInfo.getTileStats();
console.log(`Wind: ${windStats.activeTiles}/${windStats.maxTiles} tiles`);
console.log(
  `Wind: ${windStats.tileHits} GPU hits, ${windStats.cpuFallbacks} CPU fallbacks`,
);

const waterStats = waterInfo.getTileStats();
const terrainStats = terrainInfo.getTileStats();

// Reset per-frame counters
windInfo.resetStatsCounters();
waterInfo.resetStatsCounters();
terrainInfo.resetStatsCounters();
```

---

## Memory and Performance Considerations

### GPU Memory Usage

For each data system with `maxTilesPerFrame=64` and `tileResolution=256`:

- **Wind**: 64 tiles × 256² × 2 channels × 4 bytes = 32 MB
- **Water**: 64 tiles × 128² × 4 channels × 4 bytes = 16 MB
- **Terrain**: 64 tiles × 256² × 4 channels × 4 bytes = 64 MB
- **Influence Fields**: ~(grid size) MB, pre-computed once

Total GPU active: ~112 MB

### CPU Memory Usage

Readback buffers (double-buffered):

- **Wind**: 64 tiles × 256² × 2 × 2 (double buffer) = 64 MB
- **Water**: 64 tiles × 128² × 2 × 2 = 32 MB
- **Terrain**: 64 tiles × 256² × 2 × 2 = 128 MB

Total CPU buffers: ~224 MB (can be tuned via `maxTilesPerFrame`)

### Optimization Strategies

1. **Reduce tile resolution** if targeting lower-end hardware
2. **Reduce maxTilesPerFrame** to lower memory usage
3. **Increase tile size** to reduce total tile count
4. **Disable CPU fallback** if all queries hit active tiles (set thresholds aggressively)
5. **Precache common locations** by having forecasts point to them

---

## Summary Table

| System        | Tile Size         | Resolution              | Max Tiles    | GPU Format       | CPU Fallback           |
| ------------- | ----------------- | ----------------------- | ------------ | ---------------- | ---------------------- |
| **Wind**      | 64 ft             | 256×256                 | 64/frame     | rg32float        | Simplex noise          |
| **Water**     | 64 ft             | 128×128                 | 64/frame     | rgba32float      | Gerstner waves + depth |
| **Terrain**   | TERRAIN_TILE_SIZE | TERRAIN_TILE_RESOLUTION | 64/frame     | rgba32float      | Tree-based IDW         |
| **Influence** | 50 ft (wind)      | N/A (grid)              | Pre-computed | Trilinear interp | N/A                    |

---

This documentation provides everything needed to understand, modify, or reimplement the world-data system from scratch. The key insight is the **unified DataTile abstraction** that enables consistent GPU/CPU hybrid computation across all three spatial data types."}],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":6,"cache_creation_input_tokens":5346,"cache_read_input_tokens":81651,"cache_creation":{"ephemeral_5m_input_tokens":5346,"ephemeral_1h_input_tokens":0},"output_tokens":1,"service_tier":"standard"}},"requestId":"req_011CXWehqTC4MFVbrC99s2t8","type":"assistant","uuid":"2220c783-4d3c-4712-8931-a5762f7338a9","timestamp":"2026-01-26T20:53:05.534Z"}
