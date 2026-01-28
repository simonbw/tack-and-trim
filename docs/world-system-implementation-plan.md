# World Rendering System: Implementation Plan

This document provides a phased implementation plan for the world rendering and simulation system. Each phase builds on previous phases and can be tested independently.

---

## Phase 1: Core Infrastructure (Foundation)

**Goal**: Implement VirtualTexture system and QueryInfrastructure without any game-specific logic. These are the foundational pieces that all other systems depend on.

### Components to Implement

1. **VirtualTexture&lt;T&gt;** (`src/game/world/virtual-texture/VirtualTexture.ts`)
   - Generic tile-based caching system with LOD
   - TileCache for LRU eviction
   - Tile addressing (lod, tileX, tileY) → texture array index
   - Request/update/invalidate API

2. **TileCache** (`src/game/world/virtual-texture/TileCache.ts`)
   - HashMap for tile lookup: `Map<string, CachedTile>`
   - LRU tracking with frame timestamps
   - Allocation with eviction logic

3. **TileCompute (abstract)** (`src/game/world/virtual-texture/TileCompute.ts`)
   - Extends ComputeShader base class
   - Abstract interface for filling tiles
   - Workgroup size calculation for 128×128 tiles

4. **QueryInfrastructure** (`src/game/world/query/QueryInfrastructure.ts`)
   - Entity that coordinates all queries
   - Double-buffered async readback (staging buffers A/B)
   - Point collection from registered queries
   - GPU buffer management and compute dispatch
   - Result distribution to query entities

5. **BaseQuery (abstract)** (`src/game/world/query/BaseQuery.ts`)
   - Abstract entity base class
   - Points/results arrays
   - `getResultForPoint()` with linear scan
   - Iterator for [point, result] pairs
   - `getResultAndDestroy()` helper

### Key Technical Decisions

**VirtualTexture:**
- Use GPU texture array (2D array texture) for tile storage
- Each layer = one tile
- Tile address → layer index via TileCache mapping
- Cap pending tile computations per frame (4-8)

**QueryInfrastructure:**
- Fixed buffer size (8192 points) with graceful overflow handling
- Buffer layout: struct of arrays for points (x, y pairs)
- Staging buffer flow:
  ```
  Frame N:   await map(bufferA) → read → unmap → use results
             dispatch compute → copy to bufferB → mapAsync(bufferB)
  Frame N+1: await map(bufferB) → read → unmap → use results
             dispatch compute → copy to bufferA → mapAsync(bufferA)
  ```

**WGSL Buffer Layouts:**
```wgsl
// Query point buffer
struct QueryPoint {
  x: f32,
  y: f32,
}
@group(0) @binding(0) var<storage, read> points: array<QueryPoint>;

// Result buffer (generic, varies by query type)
@group(0) @binding(1) var<storage, read_write> results: array<Result>;
```

### Testing Strategy

**VirtualTexture Tests:**
- Create a simple TileCompute that fills tiles with a test pattern (e.g., gradient)
- Request tiles at different LODs
- Verify fallback to coarser LOD when tiles not ready
- Test LRU eviction when cache fills
- Test invalidation clears all tiles

**QueryInfrastructure Tests:**
- Create a mock query with simple points
- Verify double-buffered readback works
- Test first-frame behavior (empty results)
- Test buffer overflow handling
- Verify frame-to-frame latency (results lag by one frame)

**Test Harness:**
- Create a test level/scene that just sets up infrastructure
- Add debug visualization entities to display tile boundaries, query points
- Use profiler to measure GPU timing

### Files to Create
```
src/game/world/virtual-texture/
  ├── VirtualTexture.ts          (~300 lines)
  ├── TileCache.ts               (~150 lines)
  └── TileCompute.ts             (~100 lines, abstract base)

src/game/world/query/
  ├── QueryInfrastructure.ts     (~400 lines)
  └── BaseQuery.ts               (~200 lines)

tests/world/
  ├── VirtualTexture.test.ts
  └── QueryInfrastructure.test.ts
```

**Estimated effort**: 2-3 days

---

## Phase 2: Terrain System (First Complete Vertical Slice)

**Goal**: Implement terrain height queries end-to-end. This validates the entire query pipeline with real game data.

### Components to Implement

1. **TerrainDefinition** (`src/game/world/terrain/TerrainDefinition.ts`)
   - Data structures for contours
   - Serialization helpers (JSON ↔ TypeScript)
   - Validation

2. **ContainmentTree** (`src/game/world/terrain/ContainmentTree.ts`)
   - Build hierarchy from contours
   - Point-in-polygon tests
   - Height interpolation via inverse-distance weighting
   - Coastline extraction (height=0 contours)

