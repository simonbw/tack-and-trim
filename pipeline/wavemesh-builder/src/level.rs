//! JSON level file parsing, Catmull-Rom spline sampling, contour tree building,
//! and terrain CPU data construction. Mirrors LevelFileFormat.ts + LandMass.ts.

use serde::Deserialize;

// ── JSON types ───────────────────────────────────────────────────────────────

/// Top-level JSON structure for a `.level.json` file.
#[derive(Deserialize, Debug)]
pub struct LevelFileJSON {
    #[allow(dead_code)]
    pub version: u32,
    #[serde(rename = "defaultDepth")]
    pub default_depth: Option<f64>,
    pub waves: Option<WaveConfigJSON>,
    pub contours: Vec<TerrainContourJSON>,
}

/// Optional wave configuration section in a level file.
#[derive(Deserialize, Debug)]
pub struct WaveConfigJSON {
    pub sources: Vec<WaveSourceJSON>,
}

/// JSON representation of a single wave source.
#[derive(Deserialize, Debug, Clone)]
pub struct WaveSourceJSON {
    pub amplitude: f64,
    pub wavelength: f64,
    pub direction: f64,
    #[serde(rename = "phaseOffset", default)]
    pub phase_offset: f64,
    #[serde(rename = "speedMult", default = "default_speed_mult")]
    pub speed_mult: f64,
    #[serde(rename = "sourceDist", default = "default_source_dist")]
    pub source_dist: f64,
    #[serde(rename = "sourceOffsetX", default)]
    pub source_offset_x: f64,
    #[serde(rename = "sourceOffsetY", default)]
    pub source_offset_y: f64,
}
fn default_speed_mult() -> f64 { 1.0 }
fn default_source_dist() -> f64 { 1e10 }

/// JSON representation of a terrain contour (island, shoal, etc.).
#[derive(Deserialize, Debug)]
pub struct TerrainContourJSON {
    pub height: f64,
    #[serde(rename = "controlPoints")]
    pub control_points: Option<Vec<[f64; 2]>>,
    pub polygon: Option<Vec<[f64; 2]>>,
}

// ── WaveSource ───────────────────────────────────────────────────────────────

/// Resolved wave source parameters used during mesh building.
#[derive(Clone, Debug)]
pub struct WaveSource {
    pub amplitude: f64,
    pub wavelength: f64,
    pub direction: f64,
    pub source_dist: f64,
    pub source_offset_x: f64,
    pub source_offset_y: f64,
}

impl From<&WaveSourceJSON> for WaveSource {
    fn from(j: &WaveSourceJSON) -> Self {
        WaveSource {
            amplitude: j.amplitude,
            wavelength: j.wavelength,
            direction: j.direction,
            source_dist: j.source_dist,
            source_offset_x: j.source_offset_x,
            source_offset_y: j.source_offset_y,
        }
    }
}

/// Default wave sources used when the level file has no "waves" section.
/// Matches DEFAULT_WAVE_SOURCES in WaveSource.ts.
pub fn default_wave_sources() -> Vec<WaveSource> {
    vec![
        WaveSource {
            amplitude: 0.4,
            wavelength: 200.0,
            direction: 0.8,
            source_dist: 1e10,
            source_offset_x: 0.0,
            source_offset_y: 0.0,
        },
        WaveSource {
            amplitude: 0.15,
            wavelength: 20.0,
            direction: 0.8,
            source_dist: 1e10,
            source_offset_x: 0.0,
            source_offset_y: 0.0,
        },
    ]
}

// ── TerrainCPUData ───────────────────────────────────────────────────────────

const DEFAULT_DEPTH: f64 = -300.0;
const SAMPLES_PER_SEGMENT: usize = 16;
/// Number of 32-bit values per contour in the binary contour data buffer.
pub const FLOATS_PER_CONTOUR: usize = 13;

/// CPU-side terrain data matching the GPU packed buffer layout.
#[derive(Clone)]
pub struct TerrainCPUData {
    pub vertex_data: Vec<f32>,
    pub contour_data: Vec<u8>,
    pub children_data: Vec<u32>,
    pub contour_count: usize,
    pub default_depth: f64,
}

// ── Catmull-Rom spline ───────────────────────────────────────────────────────

