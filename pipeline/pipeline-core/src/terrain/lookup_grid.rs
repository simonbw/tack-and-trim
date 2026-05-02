//! Level-wide contour lookup grid: precomputes containment results per cell.
//! Each cell stores the deepest contour that fully contains it (base), plus
//! a sorted list of candidate contours whose boundaries cross the cell.

use super::contour::ParsedContour;
use super::distance::{is_inside_contour, winding_number_test};
use super::spatial::{rasterize_edge_to_grid, CELL_BOUNDARY, CELL_OUTSIDE};

/// Resolution of the level-wide contour lookup grid (cells per axis).
const CONTOUR_LOOKUP_GRID_SIZE: usize = 256;

/// Level-wide grid that precomputes containment results per cell.
/// Each cell stores the deepest contour that fully contains it (base),
/// plus a sorted list of candidate contours whose boundaries cross the cell.
/// At query time, candidates are checked deepest-first; the first match wins.
/// If none match, the base contour is the answer.
pub struct ContourLookupGrid {
    /// Per-cell: DFS index of deepest fully-containing (O) contour, or `u16::MAX`.
    base_contour: Vec<u16>,
    /// Per-cell: precomputed height of the base contour.
    base_height: Vec<f64>,
    /// Prefix-sum into `candidate_indices`.
    cell_starts: Vec<u32>,
    /// Candidate contour DFS indices (P contours deeper than base), deepest-first.
    candidate_indices: Vec<u16>,
    cols: usize,
    rows: usize,
    inv_cell_w: f64,
    inv_cell_h: f64,
    min_x: f64,
    min_y: f64,
}

impl ContourLookupGrid {
    fn empty() -> Self {
        ContourLookupGrid {
            base_contour: Vec::new(),
            base_height: Vec::new(),
            cell_starts: vec![0],
            candidate_indices: Vec::new(),
            cols: 0,
            rows: 0,
            inv_cell_w: 0.0,
            inv_cell_h: 0.0,
            min_x: 0.0,
            min_y: 0.0,
        }
    }

    /// Look up the deepest containing contour for a point.
    /// Returns `(contour_dfs_index, height)` or `(usize::MAX, default_depth)`.
    #[inline]
    pub(super) fn lookup(
        &self,
        px: f64,
        py: f64,
        contours: &[ParsedContour],
        vd: &[f32],
        default_depth: f64,
    ) -> (usize, f64) {
        if self.cols == 0 {
            return (usize::MAX, default_depth);
        }
        let ci = ((px - self.min_x) * self.inv_cell_w).floor() as isize;
        let ri = ((py - self.min_y) * self.inv_cell_h).floor() as isize;
        if ci < 0 || ri < 0 || ci >= self.cols as isize || ri >= self.rows as isize {
            return (usize::MAX, default_depth);
        }
        let cell = ri as usize * self.cols + ci as usize;

        // Check candidates deepest-first; first match is the answer
        let start = self.cell_starts[cell] as usize;
        let end = self.cell_starts[cell + 1] as usize;
        for i in start..end {
            let idx = self.candidate_indices[i] as usize;
            if is_inside_contour(px, py, &contours[idx], vd) {
                return (idx, contours[idx].height as f64);
            }
        }

        // Fall back to base (guaranteed to contain all points in this cell)
        let base = self.base_contour[cell];
        if base == u16::MAX {
            (usize::MAX, default_depth)
        } else {
            (base as usize, self.base_height[cell])
        }
    }
}

/// Per-contour classification result for a single cell.
/// `is_inside == true` → O cell (fully contains), `false` → P cell (boundary).
struct CellClassification {
    cell: u32,
    is_inside: bool,
}