3. **TerrainTileCompute** (`src/game/world/virtual-texture/TileCompute.ts`)
   - Extends TileCompute
   - WGSL shader that samples ContainmentTree data
   - Outputs r16float height values

4. **TerrainSystem** (`src/game/world/terrain/TerrainSystem.ts`)
   - Entity that owns terrain VirtualTexture
   - Uploads contour data to GPU buffers
   - Manages tile requests
   - Tick handler calls `virtualTexture.update()`

5. **TerrainQuery** (`src/game/world/query/TerrainQuery.ts`)
   - Extends BaseQuery
   - Result type: `{ height: number }`
   - Auto-registers with QueryInfrastructure on add

### Key Technical Decisions

**Contour Representation on GPU:**
```wgsl
struct Contour {
  controlPointStart: u32,  // Index into controlPoints array
  controlPointCount: u32,
  height: f32,
  parentIndex: i32,        // -1 for root contours
}

@group(0) @binding(0) var<storage, read> contours: array<Contour>;
@group(0) @binding(1) var<storage, read> controlPoints: array<vec2f>;
```

**Height Computation Shader:**
- For each tile texel:
  1. Compute world position from tile address + texel offset
  2. Walk containment tree (starting from roots)
  3. Find deepest containing contour
  4. Interpolate height using inverse-distance weighting to nearby contours
  5. Write to output texture

**Catmull-Rom Spline Evaluation:**
- Need WGSL helper functions for spline evaluation
- Point-on-spline projection for distance calculations
- Can use approximation (sample spline at regular intervals) for simplicity

### Integration with QueryInfrastructure

**Terrain Compute Shader** (different from tile compute):
```wgsl
// Takes query points, outputs heights
@group(0) @binding(0) var<storage, read> queryPoints: array<vec2f>;
@group(0) @binding(1) var<storage, read_write> results: array<f32>;
@group(0) @binding(2) var<storage, read> contours: array<Contour>;
@group(0) @binding(3) var<storage, read> controlPoints: array<vec2f>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&queryPoints)) { return; }

  let point = queryPoints[id.x];
  let height = computeHeightAt(point);  // Walk containment tree
  results[id.x] = height;
}
```

### Testing Strategy

**Unit Tests:**
- ContainmentTree construction from test contours
- Point-in-polygon tests with known positions
- Height interpolation with simple test cases

**Integration Tests:**
- Create test terrain with known contours (e.g., circular island at height=0, peak at height=10)
- Query heights at known positions
- Verify results match expected values
- Test coastline extraction

**Visual Tests:**
- Create debug visualization entity that:
  - Renders contour splines
  - Renders query points with height values
  - Displays VirtualTexture tile boundaries
- Test in editor or test level

### Files to Create
```
src/game/world/terrain/
  ├── TerrainDefinition.ts       (~150 lines)
  ├── ContainmentTree.ts         (~300 lines)
  ├── TerrainSystem.ts           (~350 lines)
  └── TerrainTileCompute.ts      (~200 lines + WGSL)

src/game/world/query/
  └── TerrainQuery.ts            (~100 lines)

tests/world/terrain/
  ├── ContainmentTree.test.ts
  └── TerrainSystem.test.ts

resources/test-levels/
  └── simple-island.json         (test terrain data)
```

**Estimated effort**: 3-4 days

---

## Phase 3: Wind System (Simple Simulation)

**Goal**: Implement wind queries with noise-based variation. Tests GPU compute without complex dependencies.

### Components to Implement

1. **WindNoise** (`src/game/world/wind/WindNoise.ts`)
   - Extends ComputeShader
   - WGSL simplex noise implementation (or use existing noise library)
   - Scrolling noise based on time
   - Outputs wind velocity at query points

2. **WindSystem** (`src/game/world/wind/WindSystem.ts`)
   - Entity that owns WindNoise compute shader
   - Stores base wind vector
   - Tick handler dispatches wind compute (after terrain)
   - Simple for now (no terrain influence)

3. **WindQuery** (`src/game/world/query/WindQuery.ts`)
   - Extends BaseQuery
   - Result type: `{ vx: number; vy: number }`
   - Auto-registers with QueryInfrastructure

### Key Technical Decisions

