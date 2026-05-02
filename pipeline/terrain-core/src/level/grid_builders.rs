//! Grid builders for the binary terrain format: containment grids (per-contour),
//! IDW candidate grids (per parent-with-children), and the level-wide lookup
//! grid (packed for GPU upload).

use crate::polygon_math::point_in_polygon_arr2;

use super::build::{BBox, ContourTree};
use super::format::CONTAINMENT_GRID_SIZE;

// ── Grid size constants ──────────────────────────────────────────────────────

const CONTAINMENT_GRID_CELLS: usize = CONTAINMENT_GRID_SIZE * CONTAINMENT_GRID_SIZE;
pub(super) const CONTAINMENT_GRID_U32S_PER_CONTOUR: usize = CONTAINMENT_GRID_CELLS / 16; // 256

pub(super) const IDW_GRID_SIZE: usize = 32;
pub(super) const IDW_GRID_CELLS: usize = IDW_GRID_SIZE * IDW_GRID_SIZE;
const IDW_GRID_CELL_STARTS: usize = IDW_GRID_CELLS + 1;
pub(super) const MAX_IDW_CONTOURS: usize = 32;

const LOOKUP_GRID_SIZE: usize = 1024;
const LOOKUP_GRID_HEADER: usize = 6; // cols, rows, min_x, min_y, inv_cell_w, inv_cell_h

// ── Cell classification flags ───────────────────────────────────────────────

const CELL_OUTSIDE: u8 = 0;
const CELL_INSIDE: u8 = 1;
const CELL_BOUNDARY: u8 = 2;

// ── Edge rasterization (DDA) ────────────────────────────────────────────────

/// DDA rasterization of a line segment into grid cells, marking traversed cells as BOUNDARY.
fn rasterize_edge_to_grid(
    ax: f64,
    ay: f64,
    bx: f64,
    by: f64,
    min_x: f64,
    min_y: f64,
    inv_cell_w: f64,
    inv_cell_h: f64,
    cols: usize,
    rows: usize,
    cell_flags: &mut [u8],
) {
    let max_col = cols as isize - 1;
    let max_row = rows as isize - 1;

    let mut col = ((ax - min_x) * inv_cell_w).floor() as isize;
    let mut row = ((ay - min_y) * inv_cell_h).floor() as isize;
    let end_col = ((bx - min_x) * inv_cell_w).floor() as isize;
    let end_row = ((by - min_y) * inv_cell_h).floor() as isize;

    if col >= 0 && col <= max_col && row >= 0 && row <= max_row {
        cell_flags[row as usize * cols + col as usize] = CELL_BOUNDARY;
    }

    let dx = bx - ax;
    let dy = by - ay;
    let step_col: isize = if dx > 0.0 { 1 } else if dx < 0.0 { -1 } else { 0 };
    let step_row: isize = if dy > 0.0 { 1 } else if dy < 0.0 { -1 } else { 0 };

    let cell_w = 1.0 / inv_cell_w;
    let cell_h = 1.0 / inv_cell_h;

    let mut t_max_x = if dx != 0.0 {
        let next_x = if dx > 0.0 {
            min_x + (col + 1) as f64 * cell_w
        } else {
            min_x + col as f64 * cell_w
        };
        (next_x - ax) / dx
    } else {
        f64::MAX
    };
    let mut t_max_y = if dy != 0.0 {
        let next_y = if dy > 0.0 {
            min_y + (row + 1) as f64 * cell_h
        } else {
            min_y + row as f64 * cell_h
        };
        (next_y - ay) / dy
    } else {
        f64::MAX
    };
    let t_delta_x = if dx != 0.0 { (cell_w / dx).abs() } else { f64::MAX };
    let t_delta_y = if dy != 0.0 { (cell_h / dy).abs() } else { f64::MAX };

    let max_steps = (cols + rows) * 2;
    for _ in 0..max_steps {
        if col == end_col && row == end_row {
            break;
        }
        if t_max_x < t_max_y {
            col += step_col;
            t_max_x += t_delta_x;
        } else {
            row += step_row;
            t_max_y += t_delta_y;
        }
        if col >= 0 && col <= max_col && row >= 0 && row <= max_row {
            cell_flags[row as usize * cols + col as usize] = CELL_BOUNDARY;
        }
    }
}

