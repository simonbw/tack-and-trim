//! Terrain query — port of `writeTerrainResult` from
//! `src/game/world/query/terrain-math.ts` (which mirrors
//! `TerrainQueryShader.ts`).
//!
//! Output layout (`TerrainResultLayout`):
//!   `[height, normal_x, normal_y, terrain_type]`
//!
//! Terrain type is 1.0 when the resolved height is ≥ 0 (land), else 0.0
//! (water).

use crate::packed::{
    contour_base, contour_idw_grid_offset, contour_point_range, find_deepest_containing_contour,
    idw_grid_candidate_range, idw_grid_entry, terrain_child_index, terrain_contour_count,
    terrain_vertex_xy, CONTOUR_BBOX_MAX_X, CONTOUR_BBOX_MAX_Y, CONTOUR_BBOX_MIN_X,
    CONTOUR_BBOX_MIN_Y, CONTOUR_CHILD_COUNT, CONTOUR_CHILD_START, CONTOUR_HEIGHT,
    CONTOUR_POINT_COUNT, CONTOUR_POINT_START, IDW_GRID_SIZE, MAX_IDW_CONTOURS,
};
use crate::world_state::WorldState;

pub const STRIDE_PER_POINT: usize = 2;
pub const PARAMS_FLOATS_PER_CHANNEL: usize = 128;

const TERRAIN_PARAM_DEFAULT_DEPTH: usize = 1;

const IDW_MIN_DIST: f32 = 0.1;
const NORMAL_Z: f32 = 1.0;

#[inline]
fn read_f32(packed: &[u32], idx: usize) -> f32 {
    f32::from_bits(packed[idx])
}

/// Distance from `(world_x, world_y)` to the nearest point on the
/// contour boundary, plus the unit gradient (∂d/∂world). The gradient
/// equals the unit vector from the nearest boundary point toward
/// `world` — used in the IDW quotient-rule normal computation.
fn distance_to_boundary_with_gradient(
    world_x: f32,
    world_y: f32,
    contour_index: usize,
    packed: &[u32],
) -> (f32, f32, f32) {
    let c_base = contour_base(packed, contour_index);
    let n = packed[c_base + CONTOUR_POINT_COUNT] as usize;
    let start = packed[c_base + CONTOUR_POINT_START] as usize;
    let mut min_dist_sq = 1.0e20_f32;
    let mut best_dx = 0.0_f32;
    let mut best_dy = 0.0_f32;
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
            best_dx = dx;
            best_dy = dy;
        }
    }
    let distance = min_dist_sq.sqrt();
    if distance > 1.0e-9 {
        let inv = 1.0 / distance;
        (distance, best_dx * inv, best_dy * inv)
    } else {
        (distance, 0.0, 0.0)
    }
}

