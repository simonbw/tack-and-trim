# GPU Wavefront Marching (Lagrangian) -- Design

## Overview

This document extends the current implementation in `WavefrontMeshBuilder.ts` to address diffraction, multi-island terrain, convergence, memory constraints, and adaptive mesh density. The approach marches wavefronts step-by-step from the upwind edge using GPU compute shaders, building a triangle mesh that encodes how terrain modifies each wave source.

The key idea: a line of vertices advances in the wave propagation direction. At each step, every vertex evaluates local terrain to determine refraction, shoaling, damping, and blocking. Adjacent vertices track their spacing to measure convergence/divergence. The result is a structured mesh where rows represent wavefronts at successive phase-time positions.

## Starting Point: Current Implementation

The existing system (`WavefrontMeshBuilder.ts` + `WavefrontMarchShader.ts`) already implements:

- GPU compute dispatch loop with one dispatch per marching step
- Terrain height evaluation via `computeTerrainHeight()` on GPU (contour tree DFS)
- Refraction via `computeRefractionOffset()` with depth gradient finite differences
- Depth-adaptive step sizing (step distance scales with local wave speed)
- Convergence/divergence from neighbor spacing
- Phase tracking with accumulated path integral
- Termination at land (depth <= 0)
- Ping-pong state buffers for marching state

What it lacks:

1. **Diffraction** -- terminated vertices create hard shadow edges with no energy leaking into shadow zones
2. **Continuation through terrain** -- terminated vertices freeze in place, so the mesh doesn't cover the leeward side of islands
3. **Multi-island handling** -- a wave that crosses one island, re-enters water, then hits a second island isn't modeled
4. **Adaptive density** -- uniform spacing wastes vertices in open ocean and under-resolves near coastlines
5. **Memory efficiency** -- the regular grid allocates the same density everywhere

This design addresses all five.

## Algorithm

### Phase 1: March with Continuation Through Terrain

The single most important change to the current algorithm: **vertices do not terminate when they hit land.** Instead, they continue marching with amplitude = 0, maintaining their position in the wavefront array. When they exit land back into water, they resume accumulating amplitude based on depth.

This is critical because:
- The mesh must cover the leeward side of islands for diffraction to fill in
- A wave passing between two islands needs continuous wavefront coverage in the gap and beyond
- The regular grid structure (fixed vertex count per row) is preserved, which keeps index generation trivial and GPU memory access patterns coherent

#### Per-vertex state changes

The existing march state gains one field, replacing the boolean `terminated`:

```
March state (6 floats per vertex):
  directionX:    f32    // current propagation direction
  directionY:    f32
  landDepth:     f32    // 0.0 = in water, >0 = consecutive steps inside land
  accPhase:      f32    // accumulated phase along path
  amplitude:     f32    // current amplitude factor (smoothly driven by terrain)
  padding:       f32
```

The `landDepth` counter replaces the binary terminated flag. It tracks how many consecutive steps a vertex has been inside terrain. This serves two purposes:
1. A vertex with `landDepth > 0` is inside terrain -- its amplitude is 0
2. When `landDepth` returns to 0 (vertex exits terrain), amplitude rebuilds from the terrain factor at the exit point, modulated by a diffraction-informed amplitude estimate (see Phase 2)

#### Per-step logic (modified from current)

```
1. Read previous vertex position and state
2. If landDepth > MAX_LAND_STEPS: freeze vertex (hard cutoff for very thick islands)
3. Evaluate terrain height at current position
4. Compute depth = tideHeight - terrainHeight

5. If depth <= 0 (on land):
   a. Increment landDepth
   b. Continue marching in the SAME direction as the last water-side step
      (refraction is meaningless on land; maintain direction continuity)
   c. Step size = baseStepSize (no depth-dependent speed on land)
   d. Set amplitude = 0
   e. Continue to step 10

6. If depth > 0 AND landDepth > 0 (just exited land):
   a. Reset landDepth = 0
   b. Amplitude starts at the terrain damping factor for this depth
      (the diffraction pass will boost this if neighbors are carrying energy)
   c. Resume normal refraction computation

7. Normal water march (unchanged from current):
   - Compute depth gradient
   - Compute refraction offset
   - Compute wave speed and adaptive step
   - Advance position
   - Compute terrain factor (shoaling + damping)
   - Compute convergence/divergence

8. Phase tracking (unchanged)
9. Write vertex to mesh buffer
10. Write state to ping-pong buffer
```

