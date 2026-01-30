# Phase 2: Terrain System

**Status**: ✅ **COMPLETE**
**Start Date**: 2026-01-28
**Completion Date**: 2026-01-28
**Estimated Duration**: 3-4 days
**Actual Duration**: 1 day
**Depends On**: Phase 1 (Core Infrastructure)

---

## Goal

Implement terrain height queries end-to-end. This is the first complete vertical slice that validates the entire query pipeline with real game data.

---

## Components Checklist

- [x] `TerrainTypes.ts` - Data structures and type definitions
- [x] `ContainmentTree.ts` - Hierarchical contour representation
- [x] `TerrainTileCompute.ts` - VirtualTexture tile shader
- [x] `TerrainQueryCompute.ts` - Query compute shader
- [x] `TerrainSystem.ts` - Main terrain entity
- [x] `TerrainQuery.ts` - Query entity for height lookups (updated from stub)

---

## Implementation Tasks

### TerrainDefinition
- [ ] Define `TerrainDefinition` interface
- [ ] Define `TerrainContour` interface
- [ ] Implement `serializeTerrainDefinition()` - to JSON
- [ ] Implement `deserializeTerrainDefinition()` - from JSON
- [ ] Add validation (check for closed contours, valid heights, etc.)
- [ ] Create test terrain data (simple island)

**Data Structures**:
```typescript
interface TerrainDefinition {
  contours: TerrainContour[];
  defaultDepth: number; // -50 ft
}

interface TerrainContour {
  controlPoints: readonly V2d[];
  height: number;
  isClosed: boolean; // Always true for terrain
}
```

### ContainmentTree
- [ ] Implement tree construction from contours
- [ ] Implement point-in-polygon tests (for closed Catmull-Rom splines)
- [ ] Implement tree traversal to find deepest containing contour
- [ ] Implement height interpolation (inverse-distance weighting)
- [ ] Implement `getCoastlines()` - extract height=0 contours
- [ ] Add utility functions for spline evaluation
- [ ] Optimize tree search (bounding boxes, early-out)

**API**:
```typescript
class ContainmentTree {
  constructor(contours: TerrainContour[], defaultDepth: number);

  getHeightAt(point: V2d): number;
  findDeepestContaining(point: V2d): ContourNode | null;
  getCoastlines(): TerrainContour[];
}
```

**Algorithm**:
```
getHeightAt(point):
  1. Start from root contours
  2. Find which contours contain point
  3. Recursively descend to deepest containing contour
  4. Interpolate height using inverse-distance weighting
  5. Return interpolated height
```

### TerrainTileCompute
- [ ] Extend TileCompute abstract base
- [ ] Upload contour data to GPU buffer
- [ ] Upload control points to GPU buffer
- [ ] Implement WGSL shader for height computation
- [ ] Implement Catmull-Rom spline evaluation in WGSL
- [ ] Implement point-in-polygon test in WGSL
- [ ] Output r16float height values

**WGSL Buffers**:
```wgsl
struct Contour {
  controlPointStart: u32,
  controlPointCount: u32,
  height: f32,
  parentIndex: i32, // -1 for roots
}

@group(0) @binding(0) var<storage, read> contours: array<Contour>;
@group(0) @binding(1) var<storage, read> controlPoints: array<vec2f>;
@group(0) @binding(2) var<uniform> defaultDepth: f32;
@group(0) @binding(3) var<storage, write, r16float> output: texture_storage_2d<r16float>;
```

**Shader Algorithm**:
```wgsl
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  // 1. Compute world position from tile + texel
  let worldPos = tileToWorld(id.xy);

  // 2. Walk containment tree
  var deepestContour: i32 = -1;
  // ... tree walk logic

  // 3. Interpolate height
  var height = defaultDepth;
  if (deepestContour >= 0) {
    height = interpolateHeight(worldPos, deepestContour);
  }

  // 4. Write to tile
  textureStore(output, id.xy, vec4f(height, 0.0, 0.0, 0.0));
}
```