fn catmull_rom_point(p0: [f64; 2], p1: [f64; 2], p2: [f64; 2], p3: [f64; 2], t: f64) -> [f64; 2] {
    let t2 = t * t;
    let t3 = t2 * t;
    let x = 0.5 * (2.0 * p1[0]
        + (-p0[0] + p2[0]) * t
        + (2.0 * p0[0] - 5.0 * p1[0] + 4.0 * p2[0] - p3[0]) * t2
        + (-p0[0] + 3.0 * p1[0] - 3.0 * p2[0] + p3[0]) * t3);
    let y = 0.5 * (2.0 * p1[1]
        + (-p0[1] + p2[1]) * t
        + (2.0 * p0[1] - 5.0 * p1[1] + 4.0 * p2[1] - p3[1]) * t2
        + (-p0[1] + 3.0 * p1[1] - 3.0 * p2[1] + p3[1]) * t3);
    [x, y]
}

fn sample_closed_spline(control_points: &[[f64; 2]], samples_per_segment: usize) -> Vec<[f64; 2]> {
    let n = control_points.len();
    if n < 3 { return control_points.to_vec(); }
    let mut result = Vec::with_capacity(n * samples_per_segment);
    for i in 0..n {
        let p0 = control_points[(i + n - 1) % n];
        let p1 = control_points[i];
        let p2 = control_points[(i + 1) % n];
        let p3 = control_points[(i + 2) % n];
        for s in 0..samples_per_segment {
            let t = s as f64 / samples_per_segment as f64;
            result.push(catmull_rom_point(p0, p1, p2, p3, t));
        }
    }
    result
}

fn adaptive_samples_per_segment(control_points: &[[f64; 2]]) -> usize {
    let n = control_points.len();
    if n < 3 { return 1; }
    let mut total_length = 0.0;
    for i in 0..n {
        let a = control_points[i];
        let b = control_points[(i + 1) % n];
        let dx = b[0] - a[0];
        let dy = b[1] - a[1];
        total_length += (dx * dx + dy * dy).sqrt();
    }
    let avg = total_length / n as f64;
    (avg / SAMPLES_PER_SEGMENT as f64).round().max(1.0).min(SAMPLES_PER_SEGMENT as f64) as usize
}

// ── Winding normalisation ────────────────────────────────────────────────────

fn signed_area(points: &[[f64; 2]]) -> f64 {
    let n = points.len();
    if n < 3 { return 0.0; }
    let mut area = 0.0;
    for i in 0..n {
        let j = (i + 1) % n;
        area += points[i][0] * points[j][1];
        area -= points[j][0] * points[i][1];
    }
    area / 2.0
}

fn ensure_ccw(points: &mut [[f64; 2]]) {
    if signed_area(points) > 0.0 {
        points.reverse();
    }
}

// ── Point-in-polygon ─────────────────────────────────────────────────────────

fn point_in_polygon(px: f64, py: f64, polygon: &[[f64; 2]]) -> bool {
    let n = polygon.len();
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let yi = polygon[i][1];
        let yj = polygon[j][1];
        if (yi > py) != (yj > py)
            && px < (polygon[j][0] - polygon[i][0]) * (py - yi) / (yj - yi) + polygon[i][0]
        {
            inside = !inside;
        }
        j = i;
    }
    inside
}

// ── Contour tree ─────────────────────────────────────────────────────────────

struct BBox { min_x: f64, min_y: f64, max_x: f64, max_y: f64 }

fn compute_bbox(points: &[[f64; 2]]) -> BBox {
    let mut b = BBox {
        min_x: f64::INFINITY, min_y: f64::INFINITY,
        max_x: f64::NEG_INFINITY, max_y: f64::NEG_INFINITY,
    };
    for p in points {
        if p[0] < b.min_x { b.min_x = p[0]; }
        if p[0] > b.max_x { b.max_x = p[0]; }
        if p[1] < b.min_y { b.min_y = p[1]; }
        if p[1] > b.max_y { b.max_y = p[1]; }
    }
    b
}

fn bbox_contains(outer: &BBox, inner: &BBox) -> bool {
    inner.min_x >= outer.min_x && inner.max_x <= outer.max_x
        && inner.min_y >= outer.min_y && inner.max_y <= outer.max_y
}

fn is_contour_inside(
    inner_poly: &[[f64; 2]], inner_bbox: &BBox,
    outer_poly: &[[f64; 2]], outer_bbox: &BBox,
) -> bool {
    if !bbox_contains(outer_bbox, inner_bbox) { return false; }
    if inner_poly.is_empty() { return false; }
    point_in_polygon(inner_poly[0][0], inner_poly[0][1], outer_poly)
}

struct ContourTreeNode {
    parent_index: i32,
    depth: u32,
    children: Vec<usize>,
}

struct ContourTree {
    nodes: Vec<ContourTreeNode>,
    children_flat: Vec<u32>,
}

