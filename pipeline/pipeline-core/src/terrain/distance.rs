//! Low-level geometric primitives used by terrain queries:
//! winding-number containment test, nearest-edge search, and point-to-segment
//! distance helpers. Has aarch64 NEON SIMD variants for the hot loops.

use super::contour::ParsedContour;
use super::spatial::EdgeGrid;

/// Raw winding number test — checks if a point is inside a polygon defined
/// by `point_count` vertices starting at `start` in `vertex_data`.
/// On aarch64, processes 4 edges at a time using NEON f32x4 intrinsics.
#[cfg(target_arch = "aarch64")]
pub(super) fn winding_number_test(
    px: f64,
    py: f64,
    point_count: usize,
    start: usize,
    vertex_data: &[f32],
) -> bool {
    use std::arch::aarch64::*;

    if point_count < 3 {
        return false;
    }

    let n = point_count;
    let px32 = px as f32;
    let py32 = py as f32;
    let mut winding: i32 = 0;

    // SIMD: process 4 consecutive edges at a time.
    // Edge i uses vertex[i] as start and vertex[i+1] as end.
    let simd_end = if n >= 5 { (n - 1) & !3 } else { 0 };

    if simd_end > 0 {
        unsafe {
            let vpy = vdupq_n_f32(py32);
            let vpx = vdupq_n_f32(px32);
            let vzero = vdupq_n_f32(0.0);

            let base = vertex_data.as_ptr().add(start);
            let mut i = 0;

            while i < simd_end {
                // Load 4 start vertices (vertex[i..i+3])
                let a_pair = vld2q_f32(base.add(i * 2));
                let xi = a_pair.0;
                let yi = a_pair.1;

                // Load 4 end vertices (vertex[i+1..i+4])
                let b_pair = vld2q_f32(base.add(i * 2 + 2));
                let xj = b_pair.0;
                let yj = b_pair.1;

                // cross = (xj - xi) * (py - yi) - (px - xi) * (yj - yi)
                let xj_xi = vsubq_f32(xj, xi);
                let py_yi = vsubq_f32(vpy, yi);
                let px_xi = vsubq_f32(vpx, xi);
                let yj_yi = vsubq_f32(yj, yi);
                let cross = vsubq_f32(vmulq_f32(xj_xi, py_yi), vmulq_f32(px_xi, yj_yi));

                // Upward crossing: yi <= py && yj > py && cross > 0 → winding += 1
                let yi_le_py = vcleq_f32(yi, vpy); // yi <= py
                let yj_gt_py = vcgtq_f32(yj, vpy); // yj > py
                let cross_gt_0 = vcgtq_f32(cross, vzero);
                let up = vandq_u32(vandq_u32(yi_le_py, yj_gt_py), cross_gt_0);

                // Downward crossing: yi > py && yj <= py && cross < 0 → winding -= 1
                let yi_gt_py = vcgtq_f32(yi, vpy); // yi > py
                let yj_le_py = vcleq_f32(yj, vpy); // yj <= py
                let cross_lt_0 = vcltq_f32(cross, vzero);
                let down = vandq_u32(vandq_u32(yi_gt_py, yj_le_py), cross_lt_0);

                // Count set bits: each lane is 0xFFFFFFFF (true) or 0 (false)
                // Reinterpret as i32: true = -1, false = 0
                // Sum up: up contributes +1 per lane, down contributes -1 per lane
                let up_i32 = vreinterpretq_s32_u32(up);
                let down_i32 = vreinterpretq_s32_u32(down);
                // up mask is -1 for match, so negate to get +1
                let delta = vsubq_s32(down_i32, up_i32);
                // Horizontal sum
                winding += vaddvq_s32(delta);

                i += 4;
            }
        }
    }

    // Scalar remainder: edges from simd_end through n-1 (including wrap-around)
    for edge_i in simd_end..n {
        let b_idx = if edge_i + 1 < n { edge_i + 1 } else { 0 };
        let xi = vertex_data[start + edge_i * 2];
        let yi = vertex_data[start + edge_i * 2 + 1];
        let xj = vertex_data[start + b_idx * 2];
        let yj = vertex_data[start + b_idx * 2 + 1];
        if yi <= py32 {
            if yj > py32 {
                let cross = (xj - xi) * (py32 - yi) - (px32 - xi) * (yj - yi);
                if cross > 0.0 {
                    winding += 1;
                }
            }
        } else if yj <= py32 {
            let cross = (xj - xi) * (py32 - yi) - (px32 - xi) * (yj - yi);
            if cross < 0.0 {
                winding -= 1;
            }
        }
    }

    winding != 0
}

