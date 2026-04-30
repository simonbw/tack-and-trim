//! Read-only accessors over the packed `[u32]` buffers shared with the
//! GPU shaders. Each buffer aliases mixed u32/f32 fields in a single
//! linear allocation; the WGSL side reads via `bitcast<f32>()`, and on
//! the wasm side we use `f32::from_bits()` (the same operation).
//!
//! Layouts mirror:
//! - `src/game/world/shaders/terrain-packed.wgsl.ts`
//! - `src/game/world/shaders/mesh-packed.wgsl.ts`
//! - `src/game/world/shaders/tide-mesh-packed.wgsl.ts`
//! - `src/game/world/shaders/wind-mesh-packed.wgsl.ts`
//!
//! Keep these constants in sync with the WGSL and the TypeScript ports
//! (`terrain-math.ts`, `water-math.ts`, etc.).

// ---------------------------------------------------------------------------
// Terrain packed-buffer layout (mirrors terrain-packed.wgsl.ts)
// ---------------------------------------------------------------------------

pub const TERRAIN_HEADER_VERTICES_OFFSET: usize = 0;
pub const TERRAIN_HEADER_CONTOURS_OFFSET: usize = 1;
pub const TERRAIN_HEADER_CHILDREN_OFFSET: usize = 2;
pub const TERRAIN_HEADER_CONTAINMENT_GRID_OFFSET: usize = 3;
// Slot 4 is the IDW grid data section base. We don't read it directly
// — each contour records an absolute `idw_grid_offset` that already
// points into this section.
pub const TERRAIN_HEADER_LOOKUP_GRID_OFFSET: usize = 5;

/// Minimum boundary distance for IDW weighting. Distances below this
/// clamp to a fixed weight to avoid division by zero / runaway weights
/// near a contour edge. Matches `_IDW_MIN_DIST` in `terrain.wgsl.ts`.
pub const IDW_MIN_DIST: f32 = 0.1;

#[inline]
pub fn read_f32(packed: &[u32], idx: usize) -> f32 {
    f32::from_bits(packed[idx])
}

/// Squared distance from `(px, py)` to the closest point on segment
/// `(ax, ay) → (bx, by)`. Used by both terrain queries (water-depth
/// scalar path and analytical-gradient path) — the gradient path also
/// wants `(dx, dy)`, so it has its own version that returns those.
#[inline]
pub fn point_to_segment_dist_sq(
    px: f32,
    py: f32,
    ax: f32,
    ay: f32,
    bx: f32,
    by: f32,
) -> f32 {
    let abx = bx - ax;
    let aby = by - ay;
    let length_sq = abx * abx + aby * aby;
    let (dx, dy) = if length_sq == 0.0 {
        (px - ax, py - ay)
    } else {
        let t = (((px - ax) * abx + (py - ay) * aby) / length_sq).clamp(0.0, 1.0);
        (px - (ax + t * abx), py - (ay + t * aby))
    };
    dx * dx + dy * dy
}

/// Lookup grid header layout (mirrors `LOOKUP_GRID_HEADER` in
/// `src/game/world/terrain/TerrainConstants.ts`):
///   [0] cols (u32)
///   [1] rows (u32)
///   [2] minX (f32)
///   [3] minY (f32)
///   [4] invCellW (f32)
///   [5] invCellH (f32)
/// Followed by `cols * rows` base-contour entries (u32, sentinel
/// `LOOKUP_GRID_NO_BASE` for cells with no fully-containing contour),
/// then `cols * rows + 1` cell-start prefix-sum entries, then the
/// candidate list itself. The cell-starts and candidate sections are
/// always sized for `LOOKUP_GRID_CELLS = LOOKUP_GRID_SIZE²` (the
/// build-side max), even when the actual grid is smaller — so we use
/// `LOOKUP_GRID_CELLS_MAX` to compute downstream offsets.
pub const LOOKUP_GRID_HEADER: usize = 6;
pub const LOOKUP_GRID_SIZE_MAX: usize = 1024;
pub const LOOKUP_GRID_CELLS_MAX: usize = LOOKUP_GRID_SIZE_MAX * LOOKUP_GRID_SIZE_MAX;
pub const LOOKUP_GRID_NO_BASE: u32 = 0xFFFFFFFF;