fn build_contour_tree(
    sampled: &[Vec<[f64; 2]>],
    bboxes: &[BBox],
) -> ContourTree {
    let n = sampled.len();
    if n == 0 {
        return ContourTree { nodes: vec![], children_flat: vec![] };
    }

    // Working tree: virtual root's children list
    let mut parent_of: Vec<Option<usize>> = vec![None; n]; // None = child of virtual root
    let mut children_of: Vec<Vec<usize>> = vec![vec![]; n + 1]; // index n = virtual root

    // Insert each contour incrementally
    for ci in 0..n {
        insert_contour(ci, n, sampled, bboxes, &mut parent_of, &mut children_of);
    }

    // Build final tree nodes
    let mut nodes: Vec<ContourTreeNode> = (0..n).map(|_| ContourTreeNode {
        parent_index: -1,
        depth: 0,
        children: vec![],
    }).collect();

    for i in 0..n {
        if let Some(p) = parent_of[i] {
            nodes[i].parent_index = p as i32;
        }
        nodes[i].children = children_of[i].clone();
    }

    // Compute depths
    let roots: Vec<usize> = children_of[n].clone();
    let mut stack: Vec<(usize, u32)> = roots.iter().map(|&r| (r, 0u32)).collect();
    while let Some((idx, depth)) = stack.pop() {
        nodes[idx].depth = depth;
        for &child in &nodes[idx].children {
            stack.push((child, depth + 1));
        }
    }

    // Build flat children
    let mut children_flat = Vec::new();
    for node in &nodes {
        for &child in &node.children {
            children_flat.push(child as u32);
        }
    }

    ContourTree { nodes, children_flat }
}

fn insert_contour(
    ci: usize,
    virtual_root: usize,
    sampled: &[Vec<[f64; 2]>],
    bboxes: &[BBox],
    parent_of: &mut [Option<usize>],
    children_of: &mut [Vec<usize>],
) {
    let parent = find_deepest_container(ci, virtual_root, sampled, bboxes, children_of);

    // Check if ci contains any existing children of parent → reparent them
    let existing_children: Vec<usize> = children_of[parent].clone();
    let mut children_to_reparent = vec![];
    for &existing in &existing_children {
        if is_contour_inside(&sampled[existing], &bboxes[existing], &sampled[ci], &bboxes[ci]) {
            children_to_reparent.push(existing);
        }
    }

    for &child in &children_to_reparent {
        children_of[parent].retain(|&c| c != child);
        children_of[ci].push(child);
        parent_of[child] = Some(ci);
    }

    children_of[parent].push(ci);
    parent_of[ci] = if parent == virtual_root { None } else { Some(parent) };
}

fn find_deepest_container(
    ci: usize,
    current: usize,
    sampled: &[Vec<[f64; 2]>],
    bboxes: &[BBox],
    children_of: &[Vec<usize>],
) -> usize {
    for &child in &children_of[current] {
        if is_contour_inside(&sampled[ci], &bboxes[ci], &sampled[child], &bboxes[child]) {
            return find_deepest_container(ci, child, sampled, bboxes, children_of);
        }
    }
    current
}

// ── Build terrain data ───────────────────────────────────────────────────────

/// Parse a level JSON string into a `LevelFileJSON`.
pub fn parse_level_file(json_str: &str) -> anyhow::Result<LevelFileJSON> {
    Ok(serde_json::from_str(json_str)?)
}