// ── Containment grid (2-bit packed) ──────────────────────────────────────────

/// Build a 64×64 containment grid for a polygon, packed into 256 u32s (2 bits per cell).
pub(super) fn build_containment_grid_packed(polygon: &[[f64; 2]], bbox: &BBox) -> Vec<u32> {
    let cols = CONTAINMENT_GRID_SIZE;
    let rows = CONTAINMENT_GRID_SIZE;
    let num_cells = CONTAINMENT_GRID_CELLS;

    let w = (bbox.max_x - bbox.min_x).max(1e-9);
    let h = (bbox.max_y - bbox.min_y).max(1e-9);
    let inv_cell_w = cols as f64 / w;
    let inv_cell_h = rows as f64 / h;
    let cell_w = w / cols as f64;
    let cell_h = h / rows as f64;

    let mut cell_flags = vec![CELL_OUTSIDE; num_cells];

    // Rasterize polygon edges
    let n = polygon.len();
    for i in 0..n {
        let j = (i + 1) % n;
        rasterize_edge_to_grid(
            polygon[i][0],
            polygon[i][1],
            polygon[j][0],
            polygon[j][1],
            bbox.min_x,
            bbox.min_y,
            inv_cell_w,
            inv_cell_h,
            cols,
            rows,
            &mut cell_flags,
        );
    }

    // Test center of non-boundary cells
    for cell in 0..num_cells {
        if cell_flags[cell] != CELL_BOUNDARY {
            let col = cell % cols;
            let row = cell / cols;
            let cx = bbox.min_x + (col as f64 + 0.5) * cell_w;
            let cy = bbox.min_y + (row as f64 + 0.5) * cell_h;
            if point_in_polygon_arr2(cx, cy, polygon) {
                cell_flags[cell] = CELL_INSIDE;
            }
        }
    }

    // Pack into 2-bit representation: 16 cells per u32
    let mut packed = vec![0u32; CONTAINMENT_GRID_U32S_PER_CONTOUR];
    for i in 0..num_cells {
        packed[i >> 4] |= ((cell_flags[i] as u32) & 3) << ((i & 15) * 2);
    }
    packed
}

// ── IDW grid (precomputed candidate edges) ───────────────────────────────────

/// Squared distance from point to line segment.
fn point_to_segment_dist_sq(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let abx = bx - ax;
    let aby = by - ay;
    let len_sq = (abx * abx + aby * aby).max(1e-20);
    let t = (((px - ax) * abx + (py - ay) * aby) / len_sq).clamp(0.0, 1.0);
    let nx = ax + t * abx;
    let ny = ay + t * aby;
    let dx = px - nx;
    let dy = py - ny;
    dx * dx + dy * dy
}

/// Compute both (min_dist_sq, max_dist_sq) from an axis-aligned rectangle to a
/// line segment in a single pass, sharing the 4 corner distance computations.
///
/// `max_dist` = max corner-to-segment distance (exact, since dist is convex).
/// `min_dist` = min of corner-to-segment and endpoint-to-rect distances, with
/// a Liang-Barsky intersection test only when the cheap checks are inconclusive.
#[inline]
fn rect_segment_min_max_dist_sq(
    rx0: f64,
    ry0: f64,
    rx1: f64,
    ry1: f64,
    ax: f64,
    ay: f64,
    bx: f64,
    by: f64,
) -> (f64, f64) {
    // 4 corner-to-segment distances (shared for both min and max)
    let d0 = point_to_segment_dist_sq(rx0, ry0, ax, ay, bx, by);
    let d1 = point_to_segment_dist_sq(rx1, ry0, ax, ay, bx, by);
    let d2 = point_to_segment_dist_sq(rx0, ry1, ax, ay, bx, by);
    let d3 = point_to_segment_dist_sq(rx1, ry1, ax, ay, bx, by);

    let d_max = d0.max(d1).max(d2).max(d3);
    let d_min_corners = d0.min(d1).min(d2).min(d3);

    // If a corner lies on the segment, min is 0
    if d_min_corners == 0.0 {
        return (0.0, d_max);
    }

    // Check segment endpoints inside rect (very cheap)
    let de0 = point_to_rect_dist_sq(ax, ay, rx0, ry0, rx1, ry1);
    if de0 == 0.0 {
        return (0.0, d_max);
    }
    let de1 = point_to_rect_dist_sq(bx, by, rx0, ry0, rx1, ry1);
    if de1 == 0.0 {
        return (0.0, d_max);
    }

    let d_min = d_min_corners.min(de0).min(de1);

    // If segment AABB doesn't overlap cell, no crossing is possible
    let e_min_x = ax.min(bx);
    let e_max_x = ax.max(bx);
    let e_min_y = ay.min(by);
    let e_max_y = ay.max(by);
    if e_min_x > rx1 || e_max_x < rx0 || e_min_y > ry1 || e_max_y < ry0 {
        return (d_min, d_max);
    }

    // AABBs overlap but endpoints are outside — segment might cross through.
    // Use Liang-Barsky to check.
    if segment_crosses_rect(ax, ay, bx, by, rx0, ry0, rx1, ry1) {
        return (0.0, d_max);
    }

    (d_min, d_max)
}

