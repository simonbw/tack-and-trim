# Phase 3: Wind System

**Status**: Not Started
**Start Date**: TBD
**Completion Date**: TBD
**Estimated Duration**: 2-3 days
**Depends On**: Phase 1 (Core Infrastructure), Phase 2 (Terrain System - optional)

---

## Goal

Implement wind queries with noise-based variation. This validates GPU compute without complex dependencies and provides a second data type for the query system.

---

## Components Checklist

- [ ] `WindNoise.ts` - Compute shader for wind variation
- [ ] `WindSystem.ts` - Main wind entity
- [ ] `WindQuery.ts` - Query entity for wind lookups
- [ ] `simplex-noise.wgsl` - WGSL noise implementation (if needed)

---

## Implementation Tasks

### Simplex Noise (WGSL)
- [ ] Research existing WGSL noise implementations
- [ ] Implement or copy simplex noise 2D function
- [ ] Test noise output (verify not NaN, reasonable range)
- [ ] Create helper for scrolling noise (time-based offset)

**Implementation Options**:
1. Copy from existing library (webgpu-noise, shadertoy, etc.)
2. Implement from scratch following simplex noise spec
3. Use value noise or Perlin noise if simplex is complex

**Noise Function**:
```wgsl
// Returns value in [-1, 1]
fn simplexNoise2D(p: vec2f) -> f32 {
  // ... implementation
}
```

### WindNoise
- [ ] Extend ComputeShader base class
- [ ] Create noise parameters uniform (scale, timeScale, variation)
- [ ] Implement compute shader that applies noise to base wind
- [ ] Calculate independent noise for X and Y components
- [ ] Apply variation as percentage of base wind

**Shader Structure**:
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

  // Scrolling noise
  let noisePos = point * noiseParams.x + vec2f(0.0, time * noiseParams.y);

  // Independent noise for X and Y
  let nx = simplexNoise2D(noisePos);
  let ny = simplexNoise2D(noisePos + vec2f(100.0, 0.0)); // Offset for independence

  // Apply variation
  let variation = noiseParams.z;
  let windX = baseWind.x * (1.0 + nx * variation);
  let windY = baseWind.y * (1.0 + ny * variation);

  results[id.x] = WindResult(windX, windY);
}
```

### WindSystem
- [ ] Create entity extending BaseEntity
- [ ] Set `id = "windSystem"` and `tickLayer = "environment"`
- [ ] Store base wind vector (from level config)
- [ ] Store noise config (scale, timeScale, variation)
- [ ] Create WindNoise compute shader instance
- [ ] Register wind compute with QueryInfrastructure
- [ ] Implement `getBaseWind()` accessor
- [ ] Implement `onTick()` - trigger compute dispatch

**Config**:
```typescript
interface WindSystemConfig {
  baseWind: V2d;
  noiseConfig: {
    noiseScale: number;    // 0.01
    timeScale: number;     // 0.1
    variation: number;     // 0.2 (±20%)
  };
}
```

**Compute Dispatch**:
```typescript
@on("tick")
onTick(dt: number) {
  // QueryInfrastructure will call our compute after terrain
  // Just update time uniform
  this.time += dt;
}
```

### WindQuery
- [ ] Extend BaseQuery
- [ ] Define result type: `{ vx: number; vy: number }`
- [ ] Implement typed `getResultForPoint()` override
- [ ] Implement typed iterator
- [ ] Auto-register with QueryInfrastructure on add
- [ ] Auto-unregister on destroy

**API**:
```typescript
class WindQuery extends BaseQuery {
  readonly results: readonly WindQueryResult[];

  getResultForPoint(point: V2d): WindQueryResult | undefined;
  [Symbol.iterator](): Iterator<[V2d, WindQueryResult]>;
}

