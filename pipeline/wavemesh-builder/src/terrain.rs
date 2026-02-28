//! CPU terrain height queries — contour tree DFS, winding number, IDW.
//! Mirrors terrainHeightCPU.ts.

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

const CONTAINMENT_GRID_SIZE: usize = 16;

impl ContainmentGrid {
    fn empty() -> Self {
        ContainmentGrid { cell_flags: Vec::new(), inv_cell_w: 0.0, inv_cell_h: 0.0, min_x: 0.0, min_y: 0.0 }
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

        // Mark cells that contain edges as BOUNDARY
        let mut cell_flags = vec![CELL_OUTSIDE; num_cells];
        for i in 0..n {
            let j = (i + 1) % n;
            let ax = vd[start + i * 2] as f64;
            let ay = vd[start + i * 2 + 1] as f64;
            let bx = vd[start + j * 2] as f64;
            let by = vd[start + j * 2 + 1] as f64;

            let c0 = ((ax.min(bx) - min_x) * inv_cell_w).floor().max(0.0) as usize;
            let c1 = ((ax.max(bx) - min_x) * inv_cell_w).floor().min((cols - 1) as f64) as usize;
            let r0 = ((ay.min(by) - min_y) * inv_cell_h).floor().max(0.0) as usize;
            let r1 = ((ay.max(by) - min_y) * inv_cell_h).floor().min((rows - 1) as f64) as usize;

            for r in r0..=r1 {
                for cc in c0..=c1 {
                    cell_flags[r * cols + cc] = CELL_BOUNDARY;
                }
            }
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

        ContainmentGrid { cell_flags, inv_cell_w, inv_cell_h, min_x, min_y }
    }

    /// Returns `Some(true)` if definitely inside, `Some(false)` if definitely
    /// outside, `None` if on a boundary cell (caller must do full winding test).
    #[inline]
    fn contains(&self, px: f64, py: f64) -> Option<bool> {
        let ci = ((px - self.min_x) * self.inv_cell_w).floor() as isize;
        let ri = ((py - self.min_y) * self.inv_cell_h).floor() as isize;
        if ci < 0 || ri < 0 || ci >= CONTAINMENT_GRID_SIZE as isize || ri >= CONTAINMENT_GRID_SIZE as isize {
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

        EdgeGrid { cell_starts, edge_indices, cols, rows, inv_cell_w, inv_cell_h, min_x, min_y }
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
                grid: self, c0: 0, c1: 0, r1: 0,
                cur_r: 1, cur_c: 0, // cur_r > r1 → immediately exhausted
                pos: 0, end: 0,
            };
        }

        let c0 = c0i.max(0) as usize;
        let c1 = c1i.min(max_c) as usize;
        let r0 = r0i.max(0) as usize;
        let r1 = r1i.min(max_r) as usize;

        let cell = r0 * self.cols + c0;
        NearbyEdges {
            grid: self,
            c0, c1, r1,
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
}

/// Extract all contour metadata from the binary contour data buffer.
pub fn parse_contours(terrain: &TerrainCPUData) -> Vec<ParsedContour> {
    let n = terrain.contour_count;
    let cd = &terrain.contour_data;
    let vd = &terrain.vertex_data;
    let mut contours = Vec::with_capacity(n);
    for i in 0..n {
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
        };
        c.containment_grid = ContainmentGrid::build(&c, vd);
        if point_count >= EDGE_GRID_THRESHOLD {
            c.edge_grid = Some(EdgeGrid::build(&c, vd));
        }
        contours.push(c);
    }
    contours
}

/// Raw winding number test — checks if a point is inside a polygon defined
/// by `point_count` vertices starting at `start` in `vertex_data`.
fn winding_number_test(px: f64, py: f64, point_count: usize, start: usize, vertex_data: &[f32]) -> bool {
    if point_count < 3 { return false; }
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
                if cross > 0.0 { winding += 1; }
            }
        } else if yj <= py {
            let cross = (xj - xi) * (py - yi) - (px - xi) * (yj - yi);
            if cross < 0.0 { winding -= 1; }
        }
    }
    winding != 0
}

