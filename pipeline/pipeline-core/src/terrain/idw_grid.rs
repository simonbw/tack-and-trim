//! IDW candidate grid: precomputed nearest-edge candidates per cell, indexed
//! over a parent contour's bounding box. Built once per parent-with-children.
//! Each entry is a packed `(contour_tag, edge_index)` pair.

use super::contour::ParsedContour;

/// Resolution of the IDW candidate grid (cells per axis).
const IDW_GRID_RESOLUTION: usize = 32;

/// Grid that precomputes, for each cell, which edges from the parent contour
/// and its direct children could be the nearest edge for any point in that cell.
/// Each entry is a packed `(contour_tag, edge_index)` pair.
///
/// Built once per parent contour (that has children) during `parse_contours`.
/// Covers the parent's bounding box and indexes edges from parent + all children.
pub struct IDWGrid {
    /// Prefix-sum cell storage: `cell_starts[cell]..cell_starts[cell+1]` gives
    /// the range of entries for that cell.
    cell_starts: Vec<u32>,
    /// Packed entries: high 16 bits = contour_tag, low 16 bits = edge_index.
    /// contour_tag 0 = parent, 1..N = child index in child_start..child_start+child_count.
    entries: Vec<u32>,
    cols: usize,
    rows: usize,
    inv_cell_w: f64,
    inv_cell_h: f64,
    min_x: f64,
    min_y: f64,
    /// Number of contours in this grid (1 parent + N children).
    pub(super) contour_count: usize,
}

/// A collected edge for IDW grid building.
struct IDWEdge {
    ax: f64,
    ay: f64,
    bx: f64,
    by: f64,
    contour_tag: u16,
    edge_index: u16,
}

impl IDWGrid {
    /// Build an IDW candidate grid for a parent contour and its direct children.
    pub(super) fn build(
        parent: &ParsedContour,
        _parent_idx: usize,
        contours: &[ParsedContour],
        children_data: &[u32],
        vd: &[f32],
    ) -> Self {
        let min_x = parent.bbox_min_x as f64;
        let min_y = parent.bbox_min_y as f64;
        let max_x = parent.bbox_max_x as f64;
        let max_y = parent.bbox_max_y as f64;

        let cols = IDW_GRID_RESOLUTION;
        let rows = IDW_GRID_RESOLUTION;
        let w = (max_x - min_x).max(1e-9);
        let h = (max_y - min_y).max(1e-9);
        let cell_w = w / cols as f64;
        let cell_h = h / rows as f64;
        let inv_cell_w = cols as f64 / w;
        let inv_cell_h = rows as f64 / h;
        let num_cells = cols * rows;

        // Collect all edges from parent + children
        let mut edges = Vec::new();
        let contour_count = 1 + parent.child_count;

        // Parent edges (tag 0)
        {
            let n = parent.point_count;
            let s = parent.point_start * 2;
            for i in 0..n {
                let j = (i + 1) % n;
                edges.push(IDWEdge {
                    ax: vd[s + i * 2] as f64,
                    ay: vd[s + i * 2 + 1] as f64,
                    bx: vd[s + j * 2] as f64,
                    by: vd[s + j * 2 + 1] as f64,
                    contour_tag: 0,
                    edge_index: i as u16,
                });
            }
        }

        // Children edges (tags 1..N)
        for ci in 0..parent.child_count {
            let child_dfs = children_data[parent.child_start + ci] as usize;
            if child_dfs >= contours.len() {
                continue;
            }
            let child = &contours[child_dfs];
            let n = child.point_count;
            let s = child.point_start * 2;
            for i in 0..n {
                let j = (i + 1) % n;
                edges.push(IDWEdge {
                    ax: vd[s + i * 2] as f64,
                    ay: vd[s + i * 2 + 1] as f64,
                    bx: vd[s + j * 2] as f64,
                    by: vd[s + j * 2 + 1] as f64,
                    contour_tag: (ci + 1) as u16,
                    edge_index: i as u16,
                });
            }
        }

        // For each cell, find candidates using exact rect-to-segment distances.
        // Per-tag upper bound = min over same-tag edges of max_dist(cell, edge).
        // Edge E is included if min_dist(cell, E) ≤ upper bound for its tag.
        // Then pairwise pruning: keep only edges nearest at ≥1 of 5 sample points.
        let mut cell_entries: Vec<Vec<u32>> = vec![Vec::new(); num_cells];
        let mut per_tag_upper_bound_sq = vec![f64::MAX; contour_count];
        let mut edge_min_dists = vec![0.0f64; edges.len()];
        let mut cell_candidate_indices: Vec<usize> = Vec::new();

        for row in 0..rows {
            for col in 0..cols {
                let rx0 = min_x + col as f64 * cell_w;
                let ry0 = min_y + row as f64 * cell_h;
                let rx1 = rx0 + cell_w;
                let ry1 = ry0 + cell_h;

                // Single pass: compute both min and max distances per edge
                per_tag_upper_bound_sq.fill(f64::MAX);
                for (i, e) in edges.iter().enumerate() {
                    let (d_min, d_max) = rect_segment_min_max_dist_sq(
                        rx0, ry0, rx1, ry1, e.ax, e.ay, e.bx, e.by,
                    );
                    edge_min_dists[i] = d_min;
                    let tag = e.contour_tag as usize;
                    if d_max < per_tag_upper_bound_sq[tag] {
                        per_tag_upper_bound_sq[tag] = d_max;
                    }
                }

                // Collect candidates passing the rect-segment upper bound filter
                cell_candidate_indices.clear();
                for (i, e) in edges.iter().enumerate() {
                    if edge_min_dists[i] <= per_tag_upper_bound_sq[e.contour_tag as usize] {
                        cell_candidate_indices.push(i);
                    }
                }

                let cell = row * cols + col;

                // Add all candidates that pass the rect-segment upper bound filter.
                for &ei in &cell_candidate_indices {
                    let e = &edges[ei];
                    cell_entries[cell].push(
                        ((e.contour_tag as u32) << 16) | (e.edge_index as u32),
                    );
                }
            }
        }

        // Flatten into prefix-sum storage
        let mut cell_starts = Vec::with_capacity(num_cells + 1);
        cell_starts.push(0u32);
        for cell in &cell_entries {
            cell_starts.push(cell_starts.last().unwrap() + cell.len() as u32);
        }
        let total = *cell_starts.last().unwrap() as usize;
        let mut entries = Vec::with_capacity(total);
        for cell in &cell_entries {
            entries.extend_from_slice(cell);
        }

        IDWGrid {
            cell_starts,
            entries,
            cols,
            rows,
            inv_cell_w,
            inv_cell_h,
            min_x,
            min_y,
            contour_count,
        }
    }