/// Raw winding number test — scalar fallback for non-aarch64.
#[cfg(not(target_arch = "aarch64"))]
pub(super) fn winding_number_test(
    px: f64,
    py: f64,
    point_count: usize,
    start: usize,
    vertex_data: &[f32],
) -> bool {
    if point_count < 3 {
        return false;
    }
    let mut winding: i32 = 0;
    for i in 0..point_count {
        let j = (i + 1) % point_count;
        let xi = vertex_data[start + i * 2] as f64;
        let yi = vertex_data[start + i * 2 + 1] as f64;
        let xj = vertex_data[start + j * 2] as f64;
        let yj = vertex_data[start + j * 2 + 1] as f64;
        if yi <= py {
            if yj > py {
                let cross = (xj - xi) * (py - yi) - (px - xi) * (yj - yi);
                if cross > 0.0 {
                    winding += 1;
                }
            }
        } else if yj <= py {
            let cross = (xj - xi) * (py - yi) - (px - xi) * (yj - yi);
            if cross < 0.0 {
                winding -= 1;
            }
        }
    }
    winding != 0
}

/// Point-in-contour test. Uses the containment grid for O(1) lookups,
/// falling back to full winding number test only for boundary cells.
pub(super) fn is_inside_contour(
    px: f64,
    py: f64,
    contour: &ParsedContour,
    vertex_data: &[f32],
) -> bool {
    if let Some(inside) = contour.containment_grid.contains(px, py) {
        return inside;
    }
    // Boundary cell — full winding test
    winding_number_test(
        px,
        py,
        contour.point_count,
        contour.point_start * 2,
        vertex_data,
    )
}

/// Minimum distance to contour boundary plus the gradient (unit direction from
/// nearest edge point to query point). Returns `(distance, grad_x, grad_y)`.
/// Mirrors TS `computeDistanceToBoundaryWithGradientFast`.
pub(super) fn min_dist_to_contour_with_gradient(
    px: f64,
    py: f64,
    c: &ParsedContour,
    vd: &[f32],
) -> (f64, f64, f64) {
    let n = c.point_count;
    if n == 0 {
        return (f64::INFINITY, 0.0, 0.0);
    }

    if let Some(grid) = &c.edge_grid {
        return min_dist_with_gradient_grid(px, py, c, vd, grid);
    }

    min_dist_with_gradient_linear(px, py, c, vd)
}

/// Grid-accelerated nearest-edge search with gradient.
fn min_dist_with_gradient_grid(
    px: f64,
    py: f64,
    c: &ParsedContour,
    vd: &[f32],
    grid: &EdgeGrid,
) -> (f64, f64, f64) {
    let n = c.point_count;
    let start = c.point_start * 2;
    let mut best_dist_sq = 1e20_f64;
    let mut best_dx = 0.0;
    let mut best_dy = 0.0;

    // First pass: check the cell containing the query point for an initial bound
    let cell_w = 1.0 / grid.inv_cell_w;
    let cell_h = 1.0 / grid.inv_cell_h;
    let initial_radius = cell_w.max(cell_h);

    for edge_i in grid.nearby_edges(px, py, initial_radius) {
        let j = (edge_i + 1) % n;
        let ax = vd[start + edge_i * 2] as f64;
        let ay = vd[start + edge_i * 2 + 1] as f64;
        let bx = vd[start + j * 2] as f64;
        let by = vd[start + j * 2 + 1] as f64;

        let (dx, dy, dist_sq) = point_to_segment_dx_dy(px, py, ax, ay, bx, by);
        if dist_sq < best_dist_sq {
            best_dist_sq = dist_sq;
            best_dx = dx;
            best_dy = dy;
        }
    }

    // If we found something, expand search to the best distance found so far
    // to catch edges in adjacent cells that might be closer
    if best_dist_sq < 1e20 {
        let radius = best_dist_sq.sqrt();
        if radius > initial_radius {
            // Need wider search — fall back to linear
            return min_dist_with_gradient_linear(px, py, c, vd);
        }
        // Search with the tighter radius to catch any we missed
        for edge_i in grid.nearby_edges(px, py, radius) {
            let j = (edge_i + 1) % n;
            let ax = vd[start + edge_i * 2] as f64;
            let ay = vd[start + edge_i * 2 + 1] as f64;
            let bx = vd[start + j * 2] as f64;
            let by = vd[start + j * 2 + 1] as f64;

            let (dx, dy, dist_sq) = point_to_segment_dx_dy(px, py, ax, ay, bx, by);
            if dist_sq < best_dist_sq {
                best_dist_sq = dist_sq;
                best_dx = dx;
                best_dy = dy;
            }
        }
    } else {
        // No edges found in nearby cells — fall back to linear scan
        return min_dist_with_gradient_linear(px, py, c, vd);
    }

    let distance = best_dist_sq.sqrt();
    if distance > 1e-9 {
        let inv = 1.0 / distance;
        (distance, best_dx * inv, best_dy * inv)
    } else {
        (distance, 0.0, 0.0)
    }
}

