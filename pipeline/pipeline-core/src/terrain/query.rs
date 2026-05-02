//! High-level terrain queries: contour-tree DFS height lookup and analytic
//! gradient via IDW interpolation. Mirrors terrainHeightCPU.ts.
//!
//! Low-level geometric primitives (winding number, nearest-edge search) live
//! in `distance.rs`.

use crate::level::TerrainCPUData;

use super::contour::ParsedContour;
use super::distance::{
    is_inside_contour, min_dist_to_contour, min_dist_to_contour_with_gradient,
    point_to_segment_dx_dy,
};
use super::idw_grid::IDWGrid;
use super::lookup_grid::ContourLookupGrid;

// ── Compute height (DFS) ────────────────────────────────────────────────────

/// Compute terrain height at (px, py) using contour tree DFS with skip counts.
pub fn compute_terrain_height(
    px: f64,
    py: f64,
    terrain: &TerrainCPUData,
    contours: &[ParsedContour],
) -> f64 {
    let n = contours.len();
    if n == 0 {
        return terrain.default_depth;
    }

    let vd = &terrain.vertex_data;
    let cd = &terrain.children_data;

    // Find the deepest contour containing the point using DFS with skipping.
    // Track the best depth found so far so that overlapping siblings at a
    // shallower tree depth cannot overwrite a deeper result.
    let mut deepest_height = terrain.default_depth;
    let mut deepest_idx: Option<usize> = None;
    let mut deepest_depth: u32 = 0;
    let mut i = 0;

    while i < n {
        let c = &contours[i];
        // Bbox reject
        if (px as f32) < c.bbox_min_x
            || (px as f32) > c.bbox_max_x
            || (py as f32) < c.bbox_min_y
            || (py as f32) > c.bbox_max_y
        {
            i += 1 + c.skip_count as usize;
            continue;
        }
        if is_inside_contour(px, py, c, vd) {
            if deepest_idx.is_none() || c.depth >= deepest_depth {
                deepest_height = c.height as f64;
                deepest_idx = Some(i);
                deepest_depth = c.depth;
            }
            i += 1; // descend into children
        } else {
            i += 1 + c.skip_count as usize;
        }
    }

    // IDW blend with children of the deepest contour
    let Some(deepest) = deepest_idx else {
        return deepest_height;
    };
    let dc = &contours[deepest];
    if dc.child_count == 0 {
        return deepest_height;
    }

    let mut weight_sum = 0.0;
    let mut height_sum = 0.0;
    let base_height = deepest_height;

    for ci in 0..dc.child_count {
        let child_dfs = cd[dc.child_start + ci] as usize;
        if child_dfs >= n {
            continue;
        }
        let child = &contours[child_dfs];
        let dist = min_dist_to_contour(px, py, child, vd);
        if dist < 1e-6 {
            return child.height as f64;
        }
        let w = 1.0 / (dist * dist);
        weight_sum += w;
        height_sum += w * child.height as f64;
    }

    if weight_sum > 0.0 {
        // Also add the base contour with a weight from its own boundary distance
        let base_dist = min_dist_to_contour(px, py, dc, vd);
        if base_dist < 1e-6 {
            return base_height;
        }
        let base_w = 1.0 / (base_dist * base_dist);
        weight_sum += base_w;
        height_sum += base_w * base_height;
        height_sum / weight_sum
    } else {
        base_height
    }
}

// ── Compute height + gradient (IDW with quotient rule) ──────────────────────

/// Terrain height and analytical gradient at a point.
pub struct TerrainHeightGradient {
    pub height: f64,
    pub gradient_x: f64,
    pub gradient_y: f64,
}

/// Minimum distance for IDW to avoid division by zero (matches TS `IDW_MIN_DIST`).
const IDW_MIN_DIST: f64 = 0.1;

