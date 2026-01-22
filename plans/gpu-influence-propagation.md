# GPU Compute for Influence Field Propagation

Port the influence field propagation algorithms (wind, swell, fetch) from CPU to GPU compute shaders. Current CPU implementation takes ~1-3 seconds at startup; GPU should reduce this to ~50-100ms.

## Current State

### CPU Propagation Algorithms
Located in `src/game/world-data/influence/propagation/`:

- **`WindInfluencePropagation.ts`** - Jacobi iteration for wind energy propagation
  - Iterates until convergence (maxChange < 0.005 or 200 iterations)
  - For each water cell, computes weighted average from 8 neighbors
  - Tracks direction accumulator for deflection calculation
  - Outputs: speedFactor, directionOffset, turbulence

- **`SwellInfluencePropagation.ts`** - Similar Jacobi iteration for wave propagation
  - Runs twice (long swell + short chop) with different configs
  - Higher lateral spread for diffraction effects
  - Outputs: energy factor, arrival direction (for each wavelength class)

- **`FetchMapComputation.ts`** - Ray marching for fetch distance
  - For each water cell, marches upwind until hitting land
  - Returns distance traveled (up to 50,000 ft max)

- **`PropagationCore.ts`** - Shared utilities
  - `computeFlowWeight()` - Directional weighting for neighbor energy transfer
  - `precomputeWaterMask()` - Binary land/water classification
  - `isUpwindBoundary()` - Detect energy source boundaries
  - `NEIGHBOR_OFFSETS` - 8-neighborhood (Moore) offsets

### Current Integration
- **`InfluenceFieldManager.ts`** orchestrates computation at startup
- Calls CPU functions, stores results in `InfluenceFieldGrid` (Float32Array)
- Creates GPU 3D textures from computed data for shader sampling
- Progress reporting via `InitializationProgress` interface

### Existing GPU Infrastructure
- **`ComputeShader.ts`** - Base class for compute shaders (bindings, workgroupSize, dispatch)
- **`ShaderBindings.ts`** - Type-safe binding definitions
- **`WaterStateShader.ts`** / **`WindStateShader.ts`** - Example compute shaders
- **`TerrainStateShader.ts`** - Spline evaluation in WGSL (reusable for water mask)

## Desired Changes

Move influence field computation to GPU for ~30x speedup while:
- Maintaining identical output (within floating-point tolerance)
- Keeping CPU fallback for non-WebGPU browsers
- Supporting progress reporting during computation
- Reusing existing GPU infrastructure patterns

## Files to Modify

```
src/game/world-data/influence/InfluenceFieldManager.ts
  - Add GPU compute path in computeAsync()
  - Keep existing CPU code as fallback
  - Route based on getWebGPU().isInitialized
```

## Files to Create

```
src/game/world-data/influence/webgpu/
  InfluencePropagationCompute.ts   - Main orchestrator class
  WaterMaskShader.ts               - Generates water mask from terrain
  WindPropagationShader.ts         - Wind Jacobi iteration
  SwellPropagationShader.ts        - Swell Jacobi iteration
  FetchComputeShader.ts            - Fetch ray marching
  InfluenceComputeBuffers.ts       - Buffer management
```

### Shader Details

#### WaterMaskShader
- Input: Terrain control points (storage buffer)
- Output: R8 texture (1 = water, 0 = land)
- Reuse spline evaluation from `TerrainStateShader`

#### WindPropagationShader / SwellPropagationShader
- Bindings:
  - `params` (uniform) - grid config, direction, propagation config
  - `waterMask` (texture_2d) - land/water classification
  - `energyIn` (texture_2d) - previous iteration energy
  - `energyOut` (storage_texture) - current iteration energy
  - `deflectionIn/Out` (texture_2d/storage) - direction accumulator
- Workgroup: 8x8
- Strategy: Ping-pong between energy textures, 10-20 iterations per dispatch

#### FetchComputeShader
- Bindings:
  - `params` (uniform) - grid config, direction
  - `waterMask` (texture_2d) - for ray march termination
  - `outputTexture` (storage_texture) - fetch distances
- Algorithm: Ray march upwind until land or max distance

### GPU Resources

| Texture | Format | Size | Purpose |
|---------|--------|------|---------|
| Water Mask | r8uint | cellsX × cellsY | Binary land/water |
| Energy A/B | r32float | cellsX × cellsY | Ping-pong for iteration |
| Deflection | rg32float | cellsX × cellsY | Direction accumulator |
| Wind Output | rgba32float 3D | cellsX × cellsY × 16 | Final wind influence |
| Swell Output | rgba32float 3D | cellsX × cellsY × 16 | Final swell influence |
| Fetch Output | rgba32float 3D | cellsX × cellsY × 16 | Final fetch distances |

## Execution Order

### Phase 1: Water Mask Generation (no dependencies)
1. Create `WaterMaskShader.ts`
2. Evaluate terrain signed distance, threshold to binary
3. Test: visualize mask in debug mode

### Phase 2: Fetch Computation (depends on Phase 1)
1. Create `FetchComputeShader.ts`
2. Create `InfluenceComputeBuffers.ts`
3. Ray march upwind, sample water mask for termination
4. Process all 16 directions sequentially
5. Test: compare GPU vs CPU output

### Phase 3: Wind Propagation (depends on Phase 1)
1. Create `WindPropagationShader.ts`
2. Implement ping-pong texture strategy
3. Add finalization pass (turbulence, direction offset)
4. Test: compare GPU vs CPU output

### Phase 4: Swell Propagation (depends on Phase 3 pattern)
1. Create `SwellPropagationShader.ts` (similar structure)
2. Run twice with different configs (long swell, short chop)
3. Combine into single RGBA output
4. Test: compare GPU vs CPU output

### Phase 5: Integration (depends on all above)
1. Create `InfluencePropagationCompute.ts` orchestrator
2. Modify `InfluenceFieldManager.computeAsync()`:
   ```typescript
   if (getWebGPU().isInitialized) {
     await this.computeWithGPU(...);
   } else {
     await this.computeWithCPU(...);  // existing code
   }
   ```
3. Wire up progress callbacks between dispatch batches
4. Verify CPU fallback still works

## Performance Expectation

| Algorithm | CPU (current) | GPU (expected) | Speedup |
|-----------|---------------|----------------|---------|
| Wind | ~300ms | ~10ms | 30x |
| Swell | ~1200ms | ~40ms | 30x |
| Fetch | ~200ms | ~5ms | 40x |
| **Total** | **~1700ms** | **~55ms** | **~30x** |

## Verification

1. `npm run tsgo` - type check passes
2. `npm start` - observe fast loading with progress bar
3. Visual comparison - terrain shadows identical to CPU version
4. Console timing - GPU ~30x faster than CPU
5. CPU fallback test - disable WebGPU, verify game still loads