/// Containment grid: per-contour 64×64 cells, 2 bits per cell, 16 cells
/// per u32 → 256 u32s per contour. Built at level-bake time and embedded
/// in the packed terrain buffer; the CPU port mirrors the WGSL fast path
/// `fn_getContainmentCellFlag` in `terrain-packed.wgsl.ts`.
pub const CONTAINMENT_GRID_SIZE: usize = 64;
pub const CONTAINMENT_GRID_U32S_PER_CONTOUR: usize = 256;
pub const CONTAINMENT_FLAG_OUTSIDE: u32 = 0;
pub const CONTAINMENT_FLAG_INSIDE: u32 = 1;
pub const CONTAINMENT_FLAG_BOUNDARY: u32 = 2;

pub const FLOATS_PER_CONTOUR: usize = 14;

pub const CONTOUR_POINT_START: usize = 0;
pub const CONTOUR_POINT_COUNT: usize = 1;
pub const CONTOUR_HEIGHT: usize = 2;
pub const CONTOUR_DEPTH: usize = 4;
pub const CONTOUR_CHILD_START: usize = 5;
pub const CONTOUR_CHILD_COUNT: usize = 6;
pub const CONTOUR_BBOX_MIN_X: usize = 8;
pub const CONTOUR_BBOX_MIN_Y: usize = 9;
pub const CONTOUR_BBOX_MAX_X: usize = 10;
pub const CONTOUR_BBOX_MAX_Y: usize = 11;
pub const CONTOUR_SKIP_COUNT: usize = 12;
/// Element offset within the packed buffer where this contour's IDW
/// grid lives, or 0 when no grid was built (rare — only contours with
/// children have grids).
pub const CONTOUR_IDW_GRID_OFFSET: usize = 13;

/// Per-contour IDW edge grid is `IDW_GRID_SIZE × IDW_GRID_SIZE` cells of
/// candidate edges from the contour's parent + children boundaries.
/// Each cell stores indices into a packed entry list:
///   - First `IDW_GRID_CELL_STARTS` u32s: prefix-sum where cell `i`'s
///     entries are `[cell_starts[i], cell_starts[i+1])`. The last entry
///     `cell_starts[IDW_GRID_CELLS]` is the total entry count.
///   - Then variable u32s — each entry is `(tag << 16) | edge_index`,
///     with `tag == 0` for the parent contour and `tag == k` for child
///     `k - 1`.
pub const IDW_GRID_SIZE: usize = 32;
pub const IDW_GRID_CELLS: usize = IDW_GRID_SIZE * IDW_GRID_SIZE;
pub const IDW_GRID_CELL_STARTS: usize = IDW_GRID_CELLS + 1;
/// Max contours that share an IDW blend: 1 parent + 31 children. Fixed
/// upper bound so per-tag tracking can use stack arrays.
pub const MAX_IDW_CONTOURS: usize = 32;

#[inline]
pub fn contour_base(packed: &[u32], contour_index: usize) -> usize {
    packed[TERRAIN_HEADER_CONTOURS_OFFSET] as usize + contour_index * FLOATS_PER_CONTOUR
}

#[inline]
pub fn terrain_vertex_xy(packed: &[u32], vertex_index: usize) -> (f32, f32) {
    let base = packed[TERRAIN_HEADER_VERTICES_OFFSET] as usize + vertex_index * 2;
    (f32::from_bits(packed[base]), f32::from_bits(packed[base + 1]))
}

#[inline]
pub fn terrain_child_index(packed: &[u32], child_list_index: usize) -> usize {
    let children_base = packed[TERRAIN_HEADER_CHILDREN_OFFSET] as usize;
    packed[children_base + child_list_index] as usize
}

/// Read a 2-bit containment-grid cell flag (OUTSIDE / INSIDE / BOUNDARY)
/// for `contour_index` at `cell_index ∈ [0, 4096)`. Mirrors WGSL
/// `getContainmentCellFlag` in `terrain-packed.wgsl.ts`.
#[inline]
pub fn containment_cell_flag(
    packed: &[u32],
    contour_index: usize,
    cell_index: usize,
) -> u32 {
    let grid_offset = packed[TERRAIN_HEADER_CONTAINMENT_GRID_OFFSET] as usize;
    let contour_grid_base = grid_offset + contour_index * CONTAINMENT_GRID_U32S_PER_CONTOUR;
    let word_index = cell_index >> 4; // 16 cells per u32
    let word = packed[contour_grid_base + word_index];
    (word >> ((cell_index & 15) * 2)) & 3
}