/// Squared distance from point to axis-aligned rectangle (0 if inside).
#[inline]
fn point_to_rect_dist_sq(px: f64, py: f64, rx0: f64, ry0: f64, rx1: f64, ry1: f64) -> f64 {
    let dx = if px < rx0 {
        rx0 - px
    } else if px > rx1 {
        px - rx1
    } else {
        0.0
    };
    let dy = if py < ry0 {
        ry0 - py
    } else if py > ry1 {
        py - ry1
    } else {
        0.0
    };
    dx * dx + dy * dy
}

/// Liang-Barsky test: does segment cross through rect? (Both endpoints outside.)
#[inline]
fn segment_crosses_rect(
    ax: f64,
    ay: f64,
    bx: f64,
    by: f64,
    rx0: f64,
    ry0: f64,
    rx1: f64,
    ry1: f64,
) -> bool {
    let dx = bx - ax;
    let dy = by - ay;
    let mut t_min = 0.0f64;
    let mut t_max = 1.0f64;

    let clips = [
        (-dx, ax - rx0),
        (dx, rx1 - ax),
        (-dy, ay - ry0),
        (dy, ry1 - ay),
    ];

    for &(p, q) in &clips {
        if p.abs() < 1e-20 {
            if q < 0.0 {
                return false;
            }
        } else {
            let r = q / p;
            if p < 0.0 {
                if r > t_max {
                    return false;
                }
                if r > t_min {
                    t_min = r;
                }
            } else {
                if r < t_min {
                    return false;
                }
                if r < t_max {
                    t_max = r;
                }
            }
        }
    }

    t_min <= t_max
}