/// Compute terrain height and gradient at (px, py) analytically in a single pass.
/// Mirrors TS `computeTerrainHeightAndGradient` in terrainHeightCPU.ts.
///
/// Instead of 3× finite-difference height queries, this computes the gradient of
/// the IDW interpolation directly via the quotient rule, using the distance
/// gradient from `min_dist_to_contour_with_gradient`.
pub fn compute_terrain_height_and_gradient(
    px: f64,
    py: f64,
    terrain: &TerrainCPUData,
    contours: &[ParsedContour],
    lookup_grid: &ContourLookupGrid,
) -> TerrainHeightGradient {
    let n = contours.len();
    if n == 0 {
        return TerrainHeightGradient {
            height: terrain.default_depth,
            gradient_x: 0.0,
            gradient_y: 0.0,
        };
    }

    let vd = &terrain.vertex_data;
    let cd = &terrain.children_data;

    // Phase 1: Find deepest containing contour using the precomputed lookup grid
    let (lookup_idx, lookup_height) =
        lookup_grid.lookup(px, py, contours, vd, terrain.default_depth);
    let deepest_height = lookup_height;
    let deepest_idx: Option<usize> = if lookup_idx != usize::MAX {
        Some(lookup_idx)
    } else {
        None
    };

    // Phase 2: No contour contains the point
    let Some(deepest) = deepest_idx else {
        return TerrainHeightGradient {
            height: deepest_height,
            gradient_x: 0.0,
            gradient_y: 0.0,
        };
    };

    let dc = &contours[deepest];

    // Phase 3: No children — flat region
    if dc.child_count == 0 {
        return TerrainHeightGradient {
            height: deepest_height,
            gradient_x: 0.0,
            gradient_y: 0.0,
        };
    }

    // Phase 4: Analytical IDW interpolation with gradient using precomputed grid
    if let Some(idw_grid) = &dc.idw_grid {
        return idw_from_grid(px, py, dc, contours, cd, n, deepest_height, idw_grid, vd);
    }

    // Fallback: no IDW grid (shouldn't happen for contours with children, but safe)
    idw_fallback(px, py, dc, contours, cd, n, deepest_height, vd)
}