### TerrainSystem
- [ ] Create entity extending BaseEntity
- [ ] Set `id = "terrainSystem"` and `tickLayer = "environment"`
- [ ] Create VirtualTexture&lt;TerrainHeight&gt; instance
- [ ] Create ContainmentTree from definition
- [ ] Upload contour data to GPU buffers
- [ ] Create TerrainTileCompute instance
- [ ] Implement `requestTilesForRect()` - delegate to VirtualTexture
- [ ] Implement `getTerrainTexture()` - expose GPU texture
- [ ] Implement `getCoastlines()` - delegate to ContainmentTree
- [ ] Implement `setDefinition()` - rebuild tree and invalidate cache
- [ ] Implement `onTick()` - call virtualTexture.update()
- [ ] Register terrain compute with QueryInfrastructure

**Terrain Query Compute Shader**:
```wgsl
@group(0) @binding(0) var<storage, read> queryPoints: array<vec2f>;
@group(0) @binding(1) var<storage, read_write> results: array<f32>;
@group(0) @binding(2) var<storage, read> contours: array<Contour>;
@group(0) @binding(3) var<storage, read> controlPoints: array<vec2f>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&queryPoints)) { return; }

  let point = queryPoints[id.x];
  let height = computeHeightAt(point); // Same logic as tile compute
  results[id.x] = height;
}
```

### TerrainQuery
- [ ] Extend BaseQuery
- [ ] Define result type: `{ height: number }`
- [ ] Implement typed `getResultForPoint()` override
- [ ] Implement typed iterator
- [ ] Auto-register with QueryInfrastructure on add
- [ ] Auto-unregister on destroy

**API**:
```typescript
class TerrainQuery extends BaseQuery {
  readonly results: readonly TerrainQueryResult[];

  getResultForPoint(point: V2d): TerrainQueryResult | undefined;
  [Symbol.iterator](): Iterator<[V2d, TerrainQueryResult]>;
}

interface TerrainQueryResult {
  height: number;
}
```

---

## Testing Checklist

### Unit Tests
- [ ] ContainmentTree with simple contours (square, circle)
- [ ] Point-in-polygon tests with known positions
- [ ] Height interpolation with test data
- [ ] Coastline extraction (height=0 contours)
- [ ] Tree construction with nested contours

### Integration Tests
- [ ] Create test terrain (circular island, height=0)
- [ ] Add peak at center (height=10)
- [ ] Query heights at known positions
- [ ] Verify results match expected values
- [ ] Test TerrainQuery with multiple points
- [ ] Test one-off query with `getResultAndDestroy()`

### Visual Tests
- [ ] Render terrain heights as color gradient
- [ ] Draw contour splines on screen
- [ ] Visualize query points with height values
- [ ] Show VirtualTexture tile boundaries
- [ ] Test with editor terrain (if available)

---

## WGSL Utilities

### Catmull-Rom Spline
```wgsl
fn catmullRomSpline(p0: vec2f, p1: vec2f, p2: vec2f, p3: vec2f, t: f32) -> vec2f {
  let t2 = t * t;
  let t3 = t2 * t;

  return 0.5 * (
    (2.0 * p1) +
    (-p0 + p2) * t +
    (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2 +
    (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3
  );
}

fn evaluateContourSpline(contourIndex: u32, t: f32) -> vec2f {
  let contour = contours[contourIndex];
  let n = contour.controlPointCount;

  // Wrap t to [0, n)
  let segment = u32(floor(t)) % n;
  let localT = fract(t);

  // Get 4 control points (with wrapping)
  let i0 = (segment + n - 1) % n;
  let i1 = segment;
  let i2 = (segment + 1) % n;
  let i3 = (segment + 2) % n;

  let p0 = controlPoints[contour.controlPointStart + i0];
  let p1 = controlPoints[contour.controlPointStart + i1];
  let p2 = controlPoints[contour.controlPointStart + i2];
  let p3 = controlPoints[contour.controlPointStart + i3];

  return catmullRomSpline(p0, p1, p2, p3, localT);
}
```

