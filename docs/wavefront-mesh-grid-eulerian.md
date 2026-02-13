# Wave Terrain Mesh -- Grid-Based Eulerian Approach

## Overview

Start with a regular grid covering the entire domain. Compute wave modification properties (amplitude factor, direction offset, phase offset) at every grid vertex using an Eulerian solver. Then apply adaptive simplification (remove vertices in uniform regions) and enhancement (add vertices where values change rapidly) to produce the final mesh.

The appeal is conceptual simplicity: the initial grid is trivially parallel, every point is computed independently with the same solver, and there are no path-dependency or topological concerns. The complexity lives in the solver (eikonal/Helmholtz equation) and the adaptive refinement passes.

## Phase Computation: The Eikonal Equation

The core computation is finding the phase field -- how long it takes the wave to reach each point. From the phase field, direction and amplitude follow naturally.

### The Eikonal Equation

The wave phase satisfies the eikonal equation:

```
|grad(phi)| = 1 / c(x, y)
```

where `phi(x, y)` is the travel time (or phase) at point `(x, y)`, and `c(x, y)` is the local wave phase speed. The phase speed depends on depth via the dispersion relation already implemented in `fn_computeWaveSpeed`:

- Deep water (depth > wavelength/2): `c = sqrt(g * wavelength / (2 * pi))`
- Shallow water (depth < wavelength/20): `c = sqrt(g * depth)`
- Intermediate: `c = sqrt(g * tanh(k * depth) / k)`

### Fast Marching Method (FMM)

The standard algorithm for solving the eikonal equation on a grid is the **Fast Marching Method** (Sethian, 1996). It's the continuous analog of Dijkstra's algorithm:

1. **Initialize**: Mark all grid points as "far." Set source points (the upwind boundary of the domain, perpendicular to the wave direction) to known phase values. Add them to a min-heap ordered by phase value.

2. **March**: Extract the point with smallest phase from the heap. Mark it as "known." For each of its grid neighbors that aren't "known," compute a tentative phase using the eikonal update stencil. If the tentative phase is less than the neighbor's current phase, update it and push/update it in the heap.

3. **Eikonal update stencil**: For a grid point at `(i, j)` with grid spacing `h`, the update solves:

   ```
   max(D_x^- phi, -D_x^+ phi, 0)^2 + max(D_y^- phi, -D_y^+ phi, 0)^2 = 1/c(i,j)^2
   ```

   where `D_x^-` and `D_x^+` are backward/forward differences. In practice, this reduces to solving a quadratic using the smallest known neighbor values in each axis direction.

4. **Termination**: All grid points are "known" when the heap is empty.

**Complexity**: O(N log N) where N is the number of grid points. The log N comes from the heap operations.

### Deriving Direction and Amplitude from Phase

Once the phase field `phi` is computed:

- **Direction**: `theta(x, y) = atan2(-dphi/dy, -dphi/dx)`. The gradient of the phase field points along the wavefront normal, which is the propagation direction. Compute via central finite differences on the grid.

- **Phase offset**: `phaseOffset = k * c_deep * phi(x,y) - dot(pos, baseWaveDir * k)`. The first term is the true accumulated phase along the curved path; the second is the straight-line prediction.

- **Amplitude factor**: From conservation of wave energy flux along ray tubes. The amplitude factor is related to the Jacobian of the ray mapping:

  ```
  A(x,y) = A_0 * sqrt(c(x,y) / c_deep) * sqrt(J_0 / J(x,y)) * terrainFactor(depth)
  ```

  where `J` is the divergence of the ray field, derivable from the second derivatives of the phase field:

  ```
  J(x,y) ~ 1 / laplacian(phi)  (simplified)
  ```

  More precisely, we compute the **ray tube spreading** from the Hessian of the phase field. Adjacent rays converge where the wavefront curvature is concave (amplitude increases) and diverge where convex (amplitude decreases). The `terrainFactor(depth)` from `fn_computeWaveTerrainFactor` handles shoaling and damping.

  Practical formula for convergence:

  ```
  divergence = d^2(phi)/dx^2 + d^2(phi)/dy^2   (Laplacian)
  convergenceFactor = sqrt(k / max(|divergence * c|, k * 0.01))
  amplitudeFactor = terrainFactor * clamp(convergenceFactor, 0.1, 2.0)
  ```

