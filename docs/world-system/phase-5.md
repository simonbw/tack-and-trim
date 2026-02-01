# Phase 5: Surface Rendering

**Status**: 🔄 In Progress (20% Complete)
**Start Date**: 2026-01-31
**Completion Date**: TBD
**Estimated Duration**: 4-5 days
**Depends On**: Phase 1-4 (All previous phases)

---

## Progress Summary

### Completed (2026-01-31): TerrainRenderPass
- ✅ Replaced mock sin/cos test pattern with real VirtualTexture sampling
- ✅ Implemented indirection table GPU buffer (maps tile coords → texture array indices)
- ✅ Added `getTileTextureIndex()` and `sampleTerrainHeight()` shader functions
- ✅ Expanded RenderParams from 8 to 12 floats (added tilesMinX, tilesMinY, tilesPerRow, defaultDepth)
- ✅ Dynamic indirection buffer resizing as needed
- ✅ Graceful fallback to defaultDepth when tiles not loaded
- ✅ Fixed TileParams buffer alignment (32→48 bytes for vec3u alignment)
- ✅ TerrainSystem.getTileFromCache() and getDefaultDepth() methods
- ✅ SurfaceRenderer automatic tile requesting before terrain pass

**Key Achievement**: Terrain now renders real contour-based heights instead of test gradients!

### In Progress
- [ ] WaterRenderPass (dense water surface evaluation)
- [ ] WetnessPass (ping-pong wetness simulation)
- [ ] CompositePass (final fragment shader with lighting)

---

## Goal

Implement the visual rendering pipeline with four GPU passes that composite terrain, water, and wetness to the screen.

---

## Components Checklist

- [x] `TerrainRenderPass.ts` - Sample terrain VT to texture ✅ **COMPLETE** (2026-01-31)
- [ ] `WaterRenderPass.ts` - Evaluate water simulation densely
- [ ] `WetnessPass.ts` - Ping-pong wetness update
- [ ] `CompositePass.ts` - Final fragment shader
- [x] `SurfaceRenderer.ts` - Orchestrator entity (partial - tile requests working) ⚠️ **PARTIAL**

---

## Implementation Tasks

### SurfaceRenderer
- [ ] Create entity extending BaseEntity
- [ ] Set `id = "surfaceRenderer"` and `renderLayer = "water"`
- [ ] Create all render pass instances
- [ ] Allocate render textures (terrain, water, wetness A/B)
- [ ] Implement render rect calculation from camera
- [ ] Implement texture reallocation on resize
- [ ] Implement `onRender()` - four-pass pipeline
- [ ] Implement `getRenderRect()` - for debugging

**Render Rect Calculation**:
```typescript
computeRenderRect(camera: Camera): Rect {
  const visible = camera.getVisibleWorldRect();
  const worldUnitsPerPixel = visible.width / this.screenWidth;
  const margin = 2 * worldUnitsPerPixel; // 2 texels

  return {
    x: visible.x - margin,
    y: visible.y - margin,
    width: visible.width + 2 * margin,
    height: visible.height + 2 * margin,
  };
}
```

**Texture Allocation**:
```typescript
private terrainTexture!: GPUTexture;   // rg16float
private waterTexture!: GPUTexture;     // rgba16float
private wetnessTextureA!: GPUTexture;  // r8unorm
private wetnessTextureB!: GPUTexture;  // r8unorm
private currentWetnessIndex = 0;

allocateTextures(width: number, height: number) {
  this.terrainTexture = device.createTexture({
    size: [width, height],
    format: 'rg16float',
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
  });

  this.waterTexture = device.createTexture({
    size: [width, height],
    format: 'rgba16float',
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
  });

  // Wetness ping-pong
  for (const tex of [this.wetnessTextureA, this.wetnessTextureB]) {
    tex = device.createTexture({
      size: [width, height],
      format: 'r8unorm',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
  }
}
```