The `MAX_LAND_STEPS` cutoff prevents vertices from marching indefinitely through large landmasses. A value of `~50 steps` (covering ~100-200 feet of terrain at baseStepSize) is sufficient -- if a wave hasn't exited land by then, it won't contribute meaningful energy on the other side. Frozen vertices remain at amplitude 0 and their position is held constant.

### Phase 2: Diffraction

Diffraction is the hard requirement and the most architecturally significant addition. The approach uses a **two-pass per-step strategy**: first march all vertices normally (Phase 1 logic), then run a diffraction smoothing pass that spreads energy from active vertices into the shadow zone.

#### Why two passes per step

Diffraction is fundamentally a lateral phenomenon -- energy spreads sideways along the wavefront, from lit regions into shadow regions. This requires reading neighbor amplitudes, which means the march pass must complete before the diffraction pass reads its output. Two dispatches per step, with a barrier between them, achieve this cleanly on the GPU.

#### Diffraction pass logic

After the march dispatch writes all vertices for step N, the diffraction dispatch reads them and writes corrected amplitude/direction values:

```
For each vertex vi at step N:
  If amplitude > 0: skip (already lit, diffraction doesn't reduce energy)

  // Search for nearest lit neighbor on each side
  leftLitDist = 0
  leftLitAmplitude = 0
  for j = vi-1 down to max(vi - DIFFRACTION_KERNEL, 0):
    leftLitDist += distance(vertex[j+1], vertex[j])
    if vertex[j].amplitude > 0:
      leftLitAmplitude = vertex[j].amplitude
      break

  rightLitDist = 0
  rightLitAmplitude = 0
  for j = vi+1 up to min(vi + DIFFRACTION_KERNEL, vertexCount-1):
    rightLitDist += distance(vertex[j-1], vertex[j])
    if vertex[j].amplitude > 0:
      rightLitAmplitude = vertex[j].amplitude
      break

  // Diffracted amplitude decays as sqrt(wavelength / (2*pi*r))
  // This is the Huygens-Fresnel cylindrical spreading factor
  leftDiffracted = leftLitAmplitude * sqrt(wavelength / max(TWO_PI * leftLitDist, 0.01))
  rightDiffracted = rightLitAmplitude * sqrt(wavelength / max(TWO_PI * rightLitDist, 0.01))

  diffractedAmplitude = max(leftDiffracted, rightDiffracted)

  // Direction bends toward the diffraction source
  // (wave appears to emanate from the gap/edge)
  if leftDiffracted > rightDiffracted:
    bendAngle = atan2(vertexSpacing, leftLitDist) * diffractedAmplitude
  else:
    bendAngle = -atan2(vertexSpacing, rightLitDist) * diffractedAmplitude

  vertex[vi].amplitude = diffractedAmplitude
  vertex[vi].directionOffset += bendAngle
```

The `DIFFRACTION_KERNEL` radius (number of neighbors to search) should be proportional to wavelength. For typical wavelengths of 50-200 ft with vertex spacing of 2 ft, a kernel of 50-100 vertices covers 1-2 wavelengths laterally, which is sufficient for the first Fresnel zone.

#### Why this produces realistic diffraction

Consider a narrow bay inlet: as the wavefront passes through the gap, only the vertices aligned with the gap remain active. On the next step, the diffraction pass finds these lit vertices and spreads energy to their shadowed neighbors. Over many steps, this creates a fan of expanding wavefronts behind the inlet -- exactly the pattern you see in real wave diffraction through a slit.

For a headland (single edge diffraction), only one side has a lit neighbor. The energy fans inward from that edge, creating the classic circular wavefront that wraps around the obstacle.

The cylindrical spreading factor `sqrt(lambda / (2*pi*r))` is physically correct for 2D Huygens-Fresnel diffraction. It gives:
- Strong diffraction (more energy penetration) for long wavelengths
- Rapid decay for short wavelengths
- The correct `1/sqrt(r)` distance falloff for cylindrical waves

#### Diffraction through multiple gaps

When a wavefront encounters two islands side by side with a gap between them, the march + diffraction naturally handles it:

1. Vertices in the gap continue at full amplitude
2. Vertices behind the islands have amplitude 0 from the march pass
3. The diffraction pass spreads energy from the gap vertices into the shadow zones behind each island
4. On subsequent steps, the diffracted energy continues to spread, creating overlapping fans from the two edges of the gap

