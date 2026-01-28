# Phase 4: Water System

**Status**: Not Started
**Start Date**: TBD
**Completion Date**: TBD
**Estimated Duration**: 5-7 days
**Depends On**: Phase 1 (Core Infrastructure), Phase 2 (Terrain System)

---

## Goal

Implement the full water simulation with Gerstner waves, shadow-based diffraction, depth effects, modifiers, and tide. This is the most complex subsystem.

---

## Components Checklist

- [ ] `WaveSource.ts` - Wave configuration and math
- [ ] `WaveShadow.ts` - Shadow geometry and VirtualTexture
- [ ] `ShadowTileCompute.ts` - Shadow rasterization shader
- [ ] `WaterModifier.ts` - Interface for disturbances
- [ ] `WaterModifierBuffer.ts` - GPU buffer management
- [ ] `WaterSystem.ts` - Main water entity
- [ ] `WaterQuery.ts` - Query entity for water data

---

## Implementation Tasks

### WaveSource
- [ ] Create WaveSource class with configuration
- [ ] Calculate wave number k = 2π/wavelength
- [ ] Calculate angular frequency ω = sqrt(g*k) (deep water)
- [ ] Implement `computeDisplacement()` - Gerstner horizontal offset
- [ ] Implement `evaluate()` - height and vertical velocity
- [ ] Implement `getGPUData()` - pack for shader upload
- [ ] Support runtime amplitude modulation

**Gerstner Math**:
```typescript
class WaveSource {
  readonly direction: number;      // radians
  readonly baseAmplitude: number;  // ft
  readonly wavelength: number;     // ft
  readonly k: number;              // 2π/wavelength
  readonly omega: number;          // sqrt(g*k)

  amplitude: number; // Runtime modulation

  computeDisplacement(pos: V2d, time: number): V2d {
    const phase = this.k * pos.dot(this.directionVec) - this.omega * time;
    const cosPhi = Math.cos(phase);
    return this.directionVec.scale(this.amplitude * cosPhi / this.k);
  }

  evaluate(pos: V2d, time: number): { z: number; vz: number } {
    const phase = this.k * pos.dot(this.directionVec) - this.omega * time;
    const sinPhi = Math.sin(phase);
    const cosPhi = Math.cos(phase);
    return {
      z: this.amplitude * sinPhi,
      vz: -this.amplitude * this.omega * cosPhi,
    };
  }
}
```

### WaveShadow
- [ ] Create entity extending BaseEntity (child of WaterSystem)
- [ ] Compute shadow geometry from coastlines + wave direction
- [ ] Create VirtualTexture&lt;ShadowData&gt; instance
- [ ] Create ShadowTileCompute instance
- [ ] Upload shadow polygons to GPU buffer
- [ ] Implement `getShadowTexture()` - expose GPU texture
- [ ] Implement `requestTilesForRect()` - delegate to VirtualTexture
- [ ] Implement `rebuildGeometry()` - recompute when terrain changes
- [ ] Implement `onTick()` - call virtualTexture.update()

**Shadow Geometry Algorithm**:
```typescript
function computeShadowGeometry(
  coastlines: TerrainContour[],
  waveDirection: number
): ShadowPolygon[] {
  const polygons: ShadowPolygon[] = [];

  for (const coastline of coastlines) {
    // 1. Find silhouette points
    const silhouettes = findSilhouettePoints(coastline, waveDirection);

    // 2. Identify left/right extremal silhouettes
    const { left, right } = findExtremalSilhouettes(silhouettes, waveDirection);

    // 3. Sample leeward coastline arc
    const leewardArc = sampleLeewardArc(coastline, left, right);

    // 4. Build shadow polygon
    const vertices = [
      ...extendFromSilhouette(left, waveDirection, 1000), // Extend far
      ...leewardArc,
      ...extendFromSilhouette(right, waveDirection, 1000),
    ];

    polygons.push({ vertices });
  }

  return polygons;
}
```

### ShadowTileCompute
- [ ] Extend TileCompute abstract base
- [ ] Implement WGSL point-in-polygon test for shadow polygons
- [ ] Implement distance-to-edge calculation
- [ ] Output rg8unorm (intensity, distance)
- [ ] Bind shadow polygon vertex buffer

**Shader Structure**:
```wgsl
struct ShadowPolygon {
  vertexStart: u32,
  vertexCount: u32,
}

@group(0) @binding(0) var<storage, read> polygons: array<ShadowPolygon>;
@group(0) @binding(1) var<storage, read> vertices: array<vec2f>;
@group(0) @binding(2) var<storage, write, rg8unorm> output: texture_storage_2d<rg8unorm>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let worldPos = tileToWorld(id.xy);

  var intensity = 0.0;
  var distToEdge = 999999.0;

  for (var i = 0u; i < arrayLength(&polygons); i++) {
    if (pointInPolygon(worldPos, polygons[i])) {
      intensity = 1.0;
      distToEdge = min(distToEdge, distanceToEdge(worldPos, polygons[i]));
    }
  }

  textureStore(output, id.xy, vec4f(intensity, distToEdge / 100.0, 0.0, 0.0));
}
```