/// Point-in-contour test. Uses the containment grid for O(1) lookups,
/// falling back to full winding number test only for boundary cells.
fn is_inside_contour(
    px: f64, py: f64,
    contour: &ParsedContour,
    vertex_data: &[f32],
) -> bool {
    if let Some(inside) = contour.containment_grid.contains(px, py) {
        return inside;
    }
    // Boundary cell — full winding test
    winding_number_test(px, py, contour.point_count, contour.point_start * 2, vertex_data)
}

/// Compute terrain height at (px, py) using contour tree DFS with skip counts.
pub fn compute_terrain_height(
    px: f64, py: f64,
    terrain: &TerrainCPUData,
    contours: &[ParsedContour],
) -> f64 {
    let n = contours.len();
    if n == 0 { return terrain.default_depth; }

    let vd = &terrain.vertex_data;
    let cd = &terrain.children_data;

    // Find the deepest contour containing the point using DFS with skipping
    let mut deepest_height = terrain.default_depth;
    let mut deepest_idx: Option<usize> = None;
    let mut i = 0;

    while i < n {
        let c = &contours[i];
        // Bbox reject
        if (px as f32) < c.bbox_min_x || (px as f32) > c.bbox_max_x
            || (py as f32) < c.bbox_min_y || (py as f32) > c.bbox_max_y
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
    let Some(deepest) = deepest_idx else { return deepest_height; };
    let dc = &contours[deepest];
    if dc.child_count == 0 { return deepest_height; }

    let mut weight_sum = 0.0;
    let mut height_sum = 0.0;
    let base_height = deepest_height;

    for ci in 0..dc.child_count {
        let child_dfs = cd[dc.child_start + ci] as usize;
        if child_dfs >= n { continue; }
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
        if base_dist < 1e-6 { return base_height; }
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
fn min_dist_to_contour_with_gradient(px: f64, py: f64, c: &ParsedContour, vd: &[f32]) -> (f64, f64, f64) {
    let n = c.point_count;
    if n == 0 { return (f64::INFINITY, 0.0, 0.0); }

    if let Some(grid) = &c.edge_grid {
        return min_dist_with_gradient_grid(px, py, c, vd, grid);
    }

    min_dist_with_gradient_linear(px, py, c, vd)
}

/// Grid-accelerated nearest-edge search with gradient.
fn min_dist_with_gradient_grid(
    px: f64, py: f64, c: &ParsedContour, vd: &[f32], grid: &EdgeGrid,
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
fn min_dist_with_gradient_linear(px: f64, py: f64, c: &ParsedContour, vd: &[f32]) -> (f64, f64, f64) {
    let n = c.point_count;
    let start = c.point_start * 2;
    let mut best_dist_sq = 1e20_f64;
    let mut best_dx = 0.0;
    let mut best_dy = 0.0;

    // Sliding window: start with last vertex
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
/// point on segment AB to point P.
#[inline]
fn point_to_segment_dx_dy(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> (f64, f64, f64) {
    let abx = bx - ax;
    let aby = by - ay;
    let len_sq = abx * abx + aby * aby;

    if len_sq < 1e-12 {
        let dx = px - ax;
        let dy = py - ay;
        (dx, dy, dx * dx + dy * dy)
    } else {
        let t = (((px - ax) * abx + (py - ay) * aby) / len_sq).clamp(0.0, 1.0);
        let nx = ax + t * abx;
        let ny = ay + t * aby;
        let dx = px - nx;
        let dy = py - ny;
        (dx, dy, dx * dx + dy * dy)
    }
}

fn min_dist_to_contour(px: f64, py: f64, c: &ParsedContour, vd: &[f32]) -> f64 {
    let n = c.point_count;
    if n == 0 { return f64::INFINITY; }
    let start = c.point_start * 2;
    let mut best = f64::INFINITY;
    for i in 0..n {
        let j = (i + 1) % n;
        let ax = vd[start + i * 2] as f64;
        let ay = vd[start + i * 2 + 1] as f64;
        let bx = vd[start + j * 2] as f64;
        let by = vd[start + j * 2 + 1] as f64;
        let d = point_to_segment_dist(px, py, ax, ay, bx, by);
        if d < best { best = d; }
    }
    best
}

fn point_to_segment_dist(px: f64, py: f64, ax: f64, ay: f64, bx: f64, by: f64) -> f64 {
    let dx = bx - ax;
    let dy = by - ay;
    let len_sq = dx * dx + dy * dy;
    if len_sq < 1e-12 {
        let ex = px - ax;
        let ey = py - ay;
        return (ex * ex + ey * ey).sqrt();
    }
    let t = ((px - ax) * dx + (py - ay) * dy) / len_sq;
    let t = t.clamp(0.0, 1.0);
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
    px: f64, py: f64,
    terrain: &TerrainCPUData,
    contours: &[ParsedContour],
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

    // Phase 1: Find deepest containing contour using DFS skip traversal
    let mut deepest_height = terrain.default_depth;
    let mut deepest_idx: Option<usize> = None;
    let mut i = 0;
    let mut last_to_check = n;

    while i < last_to_check {
        let c = &contours[i];
        if (px as f32) < c.bbox_min_x || (px as f32) > c.bbox_max_x
            || (py as f32) < c.bbox_min_y || (py as f32) > c.bbox_max_y
        {
            i += 1 + c.skip_count as usize;
            continue;
        }
        if is_inside_contour(px, py, c, vd) {
            deepest_height = c.height as f64;
            deepest_idx = Some(i);
            last_to_check = i + 1 + c.skip_count as usize;
            i += 1;
        } else {
            i += 1 + c.skip_count as usize;
        }
    }

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

    // Phase 4: Analytical IDW interpolation with gradient
    // Accumulate 6 sums for the quotient rule:
    //   weight_sum        = Σ w_i
    //   weighted_h_sum    = Σ (h_i · w_i)
    //   grad_w_sum_x/y    = Σ (dw_i/dx), Σ (dw_i/dy)
    //   grad_wh_sum_x/y   = Σ (h_i · dw_i/dx), Σ (h_i · dw_i/dy)
    let mut weight_sum = 0.0;
    let mut weighted_h_sum = 0.0;
    let mut grad_w_sum_x = 0.0;
    let mut grad_w_sum_y = 0.0;
    let mut grad_wh_sum_x = 0.0;
    let mut grad_wh_sum_y = 0.0;

    // Inline closure to accumulate one IDW term
    let mut accumulate = |height: f64, contour: &ParsedContour| {
        let (dist, ddist_dx, ddist_dy) =
            min_dist_to_contour_with_gradient(px, py, contour, vd);

        let (w, dw_dx, dw_dy);
        if dist <= IDW_MIN_DIST {
            w = 1.0 / IDW_MIN_DIST;
            dw_dx = 0.0;
            dw_dy = 0.0;
        } else {
            let inv_dist = 1.0 / dist;
            w = inv_dist;
            // d/dx (1/dist) = -1/dist² · ddist/dx
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

    // Parent contour
    accumulate(deepest_height, dc);

    // Children
    for ci in 0..dc.child_count {
        let child_dfs = cd[dc.child_start + ci] as usize;
        if child_dfs >= n { continue; }
        let child = &contours[child_dfs];
        accumulate(child.height as f64, child);
    }

    // Quotient rule: d/dx (Σ(w·h) / Σw) = (Σ(h·dw/dx)·Σw - Σ(w·h)·Σ(dw/dx)) / (Σw)²
    let inv_w = 1.0 / weight_sum;
    let inv_w_sq = inv_w * inv_w;

    TerrainHeightGradient {
        height: weighted_h_sum * inv_w,
        gradient_x: (grad_wh_sum_x * weight_sum - weighted_h_sum * grad_w_sum_x) * inv_w_sq,
        gradient_y: (grad_wh_sum_y * weight_sum - weighted_h_sum * grad_w_sum_y) * inv_w_sq,
    }
}
