# Wavemesh Builder Determinism Plan

## Current State

The Rust wavemesh pipeline currently produces byte-different `.wavemesh` outputs across repeated runs with identical inputs.

Observed behavior:

1. Rebuilding the same level twice yields different file hashes.
2. Vertex and triangle *content* is equivalent (same geometry), but ordering in serialized buffers changes.
3. Parallelism level configuration in marching is misleading because rayon's global thread pool is initialized earlier during terrain parsing.

Primary code paths involved:

- `pipeline/wavemesh-builder/src/main.rs`
- `pipeline/wavemesh-builder/src/terrain.rs`
- `pipeline/wavemesh-builder/src/marching.rs`
- `pipeline/wavemesh-builder/src/decimate.rs`
- `pipeline/wavemesh-builder/src/triangulate.rs`

## Root Causes To Fix

1. **Runtime-scheduler track ID assignment**
   - `marching.rs` assigns `track_id` values via atomics inside rayon tasks.
   - IDs depend on task execution order, so subsequent `sort_by_key(track_id)` is nondeterministic.

2. **Rayon global pool init order**
   - `parse_contours()` uses rayon before `march_wavefronts()` attempts `ThreadPoolBuilder::build_global()`.
   - After first rayon usage, `build_global()` is a no-op; `WAVEMESH_THREADS` is not reliably applied.

3. **Potential unindexed collect order in decimation**
   - `decimate.rs` uses `into_par_iter().enumerate().filter_map().collect()`.
   - `filter_map` is unindexed in rayon, so order guarantees are weaker than explicit indexed/sequential assembly.

4. **Non-canonical tie ordering in candidate sort**
   - `terrain.rs` sorts candidates by depth only (`sort_unstable_by`), without deterministic tie-breakers.

## Desired End State

1. Same inputs always produce byte-identical `.wavemesh` outputs.
2. `WAVEMESH_THREADS` behavior is accurate and explicit.
3. Any ordering-sensitive stages have explicit canonical sort keys.
4. Determinism is validated by automated test/CI checks.

## Implementation Plan

### Phase 1: Make thread pool behavior explicit and correct

Files:

- `pipeline/wavemesh-builder/src/main.rs`
- `pipeline/wavemesh-builder/src/marching.rs`

Changes:

1. Initialize rayon global thread pool once, in `main()`, before any parallel work.
2. Resolve thread count in one place (`WAVEMESH_THREADS` or default), log once.
3. Remove/disable per-call `build_global()` inside `march_wavefronts()`.
4. If pool init fails unexpectedly, surface a clear warning/error instead of silently ignoring.

Why first:

- Ensures deterministic experiments and benchmarking are trustworthy.

### Phase 2: Decouple canonical ordering from runtime-assigned IDs

Files:

- `pipeline/wavemesh-builder/src/marching.rs`
- `pipeline/wavemesh-builder/src/wavefront.rs`
- `pipeline/wavemesh-builder/src/triangulate.rs`

Changes:

1. Preserve internal IDs for lineage/debug, but stop using scheduler-derived `track_id` as serialization order key.
2. Add a deterministic canonical ordering key per track, derived from stable geometry/time metadata from snapshots (for example, first snapshot `source_step_index`, then first segment `t` range, then quantized first point coordinates, then snapshot count as tie-breakers).
3. Sort tracks by this canonical key before triangulation.
4. Keep parent/child triangulation mapping intact by resolving children via stable map lookup, but avoid relying on arrival-order IDs for output sequence.

Notes:

- If needed, compute a deterministic DFS/BFS order from parent-child relationships with deterministic child ordering.
- Deterministic tie-breaking must be total (no ambiguous equal keys).

### Phase 3: Remove nondeterministic collect ordering risks in decimation

File:

- `pipeline/wavemesh-builder/src/decimate.rs`

Changes:

1. Replace `filter_map(...).collect()` assembly with deterministic structure:
   - Keep parallel computation for transformed snapshots, but collect into indexed temporary slots keyed by original snapshot index.
   - Build final `snapshots` vector sequentially in ascending index order.
2. Add debug assertion that snapshot `source_step_index` is nondecreasing after assembly.

Why:

- Ensures snapshot order cannot drift due unindexed parallel collect behavior.

### Phase 4: Canonicalize tie-break sorting in terrain lookup build

File:

- `pipeline/wavemesh-builder/src/terrain.rs`

Changes:

1. Replace depth-only unstable sort with deterministic comparator:
   - Primary: depth descending
   - Secondary: contour index ascending
2. Prefer `sort_by` (stable) or explicit full comparator with deterministic ties.

Why:

- Removes platform/version sensitivity in equal-depth candidate ordering.

### Phase 5: Add determinism verification tooling/tests

Files:

- `pipeline/wavemesh-builder/src/main.rs` (optional CLI flag)
- `pipeline/wavemesh-builder/tests/*` (new)
- `package.json` / existing scripts (if adding command)

Changes:

1. Add an automated determinism test:
   - Build same level twice in isolated temp paths.
   - Assert byte-equality (`cmp`/hash compare).
2. Add a smoke test covering at least one complex level (`san-juan-islands.level.json`) and one small level (`default.level.json`).
3. Optionally add a `--determinism-check` mode to run repeated in-process builds and fail fast on mismatch.

## File-Level Work Breakdown (Parallelization)

Can be done in parallel:

1. **Worker A**: Phase 1 (rayon init cleanup)
2. **Worker B**: Phase 4 (terrain tie-break canonical sort)
3. **Worker C**: Phase 5 test harness scaffolding

Should be done sequentially:

1. Phase 2 before final Phase 5 assertions (largest behavior impact)
2. Phase 3 before final Phase 5 assertions (ordering correctness)

Recommended execution order:

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 4
5. Phase 5

## Acceptance Criteria

1. Re-running builder twice with identical inputs yields byte-identical `.wavemesh` outputs.
2. Determinism holds with default thread count and with `WAVEMESH_THREADS` explicitly set.
3. Existing mesh quality metrics (vertex/triangle counts) remain within expected ranges.
4. No regression in build success across all shipped levels.

## Risks and Mitigations

1. **Risk**: Canonical ordering key accidentally reorders topology linkage assumptions.
   - Mitigation: compare triangle set equivalence before/after and visually spot-check in game.

2. **Risk**: Deterministic ordering introduces measurable performance overhead.
   - Mitigation: keep canonical sort O(n log n) on track count only; benchmark before/after.

3. **Risk**: Thread pool init changes impact throughput or existing scripts.
   - Mitigation: preserve current default thread behavior unless `WAVEMESH_THREADS` is explicitly set.

## Open Questions

1. Should determinism be guaranteed only per-platform, or cross-platform byte-identical?
2. Do we want to persist legacy `track_id` semantics for debugging output, or fully replace with deterministic lineage IDs?
3. Should determinism checks run in CI for every PR, or only in a nightly/perf pipeline?