**Render Pipeline**:
```typescript
@on("render")
onRender({ dt }: GameEventMap["render"]) {
  const renderRect = this.computeRenderRect();
  const encoder = device.createCommandEncoder();

  // Pass 1: Terrain
  this.terrainPass.render(encoder, renderRect, this.terrainTexture);

  // Pass 2: Water
  this.waterPass.render(encoder, renderRect, this.terrainTexture, this.waterTexture);

  // Pass 3: Wetness (ping-pong)
  const prevWetness = this.currentWetnessIndex === 0 ? this.wetnessTextureA : this.wetnessTextureB;
  const currWetness = this.currentWetnessIndex === 0 ? this.wetnessTextureB : this.wetnessTextureA;

  this.wetnessPass.render(encoder, renderRect, this.prevRenderRect, this.terrainTexture,
    this.waterTexture, prevWetness, currWetness, dt);

  this.currentWetnessIndex = 1 - this.currentWetnessIndex;
  this.prevRenderRect = renderRect;

  // Pass 4: Composite
  this.compositePass.render(encoder, this.terrainTexture, this.waterTexture, currWetness, renderRect);

  device.queue.submit([encoder.finish()]);
}
```

### TerrainRenderPass ✅ **COMPLETE**
- [x] Extend ComputeShader base class
- [x] Bind terrain VirtualTexture array
- [x] Bind sampler for VT sampling
- [x] Bind indirection table storage buffer
- [x] Implement render rect → world position calculation
- [x] Implement LOD 0 tile sampling (fixed LOD for now)
- [x] Sample terrain VT via indirection table mapping
- [x] Fallback to defaultDepth when tiles not loaded
- [x] Output rgba16float (height, material, unused, unused)

**Implementation Notes**:
- Used indirection table approach instead of direct tile addressing
- Material ID currently stubbed to 0.0 (Phase 6+ feature)
- Fixed uniform buffer alignment issues (48-byte TileParams)
- Dynamic indirection buffer resizing for varying render rect sizes

**Shader**:
```wgsl
@group(0) @binding(0) var terrainVT: texture_2d_array<f32>;
@group(0) @binding(1) var terrainSampler: sampler;
@group(0) @binding(2) var<storage, write, rg16float> output: texture_storage_2d<rg16float>;
@group(0) @binding(3) var<uniform> renderRect: vec4f; // x, y, width, height

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let texelPos = vec2f(f32(id.x), f32(id.y));
  let worldPos = texelToWorld(texelPos, renderRect);

  // Sample terrain VT
  let lod = 0u; // Computed from renderRect
  let height = sampleTerrainVT(worldPos, lod);
  let material = 0.0; // TODO: from height or contour data

  textureStore(output, id.xy, vec4f(height, material, 0.0, 0.0));
}
```

### WaterRenderPass
- [ ] Extend ComputeShader base class
- [ ] Bind terrain texture (from pass 1)
- [ ] Bind wave sources buffer
- [ ] Bind shadow VT arrays
- [ ] Bind water modifier buffer
- [ ] Implement same water math as WaterQuery compute
- [ ] Optionally compute normals (finite differences)
- [ ] Output rgba16float (height, normal.xy, foam)

**Shader** (similar to water query compute):
```wgsl
@group(0) @binding(0) var terrainTexture: texture_2d<f32>;
@group(0) @binding(1) var<storage, read> waveSources: array<WaveSource>;
@group(0) @binding(2) var shadowTextures: texture_2d_array<f32>;
@group(0) @binding(3) var<storage, read> modifiers: array<WaterModifier>;
@group(0) @binding(4) var<storage, write, rgba16float> output: texture_storage_2d<rgba16float>;
@group(0) @binding(5) var<uniform> renderRect: vec4f;
@group(0) @binding(6) var<uniform> time: f32;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let worldPos = texelToWorld(id.xy, renderRect);
  let terrainHeight = textureLoad(terrainTexture, id.xy, 0).r;
  let depth = 0.0 - terrainHeight;

  // Same Gerstner wave evaluation as query compute
  var waterHeight = 0.0;
  // ... wave math

  // Compute normal from finite differences (optional)
  let dx = sampleWaterHeight(worldPos + vec2f(1.0, 0.0)) - sampleWaterHeight(worldPos - vec2f(1.0, 0.0));
  let dy = sampleWaterHeight(worldPos + vec2f(0.0, 1.0)) - sampleWaterHeight(worldPos - vec2f(0.0, 1.0));
  let normal = normalize(vec3f(-dx, -dy, 2.0));

  let foam = 0.0; // TODO: from wave steepness or modifier intensity

  textureStore(output, id.xy, vec4f(waterHeight, normal.x, normal.y, foam));
}
```

