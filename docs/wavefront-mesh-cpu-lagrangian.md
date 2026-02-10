# CPU Wavefront Marching (Lagrangian) Design

## Overview

A CPU-based wavefront marching algorithm that runs in web workers, constructing one triangle mesh per wave source. The key advantage over GPU marching: the CPU can dynamically insert and remove vertices during construction, adapting resolution to local complexity without preallocating a fixed grid.

Each wavefront is a polyline of vertices. At each marching step, every vertex advances along its local propagation direction. Between steps, vertices can be inserted where detail is needed (rapid attribute change, diffraction zones, convergence) or removed where the wavefront is smooth and uniform. Successive wavefronts are connected into triangles to form the final mesh.

## Algorithm

### Phase 1: Initialization

For a planar wave source, the initial wavefront is a straight line perpendicular to the wave direction, placed at the upwind edge of the simulation AABB (coastline bounds + margin, same as the current GPU builder). Vertices are spaced at `wavelength / 4` along this line, each with:

- `position`: world-space coordinates along the wavefront
- `direction`: unit vector, initially the base wave direction
- `amplitude`: 1.0 (open ocean)
- `accumulatedPhase`: 0.0
- `state`: `ACTIVE`

Terrain data is prepared as a CPU-side sampler -- either a precomputed heightfield grid, or a direct port of the contour-tree evaluation from `terrain.wgsl.ts` (see Terrain Sampling below).

### Phase 2: Wavefront Marching

Each marching step processes the current wavefront to produce the next one. For each active vertex:

1. **Terrain query**: Evaluate terrain height at the vertex position. Compute depth = tideHeight - terrainHeight.

2. **State transition**: If depth <= 0 (on land), set amplitude to 0, mark state as `ON_LAND`. The vertex does NOT stop -- it continues marching through the terrain with amplitude=0 (see Land Penetration below).

3. **Depth gradient**: Finite-difference terrain evaluation at (pos + delta_x) and (pos + delta_y) to compute the local depth gradient. For `ON_LAND` vertices, skip refraction -- just march straight.

4. **Refraction**: Apply Snell's law to bend the direction toward shallower water, identical to the existing `computeRefractionOffset` formula. The cumulative angle change is tracked per vertex.

5. **Wave speed & adaptive step**: Compute `speed = computeWaveSpeed(wavelength, depth)` for the local depth (or deep-water speed if on land). Step distance = baseStepSize \* (speed / deepSpeed), keeping wavefronts roughly evenly spaced in phase.

6. **Advance**: newPosition = position + direction \* stepDistance.

7. **Amplitude**: For water vertices, compute terrainFactor (shoaling \* damping) from the existing formulas. For on-land vertices, amplitude stays at 0.

8. **Phase tracking**: accumulatedPhase += k _ stepDistance. phaseOffset = accumulatedPhase - dot(newPosition, baseWaveDir _ k).

9. **Convergence/divergence**: Measure spacing between neighbors on the wavefront. convergenceFactor = sqrt(initialSpacing / currentSpacing). Multiply into amplitude, capped at 2.0.

10. **Direction offset**: directionOffset = currentAngle - baseWaveAngle.

After all vertices are advanced, the algorithm runs refinement passes (see Adaptive Detail below).

### Phase 3: Triangulation

Successive wavefronts are connected into triangles. Because vertex counts vary between wavefronts (due to insertion/removal), this is NOT a simple uniform grid. Instead, we use a sweep-line triangulation approach:

Given wavefront A (previous) with `m` vertices and wavefront B (current) with `n` vertices, we produce a triangle strip connecting them. Each vertex in A and B has a parametric position `t` along the wavefront (normalized arc length from 0 to 1). The triangulation advances two pointers, one on each wavefront, always connecting the next closest unconnected vertex:

```
i = 0, j = 0  // pointers into A and B
while i < m-1 or j < n-1:
  if i >= m-1:
    emit triangle(A[i], B[j], B[j+1]); j++
  elif j >= n-1:
    emit triangle(A[i], A[i+1], B[j]); i++
  elif t_A[i+1] < t_B[j+1]:
    emit triangle(A[i], A[i+1], B[j]); i++
  else:
    emit triangle(A[i], B[j], B[j+1]); j++
```

