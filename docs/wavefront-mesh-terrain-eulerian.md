# Terrain-Seeded Eulerian Mesh Construction

## Overview

This approach constructs the wave terrain mesh by seeding vertex positions from existing terrain contour data, then solving for wave properties at those fixed positions using an Eikonal-based fast marching method. Instead of marching wavefronts forward (Lagrangian), we place vertices where they're needed and compute how waves arrive at each vertex (Eulerian).

The key insight: terrain contours are densest exactly where we need the most mesh detail. Near coastlines, contour vertices are tightly spaced and capture the intricate coastline geometry. In open ocean, we have few or no contours, and we need few or no vertices because wave properties are uniform there. This gives us a natural vertex placement that matches the resolution requirements of the wave field.

## Available Terrain Data

The game's terrain system provides rich data for seeding:

- **TerrainContour**: Catmull-Rom spline control points + pre-sampled polygons (16 samples per segment, stored as `sampledPolygon: readonly V2d[]`). Each contour has a `height` field.
- **Contour tree**: Parent-child containment hierarchy via `buildContourTree()`. Contours are stored in DFS pre-order with skip counts.
- **Coastlines**: Contours where `height === 0`. Managed by `CoastlineManager` which provides bounding boxes and lookup.
- **GPU data**: `packedTerrainBuffer` with vertices, contour metadata (bboxes, depths, child indices), and children. Accessor functions (`getTerrainVertex`, `getContourData`) exist in `terrain-packed.wgsl.ts`.
- **Constants**: `MAX_CONTOURS = 128`, `MAX_VERTICES = 8192`, `SAMPLES_PER_SEGMENT = 16`.
- **Typical scale**: The default level has an island ~1400ft across with contours at heights -50, -40, -20, -10, 0, +5, with a total coastline bounding box roughly 3000x4000 ft. Default depth is -50 ft. Default wavelength is 200 ft.

## Algorithm

### Phase 1: Vertex Seeding from Terrain

Generate the initial point set by sampling terrain contour geometry.

**1a. Coastline vertices (primary source)**

For each coastline contour (`height === 0`), take the pre-sampled polygon vertices directly. These are already computed by `sampleClosedSpline()` at 16 samples per control point segment. A coastline with 20 control points produces 320 sampled vertices -- tight spacing that captures bays, headlands, and narrow passages.

For contours at other heights (shelves at -40, -20, -10, etc.), also include their sampled vertices. These define where depth changes, which is exactly where refraction and shoaling change the wave properties.

For each terrain vertex, record:
- World position (x, y) from `sampledPolygon`
- The contour height it came from
- A "terrain distance" classification (0 = on coastline, distance to nearest coastline for others)

**1b. Near-coastline densification**

Between the coastline (height=0) and the nearest underwater contour, insert additional vertices at intermediate distances. This is where wave properties change most rapidly (shallow water refraction, shoaling, damping).

Strategy: For each coastline vertex, cast 2-3 rays perpendicular to the coastline (outward normal direction) and place vertices at intervals of `wavelength / 8` up to a distance of `2 * wavelength`. This produces a band of high-resolution vertices around every coastline.

The outward normal at each coastline vertex is straightforward: with CCW winding (ensured by `normalizeTerrainWinding()`), the outward normal of edge (A, B) is `(B.y - A.y, -(B.x - A.x))`, normalized.

**1c. Leeward densification (diffraction zones)**

For each coastline contour and wave direction:
1. Classify edges as windward or leeward using the same edge-normal classification from `ShadowGeometry.ts` (`classifyEdges`).
2. Find shadow region boundaries (the silhouette points where lit transitions to shadow).
3. Behind each silhouette point, fan out additional vertices into the shadow zone. Place them along arcs at distances `wavelength/4`, `wavelength/2`, `wavelength`, `2*wavelength`, `4*wavelength` from each silhouette point, spanning an angular range of up to 90 degrees into the shadow.
4. In the deep shadow zone (more than `2*wavelength` behind the obstacle), place a sparser grid of vertices along the leeward coastline.

This leeward densification is critical for diffraction -- without it, the terrain-seeded vertices alone would leave the shadow zone empty.

**1d. Open ocean fill**