/// Build a 32×32 IDW candidate grid for a parent contour and its children.
/// Returns (cell_starts, entries) matching the TS buildIDWGrid format.
pub(super) fn build_idw_grid_packed(
    parent_polygon: &[[f64; 2]],
    child_polygons: &[&[[f64; 2]]],
    parent_bbox: &BBox,
) -> (Vec<u32>, Vec<u32>) {
    let min_x = parent_bbox.min_x;
    let min_y = parent_bbox.min_y;
    let w = (parent_bbox.max_x - min_x).max(1e-9);
    let h = (parent_bbox.max_y - min_y).max(1e-9);
    let cell_w = w / IDW_GRID_SIZE as f64;
    let cell_h = h / IDW_GRID_SIZE as f64;

    // Collect all edges with tags
    struct IDWEdge {
        ax: f64,
        ay: f64,
        bx: f64,
        by: f64,
        tag: u16,
        edge_index: u16,
    }
    let mut edges = Vec::new();

    // Parent edges (tag 0)
    for i in 0..parent_polygon.len() {
        let j = (i + 1) % parent_polygon.len();
        edges.push(IDWEdge {
            ax: parent_polygon[i][0],
            ay: parent_polygon[i][1],
            bx: parent_polygon[j][0],
            by: parent_polygon[j][1],
            tag: 0,
            edge_index: i as u16,
        });
    }

    // Child edges (tags 1..N)
    for (ci, poly) in child_polygons.iter().enumerate() {
        for i in 0..poly.len() {
            let j = (i + 1) % poly.len();
            edges.push(IDWEdge {
                ax: poly[i][0],
                ay: poly[i][1],
                bx: poly[j][0],
                by: poly[j][1],
                tag: (ci + 1) as u16,
                edge_index: i as u16,
            });
        }
    }

    let num_tags = 1 + child_polygons.len();
    let mut cell_entries: Vec<Vec<u32>> = vec![Vec::new(); IDW_GRID_CELLS];

    // Pre-allocate working buffers
    let mut per_tag_upper_bound_sq = vec![f64::MAX; num_tags];
    let mut edge_min_dists = vec![0.0f64; edges.len()];
    let mut cell_candidate_indices: Vec<usize> = Vec::new();

    for row in 0..IDW_GRID_SIZE {
        for col in 0..IDW_GRID_SIZE {
            let rx0 = min_x + col as f64 * cell_w;
            let ry0 = min_y + row as f64 * cell_h;
            let rx1 = rx0 + cell_w;
            let ry1 = ry0 + cell_h;

            // Single pass: compute both min and max distances, sharing corner
            // computations. Track per-tag upper bound and store per-edge min.
            per_tag_upper_bound_sq.fill(f64::MAX);
            for (i, e) in edges.iter().enumerate() {
                let (d_min, d_max) =
                    rect_segment_min_max_dist_sq(rx0, ry0, rx1, ry1, e.ax, e.ay, e.bx, e.by);
                edge_min_dists[i] = d_min;
                let tag = e.tag as usize;
                if d_max < per_tag_upper_bound_sq[tag] {
                    per_tag_upper_bound_sq[tag] = d_max;
                }
            }

            // Collect candidates passing the rect-segment upper bound filter
            cell_candidate_indices.clear();
            for (i, e) in edges.iter().enumerate() {
                if edge_min_dists[i] <= per_tag_upper_bound_sq[e.tag as usize] {
                    cell_candidate_indices.push(i);
                }
            }

            let cell = row * IDW_GRID_SIZE + col;

            // Add all candidates that pass the rect-segment upper bound filter.
            for &ei in &cell_candidate_indices {
                let e = &edges[ei];
                cell_entries[cell]
                    .push(((e.tag as u32) << 16) | (e.edge_index as u32));
            }
        }
    }

    // Flatten into prefix-sum storage
    let mut cell_starts = Vec::with_capacity(IDW_GRID_CELL_STARTS);
    cell_starts.push(0u32);
    for cell in &cell_entries {
        cell_starts.push(cell_starts.last().unwrap() + cell.len() as u32);
    }
    let mut entries = Vec::new();
    for cell in &cell_entries {
        entries.extend_from_slice(cell);
    }

    (cell_starts, entries)
}

// ── Contour lookup grid (level-wide, for GPU) ────────────────────────────────

/// Per-contour classification result for a single cell during lookup-grid build.
struct CellClassification {
    cell: u32,
    is_inside: bool,
}