### Land Handling

Grid points where `depth <= 0` (on land) are marked as blocked:

- Phase = infinity (never reached by the wave)
- Amplitude factor = 0
- These points act as obstacles in the FMM -- the wavefront flows around them

The damping formula in `fn_computeWaveTerrainFactor` already smoothly drives amplitude toward 0 as depth approaches 0, creating soft coastlines without special handling.

## Initial Grid

### Resolution Choice

The grid must be fine enough to capture the important wave-terrain features before simplification. The critical length scales are:

1. **Wavelength**: The primary wave has wavelength 200 ft. We need at least 4 points per wavelength to capture phase variation: **50 ft spacing**.
2. **Terrain features**: The narrowest feature (bay inlet between islands) is roughly 200-400 ft. At 50 ft spacing, we get 4-8 points across. But for diffraction, the Fresnel zone scale is `sqrt(wavelength * distance)` -- for distance 500 ft and wavelength 200 ft, that's ~300 ft. We need to resolve this zone, so 50 ft is adequate.
3. **Refraction gradients**: The steepest depth gradients occur at the shelf edge (depth contour at -20 ft, roughly 200 ft wide). 50 ft spacing gives 4 points across this transition -- marginal. For the initial grid, **25 ft spacing** is safer to ensure the solver captures the refraction curvature correctly. Simplification will remove unnecessary points afterward.

**Chosen initial spacing: 25 ft**.

### Domain Size

From the default level data, the terrain spans roughly:

- X: -1900 to 2500 ft (4400 ft range)
- Y: -2700 to 3700 ft (6400 ft range)

With 3 wavelengths (600 ft) margin on each side:

- X: -2500 to 3100 ft (5600 ft)
- Y: -3300 to 4300 ft (7600 ft)

At 25 ft spacing:

- Grid dimensions: 225 x 305 = **~68,600 grid points**

This is very manageable. Even a more complex level with 2x the domain would be ~274,000 points -- still tiny.

### Memory During Construction

Per grid point during FMM:

- Phase value: 4 bytes (f32)
- Speed cache: 4 bytes (f32)
- Status flag (far/trial/known): 1 byte
- Heap index: 4 bytes (u32)
- Depth cache: 4 bytes (f32)
- Total: ~17 bytes per point

For 68,600 points: **~1.2 MB**. Negligible.

After FMM, we also store per-point:

- Direction (2 f32): 8 bytes
- Amplitude factor (f32): 4 bytes
- Phase offset (f32): 4 bytes
- Position (2 f32): 8 bytes
- Total per vertex: 24 bytes

For 68,600 points: **~1.6 MB**. Still negligible.

Even for a grid 10x larger (686,000 points at ~12 ft spacing), total memory is under 30 MB during construction. This approach is extremely memory-efficient.

## Simplification Pass

After computing all wave properties on the initial grid, we simplify to remove vertices where interpolation adequately approximates the true values.

### Error Metric

For each vertex, compute the interpolation error: the difference between the vertex's actual values and what bilinear interpolation from its neighbors would predict.

```
error = max(
  |actual.amplitudeFactor - interpolated.amplitudeFactor| * w_amplitude,
  |actual.directionOffset - interpolated.directionOffset| * w_direction,
  |actual.phaseOffset     - interpolated.phaseOffset|     * w_phase
)
```

Weights normalize the different quantities to a common scale:

- `w_amplitude = 1.0` (amplitude factor ranges 0-2)
- `w_direction = 1.0 / 0.5` (direction offsets rarely exceed 0.5 rad)
- `w_phase = 1.0 / PI` (phase offsets can be several radians)

### Algorithm: Quadtree Collapse

Rather than operating on individual vertices, use a **quadtree simplification**:

1. Overlay a quadtree on the regular grid. The root cell covers the entire domain.
2. For each leaf cell (initially 1x1 grid cells), compute the maximum interpolation error across all interior vertices if the cell were collapsed to just its 4 corner vertices.
3. If the max error < threshold (e.g., 0.02 for amplitude, 0.01 rad for direction), collapse: remove interior vertices, keep corners.
4. Repeat hierarchically: merge 4 sibling cells into their parent if the parent's corners adequately represent all interior points.
5. Stop when no more merges are possible.

This naturally produces large cells in open ocean (where all values are near default) and small cells near terrain where values change rapidly.

**Threshold tuning**: Start with `error_threshold = 0.02` (2% amplitude error). This is invisible to the player since the mesh is rasterized to a screen-space texture (much lower resolution than the mesh itself).

### Triangulation of the Quadtree

A quadtree produces a **graded mesh** with hanging nodes (T-junctions where a large cell borders a small cell). Resolve these with constrained triangulation:

- For each cell edge shared between cells of different sizes, insert the smaller cell's midpoint into the larger cell's edge.
- Triangulate each cell by connecting its center to all boundary points (center-fan triangulation), or use simple split patterns:
  - 4-corner cell -> 2 triangles
  - Cell with 1 hanging node on one edge -> 3 triangles
  - Cell with hanging nodes on multiple edges -> more triangles, but the pattern is deterministic

The maximum grading ratio should be 2:1 (no cell more than one level different from its neighbor). This is a standard quadtree constraint that prevents degenerate triangles.

### Expected Simplification

In open ocean, all values are `(1.0, 0.0, 0.0)`. The quadtree will collapse to the maximum cell size (~800x800 ft at depth 5). For a 5600x7600 ft domain, that's roughly 10x10 = 100 cells in open ocean.

Near terrain, cells stay small. The coastal zone (within ~2 wavelengths = 400 ft of any coastline) might be 30% of the domain by area but needs full resolution. Rough estimate:

- Open ocean: ~100 large cells -> ~200 triangles
- Transition zone: ~2000 medium cells -> ~4000 triangles
- Coastal zone: ~20,000 small cells -> ~40,000 triangles
- **Total: ~45,000 triangles, ~25,000 vertices**

This is well under the 8 million vertex budget, leaving enormous headroom for more complex levels.

## Enhancement Pass

After simplification, check whether any regions need additional resolution beyond the initial grid. This addresses cases where the initial 25 ft spacing was too coarse.

### When Enhancement is Needed

1. **Sharp refraction gradients**: Where the depth gradient changes abruptly (e.g., at a shelf edge), the direction offset field has high curvature. If the interpolation error exceeds the threshold at any triangle's centroid, subdivide that triangle.

2. **Shadow boundaries**: The transition from blocked (amplitude = 0) to open ocean (amplitude = 1) should be smooth but may happen over a short distance. If the amplitude gradient exceeds a threshold within a single triangle, subdivide.

3. **Convergence zones**: Where wavefronts bunch together (headlands, focusing by concave coastlines), the amplitude factor changes rapidly. Same criterion: subdivide if interpolation error at the centroid exceeds threshold.

### Algorithm

1. For each triangle, evaluate the wave solver (same FMM-based computation) at the centroid.
2. Compare against the interpolated value from the triangle's vertices.
3. If the error exceeds the threshold, insert the centroid as a new vertex and retriangulate locally (Delaunay insertion).
4. Repeat for one more iteration (but NOT more -- see convergence section below).

### Why the Eulerian Approach Makes Enhancement Simple