After placing terrain-derived and shadow-zone vertices, fill the remaining playable area with a coarse grid. The grid spacing in open ocean should be large -- `wavelength * 2` or even larger -- since wave properties are uniform there (amplitude=1, direction=base, phase=0).

Strategy: Create a Cartesian grid over the mesh AABB (coastline bounds + 3 wavelengths margin). At each grid point, check if a terrain-seeded vertex already exists within `minSpacing = wavelength / 4`. If not, add a grid vertex. If the grid point is inside land (terrain height > 0), skip it.

**Estimated vertex count for the default level:**
- 2 coastline contours with ~300 vertices each: ~600
- 7 non-coastline contours with ~200 vertices each: ~1400
- Near-coastline densification: ~3000 (600 coastline verts * 5 offsets)
- Leeward densification: ~2000 (per wave source)
- Open ocean fill: ~2000 (7000x4000 ft area at 200ft spacing)
- Total per wave source: ~9000 vertices
- 8 wave sources: ~72,000 vertices total -- well under the 8M limit

### Phase 2: Delaunay Triangulation

Triangulate the point set using constrained Delaunay triangulation (CDT).

**Constraints:**
- Coastline edges (adjacent vertices in each coastline polygon) are constrained edges. This ensures the triangulation follows coastline geometry exactly rather than creating triangles that cross land boundaries.
- All contour polygon edges should be constraints, not just coastlines. This preserves the natural terrain structure.

**Implementation:** Use a CPU-based incremental Delaunay triangulation algorithm. For ~9000 points, this takes <50ms on modern hardware. Libraries like `delaunator` (already a common npm package) provide fast Delaunay triangulation in JS; CDT can be implemented as a post-processing step that inserts constraint edges.

**Post-triangulation cleanup:**
- Remove triangles whose centroid is inside land (terrain height > 0). Use the existing `isInsideContour()` logic on the CPU by checking against coastline contour polygons.
- Remove triangles entirely outside the mesh AABB.

### Phase 3: Solve Wave Properties (Eikonal / Fast Marching)

With vertices placed and triangulated, solve for `(amplitudeFactor, directionOffset, phaseOffset)` at each vertex. Since vertices are at fixed positions, we need a method that propagates wave information through the mesh without moving the vertices.

**3a. The Eikonal equation**

The Eikonal equation governs wavefront propagation through a medium with spatially varying speed:

```
|grad(T)| = 1/c(x)
```

where `T(x)` is the travel time from the wave source to point `x`, and `c(x)` is the local phase speed.

The solution `T(x)` gives us everything we need:
- **Phase offset**: `phaseOffset = omega * T(x) - dot(position, baseWaveDir * k)`, where `omega * T(x)` is the true accumulated phase and the second term is the straight-line prediction.
- **Direction**: `direction = grad(T) / |grad(T)|` -- the gradient of travel time points along the wave propagation direction.
- **Amplitude** (via transport equation): Once `T(x)` is known, amplitude follows from the transport equation (conservation of energy flux): `A(x) = A_0 * sqrt(c_0 / c(x)) * sqrt(J_0 / J(x))` where `J` is the Jacobian of the ray map (geometric spreading).

**3b. Fast Marching Method (FMM) on the triangle mesh**

FMM solves the Eikonal equation on unstructured meshes by propagating a "known" front through the mesh, vertex by vertex, in travel-time order. This is the standard approach for solving Eikonal equations on triangulated surfaces.

Algorithm:
1. **Initialize**: Classify each vertex as:
   - **Known** if it's on the upwind boundary (first vertices to be reached by the wave). For a planar wave, all vertices on the upwind edge of the mesh AABB are Known, with `T = dot(position, waveDir) / c_deep`.
   - **Inside land** if terrain height > 0 at the vertex position. These are permanently blocked.
   - **Far** otherwise (not yet reached).

2. **Propagate**: Maintain a priority queue of **Trial** vertices (adjacent to Known, sorted by tentative travel time). Repeatedly:
   a. Extract the Trial vertex with smallest `T`.
   b. Mark it as Known.
   c. For each neighboring vertex that is not Known and not blocked:
      - Compute a tentative travel time using the Eikonal update on the shared triangle. The update formula for vertex C in triangle (A, B, C) where A and B are Known:
        ```
        Solve: |grad(T)| = 1/c_avg
        ```
        where `c_avg` is the average wave speed in the triangle (computed from terrain depth at the triangle centroid or at the vertices).
      - If the tentative T is less than the vertex's current T, update it and add/update it in the priority queue.