/// IDW interpolation using the precomputed candidate grid.
fn idw_from_grid(
    px: f64,
    py: f64,
    dc: &ParsedContour,
    contours: &[ParsedContour],
    cd: &[u32],
    n: usize,
    deepest_height: f64,
    idw_grid: &IDWGrid,
    vd: &[f32],
) -> TerrainHeightGradient {
    let candidates = idw_grid.candidates(px, py);
    let contour_count = idw_grid.contour_count;

    // Per-contour best: (best_dist_sq, best_dx, best_dy)
    // Use a small stack-allocated array for up to 16 contours, heap for more.
    const STACK_MAX: usize = 16;
    let mut stack_buf = [(f64::MAX, 0.0f64, 0.0f64); STACK_MAX];
    let mut heap_buf: Vec<(f64, f64, f64)>;
    let bests: &mut [(f64, f64, f64)] = if contour_count <= STACK_MAX {
        &mut stack_buf[..contour_count]
    } else {
        heap_buf = vec![(f64::MAX, 0.0, 0.0); contour_count];
        &mut heap_buf
    };

    // Collect contour vertex info for edge lookups
    // tag 0 = parent, tags 1..N = children
    const CONTOUR_STACK_MAX: usize = 16;
    let mut contour_starts_stack = [0usize; CONTOUR_STACK_MAX];
    let mut contour_counts_stack = [0usize; CONTOUR_STACK_MAX];
    let mut contour_starts_heap: Vec<usize>;
    let mut contour_counts_heap: Vec<usize>;
    let (contour_starts, contour_pcounts): (&[usize], &[usize]) =
        if contour_count <= CONTOUR_STACK_MAX {
            contour_starts_stack[0] = dc.point_start * 2;
            contour_counts_stack[0] = dc.point_count;
            for ci in 0..dc.child_count {
                let child_dfs = cd[dc.child_start + ci] as usize;
                if child_dfs < n {
                    contour_starts_stack[ci + 1] = contours[child_dfs].point_start * 2;
                    contour_counts_stack[ci + 1] = contours[child_dfs].point_count;
                }
            }
            (
                &contour_starts_stack[..contour_count],
                &contour_counts_stack[..contour_count],
            )
        } else {
            contour_starts_heap = vec![0; contour_count];
            contour_counts_heap = vec![0; contour_count];
            contour_starts_heap[0] = dc.point_start * 2;
            contour_counts_heap[0] = dc.point_count;
            for ci in 0..dc.child_count {
                let child_dfs = cd[dc.child_start + ci] as usize;
                if child_dfs < n {
                    contour_starts_heap[ci + 1] = contours[child_dfs].point_start * 2;
                    contour_counts_heap[ci + 1] = contours[child_dfs].point_count;
                }
            }
            (&contour_starts_heap, &contour_counts_heap)
        };

    // Process all candidate edges, tracking per-contour best distance
    for &packed in candidates {
        let tag = (packed >> 16) as usize;
        let edge_i = (packed & 0xFFFF) as usize;
        if tag >= contour_count {
            continue;
        }

        let s = contour_starts[tag];
        let pc = contour_pcounts[tag];
        let j = if edge_i + 1 < pc { edge_i + 1 } else { 0 };
        let ax = vd[s + edge_i * 2] as f64;
        let ay = vd[s + edge_i * 2 + 1] as f64;
        let bx = vd[s + j * 2] as f64;
        let by = vd[s + j * 2 + 1] as f64;

        let (dx, dy, dist_sq) = point_to_segment_dx_dy(px, py, ax, ay, bx, by);
        if dist_sq < bests[tag].0 {
            bests[tag] = (dist_sq, dx, dy);
        }
    }

    // Accumulate IDW terms from per-contour bests
    let mut weight_sum = 0.0;
    let mut weighted_h_sum = 0.0;
    let mut grad_w_sum_x = 0.0;
    let mut grad_w_sum_y = 0.0;
    let mut grad_wh_sum_x = 0.0;
    let mut grad_wh_sum_y = 0.0;

    // Heights: tag 0 = parent, tags 1..N = children
    for tag in 0..contour_count {
        let (best_dist_sq, best_dx, best_dy) = bests[tag];
        if best_dist_sq >= f64::MAX * 0.5 {
            continue;
        } // no edge found for this contour

        let height = if tag == 0 {
            deepest_height
        } else {
            let child_dfs = cd[dc.child_start + tag - 1] as usize;
            contours[child_dfs].height as f64
        };

        let distance = best_dist_sq.sqrt();
        let (ddist_dx, ddist_dy) = if distance > 1e-9 {
            let inv = 1.0 / distance;
            (best_dx * inv, best_dy * inv)
        } else {
            (0.0, 0.0)
        };

        let (w, dw_dx, dw_dy);
        if distance <= IDW_MIN_DIST {
            w = 1.0 / IDW_MIN_DIST;
            let scale = -1.0 / (IDW_MIN_DIST * IDW_MIN_DIST);
            dw_dx = scale * ddist_dx;
            dw_dy = scale * ddist_dy;
        } else {
            let inv_dist = 1.0 / distance;
            w = inv_dist;
            let scale = -inv_dist * inv_dist;
            dw_dx = scale * ddist_dx;
            dw_dy = scale * ddist_dy;
        }

        weight_sum += w;
        weighted_h_sum += height * w;
        grad_w_sum_x += dw_dx;
        grad_w_sum_y += dw_dy;
        grad_wh_sum_x += height * dw_dx;
        grad_wh_sum_y += height * dw_dy;
    }

    if weight_sum <= 0.0 {
        return TerrainHeightGradient {
            height: deepest_height,
            gradient_x: 0.0,
            gradient_y: 0.0,
        };
    }

    let inv_w = 1.0 / weight_sum;
    let inv_w_sq = inv_w * inv_w;

    TerrainHeightGradient {
        height: weighted_h_sum * inv_w,
        gradient_x: (grad_wh_sum_x * weight_sum - weighted_h_sum * grad_w_sum_x) * inv_w_sq,
        gradient_y: (grad_wh_sum_y * weight_sum - weighted_h_sum * grad_w_sum_y) * inv_w_sq,
    }
}

