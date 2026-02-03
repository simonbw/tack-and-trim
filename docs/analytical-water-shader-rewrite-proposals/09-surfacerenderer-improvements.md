# SurfaceRenderer Architecture Improvements Proposal

## Summary

Replace monolithic surface shader with modular, self-contained rendering passes. Improves maintainability, performance visibility, and sets foundation for advanced rendering features.

## Current System (main branch)

**Architecture**: Monolithic approach

- 3 compute pipelines → 1 combined fragment shader
- `WaterRenderPipeline` → `waterTexture`
- `TerrainRenderPipeline` → `terrainTexture`
- `WetnessRenderPipeline` → `wetnessTexture`
- `SurfaceShader` (fullscreen fragment) → composites to screen
- All lighting/shading in one ~600 line WGSL shader

**Issues**:

- Tight coupling between rendering stages
- Difficult to test individual passes
- Lighting model embedded in monolithic shader
- Custom pipeline classes reinvent lifecycle management

## Proposed System (from analytical-water-shader-rewrite)

**Architecture**: Modular passes

- 4 distinct, self-contained passes with clear responsibilities
- Each pass extends engine base classes
- Offscreen compositing for better pipeline control
- Optimized texture formats

### Four Rendering Passes

1. **TerrainRenderPass** - Terrain height computation
   - Input: Terrain contours, spline data
   - Output: `terrainTexture` (rgba16float: height, materialId)
   - GPU storage: 50% memory savings vs rgba32float
   - Note: Uses same GPU compute approach as current system, just modularized

2. **WaterRenderPass** - Gerstner wave evaluation
   - Input: Wave sources, shadow textures, modifiers
   - Output: `waterTexture` (rgba16float: height, normal.xy, foam)
   - Physics: Gerstner waves, shadow sampling, modifier application

3. **WetnessPass** - Reprojection + decay
   - Input: Terrain height, water height, previous wetness
   - Output: `wetnessTexture` (r32float, ping-pong)
   - Logic: Underwater detection, exponential decay, reprojection

4. **CompositePass** - Lighting + blending
   - Input: All above textures
   - Output: `compositeTexture` (rgba8unorm) → blit to screen
   - Rendering: Terrain coloring, wetness darkening, water blending, lighting

## Key Improvements

### 1. Distinct Pass Boundaries

**Old**: Everything in `SurfaceShader.ts`

- Wave physics + terrain sampling + wetness + lighting all mixed
- ~600 lines of WGSL
- Difficult to modify one aspect without affecting others

**New**: Clear responsibilities

- **Terrain**: "Compute height from contour splines"
- **Water**: "Evaluate Gerstner waves with shadows"
- **Wetness**: "Reproject and decay wetness"
- **Composite**: "Blend everything with lighting"
- Each pass ~150-250 lines

### 2. Better Base Class Usage

**Old**: Custom pipeline classes

- Reinvent shader binding, dispatch, lifecycle
- No type safety for bindings

**New**: Extends engine classes

```typescript
class TerrainRenderPass extends ComputeShader<TerrainBindings> {
  // Type-safe bindings, automatic dispatch, standard lifecycle
}

class CompositePass extends FullscreenShader<CompositeBindings> {
  // Fragment shader rendering
}
```

### 3. Offscreen Compositing

**Old**: Direct render to screen

- Composite shader runs in main render pass
- Less control over pipeline

**New**: Offscreen → blit

- CompositePass renders to offscreen texture
- SurfaceRenderer blits to screen with `draw.image()`
- Runs on `"waterShader"` layer (no parallax)
- Better render pipeline control

### 4. Texture Format Optimization

| Texture   | Old Format  | New Format  | Savings |
| --------- | ----------- | ----------- | ------- |
| Water     | rgba32float | rgba16float | 50%     |
| Terrain   | rgba32float | rgba16float | 50%     |
| Wetness   | r32float    | r32float    | 0%      |
| Composite | N/A         | rgba8unorm  | New     |

**Memory impact**: Significant reduction for high-res rendering

### 5. Modular Terrain Computation

**Old**: Terrain computation embedded in monolithic shader

- Mixed with other rendering concerns

**New**: TerrainRenderPass isolates terrain logic

- Same contour-based GPU compute approach
- Self-contained pass with clear inputs/outputs
- Easier to maintain and optimize independently
- Future migration path to VirtualTexture system when ready

### 6. Separation of Concerns

**Old Architecture**:

```
SurfaceRenderer.ts (600+ lines)
├── Pipeline management
├── Texture allocation
├── Uniform management
├── Bind group caching
├── Terrain version tracking
├── Influence field configuration
├── Render rect calculation
└── Full lighting/shading logic
```

**New Architecture**:

```
SurfaceRenderer.ts (435 lines)
├── Pass orchestration ONLY
├── Texture lifecycle
├── Render rect calculation
├── Ping-pong state for wetness
└── 4 independent passes:
    ├── TerrainRenderPass (~250 lines)
    ├── WaterRenderPass (~450 lines)
    ├── WetnessPass (~200 lines)
    └── CompositePass (~200 lines)
```

## Benefits

### 1. Cleaner Pass Boundaries

Each pass has single, well-defined responsibility. Easy to understand data flow: Terrain → Water → Wetness → Composite.

### 2. Better Code Reuse

- Extends engine base classes
- Uses standard binding system
- Inherits profiling, error handling, lifecycle

### 3. Improved Memory Efficiency

- 50% reduction with rgba16float
- Offscreen composite texture only allocated once
- Better texture format matching

### 4. Easier to Maintain

- Pass implementations are focused and readable
- Adding effects means modifying one pass
- Changing lighting only touches CompositePass
- WGSL shaders are focused (~150-250 lines each)

### 5. Better Performance Potential

- Clear GPU pipeline barriers
- Compute passes can run asynchronously
- Profiling can identify bottlenecks per-pass
- Texture formats optimized for bandwidth

### 6. Flexibility for Future Features

Easy to add new passes:

- `ReflectionPass` for screen-space reflections
- `FoamPass` for advanced foam simulation
- `MaterialPass` for terrain materials
- Can swap passes at runtime for debug modes

### 7. Testability and Debuggability

- Each pass independently testable
- Can render individual passes to inspect
- Clear data dependencies
- Debug modes can skip passes
- Pass timings can be profiled separately

## Migration Path

### Phase 1: Create Pass Classes

1. Implement `TerrainRenderPass` extending ComputeShader
2. Implement `WaterRenderPass` extending ComputeShader
3. Implement `WetnessPass` extending ComputeShader
4. Implement `CompositePass` extending FullscreenShader

### Phase 2: Update SurfaceRenderer

1. Simplify to orchestration role
2. Create offscreen composite texture
3. Implement pass lifecycle (init, render, destroy)
4. Add blit to screen in onRender

### Phase 3: Migrate Shaders

1. Extract terrain logic to TerrainRenderPass WGSL
2. Extract water logic to WaterRenderPass WGSL
3. Extract wetness logic to WetnessPass WGSL
4. Extract lighting to CompositePass WGSL

### Phase 4: Optimize Formats

1. Change water/terrain textures to rgba16float
2. Verify visual quality
3. Measure memory savings

### Phase 5: Remove Old System

1. Delete old pipeline classes
2. Delete monolithic SurfaceShader
3. Clean up unused uniform code

### Phase 6: Testing

1. Verify visual correctness
2. Profile per-pass performance
3. Test debug visualization
4. Validate terrain computation accuracy

## Code Organization

**Old Structure**:

```
surface-rendering/
├── SurfaceRenderer.ts (~600 lines)
├── AnalyticalWaterRenderPipeline.ts
├── TerrainRenderPipeline.ts
├── WetnessRenderPipeline.ts
├── SurfaceShader.ts (monolithic)
└── SurfaceUniforms.ts
```

**New Structure**:

```
world/rendering/
├── SurfaceRenderer.ts (~435 lines - orchestrator)
├── TerrainRenderPass.ts (contour-based GPU compute)
├── WaterRenderPass.ts (Gerstner waves + shadows)
├── WetnessPass.ts (reprojection + decay)
└── CompositePass.ts (lighting + blending)
```

## Performance Impact

**Memory**:

- 50% reduction for water/terrain textures
- Additional offscreen composite texture (negligible)

**GPU**:

- Clear pipeline barriers enable better scheduling
- Profiling can identify bottlenecks
- Texture format optimization reduces bandwidth

**Maintainability**:

- Focused shaders easier to optimize
- Can profile individual passes
- Easier to experiment with optimizations

## Potential Issues

1. **Additional render target** - Offscreen composite texture
   - **Mitigation**: Small overhead, better pipeline control worth it

2. **More pass dispatch** - 4 passes vs 3 pipelines + 1 shader
   - **Mitigation**: Negligible overhead, better organization worth it

3. **Migration complexity** - Splitting monolithic shader
   - **Mitigation**: Well-defined boundaries, clear data flow

## Recommendation

**STRONGLY RECOMMEND** adopting this architecture. The modular approach is significantly more maintainable, sets foundation for advanced features (reflections, materials), and enables better performance optimization.

The separation of concerns is textbook software engineering. Each pass is focused, testable, and can be optimized independently.

This is how modern GPU rendering pipelines should be structured.

## File References

**New Implementation:**

- `src/game/world/rendering/SurfaceRenderer.ts`
- `src/game/world/rendering/TerrainRenderPass.ts`
- `src/game/world/rendering/WaterRenderPass.ts`
- `src/game/world/rendering/WetnessPass.ts`
- `src/game/world/rendering/CompositePass.ts`

**To Remove:**

- `src/game/surface-rendering/` (entire old folder)
