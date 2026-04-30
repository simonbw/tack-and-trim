//! Scalar terrain-height query — used by the water query for depth
//! sampling. Mirrors `computeTerrainHeight` in `terrain.wgsl.ts`.
//!
//! Acceleration structures used (all delegated to `packed.rs`):
//!   - Lookup grid → O(few candidates) deepest-contour lookup
//!   - Containment grid → O(1) inside/outside for ~95% of queries
//!   - IDW edge grid → per-cell candidate edges for the IDW blend,
//!     with a linear-scan fallback for contours that don't have one
//!
//! Distinct from `terrain.rs` (which produces height + analytical
//! gradient via the quotient rule). Water doesn't need the gradient,
//! so this scalar-only path skips the per-tag (dx, dy) tracking.

use crate::packed::{
    contour_base, contour_idw_grid_offset, contour_point_range, find_deepest_containing_contour,
    idw_cell_index_for_point, idw_grid_candidate_range, idw_grid_entry,
    point_to_segment_dist_sq, read_f32, terrain_child_index, terrain_vertex_xy,
    CONTOUR_CHILD_COUNT, CONTOUR_CHILD_START, CONTOUR_HEIGHT, CONTOUR_POINT_COUNT,
    CONTOUR_POINT_START, IDW_MIN_DIST, MAX_IDW_CONTOURS,
};

fn distance_to_contour_boundary(
    world_x: f32,
    world_y: f32,
    contour_index: usize,
    packed: &[u32],
) -> f32 {
    let c_base = contour_base(packed, contour_index);
    let n = packed[c_base + CONTOUR_POINT_COUNT] as usize;
    let start = packed[c_base + CONTOUR_POINT_START] as usize;
    let mut min_dist_sq = 1.0e20_f32;
    for i in 0..n {
        let (ax, ay) = terrain_vertex_xy(packed, start + i);
        let (bx, by) = terrain_vertex_xy(packed, start + ((i + 1) % n));
        let dist_sq = point_to_segment_dist_sq(world_x, world_y, ax, ay, bx, by);
        if dist_sq < min_dist_sq {
            min_dist_sq = dist_sq;
        }
    }
    min_dist_sq.sqrt()
}

/// Compute terrain height at (world_x, world_y), slow path.
///
/// Returns `default_depth` when no contour contains the point. When a
/// contour is found, blends parent + children heights via inverse-distance
/// weighting just like the GPU shader's "no IDW grid" fallback branch.
pub fn compute_terrain_height(
    world_x: f32,
    world_y: f32,
    packed: &[u32],
    contour_count: usize,
    default_depth: f32,
) -> f32 {
    if contour_count == 0 || packed.is_empty() {
        return default_depth;
    }
    let deepest_index = match find_deepest_containing_contour(world_x, world_y, packed, contour_count)
    {
        Some(i) => i,
        None => return default_depth,
    };

    let parent_base = contour_base(packed, deepest_index);
    let parent_height = read_f32(packed, parent_base + CONTOUR_HEIGHT);
    let child_count = packed[parent_base + CONTOUR_CHILD_COUNT] as usize;
    if child_count == 0 {
        return parent_height;
    }

    let grid_base = contour_idw_grid_offset(packed, deepest_index);
    if grid_base != 0 {
        return idw_blend_with_grid(
            world_x,
            world_y,
            packed,
            deepest_index,
            grid_base,
            child_count,
            parent_height,
            parent_base,
        );
    }

    // Fallback: linear scan of every parent + child edge.
    let dist_to_parent = distance_to_contour_boundary(world_x, world_y, deepest_index, packed);
    let parent_weight = 1.0 / dist_to_parent.max(IDW_MIN_DIST);
    let mut total_weight = parent_weight;
    let mut weighted_sum = parent_height * parent_weight;

    let child_start = packed[parent_base + CONTOUR_CHILD_START] as usize;
    for c in 0..child_count {
        let child_index = terrain_child_index(packed, child_start + c);
        let child_base = contour_base(packed, child_index);
        let child_height = read_f32(packed, child_base + CONTOUR_HEIGHT);
        let dist_to_child = distance_to_contour_boundary(world_x, world_y, child_index, packed);
        let child_weight = 1.0 / dist_to_child.max(IDW_MIN_DIST);
        total_weight += child_weight;
        weighted_sum += child_height * child_weight;
    }
    weighted_sum / total_weight
}

/// Grid-accelerated IDW blend. Iterates only the candidate edges for
/// the cell `(world_x, world_y)` falls into, tracking per-tag (parent
/// = 0, child k = k+1) best squared distance, then evaluates the
/// standard IDW weighted average.
fn idw_blend_with_grid(
    world_x: f32,
    world_y: f32,
    packed: &[u32],
    deepest_index: usize,
    grid_base: usize,
    child_count: usize,
    parent_height: f32,
    parent_base: usize,
) -> f32 {
    let cell_index = idw_cell_index_for_point(packed, parent_base, world_x, world_y);
    let (entry_start, entry_end) = idw_grid_candidate_range(packed, grid_base, cell_index);

    let contour_count = 1 + child_count;
    let mut best_dist_sq = [1.0e20_f32; MAX_IDW_CONTOURS];

    let child_start = packed[parent_base + CONTOUR_CHILD_START] as usize;
    for e in entry_start..entry_end {
        let entry = idw_grid_entry(packed, grid_base, e);
        let tag = (entry >> 16) as usize;
        let edge_idx = (entry & 0xFFFF) as usize;

        let contour_idx = if tag == 0 {
            deepest_index
        } else {
            terrain_child_index(packed, child_start + tag - 1)
        };
        let (p_start, p_count) = contour_point_range(packed, contour_idx);
        let (ax, ay) = terrain_vertex_xy(packed, p_start + edge_idx);
        let (bx, by) = terrain_vertex_xy(packed, p_start + ((edge_idx + 1) % p_count));

        let dist_sq = point_to_segment_dist_sq(world_x, world_y, ax, ay, bx, by);
        if dist_sq < best_dist_sq[tag] {
            best_dist_sq[tag] = dist_sq;
        }
    }

    let parent_dist = best_dist_sq[0].sqrt().max(IDW_MIN_DIST);
    let parent_weight = 1.0 / parent_dist;
    let mut total_weight = parent_weight;
    let mut weighted_sum = parent_height * parent_weight;
    for c in 1..contour_count {
        let child_index = terrain_child_index(packed, child_start + c - 1);
        let child_base = contour_base(packed, child_index);
        let child_height = read_f32(packed, child_base + CONTOUR_HEIGHT);
        let dist = best_dist_sq[c].sqrt().max(IDW_MIN_DIST);
        let weight = 1.0 / dist;
        total_weight += weight;
        weighted_sum += child_height * weight;
    }
    weighted_sum / total_weight
}