/// Build the level-wide contour lookup grid. Contour classification is
/// parallelized with rayon; the merge step is sequential.
pub(super) fn build_contour_lookup_grid(
    contours: &[ParsedContour],
    vd: &[f32],
    default_depth: f64,
) -> ContourLookupGrid {
    use rayon::prelude::*;

    if contours.is_empty() || contours.len() > u16::MAX as usize {
        return ContourLookupGrid::empty();
    }

    // Compute level bounds from all contour bboxes
    let mut level_min_x = f64::MAX;
    let mut level_min_y = f64::MAX;
    let mut level_max_x = f64::MIN;
    let mut level_max_y = f64::MIN;
    for c in contours {
        level_min_x = level_min_x.min(c.bbox_min_x as f64);
        level_min_y = level_min_y.min(c.bbox_min_y as f64);
        level_max_x = level_max_x.max(c.bbox_max_x as f64);
        level_max_y = level_max_y.max(c.bbox_max_y as f64);
    }

    let cols = CONTOUR_LOOKUP_GRID_SIZE;
    let rows = CONTOUR_LOOKUP_GRID_SIZE;
    let w = (level_max_x - level_min_x).max(1e-9);
    let h = (level_max_y - level_min_y).max(1e-9);
    let inv_cell_w = cols as f64 / w;
    let inv_cell_h = rows as f64 / h;
    let cell_w = w / cols as f64;
    let cell_h = h / rows as f64;
    let num_cells = cols * rows;

    // Classify cells per contour in parallel. Each contour produces a sparse
    // list of (cell, O|P) results; N cells are omitted.
    let per_contour: Vec<Vec<CellClassification>> = contours
        .par_iter()
        .map(|contour| {
            let c0 = ((contour.bbox_min_x as f64 - level_min_x) * inv_cell_w)
                .floor()
                .max(0.0) as usize;
            let c1 = ((contour.bbox_max_x as f64 - level_min_x) * inv_cell_w)
                .floor()
                .min((cols - 1) as f64) as usize;
            let r0 = ((contour.bbox_min_y as f64 - level_min_y) * inv_cell_h)
                .floor()
                .max(0.0) as usize;
            let r1 = ((contour.bbox_max_y as f64 - level_min_y) * inv_cell_h)
                .floor()
                .min((rows - 1) as f64) as usize;

            let bbox_cols = c1 - c0 + 1;
            let bbox_rows = r1 - r0 + 1;
            let mut cell_flags = vec![CELL_OUTSIDE; bbox_cols * bbox_rows];

            // DDA-rasterize contour edges into local bbox grid
            let n = contour.point_count;
            let start = contour.point_start * 2;
            for i in 0..n {
                let j = (i + 1) % n;
                let ax = vd[start + i * 2] as f64;
                let ay = vd[start + i * 2 + 1] as f64;
                let bx = vd[start + j * 2] as f64;
                let by = vd[start + j * 2 + 1] as f64;
                rasterize_edge_to_grid(
                    ax,
                    ay,
                    bx,
                    by,
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
                        if winding_number_test(cx, cy, n, start, vd) {
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
    let mut base_contour = vec![u16::MAX; num_cells];
    let mut base_height = vec![default_depth; num_cells];
    let mut base_depth = vec![0u32; num_cells];
    let mut all_candidates: Vec<Vec<u16>> = vec![Vec::new(); num_cells];

    for (ci, results) in per_contour.iter().enumerate() {
        let contour = &contours[ci];
        for r in results {
            let cell = r.cell as usize;
            if r.is_inside {
                if contour.depth > base_depth[cell] || base_contour[cell] == u16::MAX {
                    base_contour[cell] = ci as u16;
                    base_height[cell] = contour.height as f64;
                    base_depth[cell] = contour.depth;
                }
            } else {
                all_candidates[cell].push(ci as u16);
            }
        }
    }

    // Flatten candidates: keep only P contours deeper than base, sorted deepest-first
    let mut cell_starts = Vec::with_capacity(num_cells + 1);
    let mut candidate_indices = Vec::new();
    cell_starts.push(0u32);

    for cell in 0..num_cells {
        let bd = base_depth[cell];
        let has_base = base_contour[cell] != u16::MAX;

        let mut candidates: Vec<(u32, u16)> = all_candidates[cell]
            .iter()
            .filter(|&&ci| {
                let d = contours[ci as usize].depth;
                !has_base || d > bd
            })
            .map(|&ci| (contours[ci as usize].depth, ci))
            .collect();
        candidates.sort_unstable_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        for &(_, ci) in &candidates {
            candidate_indices.push(ci);
        }
        cell_starts.push(candidate_indices.len() as u32);
    }

    ContourLookupGrid {
        base_contour,
        base_height,
        cell_starts,
        candidate_indices,
        cols,
        rows,
        inv_cell_w,
        inv_cell_h,
        min_x: level_min_x,
        min_y: level_min_y,
    }
}