3. **Convergence**: The front sweeps from upwind to downwind. Each vertex is finalized exactly once. Total cost: O(N log N) where N is the vertex count.

**3c. Computing per-vertex wave properties from the Eikonal solution**

After FMM completes, each vertex has a travel time `T(x)`. Derive the three output values:

- **directionOffset**: Compute `grad(T)` at each vertex by averaging gradients from incident triangles (weighted by triangle area). The direction is `atan2(grad_y, grad_x)`. The offset is `direction - baseWaveDirection`.

- **phaseOffset**: `phaseOffset = omega * T(x) - dot(position, baseWaveDir * k)`. Here `omega = sqrt(g * k)` and `k = 2*PI / wavelength`.

- **amplitudeFactor**: This requires solving the transport equation. Two approaches:

  *Option A (geometric spreading)*: Compute the Jacobian of the ray map. In practice, estimate this by comparing the local vertex density to the "expected" density for straight-line propagation. Where vertices cluster (convergence), amplitude increases; where they spread, it decreases. This is approximate but cheap.

  *Option B (explicit transport equation)*: Solve `div(A^2 * c * grad(T)) = 0` on the mesh using a second FMM-like pass or a linear system. This is exact but more complex.

  *Recommended: Option A with terrain-based corrections*. For each vertex:
  ```
  terrainFactor = computeWaveTerrainFactor(depth, wavelength)  // shoaling + damping
  convergenceFactor = estimated from neighbor spacing vs initial spacing
  amplitudeFactor = terrainFactor * convergenceFactor
  ```

  The convergence factor can be estimated during FMM propagation by tracking how the wavefront "width" between adjacent rays compresses or expands. At each vertex, compute the area of the Voronoi cell in the mesh; compare it to the expected area for a plane wave. The ratio gives the convergence factor: `convergenceFactor = sqrt(expectedArea / actualArea)`.

**3d. Handling blocked regions (inside land)**

Vertices inside land get `amplitudeFactor = 0, directionOffset = 0, phaseOffset = 0`. Adjacent water vertices near the coastline get their amplitude driven toward 0 by the damping formula, creating a smooth transition.

The FMM naturally handles obstacles: when a vertex is blocked, the wave propagates around it. Vertices on the leeward side are reached by waves that traveled around the obstacle, arriving later (larger T) and from a different direction (due to the curved path). This is exactly how real waves behave.

### Phase 4: Diffraction

Diffraction is the most important aspect of this design and the primary reason to consider the Eulerian approach.

**Why Eulerian helps with diffraction:**

In a Lagrangian (marching) approach, diffraction requires detecting shadow boundaries and explicitly spawning new vertices into the shadow zone. This is topologically complex -- it changes the mesh structure, requires vertex insertion between rows, and creates bookkeeping challenges.

In the Eulerian approach, diffraction vertices are already placed during Phase 1c (leeward densification). The FMM solver propagates wave energy into the shadow zone naturally as it expands the Known front around obstacles. The wavefront simply takes longer to arrive (higher T), arrives from a different direction (grad(T) curves around the obstacle), and arrives weaker (geometric spreading reduces amplitude).

**Diffraction amplitude model:**

The FMM produces the correct wavefront geometry behind obstacles, but the basic geometric spreading underestimates diffraction amplitude (it gives the "geometric optics" answer, which goes to zero in the shadow zone). We need to augment it with a diffraction correction.

For each vertex in the shadow zone:
1. Identify the nearest diffraction edge (the silhouette points of the obstacle for this wave direction).
2. Compute the Fresnel number: `F = sqrt(2 * d_edge / (wavelength * d_behind))` where `d_edge` is the perpendicular distance from the shadow boundary line and `d_behind` is the distance behind the silhouette point along the wave direction.
3. Apply diffraction amplitude: `A_diffracted = A_incident * D(F)` where `D(F)` is a diffraction coefficient. For single-edge diffraction, `D(F) ~ 0.5` at the shadow boundary, decaying as `1/(sqrt(2*pi*F))` deep into the shadow zone.

