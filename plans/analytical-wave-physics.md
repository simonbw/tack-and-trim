# Gameplan: Analytical Wave Physics

## Current State

### Influence Field System (`src/game/world-data/influence/`)

The current system pre-computes wave influence using grid-based propagation:

- `InfluenceFieldManager.ts` - Orchestrates async computation at startup, creates GPU 3D textures
- `InfluenceFieldGrid.ts` - 3D grid (x, y, direction) with trilinear interpolation
- `PropagationConfig.ts` - Resolution settings (50-100ft cells, 16 directions)
- `propagation/` - Iterative ray-marching algorithms (Jacobi-style relaxation)

**Problems:**
- 8.5MB+ for swell texture alone (3D texture covering entire terrain)
- Grid aliasing causes visible rectangular boundaries at coastlines
- Wrong diffraction model (lateral spread factor, not Fresnel physics)
- Infinite shadows (no recovery based on obstacle width/wavelength)
- Can't handle lakes correctly (ray-casting sees through islands)

### Water Rendering (`src/game/world-data/water/`)

- `WaterStateShader.ts` - Gerstner waves + per-pixel influence sampling
- Currently samples 3D swell/fetch textures and 2D depth texture
- Applies shoaling (Green's law) and damping based on sampled depth
- Applies direction offset and energy factor from influence textures

### Terrain System (`src/game/world-data/terrain/`)

- `LandMass.ts` - TerrainContour/TerrainDefinition types, containment tree building, GPU data packing
- `TerrainComputeBuffers.ts` - GPU buffer management for contour data
- `TerrainStateShader.ts` - GPU compute for terrain height using winding number + IDW
- `Spline.ts` - Catmull-Rom evaluation, sampling, intersection detection

**Key infrastructure we can reuse:**
- Contour tree structure and GPU buffer packing
- Spline utilities (point evaluation, sampling, containment)
- TerrainComputeBuffers already uploads contour data to GPU

### Editor (`src/editor/`)

- `ContourValidation.ts` - Validates contour intersections
- `EditorDocument.ts` - Contour editing with undo/redo

---

## Desired Changes

Replace the grid-based influence system with a fully analytical approach:

1. **Shadow Geometry**: Pre-compute shadow polygons from coastline silhouette points per wave direction
2. **Analytical Terrain Queries**: Compute depth, SDF, land/water test directly from spline geometry in shader
3. **Fresnel Diffraction**: Physics-based energy attenuation with shadow recovery
4. **Huygens Direction**: Waves bend around obstacles, radiate from inlets
5. **Shoaling/Refraction**: Use analytical depth and its gradient

**Benefits:**
- Per-pixel resolution at coastlines (no grid artifacts)
- Correct physics (Fresnel diffraction, shadow recovery)
- Correct geometry handling (lakes, narrow channels)
- Less memory (geometry buffers instead of 3D textures)
- Faster startup (shadow geometry computation vs iterative propagation)

---

## Files to Modify

### Phase 1: Coastline Infrastructure

#### New Files
- `src/game/wave-physics/CoastlineManager.ts` - Track height=0 contours, compute bounding boxes
- `src/game/wave-physics/SilhouetteComputation.ts` - Find silhouette points on splines for a wave direction

#### Modify
- `src/core/util/Spline.ts` - Add `catmullRomTangent()` function for tangent evaluation
- `src/game/world-data/terrain/ContourValidation.ts` - Add coastline hierarchy validation (positive height must have height=0 parent before negative parent)
- `src/editor/EditorDocument.ts` - Integrate new validation warning for coastline hierarchy

### Phase 2: Shadow Geometry

#### New Files
- `src/game/wave-physics/ShadowGeometry.ts` - Build shadow polygons from silhouette points
- `src/game/wave-physics/ShadowGeometryBuffers.ts` - GPU buffer management for shadow boundaries and polygons
- `src/game/wave-physics/WavePhysicsManager.ts` - Orchestrate shadow geometry computation, hold per-direction data

### Phase 3: Analytical Computations in Shader

#### New Files
- `src/game/wave-physics/WavePhysicsShader.wgsl.ts` - WGSL code for analytical terrain queries (shared include)
  - `computeWaterDepth()` - IDW over contours
  - `computeCoastalSDF()` - Distance to coastline splines
  - `isLand()` - Winding number test
  - `testShadow()` - Point-in-polygon for shadow regions
  - `computeDiffraction()` - Fresnel energy formula
  - `computeDiffractedDirection()` - Huygens principle

#### Modify
- `src/game/world-data/water/webgpu/WaterStateShader.ts` - Replace influence texture sampling with analytical calls
- `src/game/world-data/water/webgpu/WaterDataTileCompute.ts` - Add shadow geometry buffers to bind group
- `src/game/world-data/water/WaterInfo.ts` - Update to use WavePhysicsManager instead of InfluenceFieldManager

### Phase 4: Integration and Cleanup

#### Modify
- `src/game/world-data/terrain/TerrainComputeBuffers.ts` - Add coastline index tracking
- `src/game/world-data/terrain/LandMass.ts` - Add `isCoastline` flag to GPU data packing

#### Deprecate (keep but disable)
- `src/game/world-data/influence/InfluenceFieldManager.ts` - Keep for reference, disable in game
- `src/game/world-data/influence/propagation/` - Keep for reference

---

## Execution Order

### Parallel Work (no dependencies)

These can be done independently:

1. **Spline tangent utility** (`Spline.ts`)
   - Add `catmullRomTangent(p0, p1, p2, p3, t)` function
   - Unit tests for tangent correctness

2. **Coastline validation** (`ContourValidation.ts`)
   - Add validation rule for coastline hierarchy
   - Update editor to show validation warnings

3. **WGSL shared code** (`WavePhysicsShader.wgsl.ts`)
   - Port `catmullRomPoint` and tangent to WGSL
   - Port winding number calculation
   - Port IDW blending algorithm
   - Port point-to-segment distance
   - Can test in isolation with simple compute shader

### Sequential Work (has dependencies)

#### Step 1: Coastline Manager
**Depends on:** Spline tangent utility

- `CoastlineManager.ts`
  - Filter contours to find height=0 coastlines
  - Compute bounding boxes per coastline
  - Store coastline indices for GPU upload

#### Step 2: Silhouette Computation
**Depends on:** Coastline Manager, Spline tangent utility

- `SilhouetteComputation.ts`
  - For each coastline, find points where `dot(tangent, waveDir) = 0`
  - Classify as shadow-casting vs shadow-ending
  - Return array of silhouette points with metadata

#### Step 3: Shadow Geometry
**Depends on:** Silhouette Computation

- `ShadowGeometry.ts`
  - From silhouette points, generate shadow boundary lines
  - Build shadow polygons by connecting boundaries with coastline segments
  - Compute obstacle width per shadow polygon
  - Clip at map boundaries

- `ShadowGeometryBuffers.ts`
  - Pack shadow boundaries into GPU buffer (origin, direction, contourIndex, isLeftEdge)
  - Pack shadow polygons into GPU buffer (boundaryIndices, obstacleWidth, bounds)

#### Step 4: Wave Physics Manager
**Depends on:** Shadow Geometry, Coastline Manager

- `WavePhysicsManager.ts`
  - Initialize on terrain load
  - Compute shadow geometry for 16 wave directions
  - Manage GPU buffers for current wave direction
  - Provide interface for water shader to query

#### Step 5: Water Shader Integration
**Depends on:** WGSL shared code, Wave Physics Manager, Shadow Geometry Buffers

- Modify `WaterStateShader.ts`:
  - Remove swell/fetch texture bindings
  - Add shadow geometry buffer bindings
  - Add contour buffer bindings (reuse from terrain)
  - Replace `sampleSwellInfluence()` with analytical `computeWaveModification()`
  - Update `calculateWaves()` to use new direction and energy

- Modify `WaterDataTileCompute.ts`:
  - Create bind group with new buffers
  - Pass shadow geometry from WavePhysicsManager

- Modify `WaterInfo.ts`:
  - Replace InfluenceFieldManager dependency with WavePhysicsManager
  - Update initialization flow

#### Step 6: Cleanup
**Depends on:** Water Shader Integration working

- Disable InfluenceFieldManager in game initialization
- Remove influence texture creation/upload
- Update any remaining references
- Profile and optimize

---

## Testing Strategy

### Unit Tests
- `catmullRomTangent()` - Verify tangent at t=0, t=0.5, t=1 matches expected
- Silhouette detection - Test with simple circle, verify 2 silhouette points for horizontal wave
- Shadow polygon - Test simple island, verify shadow region is correct

### Visual Tests
- Create debug visualization showing:
  - Coastline contours (highlight height=0)
  - Silhouette points for current wave direction
  - Shadow polygons (transparent overlay)
  - Wave direction vectors

### Integration Tests
- Bay test: Verify waves in bay come from inlet direction
- Island test: Verify shadow behind island, recovery at distance
- Lake test: Verify no waves appear in landlocked lake
- Shoaling test: Verify waves grow in shallow water

---

## Performance Considerations

### Shader Cost Per Pixel

Current system:
- 3D texture sample (swell) + 3D texture sample (fetch) + 2D texture sample (depth)
- ~3 texture fetches

New system:
- Winding number: O(coastline_segments)
- IDW depth: O(contours × children × subdivisions)
- Shadow test: O(shadow_polygons)
- SDF: O(coastline_segments)

### Optimizations

1. **Bounding box early-out**: Skip contours/polygons outside expanded AABB
2. **Deep ocean fast path**: If SDF > threshold, return full energy immediately
3. **Pre-computed shadow for 16 directions**: Interpolate at runtime
4. **LOD for distant pixels**: Reduce subdivision count

### Memory

Current: 8.5MB+ (swell 3D texture) + fetch texture + depth texture
New: ~100KB (shadow geometry for 16 directions) + reuse existing contour buffers

---

## Risk Assessment

### High Risk
- **Shader complexity**: Analytical computations per-pixel could be expensive
  - Mitigation: Aggressive early-out, bounding boxes, LOD
  - Fallback: Can keep depth texture sampling for shoaling if needed

### Medium Risk
- **Shadow polygon edge cases**: Complex coastlines may produce degenerate polygons
  - Mitigation: Robust polygon clipping, validation

### Low Risk
- **API compatibility**: Reusing existing buffer patterns, similar bind group structure
- **Correctness**: Physics formulas are well-documented in design doc

---

## Definition of Done

- [ ] Waves in bays appear to radiate from inlet
- [ ] No visible grid artifacts at coastlines
- [ ] Shadows recover at appropriate distance (based on obstacle width/wavelength)
- [ ] Lakes show no wave activity
- [ ] Shoaling works in shallow water
- [ ] Performance is acceptable (< 2ms per frame for water compute)
- [ ] Old influence system disabled but preserved for reference