This is a key advantage of the Eulerian approach: computing wave properties at any new point uses exactly the same solver as the initial grid computation. There's no path dependency, no need to trace back to a wavefront source, no concern about which "ray" the point belongs to. You evaluate `computeTerrainHeight(point)`, get the depth, and the phase field gives you everything.

In practice, enhancement points can even reuse the existing phase field via bilinear interpolation (since FMM already computed it on a fine grid). Only if the enhancement point is in a region where the phase field wasn't computed (e.g., because it was on land in the initial grid but the coastline was coarse) do we need to re-solve.

### Avoiding Oscillation

The simplification and enhancement passes must not oscillate (repeatedly adding then removing the same vertices). This is prevented by:

1. **Single-pass design**: Run simplification first (coarsen), then enhancement (refine). Do NOT iterate between them.
2. **Enhancement threshold > simplification threshold**: Simplification removes vertices with error < 0.02. Enhancement adds vertices with error > 0.04. The gap prevents a vertex from being both "removable" and "needed."
3. **Maximum of 2 enhancement iterations**: After 2 rounds, stop regardless. In practice, 1 round catches 95% of under-resolved regions.

## Diffraction

Diffraction is a HARD REQUIREMENT. The Eulerian grid approach must handle it from the start.

### The Challenge

The eikonal equation models geometric optics -- rays that travel in straight lines (modified by refraction). It does NOT model diffraction, where wave energy bends around obstacles into geometric shadow zones. The eikonal solution behind an island is `phi = infinity` (no wave reaches there), which is wrong.

### Solution: Helmholtz Equation (Full Wave Solver)

For true diffraction, we need to solve the **Helmholtz equation** instead of (or in addition to) the eikonal equation:

```
laplacian(U) + k(x,y)^2 * U = 0
```

where `U` is the complex wave amplitude and `k(x,y) = omega / c(x,y)` is the local wavenumber. This is the time-independent wave equation and inherently includes both refraction and diffraction.

However, the Helmholtz equation is a boundary-value problem (not a marching problem), and solving it on a 2D grid is computationally expensive: it requires solving a large sparse linear system. For a 68,600-point grid with wavelength 200 ft and grid spacing 25 ft (so ~8 points per wavelength -- the bare minimum for Helmholtz), this is a 68,600 x 68,600 sparse system. Modern iterative solvers (GMRES, BiCGSTAB) can handle this, but it takes O(N^1.5) to O(N^2) operations -- not the O(N log N) of FMM.

### Practical Approach: Eikonal + Diffraction Correction

A more practical approach combines the eikonal solution (which handles refraction efficiently) with a diffraction correction:

**Step 1: Solve the eikonal equation** using FMM. This gives the phase field everywhere except in shadow zones (where phase = infinity).

**Step 2: Identify shadow boundaries.** These are grid points that are "known" (reached by the wave) adjacent to "far" points (unreached, but not on land). The shadow boundary points are potential diffraction sources.

**Step 3: For each shadow boundary point, propagate diffracted waves into the shadow zone.** Treat each boundary point as a secondary point source with:

- Amplitude: `A_boundary * sqrt(wavelength / (2 * pi * r))` (cylindrical spreading from a line source, matching the existing `fn_computeFresnelEnergy` model)
- Phase: `phi_boundary + k * r` (spherical wavelet from the boundary point)
- Direction: radially outward from the boundary point

Run a second FMM pass from these boundary points into the shadow zone. This "fills in" the shadow with diffracted energy.

**Step 4: Blend.** Where the diffracted field overlaps with the direct field (near the shadow boundary), blend smoothly using the Fresnel transition model already in the codebase.

### Diffraction Quality

This two-pass approach produces physically plausible diffraction:

- Waves appear to bend around islands into the lee
- The shadow zone has reduced amplitude that falls off with distance
- Narrow gaps (bay inlets) produce a spreading pattern behind the gap, approximating a point source -- exactly the "waves appearing to originate from a narrow bay inlet" described in the requirements

