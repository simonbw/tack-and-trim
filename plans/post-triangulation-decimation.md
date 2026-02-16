# Post-Triangulation Vertex Decimation

## Current State

The mesh build pipeline in `marchingBuilder.ts` runs:

1. **March** rays through terrain → wavefronts (rows of segments of points)
2. **Compute amplitudes** (energy × shoaling × divergence)
3. **Apply diffraction** (lateral amplitude smoothing)
4. **Decimate** (`decimation.ts`) — two separate phases:
   - Row decimation: remove entire wavefront rows via min-heap, checking position/amplitude/phase interpolation error against surviving neighbor rows
   - Vertex decimation: greedy forward scan within each segment, removing vertices whose position/amplitude can be linearly interpolated from kept neighbors
5. **Triangulate** (`meshOutput.ts`) — match segments between adjacent steps by t-range overlap, sweep by t-value to emit triangles

The decimation runs *before* triangulation, operating on the structured wavefront data. This means:
- Row decimation is all-or-nothing per row
- Vertex decimation is 1D (along-wavefront only, blind to cross-row redundancy)
- Error is checked on intermediate fields (position, amplitude, phase separately) rather than the final interpolated signal

### Relevant files

- `src/game/wave-physics/mesh-building/decimation.ts` — current pre-triangulation decimation (~560 lines)
- `src/game/wave-physics/mesh-building/meshOutput.ts` — triangulation (~210 lines)
- `src/game/wave-physics/mesh-building/marchingBuilder.ts` — orchestrates the pipeline
- `src/game/wave-physics/mesh-building/marchingTypes.ts` — `VERTEX_FLOATS = 6`, vertex layout
- `src/game/wave-physics/mesh-building/MeshBuildTypes.ts` — `WavefrontMeshData` output type
- `bin/benchmark-mesh-build.ts` — existing CLI benchmark

## Desired Changes

Replace the two-phase pre-triangulation decimation with a single post-triangulation pass that operates directly on the triangle mesh:

1. Triangulate first (no decimation of wavefront data)
2. For each interior vertex, compute the error introduced by removing it — measured on the final signal fields: `amp * cos(phase)`, `amp * sin(phase)`, and blend weight
3. Priority queue sorted by error; greedily remove vertices below threshold
4. Compact the mesh

Keep the old `decimation.ts` so both strategies can be compared via the benchmark tool.

### Why this is better

- **Simpler algorithm**: one pass instead of two separate strategies
- **Cleaner error metric**: checks what rendering/queries actually see (`amp*cos`, `amp*sin`, blend) instead of intermediate fields
- **2D awareness**: can remove vertices that are redundant in both along-wavefront and cross-row directions
- **No all-or-nothing row removal**: adapts per-vertex

## New File

### `src/game/wave-physics/mesh-building/meshDecimation.ts`

Post-triangulation vertex decimation. Operates on `WavefrontMeshData` (Float32Array vertices + Uint32Array indices).

**Data structures:**

- `vertexTriangles: number[][]` — for each vertex, list of triangle indices that reference it. Built in one pass over the index buffer.
- `removable: boolean[]` — `true` for interior vertices (vertex attribute `interior === 1.0`), `false` for boundary vertices. Boundary vertices are never candidates.
- Min-heap of `{ vertexIndex, error }` — same pattern as existing `RowCandidateHeap`.

**Core operations:**

1. **Build adjacency** — one pass over indices, push triangle index onto each of its 3 vertices' lists.

2. **Compute removal error for a vertex** —
   - Walk the triangle fan to extract the ordered neighbor ring (each triangle shares edges with its fan neighbors; chain the non-center vertices in order).
   - Ear-clip the ring polygon to produce replacement triangles.
   - For each replacement triangle that covers the removed vertex's position, compute barycentric coords and interpolate the signal fields from the ring vertices.
   - Error = max absolute deviation across `amp*cos(phase)`, `amp*sin(phase)`, and blend weight between the actual vertex values and the interpolated values.

3. **Greedy removal loop** —
   - Pop lowest-error vertex from heap.
   - Skip if already removed or if its adjacency has changed (stale entry — same pattern as `decimateRows`).
   - Remove: delete all triangles in its fan from adjacency lists, ear-clip the ring, add new triangles, update `vertexTriangles` for ring vertices.
   - Recompute error and re-enqueue each ring vertex (if still removable).

4. **Compact** — final pass to build clean vertex/index arrays, remapping indices. Removed vertices and their dead triangles are simply skipped.

**Error metric detail:**

For vertex `v` with attributes `(amp, phase, broken, interior)`:
```
actual = [amp * cos(phase), amp * sin(phase), interior]
interpolated = barycentric interpolation of same fields from replacement triangle vertices
error = max(|actual[i] - interpolated[i]|) for i in 0..2
```

This naturally weights phase errors by amplitude (high-amplitude phase errors are large in the cos/sin representation, low-amplitude ones are small).

**Ordered ring extraction:**

Given vertex `v` and its triangle fan `T0, T1, ...`:
- Pick any triangle T0. Its two non-`v` vertices are the first edge of the ring.
- Find the next triangle sharing an edge with the last ring vertex. Add its other non-`v` vertex.
- Repeat until the ring closes (back to the first vertex) or hits a boundary (open fan).
- If the fan is open (boundary vertex), mark as non-removable and skip.

**Ear clipping:**

The ring polygon is small (typically 5-7 vertices). Simple ear-clipping:
- Find an ear (vertex where the triangle formed with its two ring neighbors is valid — positive area and no other ring vertex inside).
- Emit that triangle, remove the ear vertex from the ring.
- Repeat until 3 vertices remain, emit final triangle.

## Files to Modify

- **`src/game/wave-physics/mesh-building/meshDecimation.ts`** (NEW) — post-triangulation decimation as described above. Exports `decimateMesh(mesh: WavefrontMeshData, tolerance: number): WavefrontMeshData`.

- **`src/game/wave-physics/mesh-building/marchingBuilder.ts`** — Add a flag/parameter to switch between old and new decimation. With old decimation (current behavior): decimate wavefronts → triangulate. With new decimation: triangulate undecimated wavefronts → `decimateMesh()`. Both paths produce `WavefrontMeshData`. Update timing logs to cover whichever path is active.

- **`src/game/wave-physics/mesh-building/decimation.ts`** — No changes. Keep as-is for comparison.

## Execution Order

### Phase 1: New decimation module (independent)

Create `meshDecimation.ts` with:
1. Adjacency building
2. Ordered ring extraction
3. Ear-clip re-triangulation
4. Error computation (amp·cos, amp·sin, blend weight)
5. Min-heap + greedy removal loop
6. Final compaction
7. `decimateMesh()` public API

### Phase 2: Wire into builder (depends on Phase 1)

Update `marchingBuilder.ts`:
1. Add decimation strategy selection (parameter or constant for now)
2. New-decimation path: skip `decimateWavefronts`, call `buildMeshData` on raw wavefronts, then `decimateMesh` on the result
3. Old-decimation path: unchanged
4. Update timing/stats logging for both paths

### Phase 3: Benchmark comparison (depends on Phase 2)

Use existing `bin/benchmark-mesh-build.ts` to compare:
- Vertex/triangle counts
- Build time (total and decimation phase)
- Visual comparison in-game by toggling the strategy
