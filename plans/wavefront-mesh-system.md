# Wavefront Mesh System

## Context

Our current wave-terrain interaction uses shadow polygons + per-pixel analytical refraction/shoaling. This has limitations: hard shadow edges, limited diffraction, per-pixel refraction that doesn't capture true wavefront bending, and hard coastline boundaries. We want to replace this with a **wavefront marching mesh** that naturally captures blocking, diffraction, refraction, shoaling, and damping in a single unified structure -- with smooth coastlines and no grid artifacts.

The mesh is constructed per wave source on the GPU at level load time. For rendering, the mesh is rasterized to a screen-space texture each frame as part of the surface rendering pipeline. For queries, the mesh data is looked up analytically on the GPU as part of the existing query compute shader. The Gerstner wave computation stays analytical -- the mesh just provides per-wave amplitude, direction, and phase modifications.

## What the Mesh Stores

Each vertex stores a **modification factor** relative to the base wave:
- `amplitudeFactor` (f32): 0.0 = fully blocked, 1.0 = unmodified open ocean
- `directionOffset` (f32): radians of direction change from refraction/diffraction
- `phaseOffset` (f32): correction for the phase shift accumulated along the curved wavefront path

The default (open ocean with no terrain interaction) is `(1.0, 0.0, 0.0)`. This means:
- The wave's base amplitude/direction stays in the `waveData` buffer (unchanged)
- The mesh only encodes how terrain modifies each wave
- Pixels outside mesh coverage default to `(1.0, 0.0, 0.0)` (no modification)

This replaces the current per-pixel computation of `shadow.energy * terrainFactor` and `shadow.directionOffset + refractionOffset`.

### Why Phase Offset?

Without a phase correction, the shader computes phase as `dot(position, rotatedDir * k)`. This is only correct if the wave direction was constant along the entire path from the source. With refraction, the direction changes gradually, so the actual phase is the path integral of `k * ds` along the curved wavefront ray. Omitting this correction causes wavefront discontinuities where refraction is strong.

During construction, accumulated phase is tracked per vertex. The stored `phaseOffset` is the difference between the actual accumulated phase and the analytical phase `dot(position, baseWaveDir * k)`, so the shader can correct for the curved path.

## GPU Mesh Construction

### Overview

For each wave source, a GPU compute shader marches wavefronts from upwind to downwind. Each wavefront is a row of vertices at the same phase. The entire mesh (all wavefront steps) is written to a single GPU buffer that later serves as the vertex buffer for rasterization.

The compute shader reuses existing WGSL modules via the shader dependency system:
- `computeTerrainHeight()` from `terrain.wgsl.ts` (bound to the existing `packedTerrainBuffer`)
- `computeWaveSpeed()` and `computeRefractionOffset()` from `wave-physics.wgsl.ts`
- `computeWaveTerrainFactor()` (shoaling + damping) from `wave-terrain.wgsl.ts`

No CPU terrain sampler is needed -- the GPU evaluates terrain height directly using the same analytical contour-tree algorithm used by the query and rendering shaders.

### Vertex Data

Two categories of per-vertex data, separated because they have different lifetimes:

**Mesh vertex data** (persists after construction, becomes the rasterizer's vertex buffer):
```
5 floats per vertex (20 bytes, stored as array<f32>):
  positionX:       f32    // world space
  positionY:       f32
  amplitudeFactor: f32    // 0.0 - 2.0
  directionOffset: f32    // radians
  phaseOffset:     f32    // radians
```
Buffer usage: `STORAGE | VERTEX`. The compute shader writes during construction, then the same buffer is bound as a vertex buffer for rasterization. No copies.

**March state** (temporary, destroyed after construction):
```
5 floats per vertex (20 bytes, stored as array<f32>):
  directionX: f32    // current propagation direction (unit vector)
  directionY: f32
  terminated: f32    // 0.0 or 1.0 (stored as float for simplicity)
  padding:    f32
  padding:    f32
```
Two copies for ping-pong between marching steps. Buffer usage: `STORAGE`.

### Step 1: Wavefront Initialization (CPU)

For each wave source (planar wave):
1. Compute simulation AABB from coastline bounds + several wavelengths margin
2. Compute `numSteps` from march distance / base step size
3. Compute `vertexCount` from AABB cross-wave extent / vertex spacing
4. First wavefront: line of vertices perpendicular to wave direction at the upwind edge of the AABB
5. Each vertex gets: `position` along the line, `direction = waveDirection`, `amplitudeFactor = 1.0`, `directionOffset = 0.0`, `phaseOffset = 0.0`
6. Vertex spacing along wavefront: `wavelength / 4` (tunable)

The initial wavefront and state are uploaded to the GPU via `queue.writeBuffer()`.

### Step 2: Wavefront Marching (GPU Compute)

One compute dispatch per marching step. Each thread handles one vertex. Workgroup size: `[64, 1, 1]`.

Per-thread logic:
```
1. Read own vertex from meshVertices[prevStepOffset + vi]
2. Read own state from prevState[vi]
3. If terminated: copy to output unchanged, return

4. Evaluate terrain height:
     terrainHeight = computeTerrainHeight(vertex.position, packedTerrain, ...)
     depth = tideHeight - terrainHeight

5. Check termination:
     if depth <= 0: set amplitudeFactor = 0, mark terminated, write, return

6. Depth gradient via finite differences:
     hx = computeTerrainHeight(position + (5, 0), ...)
     hy = computeTerrainHeight(position + (0, 5), ...)
     depthGradient = ((tideHeight - hx) - depth, (tideHeight - hy) - depth) / 5.0

7. Refraction:
     currentAngle = atan2(direction.y, direction.x)
     refractionDelta = computeRefractionOffset(currentAngle, wavelength, depth, depthGradient)
     newAngle = currentAngle + refractionDelta
     newDirection = (cos(newAngle), sin(newAngle))

8. Wave speed and adaptive step:
     speed = computeWaveSpeed(wavelength, depth)
     stepDistance = baseStepSize * (speed / deepSpeed)

9. Advance position:
     newPosition = position + newDirection * stepDistance

10. Amplitude:
      terrainFactor = computeWaveTerrainFactor(depth, wavelength)

11. Convergence/divergence (reads neighbors from previous step):
      leftPos  = meshVertices[prevStepOffset + max(vi-1, 0)].position
      rightPos = meshVertices[prevStepOffset + min(vi+1, vertexCount-1)].position
      spacing = distance(leftPos, rightPos) / 2.0
      convergenceFactor = sqrt(initialSpacing / spacing)

12. Phase tracking:
      accumulatedPhase += k * stepDistance
      phaseOffset = accumulatedPhase - dot(newPosition, baseWaveDir * k)

13. Write vertex to meshVertices[outStepOffset + vi]
      amplitudeFactor = min(terrainFactor * convergenceFactor, 2.0)
      directionOffset = accumulated direction change from base wave direction
14. Write state to outState[vi]
```

3 `computeTerrainHeight` evaluations per vertex per step (center + 2 for gradient). The convergence factor reads neighbor positions from the previous step (guaranteed fully written before this dispatch), so there are no data races.

### Step 3: Dispatch Loop (CPU Orchestration)

Follows the same pattern as `TerrainTileCache` (separate encoder + submit per step for uniform updates):

```
for step in 1..numSteps:
  1. Update uniform buffer (prevStepOffset, outStepOffset, ping-pong flag)
  2. Create command encoder
  3. Begin compute pass
  4. Dispatch marchShader with (vertexCount, 1, 1) threads
  5. End pass, submit
```

~100 steps for a typical level. Each submit is lightweight -- the main thread's JS work is trivial (uniform writes + command encoder creation). All heavy computation happens on the GPU asynchronously.

After all steps, `await device.queue.onSubmittedWorkDone()` to ensure the mesh is complete before proceeding.

### Step 4: Land Intersection (Blocking)

Handled inline during Step 2 (check at step 5 in the per-thread logic). Key design decisions:

- Terminated vertices **stay in place** at their termination position with `amplitudeFactor = 0` -- they are NOT removed from the wavefront
- This means every wavefront has the same vertex count (no topology changes from termination)
- The damping formula drives amplitude smoothly toward 0 before termination, giving **soft coastlines**
- The rasterizer interpolates amplitude from 0 (at coast) to full amplitude (in open water) across the mesh triangles
- Vertices at the boundary between active and terminated are **diffraction source points** (see `wavefront-mesh-future-phases.md`)

### Step 5: Index Buffer + Triangle Strip (CPU)

After construction, the index buffer is generated on CPU. Since all wavefronts have the same vertex count, this is a uniform grid:

For each pair of adjacent wavefronts V (step r) and W (step r+1):
- For each column `i` from 0 to `vertexCount - 2`:
  - Emit triangle `(V[i], V[i+1], W[i])`
  - Emit triangle `(W[i], V[i+1], W[i+1])`

Where `V[i] = r * vertexCount + i` and `W[i] = (r+1) * vertexCount + i`.

Triangles near terminated vertices will have `amplitudeFactor = 0` at one or more corners -- the GPU rasterizer interpolates this smoothly. Degenerate triangles (where a terminated vertex hasn't moved) are harmless.

The index buffer is uploaded to the GPU once. Usage: `INDEX`.

### Step 6: Termination

Stop marching when the wavefront exits the simulation AABB on the downwind side, or when all vertices are terminated.

## Rendering Integration

### Wave Field Texture

A screen-space `texture_2d_array<f32>` with one layer per wave source (`numWaveSources` layers):
- Format: `rgba16float` (R = amplitudeFactor, G = directionOffset, B = phaseOffset, A = unused) -- filterable, supports `textureSampleLevel`
- Size: screen resolution (`renderer.getWidth()` x `renderer.getHeight()`), matching other surface rendering textures
- Recreated when screen size changes, same as `terrainHeightTexture` and `waterHeightTexture`
- Clear to `(1.0, 0.0, 0.0, 0.0)` before rasterizing each layer

### Rasterization Pass

New **render pass** (vertex/fragment, not compute) that runs **every frame**, inserted between Pass 1 (terrain screen) and Pass 2 (water height) in the surface rendering pipeline:

```
Pass 1:   Terrain screen compute          -> terrainHeightTexture
Pass 1.5: Wave field rasterization (NEW)  -> waveFieldTexture
Pass 2:   Water height compute            -> waterHeightTexture
Pass 3:   Wetness update                  -> wetnessTexture
Pass 4:   Surface composite               -> screen
```

**Vertex buffer layout** (`arrayStride: 20`, 5 floats per vertex):
```
@location(0) position:   vec2<f32>    // world space, offset 0
@location(1) attributes: vec2<f32>    // (amplitudeFactor, directionOffset), offset 8
@location(2) phase:      f32          // phaseOffset, offset 16
```

**Vertex shader**: Transform mesh vertex positions from world space to clip space using the same viewport uniforms as the rest of the surface pipeline (`viewportLeft/Top/Width/Height`). Pass through attributes as varyings.

**Fragment shader**: Output `vec4<f32>(amplitudeFactor, directionOffset, phaseOffset, 0.0)` to the render target.

The GPU hardware interpolates attributes across triangles -- smooth, artifact-free. One draw call per wave source (each targets a different layer of the texture array). The mesh is static (built at level load), so the per-frame cost is just submitting the draw calls with trivial shaders.

### Modified Water Height Shader

Replace the per-wave shadow + refraction + terrain factor computation with a texture sample. Since the wave field texture is screen-space (same pixel mapping as the water height shader), the UV is simply `pixel / screenSize`:

```wgsl
// Before (current):
let shadow = computeShadowForWave(worldPos, &packedShadow, i, wavelength);
let terrainFactor = computeWaveTerrainFactor(depth, wavelength);
let refractionOffset = computeRefractionOffset(waveDir, wavelength, depth, depthGradient);
energyFactors[i] = shadow.energy * terrainFactor;
directionOffsets[i] = shadow.directionOffset + refractionOffset;

// After (new):
let uv = vec2<f32>(f32(pixel.x) / params.screenWidth, f32(pixel.y) / params.screenHeight);
let waveField = textureSampleLevel(waveFieldTexture, waveFieldSampler, uv, i32(i), 0.0);
energyFactors[i] = waveField.r;     // amplitude factor (baked: shadow + shoaling + damping + convergence)
directionOffsets[i] = waveField.g;   // direction offset (baked: refraction + diffraction)
phaseOffsets[i] = waveField.b;       // phase offset (baked: accumulated path integral correction)
```

The `packedShadow` binding is removed. The depth gradient computation (used only for refraction) is also removed -- refraction is baked into the mesh.

## Query Integration

The query shader computes wave field values by looking up the mesh directly on the GPU -- no texture sampling. Each wave source's mesh is constructed into its own vertex buffer, then all meshes are copied into a single packed buffer for the query shader (one storage binding instead of one per wave source, keeping total bindings under 8). The packed buffer has a small header with per-source offsets so the shader can index into the correct mesh. The copy is a `copyBufferToBuffer` after construction -- effectively free on the GPU.

The shader finds the containing triangle via a structured grid search.

### Mesh Lookup Algorithm

The mesh is a regular grid: `mesh[step * vertexCount + vertexIdx]`. For a query point, finding the containing cell is O(1):

```
For each wave source i:
  // Transform query point to wavefront coordinate frame
  along = dot(queryPoint - meshOrigin[i], waveDir[i])
  cross = dot(queryPoint - meshOrigin[i], perpDir[i])

  // Estimate grid cell from coordinate frame
  estStep = clamp(along / avgStepDistance[i], 0, numSteps[i] - 2)
  estVertex = clamp(cross / vertexSpacing[i], 0, vertexCount[i] - 2)

  // Search small neighborhood (mesh is curved by refraction)
  for s in estStep-2 .. estStep+2:
    for v in estVertex-2 .. estVertex+2:
      // Read 4 corner vertices of cell (s, v)
      v00 = meshVertices[s * vertexCount + v]
      v10 = meshVertices[(s+1) * vertexCount + v]
      v01 = meshVertices[s * vertexCount + (v+1)]
      v11 = meshVertices[(s+1) * vertexCount + (v+1)]

      // Point-in-triangle test for both triangles of the quad
      // If found: barycentric interpolation -> amplitudeFactor, directionOffset, phaseOffset
```

This gives exact consistency with the rendered mesh -- the boat feels the same waves it sees. The lookup is ~25 cell checks with 2 triangle tests each, far cheaper than the current per-query shadow polygon evaluation.

### Mesh Metadata

Per-wave-source metadata needed for the coordinate transform, packed into the `waveData` buffer (extending the existing 8 floats per source):
- `meshOriginX, meshOriginY`: world position of the first vertex of the first wavefront
- `waveDirX, waveDirY`: wave propagation direction (unit vector)
- `perpDirX, perpDirY`: perpendicular direction (90-degree rotation of waveDir)
- `avgStepDistance`: average distance between wavefronts
- `vertexSpacing`: initial spacing between vertices along a wavefront
- `numSteps`: number of wavefront steps
- `vertexCount`: vertices per wavefront

### Changes to Query Shader

- **Added binding**: `packedMesh: storage, array<f32>` (all wave source meshes packed into one buffer with per-source offset header)
- **Removed binding**: `packedShadow: storage, array<u32>`
- **Kept binding**: `packedTerrain: storage, array<u32>` -- still needed for `computeTerrainHeight()` which computes the `.depth` result field
- **Removed code**: shadow polygon evaluation, depth gradient computation (3 extra terrain height evaluations per query point), refraction offset computation
- **Added code**: mesh lookup function (~40 lines of WGSL)

## Integration with WavePhysicsManager

`WavePhysicsManager` currently builds shadow polygons and uploads a packed shadow buffer. It will be replaced to:

1. Build `WavefrontMesh` per wave source via GPU compute at level load
2. Create and manage the `WavefrontRasterizer` (GPU render pipeline for screen-space texture)
3. Expose mesh vertex buffers for query shader binding
4. Expose the wave field texture for water height shader binding

The packed shadow buffer code, `ShadowGeometry.ts`, and `SilhouetteComputation.ts` will be removed after the new system is validated.

## New and Modified Files

### New Files

- `src/game/wave-physics/WavefrontMarchShader.ts` - GPU compute shader module for wavefront marching (bindings, uniforms, WGSL entry point)
- `src/game/wave-physics/WavefrontMesh.ts` - mesh data structure: owns vertex/index GPU buffers, stores grid dimensions and metadata
- `src/game/wave-physics/WavefrontMeshBuilder.ts` - orchestrates GPU construction: initializes wavefront, runs dispatch loop, generates index buffer
- `src/game/wave-physics/WavefrontRasterizer.ts` - manages GPU render pipeline for screen-space rasterization (vertex/fragment shaders, per-frame draw calls)
- `src/game/wave-physics/wavefront-mesh-lookup.wgsl.ts` - WGSL shader module for mesh lookup in the query shader
- `src/game/debug-renderer/modes/WavefrontMeshDebugMode.ts` - debug visualization

### Modified Files

- `src/game/wave-physics/WavePhysicsManager.ts` - replace shadow polygon construction with mesh construction + rasterization
- `src/game/wave-physics/WavePhysicsResources.ts` - expose wave field texture and mesh buffers
- `src/game/surface-rendering/SurfaceRenderer.ts` - add wave field rasterization pass between terrain screen and water height, add wave field texture to water height bind group
- `src/game/surface-rendering/WaterHeightShader.ts` - add waveFieldTexture/sampler bindings, replace shadow/refraction with texture sample
- `src/game/world/water/WaterQueryShader.ts` - add meshVertices binding, replace shadow/refraction with mesh lookup
- `src/game/world/water/WaterQueryManager.ts` - build packed mesh buffer, bind to query shader

## Phase 1 Scope

Build the core algorithm on GPU, visualize with debug renderer. No diffraction, no simplification. Just marching + refraction + blocking + shoaling/damping + convergence/divergence + phase tracking.

**New files**:
- `src/game/wave-physics/WavefrontMarchShader.ts`
- `src/game/wave-physics/WavefrontMesh.ts`
- `src/game/wave-physics/WavefrontMeshBuilder.ts`
- `src/game/debug-renderer/modes/WavefrontMeshDebugMode.ts`

**Modified files**:
- `src/game/wave-physics/WavePhysicsManager.ts` - add mesh construction

**Validation**: Debug renderer shows wavefront lines colored by amplitude, wireframe triangles, direction arrows, terminated vertices. Verify refraction curves wavefronts toward shore. Verify blocking terminates wavefronts at land.

Future phases (rendering integration, query integration, diffraction, simplification, cleanup) are in `wavefront-mesh-future-phases.md`.

## Edge Cases

- **Caustics** (crossing wavefronts): Cap amplitude factor at 2.0 (matches existing maxShoaling)
- **Map boundaries**: Wavefronts terminating at AABB edges get amplitude = 1.0; texture clear color handles areas beyond mesh
- **Very shallow water**: Damping formula drives amplitude to ~0 smoothly
- **No terrain**: If no coastlines exist, skip mesh construction entirely -- the clear value `(1.0, 0.0, 0.0, 0.0)` is correct
- **Point sources**: Phase 1 focuses on planar waves; point source support deferred
- **Tides**: The mesh is built at the tide height at level load time. With +/-2 ft tidal variation this introduces minor error near shallow coastlines, which is acceptable. Future improvement: build meshes at 2-3 tide levels and interpolate between them based on current tide
- **Query points outside mesh**: If the mesh lookup finds no containing triangle (query point outside AABB or in a gap), return default `(1.0, 0.0, 0.0)` -- unmodified open ocean

## Verification

1. **Debug visualization**: Wavefront mesh overlay showing amplitude (color), direction (arrows), triangles (wireframe)
2. **Visual comparison**: Before/after screenshots near islands -- verify soft shadows, visible refraction
3. **Boat physics**: Sail near islands, verify wave heights feel correct (sheltered in lee, amplified at headlands)
4. **Performance**: Mesh construction <500ms at load (GPU compute). Per-frame rasterization is a trivial draw call with a static mesh. Per-frame cost should decrease (texture sample cheaper than analytical shadow + refraction)
5. **Type checking**: `npm run tsgo`