### WaterModifier (Interface)
- [ ] Define WaterModifier interface
- [ ] Define WaterModifierData union type
- [ ] Document segment, point, ring types
- [ ] Provide usage examples

**Interface**:
```typescript
interface WaterModifier {
  getBounds(): AABB;
  getModifierData(): WaterModifierData;
}

type WaterModifierData =
  | { type: "segment"; p1: V2d; p2: V2d; amplitude: number; falloff: number }
  | { type: "point"; center: V2d; radius: number; amplitude: number }
  | { type: "ring"; center: V2d; radius: number; width: number; amplitude: number };

interface AABB {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
```

### WaterModifierBuffer
- [ ] Create class with GPU buffer management
- [ ] Allocate persistent buffer (16384 modifiers × 32 bytes)
- [ ] Implement `update()` - collect and upload modifiers
- [ ] Pack modifiers into GPU buffer layout
- [ ] Track active count for shader uniform
- [ ] Implement `getBuffer()` - expose GPU buffer
- [ ] Implement `getActiveCount()` - for uniform

**GPU Buffer Layout**:
```typescript
// 32 bytes per modifier (8 × f32)
const MODIFIER_STRIDE = 32;
const MAX_MODIFIERS = 16384;

class WaterModifierBuffer {
  update(modifiers: WaterModifier[]) {
    const data = new Float32Array(modifiers.length * 8);

    for (let i = 0; i < modifiers.length; i++) {
      const mod = modifiers[i];
      const bounds = mod.getBounds();
      const modData = mod.getModifierData();

      const offset = i * 8;
      data[offset + 0] = modData.type === "segment" ? 1 : modData.type === "point" ? 2 : 3;
      data[offset + 1] = bounds.minX;
      data[offset + 2] = bounds.minY;
      data[offset + 3] = bounds.maxX;
      data[offset + 4] = bounds.maxY;
      // Pack type-specific params into param0-param2
      // ...
    }

    device.queue.writeBuffer(this.buffer, 0, data);
    this.activeCount = modifiers.length;
  }
}
```

### WaterSystem
- [ ] Create entity extending BaseEntity
- [ ] Set `id = "waterSystem"` and `tickLayer = "environment"`
- [ ] Create WaveSource instances from config
- [ ] Create WaveShadow child entities (one per wave source)
- [ ] Create WaterModifierBuffer instance
- [ ] Register water compute with QueryInfrastructure
- [ ] Implement `getWaveSources()` accessor
- [ ] Implement `getShadowTextures()` accessor
- [ ] Implement `getModifierBuffer()` accessor
- [ ] Implement `getTideHeight()` - simple sinusoidal
- [ ] Implement `updateModifiers()` - called by WorldManager
- [ ] Implement `onTick()` - update children

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
  k: f32,
  omega: f32,
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
@group(0) @binding(2) var<storage, read> terrainHeights: array<f32>;
@group(0) @binding(3) var<storage, read> waveSources: array<WaveSource>;
@group(0) @binding(4) var shadowTextures: texture_2d_array<f32>;
@group(0) @binding(5) var shadowSampler: sampler;
@group(0) @binding(6) var<storage, read> modifiers: array<WaterModifier>;
@group(0) @binding(7) var<uniform> time: f32;
@group(0) @binding(8) var<uniform> activeModifierCount: u32;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&queryPoints)) { return; }

  let point = queryPoints[id.x];
  let terrainHeight = terrainHeights[id.x];
  let depth = 0.0 - terrainHeight;

  var totalZ = 0.0;
  var totalVz = 0.0;

  // Pass 1: Gerstner displacement
  var displacement = vec2f(0.0);
  for (var i = 0u; i < arrayLength(&waveSources); i++) {
    displacement += gerstnerDisplacement(waveSources[i], point, time);
  }

  let displacedPos = point + displacement;

  // Pass 2: Wave evaluation at displaced position
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
    let effectiveAmplitude = wave.amplitude * (1.0 - shadowIntensity) * depthModifier;

    totalZ += waveResult.z * effectiveAmplitude / wave.amplitude;
    totalVz += waveResult.vz * effectiveAmplitude / wave.amplitude;
  }

  // Modifiers
  for (var i = 0u; i < activeModifierCount; i++) {
    let mod = modifiers[i];

    // Bounds culling
    if (point.x < mod.boundsMinX || point.x > mod.boundsMaxX ||
        point.y < mod.boundsMinY || point.y > mod.boundsMaxY) {
      continue;
    }

    totalZ += evaluateModifier(mod, point);
  }

  results[id.x] = WaterResult(totalZ, 0.0, 0.0, totalVz);
}