**Wind Compute Shader:**
```wgsl
struct WindResult {
  vx: f32,
  vy: f32,
}

@group(0) @binding(0) var<storage, read> queryPoints: array<vec2f>;
@group(0) @binding(1) var<storage, read_write> results: array<WindResult>;
@group(0) @binding(2) var<uniform> baseWind: vec2f;
@group(0) @binding(3) var<uniform> time: f32;
@group(0) @binding(4) var<uniform> noiseParams: vec4f; // scale, timeScale, variation, padding

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&queryPoints)) { return; }

  let point = queryPoints[id.x];
  let noisePos = point * noiseParams.x + vec2f(0.0, time * noiseParams.y);

  let nx = simplexNoise2D(noisePos);
  let ny = simplexNoise2D(noisePos + vec2f(100.0, 0.0)); // Offset for independent noise

  let variation = noiseParams.z;
  let windX = baseWind.x * (1.0 + nx * variation);
  let windY = baseWind.y * (1.0 + ny * variation);

  results[id.x] = WindResult(windX, windY);
}
```

**Simplex Noise:**
- Include WGSL noise library or implement simplex noise
- 2D noise is sufficient
- Can use existing implementations (e.g., from webgpu-utils or similar)

### Integration with QueryInfrastructure

WindSystem needs to register its compute dispatch with QueryInfrastructure:
- QueryInfrastructure calls terrain compute first
- Then calls wind compute
- Wind doesn't depend on terrain results yet (future: wind shadows)

### Testing Strategy

**Unit Tests:**
- Verify noise generates reasonable values (not NaN, within expected range)
- Test that base wind + noise produces correct magnitudes

**Integration Tests:**
- Create test WindQuery with sample points
- Verify results vary spatially (due to noise)
- Verify results vary temporally (noise scrolls)
- Check base wind is correctly applied

**Visual Tests:**
- WindParticles visualization (show wind vectors as arrows)
- Verify wind varies smoothly across space
- Verify wind changes over time

### Files to Create
```
src/game/world/wind/
  ├── WindSystem.ts              (~250 lines)
  ├── WindNoise.ts               (~150 lines + WGSL)
  └── simplex-noise.wgsl         (~100 lines, if implementing)

src/game/world/query/
  └── WindQuery.ts               (~100 lines)

tests/world/wind/
  └── WindSystem.test.ts
```

**Estimated effort**: 2-3 days

---

## Phase 4: Water System (Complex Dependencies)

**Goal**: Implement full water simulation with waves, shadows, modifiers, and tide. Most complex subsystem.

### Components to Implement

1. **WaveSource** (`src/game/world/water/WaveSource.ts`)
   - Configuration and runtime state
   - Gerstner wave math (displacement, height, velocity)
   - GPU data packing

2. **WaveShadow** (`src/game/world/water/WaveShadow.ts`)
   - Entity child of WaterSystem
   - Shadow geometry computation from coastlines + wave direction
   - Owns VirtualTexture&lt;ShadowData&gt;
   - ShadowTileCompute for rasterizing shadow polygons

3. **ShadowTileCompute** (`src/game/world/virtual-texture/TileCompute.ts`)
   - Rasterizes shadow polygons into tiles
   - Outputs rg8unorm (intensity, distance-to-edge)

4. **WaterModifier** (`src/game/world/water/WaterModifier.ts`)
   - Interface definition
   - Type definitions for segment/point/ring

5. **WaterModifierBuffer** (`src/game/world/water/WaterModifierBuffer.ts`)
   - GPU buffer management
   - Collection and upload each frame
   - Active count tracking

6. **WaterSystem** (`src/game/world/water/WaterSystem.ts`)
   - Entity that owns wave sources, shadows, modifier buffer
   - Collects modifiers from tagged entities
   - Manages WaveShadow children
   - Dispatches water compute

7. **WaterQuery** (`src/game/world/query/WaterQuery.ts`)
   - Extends BaseQuery
   - Result type: `{ z, vx, vy, vz }`
   - Auto-registers terrain dependency

### Key Technical Decisions

**Shadow Geometry Computation** (CPU, at level load):
```typescript
function computeShadowGeometry(
  coastlines: TerrainContour[],
  waveDirection: number
): ShadowPolygon[] {
  // For each coastline:
  // 1. Find silhouette points (tangent parallel to wave direction)
  // 2. Identify left/right extremal silhouette points
  // 3. Sample leeward coastline arc between extremals
  // 4. Build shadow polygon extending from silhouettes
  // 5. Return polygon vertices for GPU upload
}
```

