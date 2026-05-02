//! Top-level orchestration for terrain CPU data construction:
//! Catmull-Rom spline sampling, winding normalisation, contour tree building,
//! and the public `build_terrain_data*` entry points. Mirrors LandMass.ts.
//!
//! Per-grid construction lives in `grid_builders.rs`.

use crate::polygon_math::{point_in_polygon_arr2, signed_area_arr2};

use super::format::{
    LevelFileJSON, PolygonContour, TerrainCPUData, DEFAULT_DEPTH, FLOATS_PER_CONTOUR,
};
use super::grid_builders::{
    build_containment_grid_packed, build_idw_grid_packed, build_lookup_grid_packed_gpu,
    CONTAINMENT_GRID_U32S_PER_CONTOUR, IDW_GRID_CELLS, MAX_IDW_CONTOURS,
};

const SAMPLES_PER_SEGMENT: usize = 16;

// ── Catmull-Rom spline ───────────────────────────────────────────────────────

fn catmull_rom_point(p0: [f64; 2], p1: [f64; 2], p2: [f64; 2], p3: [f64; 2], t: f64) -> [f64; 2] {
    let t2 = t * t;
    let t3 = t2 * t;
    let x = 0.5
        * (2.0 * p1[0]
            + (-p0[0] + p2[0]) * t
            + (2.0 * p0[0] - 5.0 * p1[0] + 4.0 * p2[0] - p3[0]) * t2
            + (-p0[0] + 3.0 * p1[0] - 3.0 * p2[0] + p3[0]) * t3);
    let y = 0.5
        * (2.0 * p1[1]
            + (-p0[1] + p2[1]) * t
            + (2.0 * p0[1] - 5.0 * p1[1] + 4.0 * p2[1] - p3[1]) * t2
            + (-p0[1] + 3.0 * p1[1] - 3.0 * p2[1] + p3[1]) * t3);
    [x, y]
}

fn sample_closed_spline(control_points: &[[f64; 2]], samples_per_segment: usize) -> Vec<[f64; 2]> {
    let n = control_points.len();
    if n < 3 {
        return control_points.to_vec();
    }
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
    if n < 3 {
        return 1;
    }
    let mut total_length = 0.0;
    for i in 0..n {
        let a = control_points[i];
        let b = control_points[(i + 1) % n];
        let dx = b[0] - a[0];
        let dy = b[1] - a[1];
        total_length += (dx * dx + dy * dy).sqrt();
    }
    let avg = total_length / n as f64;
    (avg / SAMPLES_PER_SEGMENT as f64)
        .round()
        .max(1.0)
        .min(SAMPLES_PER_SEGMENT as f64) as usize
}

// ── Winding normalisation ────────────────────────────────────────────────────

fn ensure_ccw(points: &mut [[f64; 2]]) {
    if signed_area_arr2(points) > 0.0 {
        points.reverse();
    }
}

// ── Contour tree ─────────────────────────────────────────────────────────────

/// Axis-aligned bounding box. Shared with `grid_builders` which builds grids
/// over these bboxes.
pub(super) struct BBox {
    pub(super) min_x: f64,
    pub(super) min_y: f64,
    pub(super) max_x: f64,
    pub(super) max_y: f64,
}

fn compute_bbox(points: &[[f64; 2]]) -> BBox {
    let mut b = BBox {
        min_x: f64::INFINITY,
        min_y: f64::INFINITY,
        max_x: f64::NEG_INFINITY,
        max_y: f64::NEG_INFINITY,
    };
    for p in points {
        if p[0] < b.min_x {
            b.min_x = p[0];
        }
        if p[0] > b.max_x {
            b.max_x = p[0];
        }
        if p[1] < b.min_y {
            b.min_y = p[1];
        }
        if p[1] > b.max_y {
            b.max_y = p[1];
        }
    }
    b
}

fn bbox_contains(outer: &BBox, inner: &BBox) -> bool {
    inner.min_x >= outer.min_x
        && inner.max_x <= outer.max_x
        && inner.min_y >= outer.min_y
        && inner.max_y <= outer.max_y
}

