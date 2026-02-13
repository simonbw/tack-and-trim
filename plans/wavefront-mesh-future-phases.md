# Wavefront Mesh System - Future Phases

Follow-on phases after Phase 1 (GPU Mesh Construction + Debug Viz). See `wavefront-mesh-system.md` for the core system design.

## Phase 2: Diffraction + Simplification

### Diffraction at Shadow Edges

When an active vertex is adjacent to a terminated vertex, it's at a shadow edge:
1. At the shadow edge vertex, spawn 3-5 extra vertices that fan into the shadow zone
2. Diffracted amplitude decays: `A_base * sqrt(wavelength / (2*pi*r))` where r = distance from diffraction point
3. Direction of diffracted vertices curves around the obstacle

When diffraction vertices are inserted into wavefront N, "bridge" vertices are also inserted into wavefront N-1 at the shadow edge position with the shadow edge's attributes. This maintains equal vertex counts between adjacent wavefronts, and the bridge vertices create the correct fan geometry from the shadow edge point to the diffraction spread.

This replaces the current Fresnel diffraction model with geometric wavefront spreading.

### Wavefront Skipping / Simplification

**During construction**: Skip emitting a wavefront step when all vertices' attributes changed by less than a threshold from the previous wavefront. Just advance positions and accumulate.

**Post-construction**: Edge-collapse mesh simplification:
- Error metric: max difference in `amplitudeFactor`, `directionOffset`, and `phaseOffset` between actual and linearly interpolated
- Priority queue by error (smallest first)
- Stop when minimum error exceeds threshold
- Target: 50-80% reduction in open water

### New files
- `src/game/wave-physics/MeshSimplification.ts`

### Modified files
- `src/game/wave-physics/WavefrontMeshBuilder.ts` - add diffraction vertex insertion logic
- `src/game/wave-physics/WavefrontMesh.ts` - add simplification pass

### Validation
Debug viz shows diffraction fans spreading into shadow zones. Triangle count reduced significantly in open water.

## Phase 3: Rendering Integration

Rasterize meshes to screen-space texture, integrate with water height shader.

### New files
- `src/game/wave-physics/WavefrontRasterizer.ts`

### Modified files
- `src/game/wave-physics/WavePhysicsManager.ts` - create rasterizer, expose texture
- `src/game/wave-physics/WavePhysicsResources.ts` - expose wave field texture
- `src/game/surface-rendering/SurfaceRenderer.ts` - add rasterization pass, bind wave field texture
- `src/game/surface-rendering/WaterHeightShader.ts` - sample wave field texture instead of computing shadow/refraction

### Validation
Water renders with refraction visible (waves bending toward shore). Soft shadow edges. Smooth amplitude transitions near coastlines.

## Phase 4: Query Integration

Query shader performs analytical mesh lookup on the GPU.

### New files
- `src/game/wave-physics/wavefront-mesh-lookup.wgsl.ts`

### Modified files
- `src/game/world/water/WaterQueryShader.ts` - add mesh lookup, remove shadow/refraction code
- `src/game/world/water/WaterQueryManager.ts` - build packed mesh buffer, bind to query shader

### Validation
Boat physics responds correctly to new wave field. Wave heights match rendered visuals near islands.

## Phase 5: Cleanup

Remove old shadow system.

### Files to Remove
- `src/game/wave-physics/ShadowGeometry.ts`
- `src/game/wave-physics/SilhouetteComputation.ts`
- `src/game/world/shaders/shadow-attenuation.wgsl.ts`
- `src/game/world/shaders/shadow-packed.wgsl.ts`
- `src/game/world/shaders/fresnel-diffraction.wgsl.ts`

### Files to Simplify
- `src/game/wave-physics/WavePhysicsManager.ts` - remove packed shadow buffer code
- `src/game/world/shaders/wave-physics.wgsl.ts` - remove per-pixel refraction function (baked into mesh), keep wave speed function
- `src/game/world/shaders/wave-terrain.wgsl.ts` - remove per-pixel shoaling/damping (baked into mesh)
