//! Terrain height computation, slow path. Mirrors `computeTerrainHeight`
//! in `src/game/world/query/water-math.ts` (which itself is a port of the
//! WGSL slow-path branch in `terrain.wgsl.ts`).
//!
//! Skips all GPU acceleration structures (containment grid, IDW grid,
//! lookup grid) — relies on:
//!   - DFS pre-order skip-count traversal for deepest-contour lookup
//!   - bbox rejection plus winding-number containment test
//!   - linear scan of parent + children edges for IDW boundary distance
//!
//! Used by the water query for depth sampling. The terrain query itself
//! (phase 3) will likely use the same code with the analytical-gradient
//! quotient-rule blending added on top.

use crate::packed::{
    contour_base, terrain_child_index, terrain_vertex_xy, CONTOUR_BBOX_MAX_X,
    CONTOUR_BBOX_MAX_Y, CONTOUR_BBOX_MIN_X, CONTOUR_BBOX_MIN_Y, CONTOUR_CHILD_COUNT,
    CONTOUR_CHILD_START, CONTOUR_DEPTH, CONTOUR_HEIGHT, CONTOUR_POINT_COUNT,
    CONTOUR_POINT_START, CONTOUR_SKIP_COUNT,
};

const IDW_MIN_DIST: f32 = 0.1;

#[inline]
fn read_f32(packed: &[u32], idx: usize) -> f32 {
    f32::from_bits(packed[idx])
}

fn is_inside_contour(world_x: f32, world_y: f32, contour_index: usize, packed: &[u32]) -> bool {
    let c_base = contour_base(packed, contour_index);
    let bbox_min_x = read_f32(packed, c_base + CONTOUR_BBOX_MIN_X);
    let bbox_min_y = read_f32(packed, c_base + CONTOUR_BBOX_MIN_Y);
    let bbox_max_x = read_f32(packed, c_base + CONTOUR_BBOX_MAX_X);
    let bbox_max_y = read_f32(packed, c_base + CONTOUR_BBOX_MAX_Y);
    if world_x < bbox_min_x
        || world_x > bbox_max_x
        || world_y < bbox_min_y
        || world_y > bbox_max_y
        || bbox_max_x - bbox_min_x <= 0.0
        || bbox_max_y - bbox_min_y <= 0.0
    {
        return false;
    }

    let n = packed[c_base + CONTOUR_POINT_COUNT] as usize;
    let start = packed[c_base + CONTOUR_POINT_START] as usize;
    let mut winding_number: i32 = 0;
    for i in 0..n {
        let ai = start + i;
        let bi = start + ((i + 1) % n);
        let (ax, ay) = terrain_vertex_xy(packed, ai);
        let (bx, by) = terrain_vertex_xy(packed, bi);
        if ay <= world_y {
            if by > world_y {
                let cross = (bx - ax) * (world_y - ay) - (world_x - ax) * (by - ay);
                if cross > 0.0 {
                    winding_number += 1;
                }
            }
        } else if by <= world_y {
            let cross = (bx - ax) * (world_y - ay) - (world_x - ax) * (by - ay);
            if cross < 0.0 {
                winding_number -= 1;
            }
        }
    }
    winding_number != 0
}

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
        let ai = start + i;
        let bi = start + ((i + 1) % n);
        let (ax, ay) = terrain_vertex_xy(packed, ai);
        let (bx, by) = terrain_vertex_xy(packed, bi);
        let abx = bx - ax;
        let aby = by - ay;
        let length_sq = abx * abx + aby * aby;
        let (dx, dy) = if length_sq == 0.0 {
            (world_x - ax, world_y - ay)
        } else {
            let mut t = ((world_x - ax) * abx + (world_y - ay) * aby) / length_sq;
            if t < 0.0 {
                t = 0.0;
            } else if t > 1.0 {
                t = 1.0;
            }
            (world_x - (ax + t * abx), world_y - (ay + t * aby))
        };
        let dist_sq = dx * dx + dy * dy;
        if dist_sq < min_dist_sq {
            min_dist_sq = dist_sq;
        }
    }
    min_dist_sq.sqrt()
}

fn find_deepest_containing_contour(
    world_x: f32,
    world_y: f32,
    packed: &[u32],
    contour_count: usize,
) -> Option<usize> {
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