This is exactly how real waves behave -- the gap acts as a secondary source (Babinet's principle).

### Phase 3: Dispatch Loop Structure

The CPU orchestration loop changes from one dispatch per step to two:

```
for step in 1..numSteps:
  // Pass 1: March (advance positions, compute raw amplitude)
  Update march uniforms (prevStepOffset, outStepOffset, pingPong, etc.)
  Dispatch marchShader with (vertexCount, 1, 1) threads

  // Pass 2: Diffraction (spread energy laterally)
  Update diffraction uniforms (stepOffset, vertexCount, wavelength, etc.)
  Dispatch diffractionShader with (vertexCount, 1, 1) threads
```

Both dispatches can be in the same command encoder with an implicit barrier between compute passes. The diffraction pass reads from and writes to the same mesh vertex buffer (only modifying amplitude and direction at the current step offset), so no additional storage buffers are needed.

Total dispatches: `2 * numSteps` instead of `numSteps`. For ~100 steps, this is ~200 dispatches -- still lightweight.

## Handling Multiple Terrain Features in Sequence

The continuation-through-terrain design (Phase 1) naturally handles complex multi-island scenarios:

**Scenario: Wave passes between two islands, then hits coastline behind**

```
Step 0:   [... active active active active active ...]

Step 30:  [... active LAND LAND gap LAND LAND active ...]
          Island A         ↑         Island B
                      gap between islands

Step 31:  [... active 0    0    1.0  0    0    active ...]
          After march: gap vertex still active

Step 31d: [... active 0.3  0.5  1.0  0.5  0.3  active ...]
          After diffraction: energy spreads from gap edges

Step 60:  The fanned-out wavefront hits coastline behind islands.
          Vertices that reach the coast experience normal shoaling/damping.
          Some may enter land again (second blocking).
```

Key behaviors:
- The gap between islands carries full wavefront energy through
- Diffraction fans energy behind each island from the gap edges
- Vertices that emerge from Island A's shadow can then interact with additional terrain features downstream
- A vertex can enter land, exit, enter again -- each transition is handled by the `landDepth` counter

**Scenario: Wave hits a single large island with varied coastline**

Vertices enter land at different steps depending on island shape. Some exit the other side (if the island is narrow enough relative to `MAX_LAND_STEPS`). The diffraction pass continuously fills energy into shadow regions from both edges. Behind the island, two diffraction fans overlap and interfere, creating the characteristic bright/dark pattern of wave interference behind an obstacle.

## Convergence and Refraction Focusing

When refraction bends wavefronts toward each other (e.g., around a headland or into a bay), vertex spacing decreases. The current implementation handles this with:

```
convergenceFactor = sqrt(initialSpacing / currentSpacing)
```

This is physically correct -- wave energy flux is conserved, so amplitude scales as the inverse square root of the spacing between adjacent rays (Green's law for ray tubes).

### Convergence Limits

The current clamp `[0.1, 3.0]` should be tightened to `[0.1, 2.0]` to match the existing `maxShoaling` cap. When spacing approaches zero (caustic), the math diverges -- capping at 2.0 prevents infinite amplitudes while still producing visible focusing effects.

### Vertex Crossing (Caustics)

In extreme refraction, adjacent vertices can cross paths (the wavefront folds over itself). This happens at caustics -- focal points of converging wave energy. The current neighbor spacing calculation produces negative or near-zero spacing in this case, which the clamp handles.

A more robust approach: detect crossing by checking if the ordering of vertices along the wavefront has reversed:

```
let perpPosLeft = dot(leftPos - meshOrigin, perpDir);
let perpPosThis = dot(thisPos - meshOrigin, perpDir);
let perpPosRight = dot(rightPos - meshOrigin, perpDir);

// Vertices should maintain their ordering along the wavefront
let ordered = (perpPosLeft < perpPosThis) && (perpPosThis < perpPosRight);
if (!ordered) {
  // At a caustic: cap amplitude, don't use spacing ratio
  convergenceFactor = 2.0;  // max amplitude
}
```

This prevents the spacing calculation from producing nonsensical values when the wavefront topology breaks down.

### Convergence and Diffraction Interaction

Diffracted waves have lower amplitude and diverge from the diffraction source, so they naturally have increasing spacing (divergence factor < 1). This is correct -- diffracted energy spreads over a larger area. No special handling is needed; the standard convergence/divergence calculation works for both refracted and diffracted vertices.

## Memory Estimate

### Current Implementation (Regular Grid)

The current system uses uniform spacing:
- Vertex spacing: 2 ft along wavefront
- Step size: wavelength/8 (for wavelength=200ft, step=25ft)

For a typical level with coastline bounds ~2000x2000 ft plus margin:
- Along extent: ~3000 ft at step=25ft -> 120 steps
- Perp extent: ~3000 ft at spacing=2ft -> 1500 vertices
- Total: 120 * 1500 = 180,000 vertices
- Per vertex: 20 bytes (5 floats) = 3.6 MB per mesh
- With 8 wave sources: 28.8 MB total vertex data
- Index buffers: 6 indices per quad, 4 bytes each -> ~10.3 MB per mesh
- **Total: ~112 MB for 8 meshes** (vertex + index)

This fits well within the 128 MB per-mesh target and the 8 million vertex limit (180K * 8 = 1.44M total vertices).

### With Diffraction (No Grid Size Change)

The diffraction pass does not add vertices -- it modifies amplitudes of existing vertices. Memory cost is identical to the regular grid.

Construction uses additional temporary buffers:
- Ping-pong state: 2 * 1500 * 24 bytes = 72 KB (destroyed after construction)
- Uniform buffer: 64 bytes (destroyed after construction)
- Staging buffer for CPU readback: 3.6 MB (destroyed after construction)

**Total temporary memory during construction: ~4 MB per mesh, freed afterward.**

### Scaling to Larger Levels

For a large level with 5000x5000 ft coastline extent:
- Steps: ~280, Vertices: ~3500
- Total per mesh: 980K vertices * 20 bytes = 19.6 MB
- 8 meshes: ~157 MB vertex data + ~112 MB index data = ~269 MB

This exceeds the budget. Solutions (in order of preference):

1. **Increase vertex spacing** near open ocean (see Adaptive Density section below)
2. **Reduce step count** by increasing base step size in areas with low terrain interaction
3. **Mesh simplification** post-construction (see Enhancement Passes section)

With adaptive density, realistic large levels should stay under 8M total vertices.

### GPU Buffer Sizes

WebGPU `maxBufferSize` is typically 256 MB or 2 GB depending on adapter. A single 20 MB mesh vertex buffer is well within limits. The `maxStorageBufferBindingSize` (typically 128-256 MB) is also fine since each mesh is bound individually.

## Diffraction: Deep Dive

Since diffraction is a hard requirement, this section addresses the specific scenarios that must work.

### Narrow Bay Inlet

A narrow inlet (gap width ~ 1-3 wavelengths) is the canonical diffraction test case.

How the algorithm handles it:
1. The wavefront approaches the inlet. Most vertices hit land and continue with amplitude 0.
2. Vertices aligned with the inlet pass through at full amplitude.
3. On each subsequent step, the diffraction pass finds these few active vertices and spreads energy to neighbors.
4. After ~N steps, the diffracted wavefront has spread to cover an angular range of roughly `arctan(N * stepSize / halfGapWidth)` on each side.
5. The `sqrt(wavelength / (2*pi*r))` decay ensures proper energy falloff.

For a 50 ft gap with wavelength 200 ft (gap = lambda/4): strong diffraction, nearly hemispherical spreading behind the inlet. This matches physical reality -- when the gap is smaller than the wavelength, the wave diffracts broadly.

For a 400 ft gap with wavelength 200 ft (gap = 2*lambda): moderate diffraction at the edges, mostly geometric shadowing in the center. Energy penetrates ~1 wavelength into the geometric shadow region.

### Headland Diffraction

A wave passing a headland (single edge) experiences diffraction that bends energy around the tip:

1. Vertices along the exposed coastline terminate at different steps (curved coast = staggered termination).
2. The vertex at the headland tip is the last to enter land. Its immediate neighbor (still in water) becomes the diffraction source.
3. Energy fans from this edge vertex into the shadow zone behind the headland.
4. Over many steps, the diffracted wavefront curves around the headland, producing the characteristic pattern of waves wrapping around a point.

The direction offset in the diffraction pass bends wave direction toward the gap/edge, which accumulates over steps to create genuinely curved wavefronts -- not just attenuated straight lines.

### Overlapping Diffraction Sources

When two islands create two shadow edges that are both within `DIFFRACTION_KERNEL` distance of a shadow vertex, both contribute. The `max(leftDiffracted, rightDiffracted)` in the algorithm picks the stronger source. A more sophisticated approach would sum them (with phase), but for visual quality in a game, taking the maximum is sufficient and avoids the complexity of coherent phase addition across diffraction sources.

### Diffraction Limitations

This approach is a geometric optics + Huygens-Fresnel hybrid, not a full wave solver. Limitations:
- No coherent interference patterns in the shadow zone (would require tracking phase per diffraction source)
- Diffraction kernel is finite, so very wide shadow zones (>100 vertices) won't fully fill
- Diffraction is lateral only (along the wavefront); it doesn't model longitudinal diffraction

These limitations are acceptable for a sailing game -- the goal is visually plausible wave behavior, not exact physics. The approach captures the most visible effect: waves appearing to emanate from gaps and wrap around headlands.

## Enhancement and Simplification Passes

### Enhancement (Adding Vertices Where Values Change Rapidly)

**Assessment: Not needed and not recommended.**

The regular grid already provides resolution via the vertex spacing parameter. Near coastlines, the terrain factor changes rapidly, but this is captured by the per-vertex amplitude values -- linear interpolation across triangles produces smooth gradients even with coarse spacing, because the amplitude change is itself smooth (driven by the `smoothstep` in `computeDampingFactor`).

Enhancement would require:
- Changing vertex counts between rows (breaking the regular grid structure)
- Variable-length index generation
- More complex query lookup (can't estimate grid cell from position)
- GPU memory management for variable-size rows

The cost far outweighs the benefit. If resolution is insufficient near coastlines, the global vertex spacing parameter can be decreased (e.g., from 2 ft to 1 ft), doubling resolution everywhere at 2x memory cost. This is simpler and more predictable than adaptive enhancement.

### Simplification (Removing Unnecessary Vertices)

**Assessment: Useful for large levels, but should be a post-construction CPU pass, not a GPU operation.**

In open ocean, most vertices have `(1.0, 0.0, 0.0)` -- no modification from default. Adjacent wavefronts are nearly identical. Removing redundant geometry saves memory and rasterization cost.

#### Approach: Row Decimation

Instead of general edge-collapse simplification (which breaks the grid structure), use row decimation:

1. After all marching steps complete, read back vertex data to CPU
2. For each pair of adjacent rows (step N and step N+1):
   - Compute max difference across all vertices: `max(|ampN[i] - ampN+1[i]|, |dirN[i] - dirN+1[i]|, |phaseN[i] - phaseN+1[i]|) for all i`
   - If max difference < threshold (e.g., 0.01), mark step N+1 for removal
3. Build a new compacted mesh omitting marked rows
4. Regenerate index buffer for the compacted row set
5. Upload the compacted mesh to a new GPU buffer

This preserves the fixed-vertex-count-per-row invariant (critical for query lookup), while eliminating redundant wavefronts in open water.

**Expected savings:** In a typical level, the wavefront traverses ~80 steps of open ocean (no terrain interaction) and ~40 steps near coastlines. Row decimation could reduce the 80 open-ocean rows to ~5-10 rows, a ~70% reduction in total vertex count.

#### Column Decimation (Along Wavefront)

A similar approach could remove every other vertex along the wavefront in regions where lateral variation is minimal. However, this breaks the uniform vertex count per row, complicating both index generation and query lookup. Not recommended unless memory is extremely tight.

### Recommendation

For Phase 1, ship with the regular grid and no simplification. The memory estimates show typical levels fit well within budget. Add row decimation in a later phase if large levels push against the 8M vertex limit.

## GPU Architecture Details

### Shader Bindings

March shader (existing, modified):
```
@group(0) @binding(0) var<uniform> params: MarchParams;
@group(0) @binding(1) var<storage, read_write> meshVertices: array<f32>;
@group(0) @binding(2) var<storage, read_write> stateA: array<f32>;
@group(0) @binding(3) var<storage, read_write> stateB: array<f32>;
@group(0) @binding(4) var<storage, read> packedTerrain: array<u32>;
```

Diffraction shader (new):
```
@group(0) @binding(0) var<uniform> params: DiffractionParams;
@group(0) @binding(1) var<storage, read_write> meshVertices: array<f32>;
```

The diffraction shader only needs the mesh vertices buffer and its own uniforms. It reads vertex amplitudes at the current step offset, computes lateral energy spreading, and writes corrected amplitudes back. This keeps bindings under the 8-binding limit.

### DiffractionParams Uniform

```
DiffractionParams {
  stepOffset:      u32    // offset into meshVertices for current step
  vertexCount:     u32    // vertices per wavefront row
  wavelength:      f32    // for decay calculation
  vertexSpacing:   f32    // initial spacing (for distance estimate)
  diffractionKernel: u32  // max neighbor search radius
  _pad1:           u32
  _pad2:           u32
  _pad3:           u32
}
```

### Workgroup Considerations

Both shaders use workgroup size `[64, 1, 1]`. For 1500 vertices, this is 24 workgroups -- well within limits.

The diffraction shader could benefit from shared memory: loading a tile of vertex amplitudes into workgroup local memory to avoid redundant global reads during the neighbor search. With `DIFFRACTION_KERNEL = 64` and workgroup size 64, each workgroup loads 192 vertices (64 core + 64 halo on each side). This is:

```
192 vertices * 20 bytes = 3.84 KB per workgroup
```

Well within the typical 16 KB workgroup shared memory limit. Whether this optimization is needed depends on profiling -- the diffraction pass is already much cheaper than the march pass (no terrain height evaluations).

### Dispatch Ordering and Barriers

WebGPU guarantees that compute dispatches within a single command encoder execute in order, with implicit barriers between passes. The two dispatches per step (march + diffraction) can share a command encoder:

```typescript
const commandEncoder = device.createCommandEncoder();

// Pass 1: March
const marchPass = commandEncoder.beginComputePass();
marchShader.dispatch(marchPass, marchBindGroup, vertexCount, 1);
marchPass.end();

// Implicit barrier: march output is visible to diffraction input

// Pass 2: Diffraction
const diffPass = commandEncoder.beginComputePass();
diffractionShader.dispatch(diffPass, diffBindGroup, vertexCount, 1);
diffPass.end();

device.queue.submit([commandEncoder.finish()]);
```

Alternatively, both passes can be in the same compute pass with a `storageBarrier()` between them, but separate passes are clearer.

## Construction Time Estimate

Current construction for a 180K vertex mesh: ~100 dispatches, each dispatching 1500 threads doing 3 terrain height evaluations. The terrain height function traverses a contour tree (~10-30 iterations depending on tree depth).

With diffraction: ~200 dispatches (2 per step). The diffraction dispatch is cheap (~100 neighbor reads per thread, no terrain evaluation).

Expected wall-clock time: 100-500ms depending on GPU. The current implementation reports times in this range for the march-only version. The diffraction pass should add <50% overhead.

## Summary of Changes to Current Implementation

### WavefrontMarchShader.ts
- Replace binary `terminated` with `landDepth` counter in state
- Continue marching through land (amplitude 0, constant direction, base step size)
- Reset when exiting land (resume refraction, recompute terrain factor)
- Add crossing detection for convergence calculation

### New: WavefrontDiffractionShader.ts
- New compute shader: reads current step vertices, spreads energy laterally
- `DIFFRACTION_KERNEL` parameter controls search radius
- Cylindrical spreading amplitude decay
- Direction bending toward diffraction source

### WavefrontMeshBuilder.ts
- Create diffraction shader and its uniform buffer
- Modify dispatch loop: 2 dispatches per step
- Add `MAX_LAND_STEPS` parameter
- (Future) Add row decimation post-pass

### WavefrontMesh.ts
- No changes needed -- the mesh data structure is unchanged

### MarchParams uniform
- Add `maxLandSteps: u32` field
- Replace `terminated`-related padding with `landDepth` state field

## Open Questions

1. **Diffraction kernel size tuning.** The kernel should scale with wavelength/vertexSpacing. For wavelength=200ft and spacing=2ft, this is 100 vertices -- possibly expensive. Profiling will determine whether shared memory is necessary.

2. **Phase coherence in diffraction.** The current design does not track phase for diffracted waves. This means diffraction from two separate edges won't produce interference patterns. For a game, this is likely fine -- interference patterns are subtle and easily lost in the noise of multiple wave sources.

3. **Vertex spacing vs. wavelength.** The current hard-coded 2 ft spacing is far finer than wavelength/4 for long waves. This may be unnecessarily dense. A spacing of wavelength/8 to wavelength/4 (25-50 ft for lambda=200ft) would dramatically reduce vertex count but might under-resolve diffraction near edges. The vertex spacing should probably be a function of wavelength: `max(2.0, wavelength / 16)`.

4. **Row decimation threshold.** Needs tuning -- too aggressive and you get visible stepping in the mesh; too conservative and you save no memory. The threshold should probably be relative to the wave amplitude (a 0.01 absolute threshold is fine for amplitude factor but may be too tight for phase offset).