/// Compute terrain height + analytical gradient at (world_x, world_y).
/// Gradient is `(∂h/∂x, ∂h/∂y)`, suitable for converting into a 3-space
/// normal `normalize(-gx, -gy, 1)`.
fn compute_terrain_height_and_gradient(
    world_x: f32,
    world_y: f32,
    packed: &[u32],
    contour_count: usize,
    default_depth: f32,
) -> (f32, f32, f32) {
    if contour_count == 0 || packed.is_empty() {
        return (default_depth, 0.0, 0.0);
    }
    let deepest_index = match find_deepest_containing_contour(
        world_x,
        world_y,
        packed,
        contour_count,
    ) {
        Some(i) => i,
        None => return (default_depth, 0.0, 0.0),
    };

    let parent_base = contour_base(packed, deepest_index);
    let parent_height = read_f32(packed, parent_base + CONTOUR_HEIGHT);
    let child_count = packed[parent_base + CONTOUR_CHILD_COUNT] as usize;
    if child_count == 0 {
        return (parent_height, 0.0, 0.0);
    }

    let grid_base = contour_idw_grid_offset(packed, deepest_index);
    if grid_base != 0 {
        return idw_blend_with_gradient_grid(
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

    // Fallback: no IDW grid — linear scan over every parent + child edge.
    // IDW with analytical gradient via the quotient rule:
    //   H     = Σ h_i w_i / Σ w_i
    //   ∇H    = (Σ h_i ∇w_i · Σ w_i − Σ h_i w_i · Σ ∇w_i) / (Σ w_i)²
    let mut weight_sum = 0.0_f32;
    let mut weighted_height_sum = 0.0_f32;
    let mut grad_weight_sum_x = 0.0_f32;
    let mut grad_weight_sum_y = 0.0_f32;
    let mut grad_weighted_height_sum_x = 0.0_f32;
    let mut grad_weighted_height_sum_y = 0.0_f32;

    let mut accumulate = |contour_index: usize, h: f32| {
        let (dist, gdx, gdy) =
            distance_to_boundary_with_gradient(world_x, world_y, contour_index, packed);
        let (w, gwx, gwy) = if dist <= IDW_MIN_DIST {
            let w = 1.0 / IDW_MIN_DIST;
            let scale = -1.0 / (IDW_MIN_DIST * IDW_MIN_DIST);
            (w, scale * gdx, scale * gdy)
        } else {
            let inv = 1.0 / dist;
            let scale = -inv * inv;
            (inv, scale * gdx, scale * gdy)
        };
        weight_sum += w;
        weighted_height_sum += h * w;
        grad_weight_sum_x += gwx;
        grad_weight_sum_y += gwy;
        grad_weighted_height_sum_x += h * gwx;
        grad_weighted_height_sum_y += h * gwy;
    };

    accumulate(deepest_index, parent_height);

    let child_start = packed[parent_base + CONTOUR_CHILD_START] as usize;
    for c in 0..child_count {
        let child_index = terrain_child_index(packed, child_start + c);
        let child_base = contour_base(packed, child_index);
        let child_height = read_f32(packed, child_base + CONTOUR_HEIGHT);
        accumulate(child_index, child_height);
    }

    let inv_weight_sum = 1.0 / weight_sum;
    let inv_weight_sum_sq = inv_weight_sum * inv_weight_sum;
    let height = weighted_height_sum * inv_weight_sum;
    let gradient_x = (grad_weighted_height_sum_x * weight_sum
        - weighted_height_sum * grad_weight_sum_x)
        * inv_weight_sum_sq;
    let gradient_y = (grad_weighted_height_sum_y * weight_sum
        - weighted_height_sum * grad_weight_sum_y)
        * inv_weight_sum_sq;
    (height, gradient_x, gradient_y)
}

/// Grid-accelerated IDW blend with analytical gradient. Mirrors the
/// "Grid-accelerated IDW with gradient" branch of
/// `fn_computeTerrainHeightAndGradient` in `terrain.wgsl.ts`.
///
/// The IDW grid stores, for each `IDW_GRID_SIZE × IDW_GRID_SIZE` cell of
/// the parent contour's bbox, a list of `(tag, edge_index)` candidate
/// edges from the parent + each child. For the cell containing the
/// query point we iterate just those candidates, tracking per-tag the
/// nearest squared distance plus the (dx, dy) from the nearest point on
/// that tag's nearest edge — `(dx, dy) / d` is the unit gradient of the
/// distance function. We then plug the per-tag distances and gradients
/// into the same quotient-rule blend the linear-scan path uses.
fn idw_blend_with_gradient_grid(
    world_x: f32,
    world_y: f32,
    packed: &[u32],
    deepest_index: usize,
    grid_base: usize,
    child_count: usize,
    parent_height: f32,
    parent_base: usize,
) -> (f32, f32, f32) {
    let bbox_min_x = read_f32(packed, parent_base + CONTOUR_BBOX_MIN_X);
    let bbox_min_y = read_f32(packed, parent_base + CONTOUR_BBOX_MIN_Y);
    let bbox_max_x = read_f32(packed, parent_base + CONTOUR_BBOX_MAX_X);
    let bbox_max_y = read_f32(packed, parent_base + CONTOUR_BBOX_MAX_Y);
    let bbox_w = bbox_max_x - bbox_min_x;
    let bbox_h = bbox_max_y - bbox_min_y;
    let grid_size_f = IDW_GRID_SIZE as f32;
    let max_idx = (IDW_GRID_SIZE - 1) as f32;
    let col = (((world_x - bbox_min_x) * (grid_size_f / bbox_w))
        .floor()
        .clamp(0.0, max_idx)) as usize;
    let row = (((world_y - bbox_min_y) * (grid_size_f / bbox_h))
        .floor()
        .clamp(0.0, max_idx)) as usize;
    let cell_index = row * IDW_GRID_SIZE + col;
    let (entry_start, entry_end) = idw_grid_candidate_range(packed, grid_base, cell_index);

    let contour_count = 1 + child_count;
    let mut best_dist_sq = [1.0e20_f32; MAX_IDW_CONTOURS];
    let mut best_dx = [0.0_f32; MAX_IDW_CONTOURS];
    let mut best_dy = [0.0_f32; MAX_IDW_CONTOURS];

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
        if dist_sq < best_dist_sq[tag] {
            best_dist_sq[tag] = dist_sq;
            best_dx[tag] = dx;
            best_dy[tag] = dy;
        }
    }

    // Quotient-rule blend over per-tag (distance, gradient).
    let mut weight_sum = 0.0_f32;
    let mut weighted_height_sum = 0.0_f32;
    let mut grad_weight_sum_x = 0.0_f32;
    let mut grad_weight_sum_y = 0.0_f32;
    let mut grad_weighted_height_sum_x = 0.0_f32;
    let mut grad_weighted_height_sum_y = 0.0_f32;
    for c2 in 0..contour_count {
        let height = if c2 == 0 {
            parent_height
        } else {
            let child_index = terrain_child_index(packed, child_start + c2 - 1);
            let child_base = contour_base(packed, child_index);
            read_f32(packed, child_base + CONTOUR_HEIGHT)
        };
        let dist = best_dist_sq[c2].sqrt();
        let dx = best_dx[c2];
        let dy = best_dy[c2];
        let (w, gwx, gwy) = if dist <= IDW_MIN_DIST {
            let w = 1.0 / IDW_MIN_DIST;
            // Use the unclamped distance to recover gradient direction
            // when not literally on the edge. Mirrors the WGSL branch.
            if dist > 1.0e-9 {
                let inv_d = 1.0 / dist;
                let scale = -1.0 / (IDW_MIN_DIST * IDW_MIN_DIST);
                (w, scale * dx * inv_d, scale * dy * inv_d)
            } else {
                (w, 0.0, 0.0)
            }
        } else {
            let inv_d = 1.0 / dist;
            let scale = -inv_d * inv_d;
            (inv_d, scale * dx * inv_d, scale * dy * inv_d)
        };
        weight_sum += w;
        weighted_height_sum += height * w;
        grad_weight_sum_x += gwx;
        grad_weight_sum_y += gwy;
        grad_weighted_height_sum_x += height * gwx;
        grad_weighted_height_sum_y += height * gwy;
    }

    let inv_weight_sum = 1.0 / weight_sum;
    let inv_weight_sum_sq = inv_weight_sum * inv_weight_sum;
    let height = weighted_height_sum * inv_weight_sum;
    let gradient_x = (grad_weighted_height_sum_x * weight_sum
        - weighted_height_sum * grad_weight_sum_x)
        * inv_weight_sum_sq;
    let gradient_y = (grad_weighted_height_sum_y * weight_sum
        - weighted_height_sum * grad_weight_sum_y)
        * inv_weight_sum_sq;
    (height, gradient_x, gradient_y)
}

pub fn process_batch(
    points: &[f32],
    params: &[f32],
    state: &WorldState,
    results: &mut [f32],
    result_stride: usize,
) {
    let default_depth = params[TERRAIN_PARAM_DEFAULT_DEPTH];
    // SAFETY: pointer was registered via `set_packed_terrain` and
    // refers to a shared-memory region live for the worker's lifetime.
    let packed: &[u32] = unsafe { state.packed_terrain.as_slice() };
    let contour_count = terrain_contour_count(packed);

    let point_count = points.len() / STRIDE_PER_POINT;
    for i in 0..point_count {
        let world_x = points[i * STRIDE_PER_POINT];
        let world_y = points[i * STRIDE_PER_POINT + 1];

        let (height, gx, gy) = compute_terrain_height_and_gradient(
            world_x,
            world_y,
            packed,
            contour_count,
            default_depth,
        );

        let mut normal_x = 0.0_f32;
        let mut normal_y = 0.0_f32;
        let grad_mag = (gx * gx + gy * gy).sqrt();
        if grad_mag > 1.0e-9 {
            let nx = -gx;
            let ny = -gy;
            let nz = NORMAL_Z;
            let inv_len = 1.0 / (nx * nx + ny * ny + nz * nz).sqrt();
            normal_x = nx * inv_len;
            normal_y = ny * inv_len;
        }

        let terrain_type = if height >= 0.0 { 1.0 } else { 0.0 };
        let r = i * result_stride;
        results[r] = height;
        results[r + 1] = normal_x;
        results[r + 2] = normal_y;
        results[r + 3] = terrain_type;
    }
}