/// Read a `(cols, rows, min_x, min_y, inv_cell_w, inv_cell_h)` tuple
/// from the lookup-grid header. Caller is responsible for checking
/// that the grid offset is non-zero.
#[inline]
pub fn lookup_grid_header(packed: &[u32], grid_offset: usize) -> (u32, u32, f32, f32, f32, f32) {
    assert!(grid_offset + 6 <= packed.len(), "lookup_grid_header OOB");
    (
        packed[grid_offset],
        packed[grid_offset + 1],
        f32::from_bits(packed[grid_offset + 2]),
        f32::from_bits(packed[grid_offset + 3]),
        f32::from_bits(packed[grid_offset + 4]),
        f32::from_bits(packed[grid_offset + 5]),
    )
}

/// Read the deepest-fully-containing-contour index for a lookup-grid
/// cell. Returns `LOOKUP_GRID_NO_BASE` when the cell sits entirely
/// outside every contour.
#[inline]
pub fn lookup_grid_base_contour(
    packed: &[u32],
    grid_offset: usize,
    cell_index: usize,
) -> u32 {
    let i = grid_offset + LOOKUP_GRID_HEADER + cell_index;
    assert!(
        i < packed.len(),
        "lookup_grid_base_contour OOB: i={} len={}",
        i,
        packed.len()
    );
    packed[i]
}

/// Read `[start, end)` into the lookup grid's candidate list for a
/// given cell. Candidates are pre-sorted deepest-first.
#[inline]
pub fn lookup_grid_candidate_range(
    packed: &[u32],
    grid_offset: usize,
    cell_index: usize,
) -> (usize, usize) {
    let cell_starts_base = grid_offset + LOOKUP_GRID_HEADER + LOOKUP_GRID_CELLS_MAX;
    let i0 = cell_starts_base + cell_index;
    let i1 = i0 + 1;
    assert!(
        i1 < packed.len(),
        "lookup_grid_candidate_range OOB: i1={} len={} grid_offset={} cell_index={}",
        i1,
        packed.len(),
        grid_offset,
        cell_index
    );
    (packed[i0] as usize, packed[i1] as usize)
}

/// Read a candidate contour DFS index from the lookup grid.
#[inline]
pub fn lookup_grid_candidate(
    packed: &[u32],
    grid_offset: usize,
    candidate_index: usize,
) -> usize {
    let candidates_base =
        grid_offset + LOOKUP_GRID_HEADER + LOOKUP_GRID_CELLS_MAX + (LOOKUP_GRID_CELLS_MAX + 1);
    let i = candidates_base + candidate_index;
    assert!(
        i < packed.len(),
        "lookup_grid_candidate OOB: i={}, packed.len()={}, grid_offset={}, candidate_index={}",
        i,
        packed.len(),
        grid_offset,
        candidate_index
    );
    packed[i] as usize
}

#[inline]
pub fn contour_idw_grid_offset(packed: &[u32], contour_index: usize) -> usize {
    let c_base = contour_base(packed, contour_index);
    packed[c_base + CONTOUR_IDW_GRID_OFFSET] as usize
}

/// Read `[entry_start, entry_end)` for the IDW grid cell `cell_index`
/// of the contour rooted at `grid_base` (= the contour's
/// `idw_grid_offset`). Mirrors the WGSL `getIDWGridCandidateRange`.
#[inline]
pub fn idw_grid_candidate_range(
    packed: &[u32],
    grid_base: usize,
    cell_index: usize,
) -> (usize, usize) {
    let i0 = grid_base + cell_index;
    (packed[i0] as usize, packed[i0 + 1] as usize)
}

/// Read a packed `(tag << 16) | edge_index` entry from the IDW grid.
/// Mirrors WGSL `getIDWGridEntry`.
#[inline]
pub fn idw_grid_entry(packed: &[u32], grid_base: usize, entry_index: usize) -> u32 {
    let entries_base = grid_base + IDW_GRID_CELL_STARTS;
    packed[entries_base + entry_index]
}

/// Resolve `(point_start, point_count)` for a contour by DFS index. Used
/// by the IDW grid path to fetch a contour's polygon outline from a
/// raw `tag` without going through `contour_data`.
#[inline]
pub fn contour_point_range(packed: &[u32], contour_index: usize) -> (usize, usize) {
    let c_base = contour_base(packed, contour_index);
    (
        packed[c_base + CONTOUR_POINT_START] as usize,
        packed[c_base + CONTOUR_POINT_COUNT] as usize,
    )
}