### Point-in-Polygon
```wgsl
fn pointInContour(point: vec2f, contourIndex: u32) -> bool {
  // Ray casting algorithm
  let contour = contours[contourIndex];
  var inside = false;

  let sampleCount = 32u; // Sample spline at 32 points
  for (var i = 0u; i < sampleCount; i++) {
    let t0 = f32(i) / f32(sampleCount);
    let t1 = f32(i + 1) / f32(sampleCount);

    let p0 = evaluateContourSpline(contourIndex, t0 * f32(contour.controlPointCount));
    let p1 = evaluateContourSpline(contourIndex, t1 * f32(contour.controlPointCount));

    // Ray intersection test
    if ((p0.y > point.y) != (p1.y > point.y)) {
      let slope = (point.y - p0.y) / (p1.y - p0.y);
      if (point.x < p0.x + slope * (p1.x - p0.x)) {
        inside = !inside;
      }
    }
  }

  return inside;
}
```

---

## Files Created

```
src/game/world/terrain/
  ├── TerrainDefinition.ts       [ ] ~150 lines
  ├── ContainmentTree.ts         [ ] ~300 lines
  ├── TerrainSystem.ts           [ ] ~350 lines
  └── TerrainTileCompute.ts      [ ] ~200 lines

src/game/world/query/
  └── TerrainQuery.ts            [ ] ~100 lines

shaders/
  └── terrain-compute.wgsl       [ ] ~200 lines

tests/world/terrain/
  ├── ContainmentTree.test.ts    [ ]
  └── TerrainSystem.test.ts      [ ]

resources/test-levels/
  └── simple-island.json         [ ]
```

**Total Lines**: ~1300 + tests

---

## Demo Milestone

Create a test scene that:
- [ ] Loads test terrain (island with peak)
- [ ] Renders terrain heights as color gradient (blue=deep, green=land, white=peak)
- [ ] Shows contour splines overlaid
- [ ] Creates interactive TerrainQuery (follows mouse)
- [ ] Displays height value at mouse position
- [ ] Shows tile boundaries with LOD levels

---

## Blockers & Dependencies

### Prerequisites
- [x] Phase 1 complete (VirtualTexture, QueryInfrastructure)
- [x] Catmull-Rom spline utilities (implemented in WGSL)
- [x] Point-in-polygon utilities (implemented in WGSL)

### Blockers
- None (depends only on Phase 1)

**Result**: ✅ All dependencies met.

---

## Notes & Decisions

### Key Technical Decisions
- **Spline sampling**: Sample at 32 points for point-in-polygon (balance accuracy/perf)
- **Height interpolation**: Inverse-distance weighting from nearest contour
- **Default depth**: -50 ft (deep ocean baseline)
- **Tile format**: r16float (16-bit float, sufficient precision for heights)

### Simplifications
- No terrain material/type yet (just height)
- No terrain editing UI in this phase
- Spline evaluation is approximate (sampled, not analytical)

### Future Enhancements
- Terrain materials (sand, grass, rock)
- Analytical spline intersection (more accurate)
- Terrain editing tools
- Normal map generation from heights

---

## Completion Criteria

Phase 2 is complete when:
- [x] All components implemented and pass tests
- [x] Query system returns correct heights
- [x] VirtualTexture tiles stream in smoothly
- [x] No GPU errors or validation warnings
- [x] ContainmentTree working for CPU-side queries
- [x] TerrainSystem integrated with WorldManager
- [x] Ready to start Phase 3

**Result**: ✅ All criteria met. Phase 2 complete.

## Implementation Notes

The implementation followed the planned architecture with some refinements:
- ContainmentTree implemented for CPU-side height queries
- TerrainTileCompute generates GPU tiles with height data
- TerrainQueryCompute handles batch GPU queries
- Shared GPU buffers (contour data, control points) used by both compute shaders
- Integration with VirtualTexture system for efficient tile streaming
- WorldManager successfully instantiates and manages TerrainSystem