fn computeDepthModifier(depth: f32, k: f32) -> f32 {
  // Shoaling (Green's Law)
  let referenceDepth = 20.0;
  var shoaling = 1.0;
  if (depth > 0.0 && depth < referenceDepth) {
    shoaling = pow(referenceDepth / depth, 0.25);
  }

  // Damping
  let deepThreshold = 15.0;
  let shallowThreshold = 2.0;
  let minDamping = 0.1;
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

### WaterQuery
- [ ] Extend BaseQuery
- [ ] Define result type: `{ z, vx, vy, vz }`
- [ ] Implement typed `getResultForPoint()` override
- [ ] Implement typed iterator
- [ ] Auto-register terrain dependency (terrain heights needed)
- [ ] Auto-register with QueryInfrastructure on add
- [ ] Auto-unregister on destroy

---

## Testing Checklist

### Unit Tests
- [ ] WaveSource Gerstner math (compare with known values)
- [ ] Shadow geometry construction (simple coastline → expected polygon)
- [ ] Depth modifier calculations (shoaling and damping)
- [ ] Water modifier buffer packing/unpacking

### Integration Tests
- [ ] Create test level with coastline
- [ ] Verify shadows appear in lee of land
- [ ] Test water queries at various depths
- [ ] Test modifier collection from tagged entities
- [ ] Test tide calculation

### Visual Tests
- [ ] Render wave heights as color
- [ ] Visualize shadow intensity overlay
- [ ] Show modifier bounds and contributions
- [ ] Animate waves to verify motion
- [ ] Test with multiple wave sources

---

## Files Created

```
src/game/world/water/
  ├── WaveSource.ts              [ ] ~200 lines
  ├── WaveShadow.ts              [ ] ~300 lines
  ├── ShadowTileCompute.ts       [ ] ~150 lines
  ├── WaterModifier.ts           [ ] ~50 lines
  ├── WaterModifierBuffer.ts     [ ] ~150 lines
  └── WaterSystem.ts             [ ] ~400 lines

src/game/world/query/
  └── WaterQuery.ts              [ ] ~120 lines

shaders/
  ├── water-compute.wgsl         [ ] ~400 lines
  ├── shadow-rasterize.wgsl      [ ] ~200 lines
  └── wave-math.wgsl             [ ] ~150 lines

tests/world/water/
  ├── WaveSource.test.ts         [ ]
  ├── WaveShadow.test.ts         [ ]
  └── WaterSystem.test.ts        [ ]
```

**Total Lines**: ~2120 + tests

---

## Demo Milestone

Create a test scene that:
- [ ] Shows island with waves approaching
- [ ] Renders wave height as color (blue=trough, white=crest)
- [ ] Shows shadow regions behind island
- [ ] Creates interactive water query (follows mouse)
- [ ] Spawns water modifiers on click (ripples)
- [ ] Displays water height and velocity at mouse

---

## Blockers & Dependencies

### Prerequisites
- [x] Phase 1 complete (VirtualTexture, QueryInfrastructure)
- [x] Phase 2 complete (Terrain for coastlines and depths)

### Blockers
- Catmull-Rom spline utilities (needed for coastline processing)
- Point-in-polygon for arbitrary polygons (shadow geometry)

---

## Notes & Decisions

### Key Technical Decisions
- **Two-pass Gerstner**: Displacement then evaluation (creates trochoid)
- **Shadow format**: rg8unorm (intensity, distance) - 2 bytes per texel
- **Modifier limit**: 16384 (generous, ~512KB buffer)
- **Modifier stride**: 32 bytes (8 × f32)
- **Depth effects**: Shoaling + damping, no breaking waves yet

### Future Enhancements
- Wave diffraction (soft shadow edges)
- Wave breaking in shallow water
- Foam at wave crests
- Undertow and rip currents
- Dynamic wave source intensity

### Simplifications
- No wave-wave interaction
- No foam rendering
- Simple tide model (sinusoidal)
- No wave reflection from shores

---

## Completion Criteria

Phase 4 is complete when:
- [ ] All components implemented and pass tests
- [ ] Demo scene shows waves, shadows, modifiers
- [ ] WaterQuery returns correct values
- [ ] Shadows correctly block waves
- [ ] Depth effects visible (shoaling in shallow water)
- [ ] No GPU errors or validation warnings
- [ ] Performance profiled (water compute < 5ms)
- [ ] Ready to start Phase 5