This model captures the key visual effect: waves appearing to originate from the edges of obstacles and spreading into the lee. It's physically accurate for the Fresnel regime (obstacle size comparable to wavelength) which is exactly the case for our game's islands and wavelengths.

**Interaction with FMM:**

The FMM travel time is correct even in shadow zones -- it represents the shortest path for wave energy to reach each point, which goes around the obstacle. The direction from `grad(T)` curves correctly. Only the amplitude needs the Fresnel diffraction correction because geometric spreading alone doesn't account for the wave nature of the propagation.

Crucially, this means diffraction is not a separate "add-on" pass -- it's integrated into the same vertex set and the same solve. The leeward vertices get their travel times and directions from FMM, and their amplitudes from the diffraction model. The triangulation ensures smooth interpolation between the diffraction zone and the geometric shadow.

### Phase 5: Enhancement and Simplification (Optional)

**Enhancement (adding vertices):**

After the initial solve, identify regions where wave properties change rapidly:
- Compute the gradient of `amplitudeFactor` and `directionOffset` on each triangle.
- If the gradient magnitude exceeds a threshold, insert a vertex at the triangle centroid or longest edge midpoint.
- Re-triangulate locally and re-solve the new vertices (using neighbors' known T values as boundary conditions -- a local FMM update).

This is most likely needed:
- At the edges of diffraction zones (amplitude transitions from full to zero)
- At refraction caustics (direction changes rapidly)
- Near headlands where convergence is strong

**Simplification (removing vertices):**

In open ocean, many vertices will have nearly identical values `(1.0, 0.0, 0.0)`. Edge-collapse simplification:
- For each edge, compute the error from removing it (max attribute difference between actual and interpolated values at the collapsed vertex).
- Use a priority queue to collapse lowest-error edges first.
- Stop when the minimum error exceeds a threshold.
- Target: 50-80% reduction in open ocean areas.

**Necessity assessment:**

Enhancement is likely needed only for the diffraction zone edges. The terrain-seeded vertex placement already gets coastlines right, and the near-coastline densification handles the refraction zone. The only area with potentially insufficient resolution is the transition between the shadow zone and the lit zone, where amplitude can change from 0 to 1 over a short distance.

Simplification is worthwhile for memory and performance, especially with 8 wave sources. Reducing open ocean vertices by 50% would save significant memory.

## Specific Questions

### 1. Multiple terrain features in sequence

Consider waves passing between two islands, then hitting a coastline behind them. The FMM handles this naturally:

- Waves propagate around the first island, forming diffraction patterns behind it.
- The diffracted waves continue propagating and encounter the second island.
- The FMM travel time at vertices behind the second island reflects the full path: around the first obstacle, through the gap, around the second obstacle.
- The amplitude at each vertex accounts for cumulative geometric spreading and diffraction losses.
- The direction at each vertex follows `grad(T)`, which correctly shows the wave bending around each obstacle in sequence.

For a narrow channel between two islands: the FMM wave enters the channel from the upwind side, propagates through with direction constrained by the channel walls (vertices are dense here due to both islands' coastline vertices), and emerges on the lee side where it spreads out. The travel time is shortest along the channel center and increases toward the edges, producing a wavefront that fans out from the channel exit -- exactly like diffraction through a slit.

No special handling is needed for sequences of obstacles. The FMM is a global solver that naturally handles arbitrary terrain configurations, unlike the Lagrangian approach where each obstacle must be handled individually.

### 2. Convergence (wavefront bunching from refraction)

When refraction focuses wave energy (e.g., at a headland where depth contours curve), wavefronts converge. In the Eikonal framework:

- The travel time `T(x)` develops a "ridge" where wavefronts bunch up. `|grad(T)|` increases.
- The geometric spreading factor `J(x)` decreases (rays converge), causing amplitude to increase.
- At a true caustic (where `J` goes to zero), the Eikonal equation breaks down and amplitude would go to infinity.

**Handling caustics:**
- Cap `amplitudeFactor` at 2.0 (matching the existing `maxShoaling`).
- The FMM travel time remains well-defined even at caustics -- it's only the amplitude that becomes singular.
- In practice, caustics in our game are mild (headlands and curved shelves) and the 2.0 cap is sufficient.
- The convergence factor estimation from Voronoi cell areas naturally saturates because vertex density is finite.

### 3. Memory estimate

**Per-vertex data:**
- Position: 2 x f32 = 8 bytes
- Amplitude factor: 1 x f32 = 4 bytes
- Direction offset: 1 x f32 = 4 bytes
- Phase offset: 1 x f32 = 4 bytes
- Total: 20 bytes per vertex (matches the existing `VERTEX_FLOATS = 5` layout)

**Per-triangle data (index buffer):**
- 3 x u32 = 12 bytes per triangle
- For Delaunay triangulation, triangle count ~ 2 * vertex count

**Per wave source estimates (default level, one swell source):**
- ~9,000 vertices: 180 KB
- ~18,000 triangles: 216 KB
- Total: ~396 KB per wave source

**With 8 wave sources:**
- 8 * 396 KB = 3.2 MB
- Well under the 128 MB per-mesh target and the 8M vertex limit

**Worst case (complex level with many islands, 8 sources):**
- 50,000 vertices per source (many islands, dense coastlines)
- 8 * 50,000 * 20 bytes = 8 MB for vertices
- Plus indices: 8 * 100,000 * 12 bytes = 9.6 MB
- Total: ~18 MB -- still very comfortable

**Construction memory (temporary):**
- FMM priority queue: 9,000 entries * ~24 bytes = 216 KB
- Adjacency structures: ~500 KB
- Triangulation working memory: ~500 KB
- Total temporary: ~1.2 MB (trivial)

### 4. Diffraction

Diffraction is built into the approach from the ground up, not bolted on as an afterthought.

**How it works end-to-end:**

1. **Vertex placement** (Phase 1c): Leeward densification places vertices behind every obstacle, fanning out from each silhouette point at multiple distances and angles. These vertices exist specifically to capture diffraction patterns.

2. **Travel time computation** (Phase 3): FMM propagates travel times around obstacles. Vertices behind obstacles are reached by waves that traveled around the obstacle edges. The travel time is longer (wave traveled further), and the direction (`grad(T)`) curves around the obstacle. This happens automatically -- no special diffraction logic needed in the FMM.

3. **Amplitude computation** (Phase 4): The geometric spreading from FMM gives the correct wavefront geometry but underestimates amplitude in shadow zones. A Fresnel diffraction correction is applied as a post-process on each vertex based on its position relative to the nearest shadow boundary.

4. **Rendering**: The triangulated mesh smoothly interpolates between the lit zone (amplitude ~1), the penumbra (amplitude ~0.5 at shadow edge), and the deep shadow (amplitude decaying toward 0). The leeward densification vertices ensure the mesh has enough resolution to capture the smooth transition.

**Narrow bay inlet scenario:**

For a narrow bay inlet (gap between two obstacles or a narrow harbor entrance):
- The inlet sides are both coastlines, so they have dense vertices.
- Leeward densification places fan vertices behind each side of the inlet.
- FMM propagates waves through the inlet. Travel time is shortest along the center of the gap.
- Behind the inlet, the wave fans out (like a slit diffraction pattern). Vertices behind the inlet see waves arriving from a range of directions, all emanating from the inlet opening.
- The diffraction amplitude model gives the correct slit diffraction pattern: amplitude highest on the center line behind the inlet, decaying toward the sides.
- The result: waves appear to originate from the inlet, exactly as desired.

**Limitations:**
- The Fresnel diffraction model is a scalar approximation. It doesn't capture full wave interference patterns (the alternating bright/dark bands of Fraunhofer diffraction). For a game, this is perfectly acceptable -- we want the smooth amplitude envelope, not the interference fringes.
- Diffraction around very large obstacles (much larger than wavelength) produces very weak diffraction. The model correctly gives near-zero amplitude deep in the shadow zone for large obstacles.

### 5. Enhancement and simplification passes

**Enhancement feasibility:** High. After the FMM solve, we have per-vertex wave properties. Computing gradients on triangles is trivial. Inserting vertices at high-gradient triangle centroids, re-triangulating locally (flip the enclosing triangle edges), and re-solving the new vertex (one FMM update step with its neighbors as boundary) is straightforward. Each enhancement iteration adds O(hundreds) of vertices and takes O(milliseconds).

**Enhancement necessity:** Moderate. The terrain-seeded placement plus leeward densification should capture most features. The most likely place where enhancement is needed is the penumbra zone -- the transition between lit and shadow regions. The leeward densification fans may not be dense enough at the exact shadow boundary. One enhancement pass focused on amplitude gradient would fix this.

**Simplification feasibility:** High. Edge-collapse with an attribute error metric is a well-understood algorithm. The per-vertex data is simple (3 scalar attributes), making error estimation trivial.

**Simplification necessity:** Low to moderate. The terrain-seeded approach already produces a reasonable vertex count (~9000 per source for the default level). The main benefit would be reducing open ocean vertices where all values are at default (1, 0, 0). With the Delaunay triangulation approach, we could alternatively just use larger spacing for the open ocean fill grid (Phase 1d), which achieves the same result without a simplification pass.

## Execution Strategy

The entire construction runs on the CPU. Unlike the Lagrangian GPU marching approach, this does not require a compute shader dispatch loop.

**Why CPU not GPU:**
- FMM is inherently sequential (process vertices in travel-time order). Parallel FMM variants exist but are complex and the vertex count is small enough (~9000) that CPU performance is fine.
- Delaunay triangulation is a well-solved CPU problem with mature implementations.
- Construction is a one-time cost at level load, not per-frame.
- Existing terrain data (`sampledPolygon`, contour tree) is already on the CPU.

**Estimated construction time:**
- Vertex generation: <5ms (iterating contour polygons + some ray casting)
- Delaunay triangulation: <20ms for 9000 points (using `delaunator` or similar)
- Constraint insertion: <10ms
- FMM solve: <30ms (O(N log N) for 9000 vertices)
- Diffraction amplitude correction: <5ms
- Enhancement pass: <10ms
- GPU upload: <1ms
- Total: ~80ms per wave source, ~640ms for 8 sources

This is competitive with the GPU wavefront marching approach (~500ms total).

## Comparison with GPU Wavefront Marching

| Aspect | Lagrangian (current) | Terrain-Seeded Eulerian |
|--------|---------------------|------------------------|
| Vertex placement | Uniform grid, refraction moves vertices | Terrain-adaptive, vertices stay fixed |
| Resolution near coast | Even across mesh | Naturally high from terrain data |
| Open ocean efficiency | Wastes vertices | Efficient (sparse fill grid) |
| Diffraction | Requires vertex insertion into wavefront rows | Natural -- pre-placed vertices, solved by FMM |
| Multiple obstacles | Must handle sequentially per wavefront row | All obstacles handled simultaneously by FMM |
| Construction platform | GPU compute (dispatch loop) | CPU (single-threaded FMM) |
| Construction time | ~500ms | ~640ms (similar) |
| Mesh topology | Regular grid (uniform row x col) | Unstructured triangulation |
| Query lookup | O(1) grid indexing | O(log N) spatial lookup or rasterize-to-texture |
| Implementation complexity | Moderate (GPU shader) | Moderate (CPU algorithms) |

**Key advantages of the Eulerian approach:**
1. Diffraction is natural, not bolted on
2. Multiple obstacles are handled globally, not incrementally
3. Resolution matches terrain complexity automatically
4. No wasted vertices in open ocean

**Key disadvantages:**
1. Unstructured mesh makes query lookup harder (no O(1) grid indexing)
2. CPU-bound construction (though fast enough)
3. Requires a triangulation library
4. FMM produces slightly less intuitive results than direct wavefront tracing (harder to debug visually)

## Output Format

The final mesh uses the same per-vertex layout as the existing `WavefrontMesh`:
```
5 floats per vertex (20 bytes):
  positionX:       f32
  positionY:       f32
  amplitudeFactor: f32
  directionOffset: f32
  phaseOffset:     f32
```

Index buffer: `Uint32Array` of triangle indices (3 per triangle).

GPU buffers: Vertex buffer (`STORAGE | VERTEX | COPY_SRC`) and index buffer (`INDEX`), same usage flags as the current mesh. The rendering and query integration described in `wavefront-mesh-system.md` works identically -- the consumers don't care whether the mesh was built by Lagrangian marching or Eulerian solving.

The only difference for query integration: since the mesh is unstructured (not a regular grid), the O(1) grid-indexing lookup from `wavefront-mesh-system.md` doesn't apply. Instead, the query shader would use the rasterize-to-texture approach (sample the wave field texture at the query point's screen position), which is already the rendering integration path.