**Shadow Rasterization Shader:**
```wgsl
struct ShadowPolygon {
  vertexStart: u32,
  vertexCount: u32,
}

@group(0) @binding(0) var<storage, read> polygons: array<ShadowPolygon>;
@group(0) @binding(1) var<storage, read> vertices: array<vec2f>;
@group(0) @binding(2) var<texture_storage_2d, write, rg8unorm> output: texture_storage_2d<rg8unorm>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  // For this texel, compute world position
  let worldPos = tileToWorld(id.xy);

  // Test if inside any shadow polygon
  var intensity = 0.0;
  var distToEdge = 999999.0;

  for (var i = 0u; i < arrayLength(&polygons); i++) {
    let poly = polygons[i];
    if (pointInPolygon(worldPos, poly)) {
      intensity = 1.0;
      distToEdge = min(distToEdge, distanceToPolygonEdge(worldPos, poly));
    }
  }

  textureStore(output, id.xy, vec4f(intensity, distToEdge / 100.0, 0.0, 0.0));
}
```

**Water Compute Shader** (most complex):
```wgsl
struct WaterResult {
  z: f32,
  vx: f32,
  vy: f32,
  vz: f32,
}

struct WaveSource {
  direction: vec2f,
  amplitude: f32,
  k: f32,           // wave number
  omega: f32,       // angular frequency
  shadowTextureIndex: u32,
}

struct WaterModifier {
  modifierType: f32,
  boundsMinX: f32,
  boundsMinY: f32,
  boundsMaxX: f32,
  boundsMaxY: f32,
  param0: f32,
  param1: f32,
  param2: f32,
}

@group(0) @binding(0) var<storage, read> queryPoints: array<vec2f>;
@group(0) @binding(1) var<storage, read_write> results: array<WaterResult>;
@group(0) @binding(2) var<storage, read> terrainHeights: array<f32>; // From terrain compute
@group(0) @binding(3) var<storage, read> waveSources: array<WaveSource>;
@group(0) @binding(4) var shadowTextures: texture_2d_array<f32>; // Shadow VTs
@group(0) @binding(5) var shadowSampler: sampler;
@group(0) @binding(6) var<storage, read> modifiers: array<WaterModifier>;
@group(0) @binding(7) var<uniform> time: f32;
@group(0) @binding(8) var<uniform> activeModifierCount: u32;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&queryPoints)) { return; }

  let point = queryPoints[id.x];
  let terrainHeight = terrainHeights[id.x];
  let depth = 0.0 - terrainHeight; // Sea level = 0

  var totalZ = 0.0;
  var totalVx = 0.0;
  var totalVy = 0.0;
  var totalVz = 0.0;

  // Gerstner waves (two-pass)
  var displacement = vec2f(0.0);
  for (var i = 0u; i < arrayLength(&waveSources); i++) {
    displacement += gerstnerDisplacement(waveSources[i], point, time);
  }

  let displacedPos = point + displacement;

  for (var i = 0u; i < arrayLength(&waveSources); i++) {
    let wave = waveSources[i];

    // Sample shadow
    let shadowUV = worldToShadowUV(displacedPos, i);
    let shadow = textureSampleLevel(shadowTextures, shadowSampler, shadowUV, i, 0.0);
    let shadowIntensity = shadow.r;

    // Depth effects
    let depthModifier = computeDepthModifier(depth, wave.k);

    // Wave contribution
    let waveResult = evaluateGerstner(wave, displacedPos, time);
    let attenuatedAmplitude = wave.amplitude * (1.0 - shadowIntensity) * depthModifier;

    totalZ += waveResult.z * attenuatedAmplitude / wave.amplitude;
    totalVz += waveResult.vz * attenuatedAmplitude / wave.amplitude;
  }

  // Water modifiers
  for (var i = 0u; i < activeModifierCount; i++) {
    let mod = modifiers[i];

    // Bounds culling
    if (point.x < mod.boundsMinX || point.x > mod.boundsMaxX ||
        point.y < mod.boundsMinY || point.y > mod.boundsMaxY) {
      continue;
    }

    // Evaluate modifier
    let contribution = evaluateModifier(mod, point);
    totalZ += contribution;
  }

  results[id.x] = WaterResult(totalZ, totalVx, totalVy, totalVz);
}
```

**Depth Effects:**
```wgsl
fn computeDepthModifier(depth: f32, k: f32) -> f32 {
  let referenceDepth = 20.0; // ft
  let deepThreshold = 15.0;
  let shallowThreshold = 2.0;
  let minDamping = 0.1;

  // Shoaling (Green's Law)
  var shoaling = 1.0;
  if (depth > 0.0 && depth < referenceDepth) {
    shoaling = pow(referenceDepth / depth, 0.25);
  }

  // Damping
  var damping = 1.0;
  if (depth < deepThreshold) {
    if (depth < shallowThreshold) {
      damping = minDamping;
    } else {
      let t = (depth - shallowThreshold) / (deepThreshold - shallowThreshold);
      damping = mix(minDamping, 1.0, t);
    }
  }

  return shoaling * damping;
}
```