    /// Look up candidate edges for a query point. Returns a slice of packed entries.
    #[inline]
    pub(super) fn candidates(&self, px: f64, py: f64) -> &[u32] {
        let ci = ((px - self.min_x) * self.inv_cell_w).floor() as isize;
        let ri = ((py - self.min_y) * self.inv_cell_h).floor() as isize;
        if ci < 0 || ri < 0 || ci >= self.cols as isize || ri >= self.rows as isize {
            return &[];
        }
        let cell = ri as usize * self.cols + ci as usize;
        let start = self.cell_starts[cell] as usize;
        let end = self.cell_starts[cell + 1] as usize;
        &self.entries[start..end]
    }
}

// ── Rect/segment distance helpers (used only for IDW grid construction) ────

/// Squared distance from point to segment (no sqrt). Used for IDW grid building.
#[inline]
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
    let d0 = point_to_segment_dist_sq(rx0, ry0, ax, ay, bx, by);
    let d1 = point_to_segment_dist_sq(rx1, ry0, ax, ay, bx, by);
    let d2 = point_to_segment_dist_sq(rx0, ry1, ax, ay, bx, by);
    let d3 = point_to_segment_dist_sq(rx1, ry1, ax, ay, bx, by);

    let d_max = d0.max(d1).max(d2).max(d3);
    let d_min_corners = d0.min(d1).min(d2).min(d3);

    if d_min_corners == 0.0 {
        return (0.0, d_max);
    }

    let de0 = point_to_rect_dist_sq(ax, ay, rx0, ry0, rx1, ry1);
    if de0 == 0.0 {
        return (0.0, d_max);
    }
    let de1 = point_to_rect_dist_sq(bx, by, rx0, ry0, rx1, ry1);
    if de1 == 0.0 {
        return (0.0, d_max);
    }

    let d_min = d_min_corners.min(de0).min(de1);

    let e_min_x = ax.min(bx);
    let e_max_x = ax.max(bx);
    let e_min_y = ay.min(by);
    let e_max_y = ay.max(by);
    if e_min_x > rx1 || e_max_x < rx0 || e_min_y > ry1 || e_max_y < ry0 {
        return (d_min, d_max);
    }

    if segment_crosses_rect(ax, ay, bx, by, rx0, ry0, rx1, ry1) {
        return (0.0, d_max);
    }

    (d_min, d_max)
}

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