This produces a well-formed triangle strip with no gaps or overlaps, even when one wavefront has many more vertices than the other. The parametric position `t` ensures triangles don't cross or become severely skewed.

### Phase 4: Land Penetration

A critical design decision: vertices that hit land do NOT terminate. They continue marching through the terrain with amplitude=0, maintaining the wavefront's structural integrity. This ensures:

1. **Full domain coverage**: The mesh covers the entire simulation area, including the leeward side of islands. Without land penetration, there would be gaps in the mesh behind islands.

2. **Leeward-side wave representation**: On the far side of an island, land-penetrating vertices re-emerge into water. Their amplitude remains 0 (unless diffraction adds energy -- see below), but they provide the mesh connectivity needed for diffraction energy to interpolate smoothly from shadow edges into the lee.

3. **Consistent wavefront topology**: The triangulation between wavefronts remains well-defined. If vertices stopped at land, the wavefront would fragment, creating complex topology problems.

When an `ON_LAND` vertex's depth becomes positive again (re-entering water on the far side), it transitions to `SHADOWED` state: still amplitude=0, but now available to receive diffracted energy.

### Phase 5: Diffraction

Diffraction is the hard requirement. The CPU approach has a natural advantage here: we can detect diffraction conditions and insert new geometry dynamically.

#### Detection

At each marching step, scan the wavefront for **shadow-edge transitions**: adjacent vertex pairs where one is `ACTIVE` (in water with amplitude > 0) and the other is `ON_LAND` or `SHADOWED`. These transition points are diffraction source locations.

#### Huygens-Fresnel Wavelet Model

