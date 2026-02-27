/// CPU terrain height queries — contour tree DFS, winding number, IDW.
/// Mirrors terrainHeightCPU.ts.

use crate::level::{TerrainCPUData, FLOATS_PER_CONTOUR};

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
}

pub fn parse_contours(terrain: &TerrainCPUData) -> Vec<ParsedContour> {
    let n = terrain.contour_count;
    let cd = &terrain.contour_data;
    let mut contours = Vec::with_capacity(n);
    for i in 0..n {
        let base = i * FLOATS_PER_CONTOUR * 4;
        let b = &cd[base..base + FLOATS_PER_CONTOUR * 4];
        contours.push(ParsedContour {
            point_start: u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize,
            point_count: u32::from_le_bytes([b[4], b[5], b[6], b[7]]) as usize,
            height: f32::from_le_bytes([b[8], b[9], b[10], b[11]]),
            depth: u32::from_le_bytes([b[16], b[17], b[18], b[19]]),
            skip_count: u32::from_le_bytes([b[48], b[49], b[50], b[51]]),
            child_start: u32::from_le_bytes([b[20], b[21], b[22], b[23]]) as usize,
            child_count: u32::from_le_bytes([b[24], b[25], b[26], b[27]]) as usize,
            bbox_min_x: f32::from_le_bytes([b[32], b[33], b[34], b[35]]),
            bbox_min_y: f32::from_le_bytes([b[36], b[37], b[38], b[39]]),
            bbox_max_x: f32::from_le_bytes([b[40], b[41], b[42], b[43]]),
            bbox_max_y: f32::from_le_bytes([b[44], b[45], b[46], b[47]]),
        });
    }
    contours
}

/// Winding number test for point-in-contour.
fn is_inside_contour(
    px: f64, py: f64,
    contour: &ParsedContour,
    vertex_data: &[f32],
) -> bool {
    let n = contour.point_count;
    if n < 3 { return false; }
    let start = contour.point_start * 2;
    let mut winding: i32 = 0;
    for i in 0..n {
        let j = (i + 1) % n;
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

/// Compute terrain height and gradient at (px, py).
pub struct TerrainHeightGradient {
    pub height: f64,
    pub gradient_x: f64,
    pub gradient_y: f64,
}

pub fn compute_terrain_height_and_gradient(
    px: f64, py: f64,
    terrain: &TerrainCPUData,
    contours: &[ParsedContour],
) -> TerrainHeightGradient {
    let eps = 2.0;
    let h0 = compute_terrain_height(px, py, terrain, contours);
    let hx = compute_terrain_height(px + eps, py, terrain, contours);
    let hy = compute_terrain_height(px, py + eps, terrain, contours);
    TerrainHeightGradient {
        height: h0,
        gradient_x: (hx - h0) / eps,
        gradient_y: (hy - h0) / eps,
    }
}