### Testing Strategy

**Unit Tests:**
- WaveSource Gerstner math (compare with known values)
- Shadow geometry construction (known coastline → expected polygon)
- Depth modifier calculations

**Integration Tests:**
- Create test level with simple coastline
- Verify shadows appear behind land
- Test water queries at various depths
- Test modifier collection and application

**Visual Tests:**
- Render wave heights as color
- Visualize shadow intensity
- Show modifier bounds and contributions
- Animate waves to verify motion

### Files to Create
```
src/game/world/water/
  ├── WaveSource.ts              (~200 lines)
  ├── WaveShadow.ts              (~300 lines)
  ├── ShadowTileCompute.ts       (~250 lines + WGSL)
  ├── WaterModifier.ts           (~50 lines, interface)
  ├── WaterModifierBuffer.ts     (~150 lines)
  └── WaterSystem.ts             (~400 lines)

src/game/world/query/
  └── WaterQuery.ts              (~120 lines)

shaders/
  ├── water-compute.wgsl         (~400 lines)
  ├── shadow-rasterize.wgsl      (~200 lines)
  └── wave-math.wgsl             (~150 lines, shared functions)

tests/world/water/
  ├── WaveSource.test.ts
  ├── WaveShadow.test.ts
  └── WaterSystem.test.ts
```

**Estimated effort**: 5-7 days

---

## Phase 5: Surface Rendering

**Goal**: Implement visual rendering pipeline. Four-pass compute/render pipeline that outputs to screen.

### Components to Implement

1. **TerrainRenderPass** (`src/game/world/rendering/TerrainRenderPass.ts`)
   - Extends ComputeShader
   - Samples terrain VirtualTexture into dense screen-res texture
   - Outputs rg16float (height, material)

2. **WaterRenderPass** (`src/game/world/rendering/WaterRenderPass.ts`)
   - Extends ComputeShader
   - Evaluates full water simulation per texel
   - Same math as water query compute but for 2D grid
   - Outputs rgba16float (height, normal.xy, foam)

3. **WetnessPass** (`src/game/world/rendering/WetnessPass.ts`)
   - Extends ComputeShader
   - Ping-pong texture update
   - Reprojection from previous frame
   - Decay calculation

4. **CompositePass** (`src/game/world/rendering/CompositePass.ts`)
   - Fragment shader (not compute)
   - Combines terrain, water, wetness
   - Lighting calculations
   - Outputs to screen

5. **SurfaceRenderer** (`src/game/world/rendering/SurfaceRenderer.ts`)
   - Entity that orchestrates all passes
   - Render rect calculation from camera
   - Texture lifecycle management
   - Pass sequencing

### Key Technical Decisions

**Render Rect Calculation:**
```typescript
function computeRenderRect(camera: Camera): Rect {
  const visibleRect = camera.getVisibleWorldRect();
  const margin = 2; // texels worth of world space
  const worldUnitsPerTexel = visibleRect.width / screenWidth;
  const marginWorld = margin * worldUnitsPerTexel;

  return {
    x: visibleRect.x - marginWorld,
    y: visibleRect.y - marginWorld,
    width: visibleRect.width + 2 * marginWorld,
    height: visibleRect.height + 2 * marginWorld,
  };
}
```

**Texture Allocation:**
```typescript
class SurfaceRenderer {
  private terrainTexture: GPUTexture;   // rg16float
  private waterTexture: GPUTexture;     // rgba16float
  private wetnessTextureA: GPUTexture;  // r8unorm
  private wetnessTextureB: GPUTexture;  // r8unorm
  private currentWetnessIndex = 0;

  private allocateTextures(width: number, height: number) {
    this.terrainTexture = device.createTexture({
      size: [width, height],
      format: 'rg16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    // ... allocate others
  }

  @on("render")
  onRender({ draw }: GameEventMap["render"]) {
    const renderRect = this.computeRenderRect();

    // Check if textures need reallocation (screen resize)
    if (this.needsReallocation(renderRect)) {
      this.allocateTextures(renderRect.widthPixels, renderRect.heightPixels);
    }

    const encoder = device.createCommandEncoder();

    // Pass 1: Terrain
    this.terrainPass.render(encoder, renderRect, this.terrainTexture);

    // Pass 2: Water
    this.waterPass.render(encoder, renderRect, this.terrainTexture, this.waterTexture);

    // Pass 3: Wetness (ping-pong)
    const prevWetness = this.currentWetnessIndex === 0 ? this.wetnessTextureA : this.wetnessTextureB;
    const currWetness = this.currentWetnessIndex === 0 ? this.wetnessTextureB : this.wetnessTextureA;
    this.wetnessPass.render(encoder, renderRect, this.terrainTexture, this.waterTexture, prevWetness, currWetness);
    this.currentWetnessIndex = 1 - this.currentWetnessIndex;

    // Pass 4: Composite
    this.compositePass.render(encoder, this.terrainTexture, this.waterTexture, currWetness, renderRect);

    device.queue.submit([encoder.finish()]);
  }
}
```