### WetnessPass
- [ ] Extend ComputeShader base class
- [ ] Bind terrain texture (from pass 1)
- [ ] Bind water texture (from pass 2)
- [ ] Bind previous wetness texture (read)
- [ ] Bind current wetness texture (write)
- [ ] Implement reprojection (world pos → prev UV)
- [ ] Implement wetness logic (underwater = 1, decay otherwise)
- [ ] Output r8unorm

**Shader**:
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

  let terrainHeight = textureLoad(terrainTexture, id.xy, 0).r;
  let waterHeight = textureLoad(waterTexture, id.xy, 0).r;

  var wetness = prevWetness;

  if (terrainHeight < waterHeight) {
    wetness = 1.0; // Underwater
  } else {
    // Decay
    let decayRate = 0.5; // 50% per second
    wetness = max(0.0, wetness - decayRate * dt);
  }

  textureStore(output, id.xy, vec4f(wetness, 0.0, 0.0, 0.0));
}
```

### CompositePass
- [ ] Create render pipeline (not compute)
- [ ] Create full-screen quad vertex buffer
- [ ] Create fragment shader
- [ ] Bind terrain, water, wetness textures
- [ ] Implement terrain color from height
- [ ] Apply wetness darkening
- [ ] Blend water over terrain
- [ ] Apply lighting (ambient + diffuse)
- [ ] Output to screen

**Fragment Shader**:
```wgsl
@group(0) @binding(0) var terrainTexture: texture_2d<f32>;
@group(0) @binding(1) var waterTexture: texture_2d<f32>;
@group(0) @binding(2) var wetnessTexture: texture_2d<f32>;
@group(0) @binding(3) var texSampler: sampler;

@fragment
fn main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let terrain = textureSample(terrainTexture, texSampler, uv);
  let water = textureSample(waterTexture, texSampler, uv);
  let wetness = textureSample(wetnessTexture, texSampler, uv).r;

  let terrainHeight = terrain.r;
  let waterHeight = water.r;
  let waterNormal = vec3f(water.g, water.b, sqrt(1.0 - water.g * water.g - water.b * water.b));

  // Base terrain color
  var baseColor = vec3f(0.8, 0.7, 0.5); // Sand
  if (terrainHeight > 2.0) {
    baseColor = vec3f(0.2, 0.6, 0.2); // Grass
  }
  if (terrainHeight > 10.0) {
    baseColor = vec3f(0.5, 0.5, 0.5); // Rock
  }

  // Wetness darkening
  baseColor *= (1.0 - wetness * 0.4);

  // Water color
  let depth = waterHeight - terrainHeight;
  var waterColor = vec3f(0.0, 0.3, 0.6); // Deep blue
  if (depth < 5.0 && depth > 0.0) {
    waterColor = mix(vec3f(0.3, 0.7, 0.8), waterColor, depth / 5.0); // Shallow cyan
  }

  // Blend water over terrain
  let waterAlpha = clamp(depth / 10.0, 0.0, 0.8);
  var finalColor = mix(baseColor, waterColor, waterAlpha);

  // Simple lighting
  let sunDir = normalize(vec3f(1.0, 1.0, 0.5));
  let ambient = 0.4;
  let diffuse = max(0.0, dot(waterNormal, sunDir)) * 0.6;
  let lighting = ambient + diffuse * waterAlpha; // Only apply diffuse to water

  return vec4f(finalColor * lighting, 1.0);
}
```

---

## Testing Checklist

### Visual Tests (Primary)
- [ ] Render test level with terrain
- [ ] Verify terrain coloring (sand, grass, rock)
- [ ] Verify water renders over terrain
- [ ] Verify water color varies with depth
- [ ] Verify wetness appears when waves hit shore
- [ ] Verify wetness decays over time
- [ ] Test camera movement (reprojection works)
- [ ] Test zoom (resolution changes, no artifacts)

### Performance Tests
- [ ] Profile each pass with GPU timestamps
- [ ] Target 60fps at 1920×1080
- [ ] Monitor texture memory usage
- [ ] Check for GPU validation errors

### Edge Cases
- [ ] Test screen resize (textures reallocate)
- [ ] Test rapid camera movement (wetness reprojection)
- [ ] Test with no water (terrain only)
- [ ] Test deep water (no terrain visible)

---

## Debug Visualization

- [ ] Toggle to show individual render passes
- [ ] Display render rect boundary
- [ ] Show texture resolution info
- [ ] GPU timing overlay for each pass
- [ ] Wetness reprojection debug (show UV coords)

---

## Files Created

```
src/game/world/rendering/
  ├── SurfaceRenderer.ts         [ ] ~400 lines
  ├── TerrainRenderPass.ts       [ ] ~150 lines
  ├── WaterRenderPass.ts         [ ] ~250 lines
  ├── WetnessPass.ts             [ ] ~200 lines
  └── CompositePass.ts           [ ] ~150 lines