/// Build a 256×256 contour lookup grid packed for GPU upload.
///
/// GPU format (all u32):
///   [cols, rows, min_x(f32 bits), min_y(f32 bits), inv_cell_w(f32 bits), inv_cell_h(f32 bits),
///    base_contour[N], cell_starts[N+1], candidates[...]]
/// where N = cols * rows = 65536.
///
/// base_contour[cell] = DFS index of deepest fully-containing contour, or u32::MAX.
/// candidates are sorted deepest-first; the first passing isInsideContour is the answer.
pub(super) fn build_lookup_grid_packed_gpu(
    sampled: &[Vec<[f64; 2]>],
    bboxes: &[BBox],
    dfs_order: &[usize],
    tree: &ContourTree,
) -> Vec<u32> {
    use rayon::prelude::*;

    let n = dfs_order.len();
    if n == 0 {
        return Vec::new();
    }

    // Compute level bounds from all contour bboxes
    let mut level_min_x = f64::MAX;
    let mut level_min_y = f64::MAX;
    let mut level_max_x = f64::MIN;
    let mut level_max_y = f64::MIN;
    for &orig in dfs_order {
        let bb = &bboxes[orig];
        level_min_x = level_min_x.min(bb.min_x);
        level_min_y = level_min_y.min(bb.min_y);
        level_max_x = level_max_x.max(bb.max_x);
        level_max_y = level_max_y.max(bb.max_y);
    }

    let cols = LOOKUP_GRID_SIZE;
    let rows = LOOKUP_GRID_SIZE;
    let w = (level_max_x - level_min_x).max(1e-9);
    let h = (level_max_y - level_min_y).max(1e-9);
    let inv_cell_w = cols as f64 / w;
    let inv_cell_h = rows as f64 / h;
    let cell_w = w / cols as f64;
    let cell_h = h / rows as f64;
    let num_cells = cols * rows;

    // Classify cells per contour in parallel (indexed by DFS index)
    let per_contour: Vec<Vec<CellClassification>> = (0..n)
        .into_par_iter()
        .map(|dfs_idx| {
            let orig = dfs_order[dfs_idx];
            let polygon = &sampled[orig];
            let bb = &bboxes[orig];

            if polygon.len() < 3 {
                return Vec::new();
            }

            let c0 = ((bb.min_x - level_min_x) * inv_cell_w)
                .floor()
                .max(0.0) as usize;
            let c1 = ((bb.max_x - level_min_x) * inv_cell_w)
                .floor()
                .min((cols - 1) as f64) as usize;
            let r0 = ((bb.min_y - level_min_y) * inv_cell_h)
                .floor()
                .max(0.0) as usize;
            let r1 = ((bb.max_y - level_min_y) * inv_cell_h)
                .floor()
                .min((rows - 1) as f64) as usize;

            let bbox_cols = c1 - c0 + 1;
            let bbox_rows = r1 - r0 + 1;
            let mut cell_flags = vec![CELL_OUTSIDE; bbox_cols * bbox_rows];

            // DDA-rasterize contour edges
            let pn = polygon.len();
            for i in 0..pn {
                let j = (i + 1) % pn;
                rasterize_edge_to_grid(
                    polygon[i][0],
                    polygon[i][1],
                    polygon[j][0],
                    polygon[j][1],
                    level_min_x + c0 as f64 * cell_w,
                    level_min_y + r0 as f64 * cell_h,
                    inv_cell_w,
                    inv_cell_h,
                    bbox_cols,
                    bbox_rows,
                    &mut cell_flags,
                );
            }

            // Classify cells
            let mut results = Vec::new();
            for lr in 0..bbox_rows {
                for lc in 0..bbox_cols {
                    let local_cell = lr * bbox_cols + lc;
                    let global_cell = (r0 + lr) * cols + (c0 + lc);
                    if cell_flags[local_cell] == CELL_BOUNDARY {
                        results.push(CellClassification {
                            cell: global_cell as u32,
                            is_inside: false,
                        });
                    } else {
                        let cx = level_min_x + ((c0 + lc) as f64 + 0.5) * cell_w;
                        let cy = level_min_y + ((r0 + lr) as f64 + 0.5) * cell_h;
                        if point_in_polygon_arr2(cx, cy, polygon) {
                            results.push(CellClassification {
                                cell: global_cell as u32,
                                is_inside: true,
                            });
                        }
                    }
                }
            }
            results
        })
        .collect();

    // Sequential merge: combine per-contour results into base + candidates
    let mut base_contour = vec![u32::MAX; num_cells];
    let mut base_depth = vec![0u32; num_cells];
    let mut all_candidates: Vec<Vec<u32>> = vec![Vec::new(); num_cells];

    for dfs_idx in 0..n {
        let orig = dfs_order[dfs_idx];
        let depth = tree.nodes[orig].depth;

        for r in &per_contour[dfs_idx] {
            let cell = r.cell as usize;
            if r.is_inside {
                if depth > base_depth[cell] || base_contour[cell] == u32::MAX {
                    base_contour[cell] = dfs_idx as u32;
                    base_depth[cell] = depth;
                }
            } else {
                all_candidates[cell].push(dfs_idx as u32);
            }
        }
    }

    // Flatten candidates: keep only P contours deeper than base, sorted deepest-first
    let mut cell_starts = Vec::with_capacity(num_cells + 1);
    let mut candidate_indices: Vec<u32> = Vec::new();
    cell_starts.push(0u32);

    for cell in 0..num_cells {
        let bd = base_depth[cell];
        let has_base = base_contour[cell] != u32::MAX;

        let mut candidates: Vec<(u32, u32)> = all_candidates[cell]
            .iter()
            .filter(|&&dfs_idx| {
                let orig = dfs_order[dfs_idx as usize];
                let d = tree.nodes[orig].depth;
                !has_base || d > bd
            })
            .map(|&dfs_idx| {
                let orig = dfs_order[dfs_idx as usize];
                (tree.nodes[orig].depth, dfs_idx)
            })
            .collect();
        candidates.sort_unstable_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        for &(_, dfs_idx) in &candidates {
            candidate_indices.push(dfs_idx);
        }
        cell_starts.push(candidate_indices.len() as u32);
    }

    // Print stats
    // Compute per-cell candidate counts
    let candidate_counts: Vec<usize> = (0..num_cells)
        .map(|c| (cell_starts[c + 1] - cell_starts[c]) as usize)
        .collect();
    let cells_with_zero_candidates = candidate_counts.iter().filter(|&&c| c == 0).count();
    let cells_outside = base_contour.iter().filter(|&&b| b == u32::MAX).count();
    // "free" = zero-cost lookup (base only, no candidates to test)
    let cells_free = cells_with_zero_candidates;
    let max_candidates = candidate_counts.iter().copied().max().unwrap_or(0);

    // Sort for percentile computation (only among cells that have candidates)
    let mut nonzero_counts: Vec<usize> = candidate_counts.iter().copied().filter(|&c| c > 0).collect();
    nonzero_counts.sort_unstable();
    let avg_candidates_nonzero = if nonzero_counts.is_empty() {
        0.0
    } else {
        nonzero_counts.iter().sum::<usize>() as f64 / nonzero_counts.len() as f64
    };
    let p50 = nonzero_counts.get(nonzero_counts.len() / 2).copied().unwrap_or(0);
    let p95 = nonzero_counts.get((nonzero_counts.len() as f64 * 0.95) as usize).copied().unwrap_or(0);

    // Overall average across ALL cells (including zero-candidate cells)
    let avg_candidates_all = candidate_indices.len() as f64 / num_cells as f64;

    eprintln!("  Lookup grid stats:");
    eprintln!("    grid size:          {}×{} ({} cells)", cols, rows, num_cells);
    eprintln!(
        "    outside all:        {} ({:.1}%)",
        cells_outside,
        cells_outside as f64 / num_cells as f64 * 100.0
    );
    eprintln!(
        "    zero-cost (base):   {} ({:.1}%)",
        cells_free,
        cells_free as f64 / num_cells as f64 * 100.0
    );
    eprintln!(
        "    candidates/cell:    avg {:.2} (overall), avg {:.1} (boundary only), median {}, p95 {}, max {}",
        avg_candidates_all, avg_candidates_nonzero, p50, p95, max_candidates
    );
    let total_u32s =
        LOOKUP_GRID_HEADER + num_cells + (num_cells + 1) + candidate_indices.len();
    eprintln!(
        "    memory:             {} bytes ({:.1} KB)",
        total_u32s * 4,
        total_u32s as f64 * 4.0 / 1024.0
    );

    // Pack into GPU format
    let mut packed = Vec::with_capacity(total_u32s);

    // Header (6 u32s)
    packed.push(cols as u32);
    packed.push(rows as u32);
    packed.push((level_min_x as f32).to_bits());
    packed.push((level_min_y as f32).to_bits());
    packed.push((inv_cell_w as f32).to_bits());
    packed.push((inv_cell_h as f32).to_bits());

    // Base contour per cell
    packed.extend_from_slice(&base_contour);

    // Cell starts (prefix sum)
    packed.extend_from_slice(&cell_starts);

    // Candidate indices
    packed.extend_from_slice(&candidate_indices);

    packed
}