/// Compute terrain height and gradient, optionally bypassing the IDW candidate grid.
/// When `use_idw_grid` is false, always uses the brute-force fallback path.
/// Useful for diagnostic comparison of grid vs. non-grid results.
pub fn compute_terrain_height_and_gradient_ex(
    px: f64,
    py: f64,
    terrain: &TerrainCPUData,
    contours: &[ParsedContour],
    lookup_grid: &ContourLookupGrid,
    use_idw_grid: bool,
) -> TerrainHeightGradient {
    let n = contours.len();
    if n == 0 {
        return TerrainHeightGradient {
            height: terrain.default_depth,
            gradient_x: 0.0,
            gradient_y: 0.0,
        };
    }

    let vd = &terrain.vertex_data;
    let cd = &terrain.children_data;

    let (lookup_idx, lookup_height) =
        lookup_grid.lookup(px, py, contours, vd, terrain.default_depth);
    let deepest_height = lookup_height;
    let deepest_idx: Option<usize> = if lookup_idx != usize::MAX {
        Some(lookup_idx)
    } else {
        None
    };

    let Some(deepest) = deepest_idx else {
        return TerrainHeightGradient {
            height: deepest_height,
            gradient_x: 0.0,
            gradient_y: 0.0,
        };
    };

    let dc = &contours[deepest];

    if dc.child_count == 0 {
        return TerrainHeightGradient {
            height: deepest_height,
            gradient_x: 0.0,
            gradient_y: 0.0,
        };
    }

    if use_idw_grid {
        if let Some(idw_grid) = &dc.idw_grid {
            return idw_from_grid(px, py, dc, contours, cd, n, deepest_height, idw_grid, vd);
        }
    }

    idw_fallback(px, py, dc, contours, cd, n, deepest_height, vd)
}

