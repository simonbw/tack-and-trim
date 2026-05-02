//! Per-contour spatial acceleration:
//! - `ContainmentGrid`: O(1) point-in-contour using a 64×64 inside/outside cache.
//! - `EdgeGrid`: 2D bucketing of contour edges for fast nearest-edge queries.
//!
//! IDW and lookup grids live in their own modules.

use super::contour::ParsedContour;
use super::distance::winding_number_test;

// ── Cell containment flags (shared with lookup_grid) ─────────────────────────

pub(super) const CELL_OUTSIDE: u8 = 0;
const CELL_INSIDE: u8 = 1;
pub(super) const CELL_BOUNDARY: u8 = 2;

// ── Edge rasterization (DDA, shared with lookup_grid) ───────────────────────

/// Rasterize a line segment through grid cells using DDA, marking each
/// traversed cell as BOUNDARY. Marks the cell of both endpoints and every
/// cell the line crosses between them.
pub(super) fn rasterize_edge_to_grid(
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

    // Cell coordinates of start and end
    let mut col = ((ax - min_x) * inv_cell_w).floor() as isize;
    let mut row = ((ay - min_y) * inv_cell_h).floor() as isize;
    let end_col = ((bx - min_x) * inv_cell_w).floor() as isize;
    let end_row = ((by - min_y) * inv_cell_h).floor() as isize;

    // Mark start cell
    if col >= 0 && col <= max_col && row >= 0 && row <= max_row {
        cell_flags[row as usize * cols + col as usize] = CELL_BOUNDARY;
    }

    let dx = bx - ax;
    let dy = by - ay;

    let step_col: isize = if dx > 0.0 {
        1
    } else if dx < 0.0 {
        -1
    } else {
        0
    };
    let step_row: isize = if dy > 0.0 {
        1
    } else if dy < 0.0 {
        -1
    } else {
        0
    };

    // t values at which the line crosses the next vertical/horizontal grid line
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

    let t_delta_x = if dx != 0.0 {
        (cell_w / dx).abs()
    } else {
        f64::MAX
    };
    let t_delta_y = if dy != 0.0 {
        (cell_h / dy).abs()
    } else {
        f64::MAX
    };

    // Walk the grid until we reach the end cell or go out of bounds
    let max_steps = (cols + rows) * 2; // safety limit
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

// ---------------------------------------------------------------------------
// Containment grid — O(1) point-in-contour for all contours
// ---------------------------------------------------------------------------

/// Lightweight grid that caches inside/outside containment flags.
/// Built for every contour (including small ones) to avoid winding number tests.
pub struct ContainmentGrid {
    cell_flags: Vec<u8>,
    inv_cell_w: f64,
    inv_cell_h: f64,
    min_x: f64,
    min_y: f64,
}

const CONTAINMENT_GRID_SIZE: usize = 64;

impl ContainmentGrid {
    pub(super) fn empty() -> Self {
        ContainmentGrid {
            cell_flags: Vec::new(),
            inv_cell_w: 0.0,
            inv_cell_h: 0.0,
            min_x: 0.0,
            min_y: 0.0,
        }
    }

    pub(super) fn build(c: &ParsedContour, vd: &[f32]) -> Self {
        let min_x = c.bbox_min_x as f64;
        let min_y = c.bbox_min_y as f64;
        let max_x = c.bbox_max_x as f64;
        let max_y = c.bbox_max_y as f64;
        let cols = CONTAINMENT_GRID_SIZE;
        let rows = CONTAINMENT_GRID_SIZE;

        let w = (max_x - min_x).max(1e-9);
        let h = (max_y - min_y).max(1e-9);
        let inv_cell_w = cols as f64 / w;
        let inv_cell_h = rows as f64 / h;
        let cell_w = w / cols as f64;
        let cell_h = h / rows as f64;
        let num_cells = cols * rows;
        let start = c.point_start * 2;
        let n = c.point_count;

        // Mark cells that the edges actually pass through as BOUNDARY.
        // Uses DDA line rasterization instead of edge bounding boxes to avoid
        // over-marking (a diagonal edge's bbox would mark the entire grid).
        let mut cell_flags = vec![CELL_OUTSIDE; num_cells];
        for i in 0..n {
            let j = (i + 1) % n;
            let ax = vd[start + i * 2] as f64;
            let ay = vd[start + i * 2 + 1] as f64;
            let bx = vd[start + j * 2] as f64;
            let by = vd[start + j * 2 + 1] as f64;

            // Rasterize line from (ax,ay) to (bx,by) through grid cells
            rasterize_edge_to_grid(
                ax,
                ay,
                bx,
                by,
                min_x,
                min_y,
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
                let cx = min_x + (col as f64 + 0.5) * cell_w;
                let cy = min_y + (row as f64 + 0.5) * cell_h;
                if winding_number_test(cx, cy, n, start, vd) {
                    cell_flags[cell] = CELL_INSIDE;
                }
            }
        }

        ContainmentGrid {
            cell_flags,
            inv_cell_w,
            inv_cell_h,
            min_x,
            min_y,
        }
    }

    /// Returns `Some(true)` if definitely inside, `Some(false)` if definitely
    /// outside, `None` if on a boundary cell (caller must do full winding test).
    #[inline]
    pub(super) fn contains(&self, px: f64, py: f64) -> Option<bool> {
        let ci = ((px - self.min_x) * self.inv_cell_w).floor() as isize;
        let ri = ((py - self.min_y) * self.inv_cell_h).floor() as isize;
        if ci < 0
            || ri < 0
            || ci >= CONTAINMENT_GRID_SIZE as isize
            || ri >= CONTAINMENT_GRID_SIZE as isize
        {
            return Some(false);
        }
        let cell = ri as usize * CONTAINMENT_GRID_SIZE + ci as usize;
        match self.cell_flags[cell] {
            CELL_INSIDE => Some(true),
            CELL_OUTSIDE => Some(false),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Edge spatial grid — accelerates nearest-edge queries for large contours
// ---------------------------------------------------------------------------

/// Minimum number of edges before we build a spatial grid.
/// Below this threshold, linear scan is faster than grid overhead.
pub(super) const EDGE_GRID_THRESHOLD: usize = 32;

/// Target number of grid cells per axis (actual count clamped to edge count).
const EDGE_GRID_RESOLUTION: usize = 16;

/// Spatial grid that indexes contour edges into 2D cells for fast
/// nearest-edge queries. Built for large contours only.
pub struct EdgeGrid {
    /// Flattened cell storage: `cell_starts[cell]..cell_starts[cell+1]` gives
    /// the range of edge indices in `edge_indices` belonging to that cell.
    cell_starts: Vec<u32>,
    edge_indices: Vec<u16>,
    cols: usize,
    rows: usize,
    pub(super) inv_cell_w: f64,
    pub(super) inv_cell_h: f64,
    min_x: f64,
    min_y: f64,
}

impl EdgeGrid {
    /// Build a spatial grid for the edges of a contour.
    pub(super) fn build(c: &ParsedContour, vd: &[f32]) -> Self {
        let n = c.point_count;
        let start = c.point_start * 2;

        let min_x = c.bbox_min_x as f64;
        let min_y = c.bbox_min_y as f64;
        let max_x = c.bbox_max_x as f64;
        let max_y = c.bbox_max_y as f64;

        let cols = EDGE_GRID_RESOLUTION.min(n).max(1);
        let rows = EDGE_GRID_RESOLUTION.min(n).max(1);
        let w = (max_x - min_x).max(1e-9);
        let h = (max_y - min_y).max(1e-9);
        let inv_cell_w = cols as f64 / w;
        let inv_cell_h = rows as f64 / h;
        let num_cells = cols * rows;

        // Count edges per cell
        let mut counts = vec![0u32; num_cells];
        for i in 0..n {
            let j = (i + 1) % n;
            let ax = vd[start + i * 2] as f64;
            let ay = vd[start + i * 2 + 1] as f64;
            let bx = vd[start + j * 2] as f64;
            let by = vd[start + j * 2 + 1] as f64;

            let e_min_x = ax.min(bx);
            let e_min_y = ay.min(by);
            let e_max_x = ax.max(bx);
            let e_max_y = ay.max(by);

            let c0 = ((e_min_x - min_x) * inv_cell_w).floor() as isize;
            let c1 = ((e_max_x - min_x) * inv_cell_w).floor() as isize;
            let r0 = ((e_min_y - min_y) * inv_cell_h).floor() as isize;
            let r1 = ((e_max_y - min_y) * inv_cell_h).floor() as isize;

            let c0 = c0.max(0) as usize;
            let c1 = (c1 as usize).min(cols - 1);
            let r0 = r0.max(0) as usize;
            let r1 = (r1 as usize).min(rows - 1);

            for r in r0..=r1 {
                for c in c0..=c1 {
                    counts[r * cols + c] += 1;
                }
            }
        }

        // Build prefix-sum offsets
        let mut cell_starts = Vec::with_capacity(num_cells + 1);
        cell_starts.push(0u32);
        for &cnt in &counts {
            cell_starts.push(cell_starts.last().unwrap() + cnt);
        }
        let total = *cell_starts.last().unwrap() as usize;
        let mut edge_indices = vec![0u16; total];

        // Fill edge indices (reuse counts as write cursors)
        counts.fill(0);
        for i in 0..n {
            let j = (i + 1) % n;
            let ax = vd[start + i * 2] as f64;
            let ay = vd[start + i * 2 + 1] as f64;
            let bx = vd[start + j * 2] as f64;
            let by = vd[start + j * 2 + 1] as f64;

            let e_min_x = ax.min(bx);
            let e_min_y = ay.min(by);
            let e_max_x = ax.max(bx);
            let e_max_y = ay.max(by);

            let c0 = ((e_min_x - min_x) * inv_cell_w).floor() as isize;
            let c1 = ((e_max_x - min_x) * inv_cell_w).floor() as isize;
            let r0 = ((e_min_y - min_y) * inv_cell_h).floor() as isize;
            let r1 = ((e_max_y - min_y) * inv_cell_h).floor() as isize;

            let c0 = c0.max(0) as usize;
            let c1 = (c1 as usize).min(cols - 1);
            let r0 = r0.max(0) as usize;
            let r1 = (r1 as usize).min(rows - 1);

            for r in r0..=r1 {
                for c in c0..=c1 {
                    let cell = r * cols + c;
                    let pos = cell_starts[cell] + counts[cell];
                    edge_indices[pos as usize] = i as u16;
                    counts[cell] += 1;
                }
            }
        }

        EdgeGrid {
            cell_starts,
            edge_indices,
            cols,
            rows,
            inv_cell_w,
            inv_cell_h,
            min_x,
            min_y,
        }
    }

    /// Return an iterator of edge indices in cells within `radius` of `(px, py)`.
    /// Edges may appear more than once (spanning multiple cells); caller deduplicates
    /// via the "best so far" distance check.
    #[inline]
    pub(super) fn nearby_edges(&self, px: f64, py: f64, radius: f64) -> NearbyEdges<'_> {
        let c0i = ((px - radius - self.min_x) * self.inv_cell_w).floor() as isize;
        let c1i = ((px + radius - self.min_x) * self.inv_cell_w).floor() as isize;
        let r0i = ((py - radius - self.min_y) * self.inv_cell_h).floor() as isize;
        let r1i = ((py + radius - self.min_y) * self.inv_cell_h).floor() as isize;

        let max_c = self.cols as isize - 1;
        let max_r = self.rows as isize - 1;

        // Clamp to grid bounds; if range is empty, return an exhausted iterator
        if c0i > max_c || c1i < 0 || r0i > max_r || r1i < 0 {
            return NearbyEdges {
                grid: self,
                c0: 0,
                c1: 0,
                r1: 0,
                cur_r: 1,
                cur_c: 0, // cur_r > r1 → immediately exhausted
                pos: 0,
                end: 0,
            };
        }

        let c0 = c0i.max(0) as usize;
        let c1 = c1i.min(max_c) as usize;
        let r0 = r0i.max(0) as usize;
        let r1 = r1i.min(max_r) as usize;

        let cell = r0 * self.cols + c0;
        NearbyEdges {
            grid: self,
            c0,
            c1,
            r1,
            cur_r: r0,
            cur_c: c0,
            pos: self.cell_starts[cell] as usize,
            end: self.cell_starts[cell + 1] as usize,
        }
    }
}

pub(super) struct NearbyEdges<'a> {
    grid: &'a EdgeGrid,
    c0: usize,
    c1: usize,
    r1: usize,
    cur_r: usize,
    cur_c: usize,
    pos: usize,
    end: usize,
}

impl Iterator for NearbyEdges<'_> {
    type Item = usize;

    #[inline]
    fn next(&mut self) -> Option<usize> {
        loop {
            if self.pos < self.end {
                let idx = self.grid.edge_indices[self.pos] as usize;
                self.pos += 1;
                return Some(idx);
            }
            // Advance to next cell
            self.cur_c += 1;
            if self.cur_c > self.c1 {
                self.cur_c = self.c0;
                self.cur_r += 1;
            }
            if self.cur_r > self.r1 {
                return None;
            }
            let cell = self.cur_r * self.grid.cols + self.cur_c;
            self.pos = self.grid.cell_starts[cell] as usize;
            self.end = self.grid.cell_starts[cell + 1] as usize;
        }
    }
}