At each shadow-edge vertex, model the tip of the obstacle as a secondary wave source (Huygens' principle). The diffracted wave radiates from the tip into the shadow zone with:

- **Amplitude decay**: `A_diffracted = A_incident * sqrt(wavelength / (2*pi*r))` where `r` is the distance from the diffraction tip. This is the cylindrical spreading factor for a line source.

- **Direction**: Diffracted energy fans into the shadow zone. The angle range is approximately `[-pi/2, pi/2]` relative to the incident wave direction at the shadow edge, centered on the shadow boundary.

- **Phase**: The diffracted wave inherits the phase of the incident wave at the tip, then accumulates additional phase proportional to the distance traveled from the tip.

#### Implementation

At each marching step, for each shadow-edge pair:

1. Identify the diffraction tip position (the last `ACTIVE` vertex's position at the obstacle boundary).

2. For `SHADOWED` vertices on the leeward side (the neighbors on the land/shadow side), compute their distance `r` from the tip.

3. Compute the diffracted amplitude: `A_incident_at_tip * sqrt(wavelength / (2*pi*r))`.

4. Compute the diffracted direction: the vector from the tip to the shadowed vertex, normalized. This naturally curves around the obstacle.

5. The shadowed vertex receives the diffracted amplitude (replacing its 0 amplitude), the diffracted direction offset, and a phase offset computed from the tip's phase plus `k * r`.

6. If there are two shadow edges (left and right sides of an island), both contribute diffracted energy to the shadow zone. Vertices between the two edges receive the sum of both diffracted contributions (energy adds, not amplitude -- so sum the squared amplitudes and take the square root).

#### Why CPU is better for diffraction

On the GPU, diffraction requires non-local communication: a shadow-edge vertex needs to influence vertices arbitrarily far away across the wavefront. The fixed-grid GPU approach handles this awkwardly -- you'd need extra passes or complex indexing. On the CPU, we simply iterate over the wavefront, find shadow edges, and update all affected vertices in a single pass.

Additionally, the CPU can insert extra vertices in the diffraction fan to capture the rapid amplitude falloff near shadow edges (see Adaptive Detail below).

### Phase 6: Adaptive Detail

This is the primary advantage of CPU construction. After each marching step, two refinement passes run:

#### Insertion Pass

Scan adjacent vertex pairs on the new wavefront. Insert a midpoint vertex if any of these conditions hold:

1. **Amplitude gradient**: `|amplitude[i+1] - amplitude[i]| > threshold_amp` (e.g., 0.15). This catches shadow edges, shoreline transitions, and diffraction zones.

2. **Direction gradient**: `|directionOffset[i+1] - directionOffset[i]| > threshold_dir` (e.g., 0.1 radians). This catches strong refraction.

3. **Phase gradient**: `|phaseOffset[i+1] - phaseOffset[i]| > threshold_phase` (e.g., pi/4 radians). This catches wavefront curvature from refraction.

4. **Geometric spacing**: `distance(pos[i], pos[i+1]) > max_spacing` (e.g., wavelength / 2). Prevents overly sparse coverage regardless of attribute smoothness.

The inserted midpoint vertex is computed by interpolating position and attributes from the two neighbors, then re-evaluating terrain/refraction at the interpolated position to get accurate values. This is a full terrain-query + physics evaluation, not just linear interpolation.

Insertion is recursive up to a depth limit (e.g., 3 levels, giving 8x refinement in the densest areas). In practice, 1-2 levels suffice for most situations.

#### Removal Pass

After insertion, scan for vertices that can be removed without losing accuracy:

1. **Redundant vertex**: If removing a vertex and linearly interpolating from its neighbors would change amplitude by < `epsilon_amp` (e.g., 0.02), direction by < `epsilon_dir` (e.g., 0.02 radians), and phase by < `epsilon_phase` (e.g., 0.05 radians), the vertex is redundant.

2. **Minimum spacing**: Never remove vertices if it would create spacing > `max_spacing`.

3. **Shadow edges**: Never remove vertices adjacent to a shadow-edge transition (they're needed for diffraction).

#### Should the algorithm get it right on the first pass?

Partially. The dynamic step logic (terrain evaluation, refraction, convergence) produces accurate attributes on the first pass. However, the vertex density of the previous wavefront determines where you have data points on the next wavefront. Without refinement, you might miss a narrow feature (e.g., a small gap between islands) because no vertex happened to land in it.

The insertion pass addresses this: it detects where the wavefront needs more detail and adds it. A single insertion pass per step (not iterating to convergence) is sufficient for most cases, since the refined vertices carry forward to the next step. Over a few steps, detail propagates to where it's needed.

The removal pass is primarily valuable in open ocean far from terrain, where the initial spacing of `wavelength/4` is denser than needed (all attributes are uniform). It can also remove vertices that were inserted for a previous feature but are now in a smooth region.

## Handling Multiple Terrain Features

### Sequential islands (wave passing between two islands, then hitting coastline)

The wavefront marches as a single continuous polyline. When it encounters the first pair of islands:

1. Vertices hitting island A become `ON_LAND` and continue through.
2. Vertices in the gap between islands A and B remain `ACTIVE`.
3. Vertices hitting island B become `ON_LAND`.
4. Diffraction from island A's shadow edges adds energy to vertices in A's shadow.
5. Diffraction from island B's shadow edges adds energy to vertices in B's shadow.
6. Vertices between the islands receive full wave energy (reduced only by any refraction effects from the bathymetry between them).

When the wavefront reaches the coastline behind the islands:

7. The gap-passing vertices hit the coastline with near-full energy (shoaling + damping apply normally).
8. Vertices that emerged from island A's shadow hit the coastline with diffracted energy.
9. Vertices still inside island B's shadow hit the coastline with near-zero energy (unless diffraction from B's edges reaches them).

The key insight: the wavefront is always a single connected polyline spanning the full simulation width. Land penetration ensures there are never "holes" in the wavefront. Each vertex independently tracks its amplitude based on the terrain it has traversed.

### Convergence from refraction

When refraction focuses wave energy (e.g., around a headland), wavefront vertices bunch together. The convergence factor `sqrt(initialSpacing / currentSpacing)` increases amplitude appropriately.

If vertices become very close together (spacing < wavelength/16), the removal pass can thin them out, but only if attributes are smoothly varying. Near a focus point where amplitude is changing rapidly, vertices are kept dense.

The amplitude cap of 2.0 prevents unrealistic energy concentration. In physical terms, this represents wave breaking at the focus point. The cap is already in the existing codebase (`maxShoaling = 2.0`).

If wavefront vertices cross (spacing becomes negative), this indicates a caustic. The algorithm handles this by capping the convergence factor and keeping amplitude at the cap value. The triangulation handles crossed vertices gracefully because it uses parametric position `t`, not geometric position, to determine connectivity.

### Narrow passages (waves entering a bay through a narrow inlet)

This is the most demanding scenario for diffraction. A wave approaching a narrow inlet:

1. Most of the wavefront hits land on either side of the inlet -- these vertices go `ON_LAND` and continue through.
2. A small number of vertices pass through the inlet with full energy.
3. Once through the inlet, diffraction from both sides of the inlet causes the wave to spread laterally into the bay.

The result: the wave appears to radiate from the inlet as a new point source. This is physically correct (Huygens' principle) and visually distinctive.

The adaptive insertion pass is critical here: without it, the few vertices passing through the inlet might not provide enough resolution for the expanding diffraction fan. The insertion pass detects the rapid amplitude gradient at the edges of the diffraction zone and adds vertices there.

For very narrow inlets (width < wavelength), the entire wave passes through with reduced amplitude proportional to `inlet_width / wavelength`. This is the diffraction limit.

## Memory Estimate

### Per-vertex storage

Each mesh vertex stores 5 floats = 20 bytes (matching the existing `VERTEX_FLOATS = 5` in `WavefrontMesh.ts`):

- positionX, positionY (f32 each)
- amplitudeFactor (f32)
- directionOffset (f32)
- phaseOffset (f32)

### Typical level dimensions

Using the default level as reference:

- Coastline bounds: roughly -1500 to 3200 in both axes (~4700ft extent)
- Margin: 3 \* wavelength = 600ft
- Simulation AABB: ~5900ft x 5900ft
- Wavelength: 200ft

### Vertex counts

**Base wavefront**: 5900 / (200/4) = 5900 / 50 = 118 vertices.

**After adaptive refinement** near terrain: expect 2-3x more vertices near islands, staying at base density in open ocean. Typical wavefront: ~200-350 vertices.

**Marching steps**: 5900 / (200/8) = 5900 / 25 = 236 steps. With adaptive step distance varying by depth, call it ~250 steps.

**Total vertices per mesh**: 250 steps \* ~250 avg vertices = ~62,500 vertices.

**Memory per mesh**: 62,500 \* 20 bytes = 1.25 MB.

**With index buffer**: ~62,500 _ 6 indices/vertex _ 4 bytes = ~1.5 MB (triangulation produces roughly 2 triangles per vertex, 3 indices each).

**Total per mesh**: ~2.75 MB. For 8 wave sources: **~22 MB total**. Well under the 128 MB target per mesh.

### Worst-case scenario

A complex level with many islands and narrow passages could increase vertex density significantly:

- Wavefronts near complex terrain: up to 1000 vertices (4x base).
- Diffraction fans add vertices in shadow zones.
- Conservative upper bound: 500 steps \* 500 avg vertices = 250,000 vertices per mesh.
- Memory: 250,000 \* 20 = 5 MB per mesh, 40 MB for 8 sources.

Still well under the 8 million vertex budget (which would be 160 MB at 20 bytes/vertex). The adaptive approach is inherently memory-efficient because it only adds detail where needed.

### Construction-time memory

During construction, each wavefront is held in memory temporarily for the adaptive passes and triangulation. Peak memory usage is approximately:

- Current wavefront: ~500 vertices \* (20 bytes vertex + 20 bytes march state) = ~20 KB
- Previous wavefront: same, ~20 KB
- Growing vertex buffer: up to 5 MB (final mesh)
- Growing index buffer: up to 5 MB
- Terrain sampler data: ~1-10 MB depending on representation

Total construction memory: **~20 MB peak**, well within web worker limits.

## Diffraction Design (Detailed)

Since diffraction is a hard requirement, this section expands on the design.

### Single-edge diffraction

The simplest case: a wave passing the tip of a breakwater or headland. One side of the wavefront is active, the other is blocked.

At each step, the shadow-edge vertex (the last active vertex before the blocked region) acts as a virtual point source. The diffracted wavelet spreads into the shadow zone with:

```
A_diffracted(r, theta) = A_tip * sqrt(lambda / (2*pi*r)) * D(theta)
```

Where:

- `r` = distance from the diffraction tip
- `theta` = angle into the shadow zone (0 = along the shadow boundary, pi/2 = directly behind the obstacle)
- `D(theta)` = angular distribution factor, approximated as `cos(theta/2)` for `theta in [0, pi]`

The `cos(theta/2)` factor captures the physical reality that diffracted energy is strongest near the shadow boundary and weakest directly behind the obstacle.

### Double-edge diffraction (island shadow)

An island blocks the wave on both sides, creating two shadow edges. Each edge diffracts independently. In the region behind the island, both diffracted wavelets overlap.

Energy addition: `A_total = sqrt(A_left^2 + A_right^2)` (incoherent addition -- phase-coherent addition would require tracking the phase of each diffracted wavelet separately, which adds complexity. Incoherent addition is a reasonable approximation and avoids interference fringes that would be visually noisy).

### Diffraction around multiple obstacles

When the wavefront encounters multiple obstacles in sequence (e.g., a chain of islands), diffraction occurs at each shadow edge independently. The first island creates a diffraction pattern. The second island then diffracts the already-diffracted wave. The CPU approach handles this naturally: the wavefront carries the cumulative amplitude from all previous interactions, and each new shadow edge creates new diffraction from whatever amplitude exists at that edge.

### Inlet diffraction

For a narrow gap between two obstacles:

1. Vertices passing through the gap have amplitude reduced by the finite gap width: `A_gap = A_incident * min(1.0, gap_width / wavelength)`.
2. On the far side, diffraction from both edges of the gap causes the wave to spread.
3. The result looks like a point source at the gap, with amplitude decaying as `1/sqrt(r)` from the gap center.

This is the correct physical behavior and produces the most visually distinctive diffraction effect.

### Limitations

- **No interference fringes**: Using incoherent addition avoids oscillating amplitude patterns that would be difficult to resolve on the mesh and visually noisy. This is a deliberate simplification.
- **Diffraction range**: The `1/sqrt(r)` decay means diffracted energy becomes negligible at distances > ~10 wavelengths from the tip. Beyond this range, the mesh naturally smooths to amplitude=0 in the shadow.
- **Single-frequency diffraction**: Each wave source has one wavelength, so we don't need to handle frequency-dependent diffraction.

## Web Worker Architecture

### Worker Design

Each wave source's mesh is built by a separate web worker. The workers are independent -- no shared state, no inter-worker communication. The main thread spawns N workers (one per wave source), sends each the input data, and collects results.

```
Main Thread                          Worker N
-----------                          --------
serialize terrain data  ------>      receive terrain data
serialize wave source   ------>      build CPU terrain sampler
                                     initialize wavefront
                                     for each step:
                                       march vertices
                                       diffraction pass
                                       insertion pass
                                       removal pass
                                       triangulate to previous wavefront
                                     serialize mesh data
collect mesh data       <------      post result
upload to GPU buffers
```

### Data Transfer

**Main -> Worker**:

- Terrain contour data (control points, heights, tree structure). Serialized as ArrayBuffers for zero-copy transfer using `postMessage` with `Transferable` objects. Or structured clone of the contour data arrays.
- Wave source parameters (direction, wavelength, etc.).
- Simulation AABB bounds.
- Tide height, default depth.

**Worker -> Main**:

- Vertex data as `Float32Array` (transferable -- zero-copy back to main thread).
- Index data as `Uint32Array` (transferable).
- Mesh metadata (numSteps, vertexCount, origin, directions, etc.).

Using transferable ArrayBuffers avoids copying the mesh data. The worker allocates the buffers, the main thread receives ownership, and uploads directly to the GPU.

### Terrain Sampling in Workers

Workers don't have access to WebGPU, so terrain height evaluation must be done on the CPU. Two options:

**Option A: Port the contour-tree algorithm to JavaScript**

Translate the `computeTerrainHeight` logic from WGSL to TypeScript. The algorithm is:

1. DFS pre-order traversal of the contour containment tree.
2. Winding-number test for point-in-polygon (fast, exact for the pre-sampled polygon).
3. IDW blending between parent and child contour heights.

This is straightforward to implement (the WGSL code is already clear) and gives exact consistency with the GPU terrain evaluation. The contour data (pre-sampled polygons, tree structure) is sent to the worker.

Performance: Each terrain query requires iterating polygon edges for winding tests. With ~20 control points _ 8 samples/segment = 160 polygon points per contour, and ~7 contours, that's ~1120 point-left-of-segment tests per terrain query in the worst case (much less with DFS skip + bbox culling). At 3 terrain queries per vertex per step (center + 2 for gradient), this is ~3360 tests per vertex per step. With ~250 vertices _ 250 steps = 62,500 vertex-steps, that's ~210 million point tests total. At ~10ns per test (branch-heavy but cache-friendly), that's ~2.1 seconds.

**Option B: Precompute a terrain heightfield grid**

Before spawning workers, sample the terrain on a regular grid (e.g., 5ft resolution over the simulation AABB). At 5900/5 = 1180 cells per axis, that's 1.4M grid cells \* 4 bytes = 5.6 MB. Send this grid to all workers as a shared ArrayBuffer (or copy per worker).

Workers evaluate terrain height with bilinear interpolation of the grid: 4 lookups + 3 multiplies. Vastly faster than the contour-tree algorithm.

Downside: 5ft resolution introduces some smoothing near sharp contour boundaries. For wavefront marching purposes (where the step size is 25ft and vertex spacing is 50ft), this is negligible.

**Recommendation**: Option B (precomputed grid). The performance difference is substantial, and the accuracy loss is irrelevant at the mesh's spatial resolution. The grid is computed once on the main thread (or in a separate worker) and shared with all wavefront workers.

### Parallelism

With N wave sources, spawn N workers running simultaneously. On a typical 8-core machine, up to 8 workers can run in true parallel. Each worker's construction is independent.

The workers can also be spawned on-demand from a pool to avoid the overhead of creating new workers for each level load.

## Performance Analysis

### Per-vertex cost

Each vertex per step requires:

- 3 terrain lookups (center + gradient): ~15ns with grid interpolation, ~3us with contour tree
- Refraction computation: ~50ns (trig functions)
- Phase/amplitude/convergence: ~20ns
- Adaptive insertion check: ~10ns
- Total: **~100ns per vertex per step** (with grid terrain), **~3.1us** (with contour tree)

### Total construction time per mesh

With grid terrain:

- 250 steps _ 250 avg vertices _ 100ns = ~6.25ms per mesh
- Diffraction pass adds ~20% overhead: ~7.5ms
- Adaptive insertion adds ~30% overhead: ~9.75ms
- Triangulation: ~2ms
- **Total: ~12ms per mesh**

With contour-tree terrain:

- 250 steps _ 250 avg vertices _ 3.1us = ~194ms per mesh
- With overhead: **~250ms per mesh**

### Total construction time for all wave sources

- Grid terrain, 8 workers in parallel: **~12ms** (limited by slowest worker)
- Contour tree, 8 workers in parallel: **~250ms**
- Grid terrain, sequential: ~96ms
- Contour tree, sequential: ~2 seconds

**Comparison with current GPU approach**: The GPU builder dispatches ~250 compute passes with 250 threads each. GPU compute passes have significant dispatch overhead (~50-100us per dispatch for small workloads). Total GPU time: 250 \* 100us = ~25ms, plus ~10ms for buffer readback. Total: ~35ms. But this blocks the main thread for the dispatch loop orchestration and requires WebGPU access.

The CPU approach with grid terrain is competitive with or faster than the GPU approach for this workload size, and has the advantage of not blocking the GPU during construction. The GPU is free to render frames while workers build meshes in the background.

### Data transfer overhead

- Terrain grid: 5.6 MB, transferred once, ~2ms
- Mesh result: ~2.75 MB per mesh, ~1ms transfer
- GPU upload: device.queue.writeBuffer of vertex + index data, ~0.5ms per mesh

Total overhead: **~5ms per mesh** for data transfer + GPU upload.

### End-to-end estimate

For the typical case (8 wave sources, grid terrain, 8 workers):

1. Precompute terrain grid: ~50ms (main thread, one-time)
2. Spawn workers + transfer data: ~5ms
3. Wavefront construction (parallel): ~12ms
4. Collect results + GPU upload: ~8ms
5. **Total: ~75ms**

This is well within the target of <500ms at level load.

## Comparison with GPU Approach

| Aspect                  | GPU Marching                            | CPU Lagrangian                                |
| ----------------------- | --------------------------------------- | --------------------------------------------- |
| Vertex count            | Fixed per row                           | Dynamic, adapts to local complexity           |
| Memory efficiency       | Uniform density everywhere              | Dense near terrain, sparse in open ocean      |
| Diffraction             | Requires extra passes, non-local writes | Natural: iterate wavefront, update neighbors  |
| Land handling           | Vertices terminate, stay in place       | Vertices penetrate land, emerge on far side   |
| Triangulation           | Uniform grid, trivial                   | Variable vertex count, sweep-line             |
| Construction speed      | ~35ms (GPU compute)                     | ~12ms (grid terrain) to ~250ms (contour tree) |
| GPU during construction | Blocked by dispatches                   | Free for rendering                            |
| Complexity              | WGSL compute shader, ping-pong buffers  | TypeScript, straightforward loops             |
| Debugging               | Hard (GPU readback)                     | Easy (console.log, breakpoints)               |

### When to prefer CPU

- Diffraction is required (hard requirement in this project)
- Terrain is complex with narrow passages
- GPU resources are constrained
- Debugging and iteration speed matter

### When to prefer GPU

- Very large meshes (millions of vertices)
- Uniform resolution is acceptable
- No diffraction needed
- GPU has spare capacity during loading

## API Design

```typescript
// Main thread
const builder = new CpuWavefrontMeshBuilder();

// Build all meshes in parallel
const meshes = await builder.buildAll(
  waveSources,        // WaveSource[]
  terrainDef,         // TerrainDefinition
  defaultDepth,       // number
  tideHeight,         // number
  coastlineBounds,    // AABB | null
);

// Each mesh: { vertexData: Float32Array, indexData: Uint32Array, metadata: MeshMetadata }
// Upload to GPU
for (const mesh of meshes) {
  const vertexBuffer = device.createBuffer({ ... });
  device.queue.writeBuffer(vertexBuffer, 0, mesh.vertexData);
  // etc.
}
```

The builder manages the worker pool internally. The returned data is in the same format as the existing `WavefrontMesh` class expects, so integration with the existing rendering and query systems requires no changes to consumers.

## Open Questions and Tradeoffs

### Terrain grid resolution

5ft resolution is recommended for the grid. At this resolution, the coastline is approximated to within ~3.5ft (diagonal of a grid cell). Since the mesh vertex spacing is ~50ft, this introduces negligible error. If higher fidelity is needed near coastlines, the grid could use non-uniform resolution (finer near coastlines), but this adds complexity for minimal benefit.

### Diffraction coherence

The design uses incoherent addition of diffracted wavelets (summing energy, not amplitude). This avoids interference fringes but also prevents constructive interference in the overlap zone behind an island. The visual effect is a smooth "shadow fill" rather than a physically accurate interference pattern. For a game, this is the right tradeoff -- interference fringes would look noisy and artificial at game resolution.

### Worker reuse

Workers should be kept alive between level loads to avoid creation overhead (~50ms per worker). A worker pool of 8 workers can be created at game startup and reused for each level.

### Incremental construction

For tidal variation, we could build meshes at 2-3 tide levels and interpolate. The CPU approach makes this cheap: build 3 meshes per source in the background during loading, total ~36ms with 8 parallel workers. Store all three and interpolate per-frame on the GPU during rasterization.