/// Fallback IDW interpolation without grid (for safety).
fn idw_fallback(
    px: f64,
    py: f64,
    dc: &ParsedContour,
    contours: &[ParsedContour],
    cd: &[u32],
    n: usize,
    deepest_height: f64,
    vd: &[f32],
) -> TerrainHeightGradient {
    let mut weight_sum = 0.0;
    let mut weighted_h_sum = 0.0;
    let mut grad_w_sum_x = 0.0;
    let mut grad_w_sum_y = 0.0;
    let mut grad_wh_sum_x = 0.0;
    let mut grad_wh_sum_y = 0.0;

    let mut accumulate = |height: f64, contour: &ParsedContour| {
        let (dist, ddist_dx, ddist_dy) = min_dist_to_contour_with_gradient(px, py, contour, vd);

        let (w, dw_dx, dw_dy);
        if dist <= IDW_MIN_DIST {
            w = 1.0 / IDW_MIN_DIST;
            let scale = -1.0 / (IDW_MIN_DIST * IDW_MIN_DIST);
            dw_dx = scale * ddist_dx;
            dw_dy = scale * ddist_dy;
        } else {
            let inv_dist = 1.0 / dist;
            w = inv_dist;
            let scale = -inv_dist * inv_dist;
            dw_dx = scale * ddist_dx;
            dw_dy = scale * ddist_dy;
        }

        weight_sum += w;
        weighted_h_sum += height * w;
        grad_w_sum_x += dw_dx;
        grad_w_sum_y += dw_dy;
        grad_wh_sum_x += height * dw_dx;
        grad_wh_sum_y += height * dw_dy;
    };

    accumulate(deepest_height, dc);
    for ci in 0..dc.child_count {
        let child_dfs = cd[dc.child_start + ci] as usize;
        if child_dfs >= n {
            continue;
        }
        accumulate(contours[child_dfs].height as f64, &contours[child_dfs]);
    }

    let inv_w = 1.0 / weight_sum;
    let inv_w_sq = inv_w * inv_w;

    TerrainHeightGradient {
        height: weighted_h_sum * inv_w,
        gradient_x: (grad_wh_sum_x * weight_sum - weighted_h_sum * grad_w_sum_x) * inv_w_sq,
        gradient_y: (grad_wh_sum_y * weight_sum - weighted_h_sum * grad_w_sum_y) * inv_w_sq,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::level::{build_terrain_data, parse_level_file, resolve_level_terrain};
    use crate::terrain::parse_contours;

    #[test]
    fn test_idw_grid_matches_brute_force() {
        // Locate the level file relative to the workspace root.
        let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let level_path = manifest_dir.join("../../resources/levels/default.level.json");
        assert!(
            level_path.exists(),
            "Level file not found at {}",
            level_path.display()
        );

        // Load and parse the level
        let json_str = std::fs::read_to_string(&level_path)
            .unwrap_or_else(|e| panic!("Failed to read {}: {}", level_path.display(), e));
        let mut level = parse_level_file(&json_str)
            .unwrap_or_else(|e| panic!("Failed to parse level file: {}", e));
        resolve_level_terrain(&mut level, &level_path)
            .unwrap_or_else(|e| panic!("Failed to resolve terrain: {}", e));

        assert!(
            !level.contours.is_empty(),
            "Level has no contours — nothing to test"
        );

        // Build terrain data and parse contours
        let terrain = build_terrain_data(&level);
        let (contours, lookup_grid) = parse_contours(&terrain);

        // Compute bounding box with 5% margin
        let mut min_x = f64::MAX;
        let mut min_y = f64::MAX;
        let mut max_x = f64::MIN;
        let mut max_y = f64::MIN;
        for c in &contours {
            min_x = min_x.min(c.bbox_min_x as f64);
            min_y = min_y.min(c.bbox_min_y as f64);
            max_x = max_x.max(c.bbox_max_x as f64);
            max_y = max_y.max(c.bbox_max_y as f64);
        }
        let width = max_x - min_x;
        let height = max_y - min_y;
        let margin = 0.05;
        let render_min_x = min_x - width * margin;
        let render_min_y = min_y - height * margin;
        let render_w = width * (1.0 + 2.0 * margin);
        let render_h = height * (1.0 + 2.0 * margin);

        // Sample a 256x256 grid
        const GRID_SIZE: usize = 256;
        let mut max_height_diff: f64 = 0.0;
        let mut max_gx_diff: f64 = 0.0;
        let mut max_gy_diff: f64 = 0.0;
        let mut sum_height_diff: f64 = 0.0;
        let mut sum_gx_diff: f64 = 0.0;
        let mut sum_gy_diff: f64 = 0.0;
        let mut worst_height_point = (0.0_f64, 0.0_f64);
        let mut worst_height_vals = (0.0_f64, 0.0_f64); // (grid, brute)
        let mut worst_gx_point = (0.0_f64, 0.0_f64);
        let mut worst_gy_point = (0.0_f64, 0.0_f64);
        let mut nonzero_count: usize = 0;
        let total_points = GRID_SIZE * GRID_SIZE;

        for row in 0..GRID_SIZE {
            for col in 0..GRID_SIZE {
                let px =
                    render_min_x + (col as f64 + 0.5) / GRID_SIZE as f64 * render_w;
                let py =
                    render_min_y + (row as f64 + 0.5) / GRID_SIZE as f64 * render_h;

                let with_grid = compute_terrain_height_and_gradient_ex(
                    px,
                    py,
                    &terrain,
                    &contours,
                    &lookup_grid,
                    true,
                );
                let without_grid = compute_terrain_height_and_gradient_ex(
                    px,
                    py,
                    &terrain,
                    &contours,
                    &lookup_grid,
                    false,
                );

                let h_diff = (with_grid.height - without_grid.height).abs();
                let gx_diff =
                    (with_grid.gradient_x - without_grid.gradient_x).abs();
                let gy_diff =
                    (with_grid.gradient_y - without_grid.gradient_y).abs();

                sum_height_diff += h_diff;
                sum_gx_diff += gx_diff;
                sum_gy_diff += gy_diff;

                if h_diff > 1e-15 || gx_diff > 1e-15 || gy_diff > 1e-15 {
                    nonzero_count += 1;
                }

                if h_diff > max_height_diff {
                    max_height_diff = h_diff;
                    worst_height_point = (px, py);
                    worst_height_vals = (with_grid.height, without_grid.height);
                }
                if gx_diff > max_gx_diff {
                    max_gx_diff = gx_diff;
                    worst_gx_point = (px, py);
                }
                if gy_diff > max_gy_diff {
                    max_gy_diff = gy_diff;
                    worst_gy_point = (px, py);
                }
            }
        }

        // Print comprehensive statistics
        println!();
        println!(
            "IDW Grid vs Brute-Force comparison ({0}x{0} = {1} points):",
            GRID_SIZE, total_points
        );
        println!("  Contours: {}", contours.len());
        println!(
            "  Terrain bounds: ({:.1}, {:.1}) to ({:.1}, {:.1})",
            min_x, min_y, max_x, max_y
        );
        println!();
        println!(
            "  Points with any difference (>1e-15): {} / {} ({:.2}%)",
            nonzero_count,
            total_points,
            100.0 * nonzero_count as f64 / total_points as f64
        );
        println!();
        println!("  Height:");
        println!("    Max error:        {:.6e} ft  at ({:.2}, {:.2})", max_height_diff, worst_height_point.0, worst_height_point.1);
        println!("      grid={:.6}, brute={:.6}", worst_height_vals.0, worst_height_vals.1);
        println!("    Cumulative error: {:.6e} ft", sum_height_diff);
        println!("    Mean error:       {:.6e} ft", sum_height_diff / total_points as f64);
        println!();
        println!("  Gradient X:");
        println!("    Max error:        {:.6e}  at ({:.2}, {:.2})", max_gx_diff, worst_gx_point.0, worst_gx_point.1);
        println!("    Cumulative error: {:.6e}", sum_gx_diff);
        println!("    Mean error:       {:.6e}", sum_gx_diff / total_points as f64);
        println!();
        println!("  Gradient Y:");
        println!("    Max error:        {:.6e}  at ({:.2}, {:.2})", max_gy_diff, worst_gy_point.0, worst_gy_point.1);
        println!("    Cumulative error: {:.6e}", sum_gy_diff);
        println!("    Mean error:       {:.6e}", sum_gy_diff / total_points as f64);
        println!();

        // The IDW grid path computes distances in f64, while the brute-force
        // fallback uses NEON f32 SIMD on aarch64. When two edges have nearly
        // equal distances, f32 vs f64 precision can pick different "nearest"
        // edges, causing small IDW blending differences. Tolerance of 1e-3
        // catches real grid construction bugs (which cause multi-foot errors)
        // while allowing for f32/f64 precision differences.
        assert!(
            max_height_diff < 1e-3,
            "Height mismatch: max diff {:.6e} at ({:.4}, {:.4}) — grid candidate set may be missing edges",
            max_height_diff,
            worst_height_point.0,
            worst_height_point.1,
        );
        assert!(
            max_gx_diff < 1e-3,
            "Gradient X mismatch: max diff {:.6e} at ({:.4}, {:.4})",
            max_gx_diff,
            worst_gx_point.0,
            worst_gx_point.1,
        );
        assert!(
            max_gy_diff < 1e-3,
            "Gradient Y mismatch: max diff {:.6e} at ({:.4}, {:.4})",
            max_gy_diff,
            worst_gy_point.0,
            worst_gy_point.1,
        );
    }
}