**Terrain Pass Shader:**
```wgsl
@group(0) @binding(0) var terrainVT: texture_2d_array<f32>;
@group(0) @binding(1) var terrainSampler: sampler;
@group(0) @binding(2) var<storage, write, rg16float> output: texture_storage_2d<rg16float>;
@group(0) @binding(3) var<uniform> renderRect: vec4f; // x, y, width, height

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let texelPos = vec2f(f32(id.x), f32(id.y));
  let worldPos = renderRectToWorld(texelPos, renderRect);

  // Sample terrain VT at appropriate LOD
  let lod = computeLOD(renderRect);
  let height = sampleTerrainVT(worldPos, lod);
  let material = 0.0; // TODO: derive from height

  textureStore(output, id.xy, vec4f(height, material, 0.0, 0.0));
}
```

**Water Pass Shader:**
- Nearly identical to water query compute
- But operates on 2D grid of texels instead of sparse points
- Can compute normals via finite differences (sample neighbors)

**Wetness Pass Shader:**
```wgsl
@group(0) @binding(0) var terrainTexture: texture_2d<f32>;
@group(0) @binding(1) var waterTexture: texture_2d<f32>;
@group(0) @binding(2) var prevWetnessTexture: texture_2d<f32>;
@group(0) @binding(3) var wetnessSampler: sampler;
@group(0) @binding(4) var<storage, write, r8unorm> output: texture_storage_2d<r8unorm>;
@group(0) @binding(5) var<uniform> currentRect: vec4f;
@group(0) @binding(6) var<uniform> previousRect: vec4f;
@group(0) @binding(7) var<uniform> dt: f32;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let worldPos = texelToWorld(id.xy, currentRect);

  // Reproject to previous frame
  let prevUV = worldToPrevUV(worldPos, previousRect);
  var prevWetness = 0.0;
  if (prevUV.x >= 0.0 && prevUV.x <= 1.0 && prevUV.y >= 0.0 && prevUV.y <= 1.0) {
    prevWetness = textureSampleLevel(prevWetnessTexture, wetnessSampler, prevUV, 0.0).r;
  }

  // Read terrain and water heights
  let terrainHeight = textureLoad(terrainTexture, id.xy, 0).r;
  let waterHeight = textureLoad(waterTexture, id.xy, 0).r;

  var wetness = prevWetness;

  // Underwater = fully wet
  if (terrainHeight < waterHeight) {
    wetness = 1.0;
  } else {
    // Decay
    let heightAboveWater = terrainHeight - waterHeight;
    let decayRate = 0.5; // 50% per second
    wetness = max(0.0, wetness - decayRate * dt);
  }

  textureStore(output, id.xy, vec4f(wetness, 0.0, 0.0, 0.0));
}
```

**Composite Pass (Fragment Shader):**
```wgsl
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@group(0) @binding(0) var terrainTexture: texture_2d<f32>;
@group(0) @binding(1) var waterTexture: texture_2d<f32>;
@group(0) @binding(2) var wetnessTexture: texture_2d<f32>;
@group(0) @binding(3) var texSampler: sampler;

@fragment
fn main(input: VertexOutput) -> @location(0) vec4f {
  let terrain = textureSample(terrainTexture, texSampler, input.uv);
  let water = textureSample(waterTexture, texSampler, input.uv);
  let wetness = textureSample(wetnessTexture, texSampler, input.uv).r;

  let terrainHeight = terrain.r;
  let waterHeight = water.r;

  // Base terrain color
  var baseColor = vec3f(0.8, 0.7, 0.5); // Sand
  if (terrainHeight > 2.0) {
    baseColor = vec3f(0.2, 0.6, 0.2); // Grass
  }
  if (terrainHeight > 10.0) {
    baseColor = vec3f(0.5, 0.5, 0.5); // Rock
  }

  // Apply wetness darkening
  let darkeningFactor = 0.4;
  baseColor = baseColor * (1.0 - wetness * darkeningFactor);

  // Water color
  let depth = waterHeight - terrainHeight;
  var waterColor = vec3f(0.0, 0.3, 0.6); // Deep blue
  if (depth < 5.0) {
    waterColor = mix(vec3f(0.3, 0.7, 0.8), waterColor, depth / 5.0); // Shallow cyan
  }

  // Blend water over terrain
  let waterAlpha = clamp(depth / 10.0, 0.0, 0.8);
  let finalColor = mix(baseColor, waterColor, waterAlpha);

  // Simple lighting (TODO: use water normals for specular)
  let sunDir = normalize(vec3f(1.0, 1.0, 0.5));
  let ambient = 0.4;
  let diffuse = 0.6;
  let lighting = ambient + diffuse;

  return vec4f(finalColor * lighting, 1.0);
}
```

