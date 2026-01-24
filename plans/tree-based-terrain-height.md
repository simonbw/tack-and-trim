# Tree-Based Terrain Height Calculation

## Current State

The terrain system uses a **floor/ceiling algorithm** where contours are sorted by height and the system finds:
- **Floor**: Highest-elevation contour the query point is inside
- **Ceiling**: Nearest contour the point is outside with height > floor

This approach has a fundamental flaw: it assumes contours nest in height order, which isn't always true (e.g., a valley inside a mountain).

### Relevant Files

| File | Purpose |
|------|---------|
| `src/game/world-data/terrain/LandMass.ts` | TerrainContour/TerrainDefinition types, `buildTerrainGPUData()` |
| `src/game/world-data/terrain/SplineGeometry.ts` | `isSplineInsideSpline()`, `isPointInsideSpline()`, spline utilities |
| `src/game/world-data/terrain/webgpu/TerrainStateShader.ts` | GPU compute shader with floor/ceiling algorithm |
| `src/game/world-data/terrain/webgpu/TerrainComputeBuffers.ts` | GPU buffer management |
| `src/game/world-data/terrain/webgpu/TerrainDataTileCompute.ts` | Tile compute orchestration |
| `src/game/world-data/terrain/cpu/TerrainComputeCPU.ts` | CPU fallback implementation |

## Desired Changes

Replace floor/ceiling with a **tree-based algorithm using GPU rasterization**:

1. **Contour Tree**: Build a tree where each contour's parent is the contour that directly contains it
2. **Rasterization for Containment**: Render filled contours front-to-back with depth testing to determine which contour contains each pixel
3. **IDW Height Interpolation**: For points inside a contour, blend toward its children using inverse-distance weighting

### New Algorithm

For a point inside contour C with children [C1, C2, ...]:
```
For each child Ci:
  dist_i = signed distance to Ci (positive, since we're outside it)
  t_i = smoothstep(0, transitionDist, dist_i)
  h_i = lerp(Ci.height, C.height, t_i)

Final height = IDW average: Σ(h_i / dist_i) / Σ(1 / dist_i)
```

If C has no children: return `C.height + hill_noise`

### Rasterization Approach

- Render contours front-to-back (deepest tree depth first)
- Assign z-values: `z = (maxDepth - contourDepth) / maxDepth`
- Enable depth testing (`less-equal`) so first write wins
- Fragment shader computes final height directly (no separate compute pass)

## Files to Modify

### `src/game/world-data/terrain/LandMass.ts`
- Add `ContourTreeNode` interface with `parentIndex`, `depth`, `childStartIndex`, `childCount`
- Add `ContourTree` interface containing nodes and a flat children array
- Add `buildContourTree(definition: TerrainDefinition): ContourTree` function
- Update `buildTerrainGPUData()` to include tree structure in GPU buffer

### `src/game/world-data/terrain/webgpu/TerrainComputeBuffers.ts`
- Add `childrenBuffer` for flat array of child indices
- Update `contourBuffer` layout to include tree fields (parentIndex, depth, childStartIndex, childCount)
- Update `updateTerrainData()` to upload tree structure

### `src/game/world-data/terrain/webgpu/TerrainDataTileCompute.ts`
- Replace compute shader dispatch with render pass
- Create render pipeline with vertex/fragment shaders
- Set up depth buffer and depth testing
- Tessellate contours into triangle meshes for rasterization

### `src/game/world-data/terrain/webgpu/TerrainStateShader.ts`
- Convert from compute shader to vertex + fragment shader pair
- Vertex shader: position triangles with z from tree depth
- Fragment shader: look up contour's children, compute distances, IDW blend, output height

### `src/game/world-data/terrain/cpu/TerrainComputeCPU.ts`
- Add `buildContourTree()` call (or accept pre-built tree)
- Replace `findFloorCeiling()` with `findDeepestContainingContour()` using tree
- Replace height interpolation with IDW blending toward children

## Execution Order

### Phase 1: CPU Tree Building (no dependencies)
1. `LandMass.ts` - Add tree types and `buildContourTree()` function
   - Use existing `isSplineInsideSpline()` from SplineGeometry.ts
   - For each contour, find which other contours contain it
   - Build parent/child relationships

### Phase 2: CPU Algorithm Update (depends on Phase 1)
2. `TerrainComputeCPU.ts` - Implement new tree-based algorithm
   - This lets us test the algorithm before touching GPU code
   - Add `findDeepestContainingContour()`
   - Add IDW height computation with children

### Phase 3: GPU Buffer Updates (depends on Phase 1)
3. `TerrainComputeBuffers.ts` - Update buffer structure
   - Add children buffer
   - Update contour buffer layout for tree fields

4. `LandMass.ts` - Update `buildTerrainGPUData()` to output tree data

### Phase 4: GPU Rendering (depends on Phase 3)
5. `TerrainDataTileCompute.ts` - Switch from compute to render
   - Add contour tessellation (spline → triangles)
   - Create render pipeline with depth testing
   - Set up depth buffer

6. `TerrainStateShader.ts` - Convert to vertex/fragment shader
   - Vertex shader positions with z from depth
   - Fragment shader does IDW height calculation

## Data Structures

### ContourTreeNode (CPU)
```typescript
interface ContourTreeNode {
  contourIndex: number;      // Index in original contours array
  parentIndex: number;       // -1 for root contours
  depth: number;             // 0 = root, 1 = child of root, etc.
  children: number[];        // Indices of direct children
}
```

### GPU Contour Buffer (updated layout)
```
struct ContourData {
  pointStartIndex: u32,
  pointCount: u32,
  height: f32,
  hillFrequency: f32,
  hillAmplitude: f32,
  parentIndex: i32,          // NEW: -1 for roots
  depth: u32,                // NEW: tree depth
  childStartIndex: u32,      // NEW: index into children buffer
  childCount: u32,           // NEW: number of children
  _padding: f32,             // Alignment
}
// = 40 bytes per contour
```

### GPU Children Buffer (new)
```
// Flat array of u32 child indices
// Contour i's children are at indices [childStartIndex, childStartIndex + childCount)
```
