# Terrain Import Determinism Analysis

## Scope

Same binary, same inputs, same machine — should produce identical `.level.json` and `.wavemesh` output every time.

Pipeline path: `terrain-import import` → `download` → `build-grid` → `extract` → `wavemesh_builder::build_wavemesh_for_level`

## Non-Determinism Sources

### 1. CRITICAL: Wrong parent ID propagation in wavemesh marching
**Files:** `pipeline/wavemesh-builder/src/marching.rs:377-379, 212, 742`

```rust
// Line 379: passes grandparent instead of current track ID
let (next_step, produced, ..) = advance_track_segment_step(
    &segment,
    segment.parent_track_id,  // BUG: should be Some(track.track_id)
    ...);
```

`advance_track_segment_step` receives `segment.parent_track_id` (the *grandparent*) and stamps it onto all newly created child segments at line 212. When children are spawned at line 742-743, `track_id` is updated but `parent_track_id` is left pointing at the grandparent.

This breaks the parent-child tree that `reorder_tracks_deterministic` relies on:
- Multiple tracks appear as roots (`parent_track_id` pointing to non-existent tracks)
- DFS from "first root" doesn't visit all tracks
- The `debug_assert_eq!` at line 618 catches this in debug mode but **release silently proceeds with partial track visits**, dropping tracks from output

Empirically confirmed: debug builds hit `DFS did not visit all tracks: visited 1 of 29`. Release builds produce different file sizes across runs (e.g., 588,904 vs 587,584 bytes).

**Severity: CRITICAL** — This is a bug that causes both non-determinism and data loss in release mode.

### 2. HIGH: `build_closed_rings` iterates HashMap keys in arbitrary order
**File:** `pipeline/terrain-import/src/marching.rs:286`

```rust
for &start_edge in adj.keys() {  // HashMap iteration order is non-deterministic
```

The `adj` HashMap maps edge IDs to adjacency lists. Rust's HashMap uses randomized hash seeding per process, so `adj.keys()` iterates in a different order every run. This means:
- Ring order from `build_closed_rings` varies between runs
- The `all_rings` vec in `extract.rs` gets rings in a different sequence
- Different rings may be chosen as "first tested" in the containment tree builder
- Even though a `contours.sort_by` on height happens later (line 283), **rings at the same height** remain in insertion order, which was non-deterministic

**Severity: HIGH** — This directly affects the output `.level.json` file.

### 3. HIGH: Simplification order dependence via mutable global segment index
**Files:** `pipeline/terrain-import/src/extract.rs:243, 252-253`

Rings are simplified one-by-one in BFS `order`. After each ring, the `SegmentIndex` is mutated (old segments removed, simplified segments added). The constraints seen by later rings depend on the results of earlier simplifications.