### Testing Strategy

**Visual Tests (primary):**
- Render test level with terrain
- Verify terrain coloring based on height
- Verify water renders over terrain
- Verify wetness appears when waves hit shore
- Verify wetness decays over time
- Test camera movement (reprojection works)
- Test zoom (LOD selection works)

**Performance Tests:**
- Profile each pass with GPU timestamps
- Target: 60fps at 1920×1080
- Monitor texture memory usage

### Files to Create
```
src/game/world/rendering/
  ├── SurfaceRenderer.ts         (~400 lines)
  ├── TerrainRenderPass.ts       (~200 lines + WGSL)
  ├── WaterRenderPass.ts         (~300 lines + WGSL)
  ├── WetnessPass.ts             (~250 lines + WGSL)
  └── CompositePass.ts           (~200 lines + WGSL)

shaders/
  ├── terrain-pass.wgsl          (~150 lines)
  ├── water-pass.wgsl            (~300 lines)
  ├── wetness-pass.wgsl          (~150 lines)
  └── composite-pass.wgsl        (~200 lines)
```

**Estimated effort**: 4-5 days

---

## Phase 6: Integration & Polish

**Goal**: Tie everything together with WorldManager, polish the public API, and add nice-to-have features.

### Components to Implement

1. **WorldManager** (`src/game/world/WorldManager.ts`)
   - Entity that owns all systems
   - Initializes from LevelDefinition
   - Collects water modifiers each frame
   - Provides getBaseWind() accessor

2. **LevelDefinition** format
   - JSON schema for levels
   - Validation
   - Example levels

3. **Polish & Optimizations**
   - Proper error handling throughout
   - Performance profiling and optimization
   - Memory leak checks
   - Debug visualization improvements

### Key Implementation Points

**WorldManager Structure:**
```typescript
export class WorldManager extends BaseEntity {
  readonly id = "worldManager";
  readonly tickLayer = "environment";

  private terrainSystem!: TerrainSystem;
  private waterSystem!: WaterSystem;
  private windSystem!: WindSystem;
  private queryInfrastructure!: QueryInfrastructure;

  constructor(private level: LevelDefinition) {
    super();
  }

  @on("add")
  onAdd() {
    const device = this.game.renderer.getDevice();

    // 1. Query infrastructure
    this.queryInfrastructure = this.addChild(new QueryInfrastructure(device));

    // 2. Terrain
    this.terrainSystem = this.addChild(new TerrainSystem(this.level.terrain));

    // 3. Water (depends on terrain for coastlines)
    this.waterSystem = this.addChild(new WaterSystem({
      waveSources: this.level.waveSources,
      tideConfig: this.level.tide || { range: 0, frequency: 0 },
      modifierBufferSize: 16384,
    }, this.terrainSystem.getCoastlines()));

    // 4. Wind
    this.windSystem = this.addChild(new WindSystem({
      baseWind: new V2d(
        this.level.baseWind.speed * Math.cos(this.level.baseWind.direction),
        this.level.baseWind.speed * Math.sin(this.level.baseWind.direction)
      ),
      noiseConfig: {
        noiseScale: 0.01,
        timeScale: 0.1,
        variation: 0.2,
      },
    }));
  }

  @on("tick")
  onTick(dt: number) {
    // Collect water modifiers from tagged entities
    const modifierEntities = this.game.entities.getTagged("waterModifier") as (Entity & WaterModifier)[];
    this.waterSystem.updateModifiers(modifierEntities);
  }

  getBaseWind(): V2d {
    return this.windSystem.getBaseWind();
  }
}
```

**LevelDefinition Schema:**
```typescript
export interface LevelDefinition {
  terrain: TerrainDefinition;
  waveSources: WaveSourceConfig[];
  baseWind: {
    direction: number; // radians
    speed: number;     // ft/s
  };
  tide?: {
    range: number;     // ft
    frequency: number; // cycles per second
  };
}
```