shaders/
  ├── terrain-pass.wgsl          [ ] ~100 lines
  ├── water-pass.wgsl            [ ] ~250 lines
  ├── wetness-pass.wgsl          [ ] ~150 lines
  └── composite-pass.wgsl        [ ] ~150 lines
```

**Total Lines**: ~1800 + shaders

---

## Demo Milestone

Full visual rendering:
- [ ] Island with terrain coloring
- [ ] Water with waves approaching shore
- [ ] Wetness appearing when waves hit
- [ ] Wetness fading on exposed terrain
- [ ] Smooth camera movement
- [ ] Zoom works (tiles stream in)
- [ ] 60fps performance

---

## Blockers & Dependencies

### Prerequisites
- [x] Phase 1-4 complete (all systems)
- [ ] Camera.getVisibleWorldRect() API
- [ ] Full-screen quad rendering utilities

### Blockers
- None (depends on all previous phases)

---

## Notes & Decisions

### Key Technical Decisions
- **Texture formats**: rg16float (terrain), rgba16float (water), r8unorm (wetness)
- **Resolution**: ~1 texel per screen pixel
- **Render margin**: 2 texels (for normal calculations, edge effects)
- **Wetness ping-pong**: Prevents read-write hazards
- **Reprojection**: World-space (not screen-space) for camera independence

### Future Enhancements
- Specular highlights on water
- Foam rendering at wave crests
- Caustics on sea floor
- Subsurface scattering in shallow water
- Sky reflection on water surface
- Particle spray at wave impacts

### Simplifications
- Basic lighting (ambient + diffuse only)
- Simple terrain colors (no textures)
- No foam rendering yet
- Wetness decay is uniform (no material variation)

---

## Actual Implementation Notes

### TerrainRenderPass Implementation (2026-01-31)

The implemented approach differs from the original plan with an improved architecture:

**Original Plan**: Direct VirtualTexture LOD sampling
**As Implemented**: Indirection table mapping with dynamic cache support

#### Key Implementation Details

1. **Indirection Table Buffer** (`i32` storage buffer)
   - Maps (tileX, tileY) coordinates to GPU texture array indices
   - Built per-frame based on render rect bounds
   - Dynamically resized as needed (starts at 256 entries, doubles on overflow)
   - Entries set to -1 when tiles not loaded (for fallback detection)

2. **Shader Functions**
   ```wgsl
   fn getTileTextureIndex(tileX: i32, tileY: i32) -> i32
   fn sampleTerrainHeight(worldX: f32, worldY: f32) -> f32
   ```

3. **RenderParams Struct** (12 floats, 48 bytes)
   - Original 7 params + 5 new params for indirection table:
     - `tilesMinX`, `tilesMinY` - Bounds of visible tile region
     - `tilesPerRow` - Width of indirection table
     - `defaultDepth` - Fallback when tile not loaded

4. **TerrainSystem API Extensions**
   - `getTileFromCache(lod, tileX, tileY): CachedTile | null`
   - `getDefaultDepth(): number`

5. **Buffer Alignment Fix**
   - TileParams buffer: 32 → 48 bytes (vec3u requires 16-byte alignment)
   - Prevents WebGPU validation errors

#### Advantages Over Original Plan

- ✅ Handles dynamic LRU cache eviction gracefully
- ✅ Works with non-sequential texture array indices
- ✅ Explicit fallback handling (no undefined behavior)
- ✅ Scales to varying render rect sizes
- ✅ Clean separation between cache management and rendering

## Completion Criteria

Phase 5 is complete when:
- [x] TerrainRenderPass implemented and working ✅
- [ ] WaterRenderPass implemented
- [ ] WetnessPass implemented
- [ ] CompositePass implemented
- [ ] Demo shows full visual rendering
- [ ] 60fps at 1080p
- [ ] All textures properly allocated/deallocated
- [ ] No GPU errors or warnings
- [ ] Performance profiled (each pass < 2ms)
- [ ] Wetness reprojection works smoothly
- [ ] Ready to start Phase 6