fn is_contour_inside(
    inner_poly: &[[f64; 2]],
    inner_bbox: &BBox,
    outer_poly: &[[f64; 2]],
    outer_bbox: &BBox,
) -> bool {
    if !bbox_contains(outer_bbox, inner_bbox) {
        return false;
    }
    if inner_poly.is_empty() {
        return false;
    }
    point_in_polygon_arr2(inner_poly[0][0], inner_poly[0][1], outer_poly)
}

pub(super) struct ContourTreeNode {
    parent_index: i32,
    pub(super) depth: u32,
    children: Vec<usize>,
}

pub(super) struct ContourTree {
    pub(super) nodes: Vec<ContourTreeNode>,
}

fn build_contour_tree(sampled: &[Vec<[f64; 2]>], bboxes: &[BBox]) -> ContourTree {
    let n = sampled.len();
    if n == 0 {
        return ContourTree { nodes: vec![] };
    }

    // Working tree: virtual root's children list
    let mut parent_of: Vec<Option<usize>> = vec![None; n]; // None = child of virtual root
    let mut children_of: Vec<Vec<usize>> = vec![vec![]; n + 1]; // index n = virtual root

    // Insert each contour incrementally
    for ci in 0..n {
        insert_contour(ci, n, sampled, bboxes, &mut parent_of, &mut children_of);
    }

    // Build final tree nodes
    let mut nodes: Vec<ContourTreeNode> = (0..n)
        .map(|_| ContourTreeNode {
            parent_index: -1,
            depth: 0,
            children: vec![],
        })
        .collect();

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

    ContourTree { nodes }
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
        if is_contour_inside(
            &sampled[existing],
            &bboxes[existing],
            &sampled[ci],
            &bboxes[ci],
        ) {
            children_to_reparent.push(existing);
        }
    }

    for &child in &children_to_reparent {
        children_of[parent].retain(|&c| c != child);
        children_of[ci].push(child);
        parent_of[child] = Some(ci);
    }

    children_of[parent].push(ci);
    parent_of[ci] = if parent == virtual_root {
        None
    } else {
        Some(parent)
    };
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

/// Build the binary terrain CPU data from a parsed level file, including contour
/// tree construction, DFS ordering, and flat vertex/children buffers.
pub fn build_terrain_data(level: &LevelFileJSON) -> TerrainCPUData {
    let def_depth = level.default_depth.unwrap_or(DEFAULT_DEPTH);
    let contours = &level.contours;

    let polygon_contours: Vec<PolygonContour> = contours
        .iter()
        .map(|c| {
            let pts: Vec<[f64; 2]> = if let Some(ref poly) = c.polygon {
                poly.clone()
            } else if let Some(ref cp) = c.control_points {
                let sps = adaptive_samples_per_segment(cp);
                sample_closed_spline(cp, sps)
            } else {
                vec![]
            };
            PolygonContour {
                height: c.height,
                polygon: pts,
            }
        })
        .collect();

    build_terrain_data_from_polygons(&polygon_contours, def_depth)
}