/// Linear scan nearest-edge search with gradient — used for small contours.
/// On aarch64, processes 4 edges at a time using NEON f32x4 intrinsics.
#[cfg(target_arch = "aarch64")]
fn min_dist_with_gradient_linear(
    px: f64,
    py: f64,
    c: &ParsedContour,
    vd: &[f32],
) -> (f64, f64, f64) {
    use std::arch::aarch64::*;

    let n = c.point_count;
    let s = c.point_start * 2;
    let px32 = px as f32;
    let py32 = py as f32;

    let mut best_dist_sq: f32 = f32::MAX;
    let mut best_dx: f32 = 0.0;
    let mut best_dy: f32 = 0.0;

    // SIMD batch: process 4 consecutive edges at a time.
    // Edge i uses vertex[i] as A and vertex[i+1] as B.
    // We can batch edges 0..(simd_end-1) where simd_end+4 vertices are available.
    // The wrap-around edge (n-1 → 0) and remainder are handled with scalar code.
    let simd_end = if n >= 5 { (n - 1) & !3 } else { 0 };

    if simd_end > 0 {
        unsafe {
            let vpx = vdupq_n_f32(px32);
            let vpy = vdupq_n_f32(py32);
            let vzero = vdupq_n_f32(0.0);
            let vone = vdupq_n_f32(1.0);
            let veps = vdupq_n_f32(1e-20);

            let base = vd.as_ptr().add(s);
            let mut i = 0;

            while i < simd_end {
                // Load 4 A vertices (interleaved x,y) via deinterleaving load
                let a_pair = vld2q_f32(base.add(i * 2));
                let ax = a_pair.0;
                let ay = a_pair.1;

                // Load 4 B vertices (shifted by one vertex)
                let b_pair = vld2q_f32(base.add(i * 2 + 2));
                let bx = b_pair.0;
                let by = b_pair.1;

                // AB = B - A
                let abx = vsubq_f32(bx, ax);
                let aby = vsubq_f32(by, ay);

                // len_sq = AB·AB, clamped to avoid div-by-zero
                let len_sq = vmaxq_f32(vfmaq_f32(vmulq_f32(abx, abx), aby, aby), veps);

                // AP = P - A
                let apx = vsubq_f32(vpx, ax);
                let apy = vsubq_f32(vpy, ay);

                // t = clamp(AP·AB / len_sq, 0, 1)
                let dot = vfmaq_f32(vmulq_f32(apx, abx), apy, aby);
                let t = vminq_f32(vmaxq_f32(vdivq_f32(dot, len_sq), vzero), vone);

                // Nearest point N = A + t * AB
                let nx = vfmaq_f32(ax, t, abx);
                let ny = vfmaq_f32(ay, t, aby);

                // Delta = P - N
                let dx = vsubq_f32(vpx, nx);
                let dy = vsubq_f32(vpy, ny);
                let dist_sq = vfmaq_f32(vmulq_f32(dx, dx), dy, dy);

                // Extract lanes and update best
                let mut ds = [0f32; 4];
                let mut dxs = [0f32; 4];
                let mut dys = [0f32; 4];
                vst1q_f32(ds.as_mut_ptr(), dist_sq);
                vst1q_f32(dxs.as_mut_ptr(), dx);
                vst1q_f32(dys.as_mut_ptr(), dy);

                for k in 0..4 {
                    if ds[k] < best_dist_sq {
                        best_dist_sq = ds[k];
                        best_dx = dxs[k];
                        best_dy = dys[k];
                    }
                }

                i += 4;
            }
        }
    }

    // Scalar remainder: edges from simd_end through n-1 (including wrap-around)
    for edge_i in simd_end..n {
        let b_idx = if edge_i + 1 < n { edge_i + 1 } else { 0 };
        let ax = vd[s + edge_i * 2];
        let ay = vd[s + edge_i * 2 + 1];
        let bx = vd[s + b_idx * 2];
        let by = vd[s + b_idx * 2 + 1];

        let abx = bx - ax;
        let aby = by - ay;
        let len_sq = (abx * abx + aby * aby).max(1e-20);
        let t = (((px32 - ax) * abx + (py32 - ay) * aby) / len_sq).clamp(0.0, 1.0);
        let nx = ax + t * abx;
        let ny = ay + t * aby;
        let dx = px32 - nx;
        let dy = py32 - ny;
        let dist_sq = dx * dx + dy * dy;

        if dist_sq < best_dist_sq {
            best_dist_sq = dist_sq;
            best_dx = dx;
            best_dy = dy;
        }
    }

    let distance = (best_dist_sq as f64).sqrt();
    if distance > 1e-9 {
        let inv = 1.0 / distance;
        (distance, best_dx as f64 * inv, best_dy as f64 * inv)
    } else {
        (distance, 0.0, 0.0)
    }
}