/// Read fields the inside-contour test needs without redoing all the
/// per-field reads in two files.
#[inline]
pub fn contour_bbox(packed: &[u32], contour_index: usize) -> (f32, f32, f32, f32) {
    let c_base = contour_base(packed, contour_index);
    (
        f32::from_bits(packed[c_base + CONTOUR_BBOX_MIN_X]),
        f32::from_bits(packed[c_base + CONTOUR_BBOX_MIN_Y]),
        f32::from_bits(packed[c_base + CONTOUR_BBOX_MAX_X]),
        f32::from_bits(packed[c_base + CONTOUR_BBOX_MAX_Y]),
    )
}

/// Single-source-of-truth `is_inside_contour` shared by terrain.rs and
/// terrain_height.rs. Mirrors the WGSL fast-path:
///   1. Reject by bbox.
///   2. Containment-grid lookup (O(1) for INSIDE/OUTSIDE cells, ~95% of
///      queries).
///   3. Polygon winding-number test for BOUNDARY cells.
pub fn is_inside_contour(
    world_x: f32,
    world_y: f32,
    contour_index: usize,
    packed: &[u32],
) -> bool {
    let (bbox_min_x, bbox_min_y, bbox_max_x, bbox_max_y) =
        contour_bbox(packed, contour_index);
    let bbox_w = bbox_max_x - bbox_min_x;
    let bbox_h = bbox_max_y - bbox_min_y;
    if world_x < bbox_min_x
        || world_x > bbox_max_x
        || world_y < bbox_min_y
        || world_y > bbox_max_y
        || bbox_w <= 0.0
        || bbox_h <= 0.0
    {
        return false;
    }

    let grid_size_f = CONTAINMENT_GRID_SIZE as f32;
    let max_idx = (CONTAINMENT_GRID_SIZE - 1) as f32;
    let col = (((world_x - bbox_min_x) * (grid_size_f / bbox_w))
        .floor()
        .clamp(0.0, max_idx)) as usize;
    let row = (((world_y - bbox_min_y) * (grid_size_f / bbox_h))
        .floor()
        .clamp(0.0, max_idx)) as usize;
    let cell_index = row * CONTAINMENT_GRID_SIZE + col;
    let flag = containment_cell_flag(packed, contour_index, cell_index);
    if flag == CONTAINMENT_FLAG_OUTSIDE {
        return false;
    }
    if flag == CONTAINMENT_FLAG_INSIDE {
        return true;
    }
    debug_assert_eq!(flag, CONTAINMENT_FLAG_BOUNDARY);

    let c_base = contour_base(packed, contour_index);
    let n = packed[c_base + CONTOUR_POINT_COUNT] as usize;
    let start = packed[c_base + CONTOUR_POINT_START] as usize;
    let mut winding: i32 = 0;
    for i in 0..n {
        let ai = start + i;
        let bi = start + ((i + 1) % n);
        let (ax, ay) = terrain_vertex_xy(packed, ai);
        let (bx, by) = terrain_vertex_xy(packed, bi);
        if ay <= world_y {
            if by > world_y {
                let cross = (bx - ax) * (world_y - ay) - (world_x - ax) * (by - ay);
                if cross > 0.0 {
                    winding += 1;
                }
            }
        } else if by <= world_y {
            let cross = (bx - ax) * (world_y - ay) - (world_x - ax) * (by - ay);
            if cross < 0.0 {
                winding -= 1;
            }
        }
    }
    winding != 0
}