interface WindQueryResult {
  vx: number; // ft/s
  vy: number; // ft/s
}
```

---

## Testing Checklist

### Unit Tests
- [ ] Noise function returns values in expected range
- [ ] Noise is continuous (nearby points have similar values)
- [ ] Base wind is correctly applied
- [ ] Variation percentage works (±20% produces 0.8x to 1.2x)
- [ ] Independent noise for X and Y (not correlated)

### Integration Tests
- [ ] Create WindQuery with sample points
- [ ] Verify results vary spatially (different positions = different wind)
- [ ] Verify results vary temporally (time advances = wind changes)
- [ ] Test with zero base wind (noise still applied)
- [ ] Test with zero variation (returns base wind exactly)

### Visual Tests
- [ ] Render wind vectors as arrows on grid
- [ ] Color-code by magnitude
- [ ] Animate to show temporal variation
- [ ] Verify smooth spatial variation (no discontinuities)
- [ ] Compare to WindParticles (if they exist)

---

## Debug Visualization

- [ ] Create WindVectorGrid entity (debug visualization)
- [ ] Sample wind on regular grid (e.g., every 50 ft)
- [ ] Render arrows showing direction and magnitude
- [ ] Color arrows by speed (blue=slow, red=fast)
- [ ] Add toggle to show/hide wind visualization

---

## Files Created

```
src/game/world/wind/
  ├── WindSystem.ts              [ ] ~250 lines
  ├── WindNoise.ts               [ ] ~150 lines
  └── simplex-noise.wgsl         [ ] ~100 lines (if implementing)

src/game/world/query/
  └── WindQuery.ts               [ ] ~100 lines

tests/world/wind/
  └── WindSystem.test.ts         [ ]

src/game/debug/
  └── WindVectorGrid.ts          [ ] ~150 lines (optional)
```

**Total Lines**: ~600 + tests

---

## Demo Milestone

Create a test scene that:
- [ ] Initializes WindSystem with base wind (e.g., 15 ft/s from NE)
- [ ] Creates WindQuery following mouse position
- [ ] Displays wind vector at mouse (arrow or text)
- [ ] Shows grid of wind vectors across screen
- [ ] Animates wind variation over time
- [ ] Displays base wind for comparison

---

## Blockers & Dependencies

### Prerequisites
- [x] Phase 1 complete (QueryInfrastructure)
- [ ] Simplex noise WGSL implementation sourced

### Optional Dependencies
- Phase 2 (Terrain) - not strictly required, but wind can eventually use terrain for blocking

### Blockers
- Finding/implementing WGSL noise function

---

## Notes & Decisions

### Key Technical Decisions
- **Noise type**: Simplex noise (smooth, continuous, efficient)
- **Variation range**: ±20% of base wind (configurable)
- **Spatial scale**: 0.01 (100 ft between major variations)
- **Time scale**: 0.1 (10 seconds for pattern to scroll by)
- **No terrain influence**: Keep simple for now (future enhancement)

### Future Enhancements
- Wind shadows (blocked by terrain)
- Wind deflection around islands
- Gusts (temporal variation beyond smooth noise)
- Altitude-based wind (stronger higher up)
- Local wind modifiers (sails, windmills)

### Simplifications
- Uniform wind at all altitudes
- No terrain blocking
- No turbulence or vortices
- Simple noise-based variation

---

## Integration with QueryInfrastructure

Wind compute runs after terrain compute in the dispatch sequence:

```typescript
// In QueryInfrastructure
dispatchComputes(encoder: GPUCommandEncoder) {
  // 1. Terrain (no dependencies)
  this.terrainCompute.dispatch(encoder, ...);

  // 2. Wind (could depend on terrain for blocking, but doesn't yet)
  this.windCompute.dispatch(encoder, ...);

  // 3. Water (depends on terrain for depth)
  this.waterCompute.dispatch(encoder, ...);
}
```

---

## Completion Criteria

Phase 3 is complete when:
- [ ] All components implemented and pass tests
- [ ] Demo scene shows wind vectors
- [ ] Wind varies smoothly in space and time
- [ ] WindQuery returns correct values
- [ ] No GPU errors or validation warnings
- [ ] Performance profiled (wind compute < 0.5ms)
- [ ] Ready to start Phase 4