/// Linear scan nearest-edge search with gradient — scalar fallback for non-aarch64.
#[cfg(not(target_arch = "aarch64"))]
fn min_dist_with_gradient_linear(
    px: f64,
    py: f64,
    c: &ParsedContour,
    vd: &[f32],
) -> (f64, f64, f64) {
    let n = c.point_count;
    let start = c.point_start * 2;
    let mut best_dist_sq = 1e20_f64;
    let mut best_dx = 0.0;
    let mut best_dy = 0.0;

    let mut ax = vd[start + (n - 1) * 2] as f64;
    let mut ay = vd[start + (n - 1) * 2 + 1] as f64;

    for i in 0..n {
        let bx = vd[start + i * 2] as f64;
        let by = vd[start + i * 2 + 1] as f64;

        let (dx, dy, dist_sq) = point_to_segment_dx_dy(px, py, ax, ay, bx, by);

        if dist_sq < best_dist_sq {
            best_dist_sq = dist_sq;
            best_dx = dx;
            best_dy = dy;
        }

        ax = bx;
        ay = by;
    }

    let distance = best_dist_sq.sqrt();
    if distance > 1e-9 {
        let inv = 1.0 / distance;
        (distance, best_dx * inv, best_dy * inv)
    } else {
        (distance, 0.0, 0.0)
    }
}

/// Returns `(dx, dy, dist_sq)` where `(dx, dy)` is the vector from the nearest
/// point on segment AB to point P. Branchless: when AB is degenerate (len≈0),
/// dot≈0 so t=0 and the result naturally reduces to point-to-A distance.
#[inline]
pub(super) fn point_to_segment_dx_dy(
    px: f64,
    py: f64,
    ax: f64,
    ay: f64,
    bx: f64,
    by: f64,
) -> (f64, f64, f64) {
    let abx = bx - ax;
    let aby = by - ay;
    let len_sq = (abx * abx + aby * aby).max(1e-20);
    let t = (((px - ax) * abx + (py - ay) * aby) / len_sq).clamp(0.0, 1.0);
    let nx = ax + t * abx;
    let ny = ay + t * aby;
    let dx = px - nx;
    let dy = py - ny;
    (dx, dy, dx * dx + dy * dy)
}

pub(super) fn min_dist_to_contour(px: f64, py: f64, c: &ParsedContour, vd: &[f32]) -> f64 {
    let n = c.point_count;
    if n == 0 {
        return f64::INFINITY;
    }
    let start = c.point_start * 2;
    let mut best = f64::INFINITY;
    for i in 0..n {
        let j = (i + 1) % n;
        let ax = vd[start + i * 2] as f64;
        let ay = vd[start + i * 2 + 1] as f64;
        let bx = vd[start + j * 2] as f64;
        let by = vd[start + j * 2 + 1] as f64;
        let d = point_to_segment_dist(px, py, ax, ay, bx, by);
        if d < best {
            best = d;
        }
    }
    best
}

fn point_to_segment_dist(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let dx = bx - ax;
    let dy = by - ay;
    let len_sq = (dx * dx + dy * dy).max(1e-20);
    let t = (((px - ax) * dx + (py - ay) * dy) / len_sq).clamp(0.0, 1.0);
    let cx = ax + t * dx;
    let cy = ay + t * dy;
    let ex = px - cx;
    let ey = py - cy;
    (ex * ex + ey * ey).sqrt()
}