/// Build the binary terrain CPU data from a parsed level file, including contour
/// tree construction, DFS ordering, and flat vertex/children buffers.
pub fn build_terrain_data(level: &LevelFileJSON) -> TerrainCPUData {
    let def_depth = level.default_depth.unwrap_or(DEFAULT_DEPTH);
    let contours = &level.contours;
    let n = contours.len();

    // Sample contour polygons and normalise winding
    let mut sampled: Vec<Vec<[f64; 2]>> = Vec::with_capacity(n);
    let mut control_pts: Vec<Vec<[f64; 2]>> = Vec::with_capacity(n);
    for c in contours {
        let pts: Vec<[f64; 2]> = if let Some(ref poly) = c.polygon {
            poly.clone()
        } else if let Some(ref cp) = c.control_points {
            cp.clone()
        } else {
            vec![]
        };
        control_pts.push(pts);
    }

    for (i, c) in contours.iter().enumerate() {
        let pts = &control_pts[i];
        let mut poly = if c.polygon.is_some() {
            pts.clone()
        } else {
            let sps = adaptive_samples_per_segment(pts);
            sample_closed_spline(pts, sps)
        };
        // normalise winding to CCW (based on control points)
        let mut cp = pts.clone();
        if signed_area(&cp) > 0.0 {
            cp.reverse();
            poly.reverse();
        }
        let _ = cp; // control points used for winding check only
        ensure_ccw(&mut poly);
        sampled.push(poly);
    }

    // Build bounding boxes
    let bboxes: Vec<BBox> = sampled.iter().map(|p| compute_bbox(p)).collect();

    // Build containment tree
    let tree = build_contour_tree(&sampled, &bboxes);

    // DFS ordering
    let mut dfs_order: Vec<usize> = Vec::with_capacity(n);
    let mut skip_counts = vec![0usize; n];
    let roots: Vec<usize> = (0..n).filter(|&i| tree.nodes[i].parent_index < 0).collect();

    fn dfs_visit(idx: usize, tree: &ContourTree, dfs_order: &mut Vec<usize>, skip_counts: &mut Vec<usize>) -> usize {
        let dfs_idx = dfs_order.len();
        dfs_order.push(idx);
        let mut sub = 0usize;
        for &child in &tree.nodes[idx].children {
            sub += 1 + dfs_visit(child, tree, dfs_order, skip_counts);
        }
        skip_counts[dfs_idx] = sub;
        sub
    }

    for &root in &roots {
        dfs_visit(root, &tree, &mut dfs_order, &mut skip_counts);
    }

    // Build original→dfs mapping
    let mut original_to_dfs = vec![0usize; n];
    for (dfs_idx, &orig) in dfs_order.iter().enumerate() {
        original_to_dfs[orig] = dfs_idx;
    }

    // Count vertices
    let total_verts: usize = sampled.iter().map(|p| p.len()).sum();
    let mut vertex_data = Vec::with_capacity(total_verts * 2);
    let mut contour_data = vec![0u8; n * FLOATS_PER_CONTOUR * 4];

    // Build flat children in DFS order
    let mut child_starts = Vec::with_capacity(n);
    let mut children_flat: Vec<u32> = Vec::new();
    for &orig in dfs_order.iter().take(n) {
        child_starts.push(children_flat.len());
        for &child_orig in &tree.nodes[orig].children {
            children_flat.push(original_to_dfs[child_orig] as u32);
        }
    }

    let mut vertex_index: usize = 0;

    for (dfs_idx, &orig) in dfs_order.iter().enumerate().take(n) {
        let vertices = &sampled[orig];
        let height = contours[orig].height;
        let depth = tree.nodes[orig].depth;
        let parent_dfs: i32 = if tree.nodes[orig].parent_index < 0 {
            -1
        } else {
            original_to_dfs[tree.nodes[orig].parent_index as usize] as i32
        };
        let child_count = tree.nodes[orig].children.len();
        let child_start = child_starts[dfs_idx];

        let byte_base = dfs_idx * FLOATS_PER_CONTOUR * 4;
        let cd = &mut contour_data[byte_base..byte_base + FLOATS_PER_CONTOUR * 4];

        // pointStartIndex (u32)
        cd[0..4].copy_from_slice(&(vertex_index as u32).to_le_bytes());
        // pointCount (u32)
        cd[4..8].copy_from_slice(&(vertices.len() as u32).to_le_bytes());
        // height (f32)
        cd[8..12].copy_from_slice(&(height as f32).to_le_bytes());
        // parentIndex (i32)
        cd[12..16].copy_from_slice(&parent_dfs.to_le_bytes());
        // depth (u32)
        cd[16..20].copy_from_slice(&depth.to_le_bytes());
        // childStartIndex (u32)
        cd[20..24].copy_from_slice(&(child_start as u32).to_le_bytes());
        // childCount (u32)
        cd[24..28].copy_from_slice(&(child_count as u32).to_le_bytes());
        // isCoastline (u32)
        let is_coast: u32 = if height == 0.0 { 1 } else { 0 };
        cd[28..32].copy_from_slice(&is_coast.to_le_bytes());

        // bbox
        let bb = &bboxes[orig];
        cd[32..36].copy_from_slice(&(bb.min_x as f32).to_le_bytes());
        cd[36..40].copy_from_slice(&(bb.min_y as f32).to_le_bytes());
        cd[40..44].copy_from_slice(&(bb.max_x as f32).to_le_bytes());
        cd[44..48].copy_from_slice(&(bb.max_y as f32).to_le_bytes());

        // skipCount (u32)
        cd[48..52].copy_from_slice(&(skip_counts[dfs_idx] as u32).to_le_bytes());

        // vertex data
        for pt in vertices {
            vertex_data.push(pt[0] as f32);
            vertex_data.push(pt[1] as f32);
            vertex_index += 1;
        }
    }

    TerrainCPUData {
        vertex_data,
        contour_data,
        children_data: children_flat,
        contour_count: n,
        default_depth: def_depth,
    }
}