The quality is comparable to the Kirchhoff diffraction approximation, which is standard in computational ocean wave modeling. It's not a full Helmholtz solve, but it captures the visually important effects.

### Concrete Diffraction Example: Narrow Bay Inlet

Consider a wave approaching a bay with a narrow inlet (200 ft wide, wavelength 200 ft):

1. FMM computes phase everywhere outside the bay. Wavefronts approach the inlet. Points inside the bay behind the walls are "far" (shadow).
2. Shadow boundary identification finds the two points at the inlet edges.
3. Diffracted wave propagation: each inlet edge generates cylindrical wavelets spreading into the bay.
4. Where the two wavelets overlap (interference pattern), the combined amplitude creates a pattern resembling a new point source at the inlet center.
5. The mesh captures this: vertices near the inlet have amplitude rising from 0 (at the walls) to some fraction of the incident amplitude (at the inlet center), then decaying deeper into the bay.

This is exactly the physically correct behavior for single-slit diffraction.

## Handling Multiple Terrain Features

### Scenario: Wave Passing Between Two Islands, Then Hitting Coastline

The FMM naturally handles this. The wavefront propagates through the gap between islands (where depth > 0 and speed is computed normally). Behind the islands, the wavefront is blocked (phase = infinity). The diffraction correction fills in the shadow zones.

The key insight is that FMM respects the speed field globally. If there's a channel between two islands, the wavefront flows through it at the local wave speed. If the channel opens into a wider area with a coastline behind, the FMM continues propagating until the wavefront reaches that coastline. The entire path is captured in a single FMM solve -- no special case handling for "sequences of terrain features."

Phase is accumulated correctly because FMM computes exact shortest-path travel time through the speed field. Even through a winding channel, the phase at each point is the minimum-time path from the source, accounting for all refraction along the way.

### Multiple Shadow Zones