/// Build the binary terrain CPU data from pre-sampled polygon contours.
/// This is the core implementation used by both `build_terrain_data` (from JSON)
/// and `extract.rs` (from GIS pipeline).
pub fn build_terrain_data_from_polygons(
    contours: &[PolygonContour],
    default_depth: f64,
) -> TerrainCPUData {
    let n = contours.len();

    // Normalise winding to CCW
    let mut sampled: Vec<Vec<[f64; 2]>> = Vec::with_capacity(n);
    for c in contours {
        let mut poly = c.polygon.clone();
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

    fn dfs_visit(
        idx: usize,
        tree: &ContourTree,
        dfs_order: &mut Vec<usize>,
        skip_counts: &mut Vec<usize>,
    ) -> usize {
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

        // idwGridDataOffset (u32) — 0 initially, filled below
        cd[52..56].copy_from_slice(&0u32.to_le_bytes());

        // vertex data
        for pt in vertices {
            vertex_data.push(pt[0] as f32);
            vertex_data.push(pt[1] as f32);
            vertex_index += 1;
        }
    }

    // Build containment grids (256 u32 per contour, 2-bit packed)
    let mut containment_grid_data = vec![0u32; n * CONTAINMENT_GRID_U32S_PER_CONTOUR];
    for (dfs_idx, &orig) in dfs_order.iter().enumerate().take(n) {
        let vertices = &sampled[orig];
        if vertices.len() >= 3 {
            let packed = build_containment_grid_packed(vertices, &bboxes[orig]);
            let offset = dfs_idx * CONTAINMENT_GRID_U32S_PER_CONTOUR;
            containment_grid_data[offset..offset + CONTAINMENT_GRID_U32S_PER_CONTOUR]
                .copy_from_slice(&packed);
        }
    }

    // Build IDW grids for contours with children
    let mut idw_grid_parts: Vec<u32> = Vec::new();
    let mut idw_grid_count = 0usize;
    let mut idw_total_edges = 0usize;
    let mut idw_total_entries = 0usize;
    let mut idw_max_entries_per_cell = 0usize;
    let mut idw_cell_counts: Vec<usize> = Vec::new(); // entries-per-cell across all grids
    for (dfs_idx, &orig) in dfs_order.iter().enumerate().take(n) {
        let node = &tree.nodes[orig];
        if node.children.is_empty() || node.children.len() + 1 > MAX_IDW_CONTOURS {
            continue;
        }

        let parent_poly = &sampled[orig];
        let child_polys: Vec<&[[f64; 2]]> = node
            .children
            .iter()
            .map(|&child_orig| sampled[child_orig].as_slice())
            .collect();

        let (cell_starts, entries) =
            build_idw_grid_packed(parent_poly, &child_polys, &bboxes[orig]);

        // Collect stats
        let num_edges: usize =
            parent_poly.len() + child_polys.iter().map(|p| p.len()).sum::<usize>();
        idw_grid_count += 1;
        idw_total_edges += num_edges;
        idw_total_entries += entries.len();
        for i in 0..IDW_GRID_CELLS {
            let count = (cell_starts[i + 1] - cell_starts[i]) as usize;
            idw_cell_counts.push(count);
            if count > idw_max_entries_per_cell {
                idw_max_entries_per_cell = count;
            }
        }

        // Record relative offset + 1 (0 = no grid sentinel)
        let offset = idw_grid_parts.len();
        let byte_base = dfs_idx * FLOATS_PER_CONTOUR * 4;
        contour_data[byte_base + 52..byte_base + 56]
            .copy_from_slice(&((offset + 1) as u32).to_le_bytes());

        idw_grid_parts.extend_from_slice(&cell_starts);
        idw_grid_parts.extend_from_slice(&entries);
    }

    // Print IDW grid stats
    if idw_grid_count > 0 {
        let total_cells = idw_cell_counts.len();
        let avg_entries = idw_total_entries as f64 / total_cells as f64;
        let median_entries = {
            let mut sorted = idw_cell_counts.clone();
            sorted.sort_unstable();
            sorted[sorted.len() / 2]
        };
        let p95_entries = {
            let mut sorted = idw_cell_counts.clone();
            sorted.sort_unstable();
            sorted[(sorted.len() as f64 * 0.95) as usize]
        };
        let memory_bytes = idw_grid_parts.len() * 4;
        eprintln!("  IDW grid stats:");
        eprintln!("    grids:           {}", idw_grid_count);
        eprintln!("    total edges:     {}", idw_total_edges);
        eprintln!("    total entries:   {}", idw_total_entries);
        eprintln!(
            "    entries/cell:    avg {:.1}, median {}, p95 {}, max {}",
            avg_entries, median_entries, p95_entries, idw_max_entries_per_cell
        );
        eprintln!(
            "    memory:          {} bytes ({:.1} KB)",
            memory_bytes,
            memory_bytes as f64 / 1024.0
        );
    }

    // Build contour lookup grid for GPU
    let lookup_grid_data =
        build_lookup_grid_packed_gpu(&sampled, &bboxes, &dfs_order, &tree);

    TerrainCPUData {
        vertex_data,
        contour_data,
        children_data: children_flat,
        contour_count: n,
        default_depth,
        containment_grid_data,
        idw_grid_data: idw_grid_parts,
        lookup_grid_data,
    }
}