**Example Level:**
```json
{
  "terrain": {
    "defaultDepth": -50,
    "contours": [
      {
        "height": 0,
        "controlPoints": [
          [0, 0], [100, 0], [100, 100], [0, 100]
        ]
      },
      {
        "height": 10,
        "controlPoints": [
          [40, 40], [60, 40], [60, 60], [40, 60]
        ]
      }
    ]
  },
  "waveSources": [
    {
      "direction": 0,
      "baseAmplitude": 2,
      "wavelength": 50
    }
  ],
  "baseWind": {
    "direction": 0.785,
    "speed": 15
  },
  "tide": {
    "range": 3,
    "frequency": 0.0001
  }
}
```

### Polish Tasks

**Error Handling:**
- [ ] Validate LevelDefinition on load
- [ ] Handle GPU device loss gracefully
- [ ] Provide helpful error messages for invalid terrain data
- [ ] Detect and warn about buffer overflow

**Performance:**
- [ ] Profile all GPU passes with timestamps
- [ ] Optimize tile computation batching
- [ ] Consider spatial hashing for modifier culling
- [ ] Monitor texture memory usage

**Debug Visualization:**
- [ ] Terrain contour rendering
- [ ] VirtualTexture tile boundaries
- [ ] Query point visualization
- [ ] Shadow intensity overlay
- [ ] Modifier bounds visualization
- [ ] Performance stats overlay

**Documentation:**
- [ ] Update world-system-api.md with final API
- [ ] Add JSDoc comments to all public classes
- [ ] Create example usage in CLAUDE.md
- [ ] Write migration guide for existing water/wind code

**Testing:**
- [ ] End-to-end integration test
- [ ] Performance benchmarks
- [ ] Memory leak tests (long-running sessions)
- [ ] Test with multiple levels

### Files to Create
```
src/game/world/
  └── WorldManager.ts            (~300 lines)

resources/levels/
  ├── test-simple.json           (simple test level)
  ├── test-complex.json          (complex multi-island level)
  └── level-schema.json          (JSON schema for validation)

tests/world/
  └── integration.test.ts        (end-to-end test)

docs/
  └── world-system-migration.md (migration guide)
```

**Estimated effort**: 3-4 days

---

## Total Timeline

- Phase 1: 2-3 days
- Phase 2: 3-4 days
- Phase 3: 2-3 days
- Phase 4: 5-7 days
- Phase 5: 4-5 days
- Phase 6: 3-4 days

**Total: 19-26 days** (roughly 4-5 weeks of focused work)

---

## Milestones & Demos

After each phase, we should have a working demo:

1. **Phase 1 Demo**: Visualize VirtualTexture tiles loading, show query point→result roundtrip
2. **Phase 2 Demo**: Render terrain heights as colors, query terrain interactively
3. **Phase 3 Demo**: Render wind vectors as arrows, show variation over space/time
4. **Phase 4 Demo**: Show water height varying with depth, shadows behind islands, wake modifiers
5. **Phase 5 Demo**: Full visual rendering with terrain, water, and wetness
6. **Phase 6 Demo**: Complete game integration with WorldManager + SurfaceRenderer

---

## Dependencies & Prerequisites

**Before Phase 1:**
- Ensure ComputeShader base class exists and works
- Verify GPU timestamp queries work (for profiling)
- Set up test harness for GPU compute tests

**Before Phase 2:**
- Need Catmull-Rom spline utilities (may already exist)
- Point-in-polygon test utilities

**Before Phase 4:**
- Simplex noise WGSL implementation (for wind, reusable)
- Geometry utilities for shadow polygon construction

**Before Phase 5:**
- Camera API for getVisibleWorldRect()
- Full-screen quad rendering utilities

---

## Risk Mitigation

**GPU Compute Complexity:**
- Start simple, add complexity incrementally
- Test each shader thoroughly before integrating
- Keep CPU fallback option for debugging (shadow geometry, etc.)

**Performance:**
- Profile early and often
- Have fallback strategies (reduce tile resolution, fewer modifiers, etc.)
- Test on lower-end hardware

**Scope Creep:**
- Mark features as "future enhancements" and skip for initial implementation
- Focus on core functionality first (e.g., skip diffraction, skip wind shadows)
- Can add polish in Phase 6 or post-launch

**Memory:**
- Monitor texture memory usage
- Have configurable quality settings (tile count, resolution, etc.)
- Test long-running sessions for leaks

---

## Next Steps

1. **Review this plan** - Does the phase breakdown make sense? Any concerns?
2. **Set up project structure** - Create directories, stub files
3. **Begin Phase 1** - Start with VirtualTexture implementation
4. **Iterate** - After each phase, review and adjust remaining phases as needed