After the first FMM pass, there may be multiple disconnected shadow zones (behind island A, behind island B, in a bay). The diffraction correction handles all of them in a single second pass: all shadow boundary points are initialized simultaneously as secondary sources, and the second FMM propagates from all of them in parallel (just like multi-source shortest paths in Dijkstra's algorithm).

## Convergence and Wavefront Focusing

When refraction bends wavefronts toward a common point (e.g., at a headland or concave coastline), the ray density increases and amplitude should increase. The eikonal equation handles this naturally through the phase field's geometry:

- In the phase field, convergence appears as regions where `|grad(phi)|` remains `1/c` (the eikonal constraint holds everywhere) but the **curvature** of the wavefronts (level sets of `phi`) increases.
- The amplitude factor is derived from the divergence of the ray field, which we compute from the Hessian (second derivatives) of `phi`.

Specifically:

```
ray_divergence = laplacian(phi) * c  (simplified 2D version)
convergence_factor = sqrt(abs(reference_divergence / ray_divergence))
```

This gives `convergence_factor > 1` when rays converge and `< 1` when they diverge. The factor is clamped to `[0.1, 2.0]` to match the existing `maxShoaling = 2.0` cap.

**Caustic handling**: At a true caustic (mathematical convergence point), the amplitude would be infinite. The clamp at 2.0 prevents this, same as the existing system. The phase field remains well-defined at caustics -- only the amplitude blows up -- so the eikonal approach doesn't break down.

## Memory Estimate

### Final Mesh

For the default level (~68,600 initial grid points, simplified to ~25,000 vertices):

Per vertex: 5 floats = 20 bytes

- 25,000 vertices \* 20 bytes = **500 KB**

Triangles: ~45,000, each 3 uint32 indices = 12 bytes

- 45,000 \* 12 = **540 KB**

**Total per mesh: ~1 MB.**

For 8 meshes (8 wave sources): **~8 MB total.** This is far under the 128 MB per-mesh budget.

### Worst Case: Complex Level

A level with 10x the coastline complexity (many islands, narrow channels, complex bathymetry):

- Initial grid: 25 ft spacing on a 15,000 x 15,000 ft domain = 360,000 points
- After simplification: ~150,000 vertices (less simplification near complex terrain)
- Per vertex: 20 bytes -> 3 MB
- Triangles: ~280,000, 12 bytes each -> 3.4 MB
- **Total per mesh: ~6.4 MB. For 8 meshes: ~51 MB.** Still well under budget.

### During Construction

The FMM state for a 360,000-point grid requires ~6 MB. The phase field, speed cache, and derivative computations add another ~10 MB. The quadtree simplification data structure is ~5 MB. **Total construction memory: ~21 MB per mesh.** Meshes are built sequentially, so only one is in construction at a time.

### Absolute Worst Case

Even if we went to 10 ft grid spacing on a 20,000 x 20,000 ft domain (4,000,000 grid points) -- which is far beyond any reasonable level -- the initial grid would take ~96 MB during construction and the final simplified mesh would have at most 1,000,000 vertices = 20 MB. Still under budget.

## CPU vs. GPU Execution

### CPU (Recommended for this approach)

The FMM is inherently sequential due to the priority queue (each extracted minimum determines the next). It runs on CPU with O(N log N) complexity.

For 68,600 points: FMM takes ~5-10 ms on a modern CPU. The finite-difference derivative computation and simplification passes are O(N) and take ~2-5 ms. Enhancement adds a few ms more. **Total: ~15-30 ms per mesh.** For 8 meshes: ~120-240 ms. Well within the <500 ms build budget.

For the worst case (360,000 points): FMM ~50-100 ms, derivatives ~10-20 ms, simplification ~20-30 ms. **Total: ~80-150 ms per mesh, ~640-1200 ms for 8.** Slightly over budget but still practical. Could be parallelized across CPU cores (one mesh per core) to bring it under 500 ms.

### GPU Option (Future Enhancement)

The FMM itself is hard to parallelize (it's Dijkstra's algorithm). However, the **Fast Iterative Method (FIM)** is a GPU-friendly alternative that solves the eikonal equation with similar accuracy. FIM replaces the priority queue with iterative sweeping that converges in O(N) work total but can process many points per iteration in parallel. Published GPU implementations achieve 10-50x speedups over CPU FMM.

This could be a future optimization if build time becomes a concern, but for current level sizes, CPU FMM is fast enough and much simpler to implement.

## Construction Pipeline

### Step 1: Grid Setup (~1 ms)

1. Compute domain AABB from coastline bounds + 3 wavelength margin.
2. Create 2D grid at 25 ft spacing.
3. For each grid point, evaluate `computeTerrainHeight()` and cache depth.
4. For each grid point, compute wave speed from depth using dispersion relation.
5. Mark land points (depth <= 0) as obstacles.

### Step 2: FMM Phase Solve (~5-10 ms)

1. Initialize upwind boundary: set phase values based on initial wave direction. For a planar wave arriving from direction `theta`, the initial phase at boundary point `p` is `dot(p, waveDir) / c_deep`.
2. Run FMM with the cached speed field.
3. Result: phase field `phi(i, j)` for all reachable grid points. Unreachable points (behind land, in shadow) have `phi = infinity`.

### Step 3: Diffraction Pass (~3-5 ms)

1. Identify shadow boundary points: reachable points adjacent to unreachable non-land points.
2. For each shadow boundary point, set it as a secondary source with `phi_diffraction = phi_boundary`.
3. Run a second FMM from these sources into the shadow zone only (don't overwrite already-computed points where the direct wave is stronger).
4. At each newly reached point, set amplitude using cylindrical decay: `A = A_boundary * sqrt(wavelength / (2 * pi * r))`.

### Step 4: Derive Wave Properties (~2-3 ms)

For each grid point with finite phase:

1. **Direction offset**: `theta = atan2(-dphi/dy, -dphi/dx)`, then `directionOffset = theta - baseWaveDirection`. Use central finite differences for gradients.
2. **Phase offset**: `phaseOffset = k * c_deep * phi - dot(position, baseWaveDir * k)`.
3. **Amplitude factor**: Combine terrain factor (from `computeWaveTerrainFactor(depth, wavelength)`) with convergence factor (from Laplacian of phase field) and diffraction decay (if applicable).

For points on land: `amplitudeFactor = 0, directionOffset = 0, phaseOffset = 0`.

### Step 5: Quadtree Simplification (~3-5 ms)

1. Build quadtree over the grid.
2. Bottom-up collapse: merge cells where max interpolation error < threshold.
3. Enforce 2:1 grading constraint.
4. Triangulate the quadtree with T-junction handling.

### Step 6: Enhancement (~2-3 ms, 1-2 iterations)

1. For each triangle, evaluate wave properties at centroid.
2. Compare against interpolated value from vertices.
3. If error > enhancement threshold (2x simplification threshold), insert centroid and retriangulate (Delaunay insertion).
4. Repeat once more for remaining high-error triangles.

### Step 7: Output (~1 ms)

1. Pack vertex data: `[posX, posY, amplitudeFactor, directionOffset, phaseOffset]` per vertex.
2. Generate index buffer.
3. Upload to GPU buffers.

**Total: ~17-28 ms per mesh. For 8 meshes: ~136-224 ms.**

## Enhancement and Simplification Detail

Since these passes are CENTRAL to this approach, here is additional design detail.

### Simplification: Error Metric Formulation

For a candidate removal, consider a grid point `P` with neighbors `A, B, C, D` (left, right, above, below). If `P` were removed, its value would be interpolated from the surrounding cell corners. The error is:

```
interpolated = bilinear(A, B, C, D, P.position)
error_amp   = |P.amplitudeFactor - interpolated.amplitudeFactor|
error_dir   = |P.directionOffset - interpolated.directionOffset|
error_phase = |P.phaseOffset     - interpolated.phaseOffset|
error = max(error_amp, error_dir / 0.5, error_phase / PI)
```

The denominator values (0.5 and PI) normalize each field to roughly unit scale so the max operation is meaningful.

### Simplification: Quadtree Collapse Rules

Starting from the finest level (1x1 grid cells):

**Level 0 (individual cells)**: No simplification possible.

**Level 1 (2x2 blocks)**: A block of 4 cells can merge into one if the center point's interpolation error is below threshold. This removes 4 interior points.

**Level k (2^k x 2^k blocks)**: A block can merge if ALL interior points' errors are below threshold when interpolated from just the 4 corners. Checked recursively: a level-k block can merge only if all 4 child blocks at level k-1 could also merge.

**2:1 grading**: After all merges, check each cell boundary. If two adjacent cells differ by more than 1 level, split the larger cell. This prevents degenerate triangles (very long, thin triangles spanning a large cell next to a small one).

### Simplification: Expected Behavior by Region

- **Open ocean** (>2 wavelengths from any terrain): All values are `(1.0, 0.0, 0.0)`. Error = 0 at every point. Collapses to maximum cell size. A 5600x7600 ft domain with 800 ft max cells = ~70 cells total.

- **Refraction zone** (shallow water shelf): Direction and phase change gradually over ~200-400 ft. The quadratic interpolation error is proportional to `h^2 * d^2f/dx^2` where `h` is cell size. For typical refraction curvature, cells collapse to 100-200 ft (2-4x initial spacing). ~500 cells.

- **Shadow boundary** (transition from blocked to open): Amplitude changes rapidly over ~100-300 ft (Fresnel zone width). Cells stay at 25-50 ft near the boundary, expanding to 100+ ft further away. ~3000 cells.

- **Diffraction zone** (behind obstacles): Amplitude and direction change moderately. Cells at 50-100 ft. ~2000 cells.

- **Coastline zone** (within 1 wavelength of shore): Amplitude, direction, and phase all change rapidly. Cells stay at 25 ft (no simplification). ~8000 cells.

### Enhancement: Centroid Evaluation

For each triangle with corners `A, B, C`:

```
centroid = (A.pos + B.pos + C.pos) / 3
true_value = evaluateWaveProperties(centroid)   // uses the same solver
interpolated_value = (A.value + B.value + C.value) / 3
error = max weighted difference (same metric as simplification)
```

If `error > enhancement_threshold`:

1. Insert centroid as new vertex with `true_value`.
2. Split the triangle into 3 sub-triangles (connecting centroid to each edge).
3. Check new sub-triangles on the next iteration.

### Enhancement: Why 2 Iterations Suffice

The initial grid at 25 ft captures features down to ~50 ft scale. Enhancement subdivides triangles whose edges are ~25-50 ft. After one subdivision, edges are ~12-25 ft. After two, ~6-12 ft.

The shortest physically meaningful scale in the problem is the wave amplitude variation across the damping zone (wavelength \* 0.05 = 10 ft for 200 ft wavelength). Two enhancement iterations bring us to ~12 ft resolution in problematic areas -- adequate.

A third iteration would refine to ~6 ft, which is below the per-pixel rendering resolution (the screen-space texture is typically ~2-4 ft per pixel near the camera, but 10-20 ft per pixel at the edge of the view). There's no visual benefit.

## Comparison to Wavefront Marching

### Advantages of Grid Eulerian

1. **No topological complexity**: The mesh is always a valid triangulation. No concerns about wavefront crossing, tangling, or degenerate triangles from convergence.
2. **Diffraction is natural**: The eikonal + diffraction correction approach fills in shadow zones without topological surgery. No need to insert "bridge vertices" or modify the wavefront structure.
3. **Independent point evaluation**: Every grid point is computed from the same global solve. Enhancement can evaluate any point without path dependency.
4. **Predictable memory**: Grid size is known upfront. No dynamic growth from diffraction fans or convergence spreading.
5. **Robust convergence handling**: Wavefront convergence just makes the amplitude large at some grid points. No risk of crossed wavefronts or tangled mesh.

### Disadvantages of Grid Eulerian

1. **FMM is sequential**: The priority queue makes FMM hard to parallelize on GPU. Current levels are small enough that CPU is fast, but larger levels might benefit from GPU execution.
2. **Initial grid is larger than necessary**: We compute wave properties at thousands of open-ocean points that will be immediately simplified away. This is wasted work, though it's cheap work.
3. **Two-pass diffraction is approximate**: The eikonal + diffraction correction is not a true wave solution. The Helmholtz equation would give exact diffraction, but at much higher cost. For a game, the approximation is sufficient.
4. **Quadtree simplification adds complexity**: The simplification pass is a significant implementation effort (quadtree construction, grading, T-junction triangulation). The wavefront marching approach starts with an approximately-right resolution and doesn't need post-processing.

## Summary

| Aspect                        | Value                                                        |
| ----------------------------- | ------------------------------------------------------------ |
| Solver                        | Eikonal equation via Fast Marching Method (CPU)              |
| Initial grid                  | 25 ft spacing, ~68K points for default level                 |
| Construction time             | ~20-30 ms per mesh, ~200 ms for 8 meshes                     |
| Final mesh size               | ~25K vertices, ~45K triangles (~1 MB per mesh)               |
| Memory during construction    | ~3 MB per mesh                                               |
| Diffraction method            | Eikonal + secondary source FMM in shadow zones               |
| Simplification                | Quadtree collapse with 2:1 grading                           |
| Enhancement                   | 1-2 iterations of centroid subdivision                       |
| Max vertex count (worst case) | ~150K vertices per mesh, ~1.2M for 8 meshes                  |
| GPU execution                 | Not needed for current sizes; FIM available as future option |