/// Find the deepest contour that contains `(world_x, world_y)`. Mirrors
/// `fn_computeTerrainHeight` phase 1 in `terrain.wgsl.ts`. Uses the
/// lookup grid when present, falls back to DFS skip-count traversal
/// otherwise.
///
/// The lookup grid stores, for each cell of a level-wide grid, the
/// deepest contour that *fully* contains the cell ("base") plus a
/// candidate list of contours whose bbox overlaps the cell, sorted
/// deepest-first. The first candidate that contains the point wins;
/// if none match, the base contour is the answer.
pub fn find_deepest_containing_contour(
    world_x: f32,
    world_y: f32,
    packed: &[u32],
    contour_count: usize,
) -> Option<usize> {
    let lookup_offset = packed[TERRAIN_HEADER_LOOKUP_GRID_OFFSET] as usize;
    if lookup_offset != 0 {
        let (cols, rows, min_x, min_y, inv_cell_w, inv_cell_h) =
            lookup_grid_header(packed, lookup_offset);
        let col_f = ((world_x - min_x) * inv_cell_w).floor();
        let row_f = ((world_y - min_y) * inv_cell_h).floor();
        if col_f >= 0.0
            && row_f >= 0.0
            && (col_f as u32) < cols
            && (row_f as u32) < rows
        {
            let cell_index = (row_f as usize) * (cols as usize) + (col_f as usize);
            let (range_start, range_end) =
                lookup_grid_candidate_range(packed, lookup_offset, cell_index);
            for c in range_start..range_end {
                let candidate_idx = lookup_grid_candidate(packed, lookup_offset, c);
                if is_inside_contour(world_x, world_y, candidate_idx, packed) {
                    return Some(candidate_idx);
                }
            }
            let base = lookup_grid_base_contour(packed, lookup_offset, cell_index);
            if base != LOOKUP_GRID_NO_BASE {
                return Some(base as usize);
            }
        }
        return None;
    }

    // Fallback: DFS skip-count traversal. Containment grid still
    // accelerates each `is_inside_contour` call.
    let mut deepest_index: Option<usize> = None;
    let mut deepest_depth: u32 = 0;
    let mut i = 0usize;
    let mut last_to_check = contour_count;
    while i < last_to_check {
        let c_base = contour_base(packed, i);
        let skip_count = packed[c_base + CONTOUR_SKIP_COUNT] as usize;
        if is_inside_contour(world_x, world_y, i, packed) {
            let depth = packed[c_base + CONTOUR_DEPTH];
            if depth >= deepest_depth {
                deepest_depth = depth;
                deepest_index = Some(i);
            }
            last_to_check = i + skip_count + 1;
            i += 1;
        } else {
            i += skip_count + 1;
        }
    }
    deepest_index
}

/// Derive contour count from the packed-terrain layout. The contour
/// section starts at HEADER_CONTOURS_OFFSET and each contour is
/// FLOATS_PER_CONTOUR wide; the children section follows it, so we
/// derive the count from the gap between the two offsets.
pub fn terrain_contour_count(packed: &[u32]) -> usize {
    if packed.len() <= TERRAIN_HEADER_CHILDREN_OFFSET {
        return 0;
    }
    let contours_offset = packed[TERRAIN_HEADER_CONTOURS_OFFSET] as usize;
    let children_offset = packed[TERRAIN_HEADER_CHILDREN_OFFSET] as usize;
    if children_offset > contours_offset {
        (children_offset - contours_offset) / FLOATS_PER_CONTOUR
    } else {
        0
    }
}

// ---------------------------------------------------------------------------
// Wave mesh packed-buffer layout (mirrors mesh-packed.wgsl.ts)
// ---------------------------------------------------------------------------

pub const MESH_HEADER_MESH_OFFSETS_BASE: usize = 1;

/// Offsets into a per-wave mesh header (16 u32). [13..15] are padding.
pub const MESH_VERTEX_OFFSET: usize = 0;
pub const MESH_INDEX_OFFSET: usize = 2;
pub const MESH_TRIANGLE_COUNT: usize = 3;
pub const MESH_GRID_OFFSET: usize = 4;
pub const MESH_GRID_COLS: usize = 5;
pub const MESH_GRID_ROWS: usize = 6;
pub const MESH_GRID_MIN_X_F32: usize = 7;
pub const MESH_GRID_MIN_Y_F32: usize = 8;
pub const MESH_GRID_CELL_W_F32: usize = 9;
pub const MESH_GRID_CELL_H_F32: usize = 10;
pub const MESH_GRID_COS_A_F32: usize = 11;
pub const MESH_GRID_SIN_A_F32: usize = 12;

/// Each wave-mesh vertex is 6 floats: [posX, posY, ampFactor, dirOffset,
/// phaseOffset, blendWeight].
pub const MESH_FLOATS_PER_VERTEX: usize = 6;

#[inline]
pub fn mesh_num_waves(packed: &[u32]) -> u32 {
    if packed.is_empty() {
        0
    } else {
        packed[0]
    }
}

// ---------------------------------------------------------------------------
// Wind mesh packed-buffer layout (mirrors wind-mesh-packed.wgsl.ts).
// ---------------------------------------------------------------------------

/// Each wind-mesh vertex is 5 floats: [posX, posY, speedFactor,
/// dirOffset, turbulence].
pub const WIND_MESH_FLOATS_PER_VERTEX: usize = 5;
