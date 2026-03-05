//! CPU terrain height queries — contour tree DFS, winding number, IDW.
//! Mirrors terrainHeightCPU.ts.

use crate::humanize::format_int;
use crate::level::{TerrainCPUData, FLOATS_PER_CONTOUR};

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

/// Rasterize a line segment through grid cells using DDA, marking each
/// traversed cell as BOUNDARY. Marks the cell of both endpoints and every
/// cell the line crosses between them.
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

impl ContainmentGrid {
    fn empty() -> Self {
        ContainmentGrid {
            cell_flags: Vec::new(),
            inv_cell_w: 0.0,
            inv_cell_h: 0.0,
            min_x: 0.0,
            min_y: 0.0,
        }
    }

    fn build(c: &ParsedContour, vd: &[f32]) -> Self {
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
    fn contains(&self, px: f64, py: f64) -> Option<bool> {
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
const EDGE_GRID_THRESHOLD: usize = 32;

/// Target number of grid cells per axis (actual count clamped to edge count).
const EDGE_GRID_RESOLUTION: usize = 16;

/// Cell containment flag for the rasterized inside/outside grid.
const CELL_OUTSIDE: u8 = 0;
const CELL_INSIDE: u8 = 1;
const CELL_BOUNDARY: u8 = 2;

/// Spatial grid that indexes contour edges into 2D cells for fast
/// nearest-edge queries. Built for large contours only.
pub struct EdgeGrid {
    /// Flattened cell storage: `cell_starts[cell]..cell_starts[cell+1]` gives
    /// the range of edge indices in `edge_indices` belonging to that cell.
    cell_starts: Vec<u32>,
    edge_indices: Vec<u16>,
    cols: usize,
    rows: usize,
    inv_cell_w: f64,
    inv_cell_h: f64,
    min_x: f64,
    min_y: f64,
}

impl EdgeGrid {
    /// Build a spatial grid for the edges of a contour.
    fn build(c: &ParsedContour, vd: &[f32]) -> Self {
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
    fn nearby_edges(&self, px: f64, py: f64, radius: f64) -> NearbyEdges<'_> {
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

struct NearbyEdges<'a> {
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

// ---------------------------------------------------------------------------
// IDW candidate grid — precomputed nearest-edge candidates per cell
// ---------------------------------------------------------------------------

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
    contour_count: usize,
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
    fn build(
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
        let cell_diagonal = (cell_w * cell_w + cell_h * cell_h).sqrt() * 0.5;
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

        // For each cell, find candidates: all edges within min_dist + cell_diagonal
        let mut cell_entries: Vec<Vec<u32>> = vec![Vec::new(); num_cells];

        for row in 0..rows {
            for col in 0..cols {
                let cx = min_x + (col as f64 + 0.5) * cell_w;
                let cy = min_y + (row as f64 + 0.5) * cell_h;

                // Find min distance from cell center to any edge
                let mut min_dist_sq = f64::MAX;
                for e in &edges {
                    let d2 = point_to_segment_dist_sq(cx, cy, e.ax, e.ay, e.bx, e.by);
                    if d2 < min_dist_sq {
                        min_dist_sq = d2;
                    }
                }

                // Threshold: any edge within min_dist + cell_diagonal
                let threshold = min_dist_sq.sqrt() + cell_diagonal;
                let threshold_sq = threshold * threshold;

                let cell = row * cols + col;
                for e in &edges {
                    let d2 = point_to_segment_dist_sq(cx, cy, e.ax, e.ay, e.bx, e.by);
                    if d2 <= threshold_sq {
                        let packed = ((e.contour_tag as u32) << 16) | (e.edge_index as u32);
                        cell_entries[cell].push(packed);
                    }
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
    fn candidates(&self, px: f64, py: f64) -> &[u32] {
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

// ---------------------------------------------------------------------------
// Contour lookup grid — level-wide precomputed containment
// ---------------------------------------------------------------------------

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
    fn lookup(
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
fn build_contour_lookup_grid(
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

    let total_candidates: usize = candidate_indices.len();
    let cells_with_candidates = cell_starts.windows(2).filter(|w| w[1] > w[0]).count();
    eprintln!(
        "    [lookup grid] {}x{} cells, {} total candidates, {} cells with candidates",
        format_int(cols),
        format_int(rows),
        format_int(total_candidates),
        format_int(cells_with_candidates),
    );

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

// ---------------------------------------------------------------------------
// Parsed contour data
// ---------------------------------------------------------------------------

/// A contour parsed from the binary contour data buffer.
pub struct ParsedContour {
    pub point_start: usize,
    pub point_count: usize,
    pub height: f32,
    pub depth: u32,
    pub skip_count: u32,
    pub child_start: usize,
    pub child_count: usize,
    pub bbox_min_x: f32,
    pub bbox_min_y: f32,
    pub bbox_max_x: f32,
    pub bbox_max_y: f32,
    /// Spatial grid for fast nearest-edge queries. `None` for small contours.
    pub edge_grid: Option<EdgeGrid>,
    /// Containment grid for O(1) point-in-contour tests. Built for all contours.
    pub containment_grid: ContainmentGrid,
    /// Precomputed IDW candidate grid. Built for contours with children.
    pub idw_grid: Option<IDWGrid>,
}

/// Extract all contour metadata from the binary contour data buffer and build
/// the level-wide contour lookup grid. All phases are parallelized with rayon.
pub fn parse_contours(terrain: &TerrainCPUData) -> (Vec<ParsedContour>, ContourLookupGrid) {
    use rayon::prelude::*;
    use std::time::Instant;

    let n = terrain.contour_count;
    let cd = &terrain.contour_data;
    let vd = &terrain.vertex_data;

    // Phase 1: Parse contours and build per-contour grids in parallel
    let t_contour_grids = Instant::now();
    let mut contours: Vec<ParsedContour> = (0..n)
        .into_par_iter()
        .map(|i| {
            let base = i * FLOATS_PER_CONTOUR * 4;
            let b = &cd[base..base + FLOATS_PER_CONTOUR * 4];
            let point_start = u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize;
            let point_count = u32::from_le_bytes([b[4], b[5], b[6], b[7]]) as usize;
            let mut c = ParsedContour {
                point_start,
                point_count,
                height: f32::from_le_bytes([b[8], b[9], b[10], b[11]]),
                depth: u32::from_le_bytes([b[16], b[17], b[18], b[19]]),
                skip_count: u32::from_le_bytes([b[48], b[49], b[50], b[51]]),
                child_start: u32::from_le_bytes([b[20], b[21], b[22], b[23]]) as usize,
                child_count: u32::from_le_bytes([b[24], b[25], b[26], b[27]]) as usize,
                bbox_min_x: f32::from_le_bytes([b[32], b[33], b[34], b[35]]),
                bbox_min_y: f32::from_le_bytes([b[36], b[37], b[38], b[39]]),
                bbox_max_x: f32::from_le_bytes([b[40], b[41], b[42], b[43]]),
                bbox_max_y: f32::from_le_bytes([b[44], b[45], b[46], b[47]]),
                edge_grid: None,
                containment_grid: ContainmentGrid::empty(),
                idw_grid: None,
            };
            c.containment_grid = ContainmentGrid::build(&c, vd);
            if point_count >= EDGE_GRID_THRESHOLD {
                c.edge_grid = Some(EdgeGrid::build(&c, vd));
            }
            c
        })
        .collect();
    let total_vertices: usize = contours.iter().map(|c| c.point_count).sum();
    let contour_grids_ms = t_contour_grids.elapsed().as_secs_f64() * 1000.0;

    // Phase 2: Build IDW grids in parallel (reads shared contours, each writes its own grid)
    let t_idw = Instant::now();
    let children_data = &terrain.children_data;
    let idw_grids: Vec<Option<IDWGrid>> = (0..n)
        .into_par_iter()
        .map(|i| {
            if contours[i].child_count > 0 {
                Some(IDWGrid::build(
                    &contours[i],
                    i,
                    &contours,
                    children_data,
                    vd,
                ))
            } else {
                None
            }
        })
        .collect();
    let mut idw_count = 0usize;
    for (i, grid) in idw_grids.into_iter().enumerate() {
        if let Some(g) = grid {
            contours[i].idw_grid = Some(g);
            idw_count += 1;
        }
    }
    let idw_ms = t_idw.elapsed().as_secs_f64() * 1000.0;

    // Phase 3: Build level-wide lookup grid (contour classification parallelized)
    let t_lookup = Instant::now();
    let lookup_grid = build_contour_lookup_grid(&contours, vd, terrain.default_depth);
    let lookup_ms = t_lookup.elapsed().as_secs_f64() * 1000.0;

    eprintln!(
        "    [terrain] {} contours, {} vertices",
        format_int(n),
        format_int(total_vertices)
    );
    eprintln!(
        "      contour grids: {}ms",
        format_int(contour_grids_ms.round() as u64)
    );
    eprintln!(
        "      IDW grids ({}): {}ms",
        format_int(idw_count),
        format_int(idw_ms.round() as u64)
    );
    eprintln!(
        "      lookup grid: {}ms",
        format_int(lookup_ms.round() as u64)
    );

    (contours, lookup_grid)
}

/// Raw winding number test — checks if a point is inside a polygon defined
/// by `point_count` vertices starting at `start` in `vertex_data`.
/// On aarch64, processes 4 edges at a time using NEON f32x4 intrinsics.
#[cfg(target_arch = "aarch64")]
fn winding_number_test(
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
fn winding_number_test(
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
fn is_inside_contour(px: f64, py: f64, contour: &ParsedContour, vertex_data: &[f32]) -> bool {
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

    // Find the deepest contour containing the point using DFS with skipping
    let mut deepest_height = terrain.default_depth;
    let mut deepest_idx: Option<usize> = None;
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
            deepest_height = c.height as f64;
            deepest_idx = Some(i);
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

/// Minimum distance to contour boundary plus the gradient (unit direction from
/// nearest edge point to query point). Returns `(distance, grad_x, grad_y)`.
/// Mirrors TS `computeDistanceToBoundaryWithGradientFast`.
fn min_dist_to_contour_with_gradient(
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
fn point_to_segment_dx_dy(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> (f64, f64, f64) {
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

fn min_dist_to_contour(px: f64, py: f64, c: &ParsedContour, vd: &[f32]) -> f64 {
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
            dw_dx = 0.0;
            dw_dy = 0.0;
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
            dw_dx = 0.0;
            dw_dy = 0.0;
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