If `order` changes due to upstream non-determinism (issues #2, #4), different rings are simplified against different constraint sets. This means the **actual polygon geometry changes**, not just ordering.

**Severity: HIGH** — Produces different simplified polygon point sets, not just reordering.

### 4. HIGH: Containment tree probe uses first vertex of inner ring
**File:** `pipeline/terrain-import/src/extract.rs:507`

```rust
let (px, py) = rings[inner_idx].points[0];
point_in_polygon(px, py, &rings[outer_idx].points)
```

The containment test uses `points[0]` as the probe point. If ring startpoint shifts (from non-deterministic HashMap traversal in issue #2), the probe point changes. Near polygon boundaries, this can flip containment decisions, producing a different tree structure.

**Severity: HIGH** — Amplifies issue #2 into structural tree changes.

### 5. MEDIUM: Final contour sort has no deterministic tie-breaker
**File:** `pipeline/terrain-import/src/extract.rs:283-287`

```rust
contours.sort_by(|a, b| {
    a.height.partial_cmp(&b.height).unwrap_or(std::cmp::Ordering::Equal)
});
```

`sort_by` is stable in Rust, so equal-height contours preserve their insertion order. But since insertion order comes from `build_closed_rings` → `bfs_order`, and `build_closed_rings` is non-deterministic (issue #2), contours at the same height level will appear in arbitrary order. Adding a geometric tie-breaker (e.g., centroid position or area) would make this deterministic.

**Severity: MEDIUM** — Amplifies issue #2 for same-height contours.

### 6. MEDIUM: `all_tracks` Mutex push order depends on scheduling
**File:** `pipeline/wavemesh-builder/src/marching.rs:780`

```rust
all_tracks.lock().unwrap().push(dec.track);
```

Tracks are pushed into the shared vec in task-completion order, which depends on rayon scheduling. `reorder_tracks_deterministic` was meant to fix this, but it relies on the broken parent-child tree (issue #1).

**Severity: MEDIUM** — Would be LOW if issue #1 were fixed.

### 7. LOW-MEDIUM: Child midpoint sort lacks explicit secondary key
**File:** `pipeline/wavemesh-builder/src/marching.rs:595`

```rust
children_with_key.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
```

If two children have exactly the same midpoint `t` value (or if NaN appears), they compare as `Equal`, leaving their relative order dependent on the non-deterministic input order from atomic track ID assignment.

**Severity: LOW-MEDIUM** — Only triggers when two child tracks have identical midpoint `t` values.

### 8. LOW: Atomic track ID assignment during parallel marching
**File:** `pipeline/wavemesh-builder/src/marching.rs:689, 724, 738-739`

Track IDs are assigned with `next_track_id.fetch_add(1, Ordering::Relaxed)` inside `process_track` on rayon's thread pool. The scheduling order determines which tracks get which IDs. Partially mitigated by `reorder_tracks_deterministic`, but that function's correctness depends on fixing issue #1.

**Severity: LOW** — Would be fully mitigated once issue #1 is fixed.

## Investigated & Cleared

### `segment_intersects_any` HashSet dedup
**File:** `pipeline/terrain-import/src/segment_index.rs:142`

The `tested` HashSet avoids testing the same segment twice. Since the function returns a boolean (any intersection found), the result is deterministic even though iteration order varies.

### `coord_idx` HashMap in `build_closed_rings`
**File:** `pipeline/terrain-import/src/marching.rs:254`

Determines which duplicate coordinate gets stored via `or_insert_with`. Segments are added in grid-scan order (deterministic), so this is safe.

### Parallel ray advancement
**File:** `pipeline/wavemesh-builder/src/marching.rs:130-204`

Uses indexed `into_par_iter()` which preserves output order. Sequential assembly in Pass 2 processes outcomes in original order.

### Parallel decimation
**File:** `pipeline/wavemesh-builder/src/decimate.rs:451`

Uses `into_par_iter().enumerate().filter_map().collect()`, which preserves indexed order in rayon.

### Triangulation HashMaps
**File:** `pipeline/wavemesh-builder/src/triangulate.rs`

`track_by_id` and `base_by_segment` HashMaps are used only for lookups, never iterated for output ordering. `unique_ptrs` HashSet is iterated only for counting vertices (pre-allocation sizing).

### JSON serialization
**File:** `src/editor/io/LevelFileFormat.ts`

Object properties are constructed in fixed order. No dynamic key iteration.

### Marching squares grid scan
**File:** `pipeline/terrain-import/src/marching.rs:70-246`

Iterates y then x in fixed order. Deterministic.

### Tile merge input order
**File:** `pipeline/terrain-import/src/build_grid.rs:111` — explicitly sorted.

### Region listing order
**File:** `pipeline/terrain-import/src/region.rs:130` — explicitly sorted.

### Terrain-core lookup candidate ties
**File:** `pipeline/terrain-core/src/terrain.rs:883` — already has deterministic tie-break by contour index.

## Additional Variability (Not Strict Same-Input)

These affect full import reproducibility but are input/state drift issues rather than in-process non-determinism:

- **Download URL list freshness** (`download.rs:340, 433, 564`) — stale vs refreshed URL lists can change selected tiles
- **Parallel duplicate filename race** (`download.rs:164, 179, 215`) — if two URLs resolve to same basename, writes can race
- **Cached `merged.tif` reuse** (`build_grid.rs:32`) — old cache may mask tile/config changes without `--force`
- **External `gdalwarp` version** (`build_grid.rs:47, 62`) — output depends on external tool version

## Summary

| # | Location | Issue | Severity |
|---|----------|-------|----------|
| 1 | `wavemesh-builder/marching.rs:379` | Wrong parent ID propagation breaks DFS reordering | **CRITICAL** |
| 2 | `terrain-import/marching.rs:286` | `adj.keys()` HashMap iteration in `build_closed_rings` | **HIGH** |
| 3 | `terrain-import/extract.rs:243` | Simplification order dependence via mutable segment index | **HIGH** |
| 4 | `terrain-import/extract.rs:507` | Containment probe uses first vertex, shifts with ring order | **HIGH** |
| 5 | `terrain-import/extract.rs:283` | Contour sort has no tie-breaker for same-height rings | **MEDIUM** |
| 6 | `wavemesh-builder/marching.rs:780` | Mutex push order depends on scheduling | **MEDIUM** |
| 7 | `wavemesh-builder/marching.rs:595` | Child sort `partial_cmp` fallback leaves ties unbroken | **LOW-MEDIUM** |
| 8 | `wavemesh-builder/marching.rs:689` | Atomic track ID assignment (partially mitigated) | **LOW** |

## Recommended Fix Order

1. ~~Fix wavemesh parent propagation (issue #1) — this is a bug causing data loss, not just non-determinism~~ **DONE** (commit cbbd916)
2. ~~Canonicalize ring traversal order and startpoint in `build_closed_rings` (issue #2)~~ **DONE** — canonical lex-min startpoint + sort by first point
3. ~~Add deterministic tie-break for equal-height contour sorting (issue #5)~~ **DONE** — first-point tie-breaker in extract.rs
4. Add secondary sort key to child midpoint sort (issue #7)
5. Add determinism regression tests for both `.level.json` and `.wavemesh`
