use std::collections::HashSet;
use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use serde::Deserialize;
use terrain_core::humanize::format_int;

const DEFAULT_DEPTH: f64 = -300.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValidationErrorType {
    Overlap,
    Tree,
}

#[derive(Debug, Clone)]
pub struct ValidationError {
    pub error_type: ValidationErrorType,
    pub message: String,
}

#[derive(Debug, Clone)]
pub struct ValidationResult {
    pub errors: Vec<ValidationError>,
    pub warnings: Vec<String>,
    pub contour_count: usize,
    pub root_count: usize,
    pub max_depth: usize,
}

#[derive(Debug, Clone)]
struct LightContour {
    height: f64,
    /// Flat array: [x0, y0, x1, y1, ...]
    points: Vec<f64>,
    num_points: usize,
}

#[derive(Debug, Clone, Copy)]
struct BBox {
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
}

#[derive(Debug, Clone)]
struct TreeNode {
    parent_index: isize,
    children: Vec<usize>,
    depth: usize,
}

#[derive(Debug, Deserialize)]
struct RawLevel {
    #[serde(rename = "defaultDepth")]
    default_depth: Option<f64>,
    region: Option<serde_json::Value>,
    #[serde(default)]
    contours: Vec<RawContour>,
}

#[derive(Debug, Deserialize)]
struct RawContour {
    height: f64,
    #[serde(rename = "controlPoints")]
    control_points: Option<Vec<[f64; 2]>>,
    polygon: Option<Vec<[f64; 2]>>,
}

pub fn validate_level_file(level_path: &Path) -> Result<ValidationResult> {
    let json = fs::read_to_string(level_path)
        .with_context(|| format!("Failed to read {}", level_path.display()))?;
    let data: RawLevel = serde_json::from_str(&json).context("Failed to parse level JSON")?;

    // If the level has a region config, look for a prebuilt .terrain binary
    if data.region.is_some() {
        let slug = level_path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .replace(".level", "");
        let terrain_path = level_path
            .parent()
            .unwrap_or(std::path::Path::new("."))
            .join(format!("{}.terrain", slug));
        return validate_terrain_binary(&terrain_path);
    }

    Ok(validate_level_data(data))
}

/// Parse and validate a binary .terrain file (v2 format).
/// Uses `read_terrain_binary` to parse the file, then extracts contour
/// polygons for validation.
pub fn validate_terrain_binary(terrain_path: &Path) -> Result<ValidationResult> {
    let bytes = fs::read(terrain_path)
        .with_context(|| format!("Failed to read {}", terrain_path.display()))?;

    let terrain = terrain_core::level::read_terrain_binary(&bytes)
        .with_context(|| format!("Failed to parse terrain binary: {}", terrain_path.display()))?;

    let default_depth = terrain.default_depth;
    let fpc = terrain_core::level::FLOATS_PER_CONTOUR;
    let mut contours = Vec::with_capacity(terrain.contour_count);

    for i in 0..terrain.contour_count {
        let base = i * fpc * 4;
        let cd = &terrain.contour_data[base..base + fpc * 4];

        let point_start =
            u32::from_le_bytes(cd[0..4].try_into().unwrap()) as usize;
        let point_count =
            u32::from_le_bytes(cd[4..8].try_into().unwrap()) as usize;
        let height =
            f32::from_le_bytes(cd[8..12].try_into().unwrap()) as f64;

        let mut flat = Vec::with_capacity(point_count * 2);
        for j in 0..point_count {
            let vi = (point_start + j) * 2;
            flat.push(terrain.vertex_data[vi] as f64);
            flat.push(terrain.vertex_data[vi + 1] as f64);
        }

        contours.push(ensure_ccw(LightContour {
            height,
            num_points: point_count,
            points: flat,
        }));
    }

    Ok(validate_contours(contours, default_depth))
}

#[cfg(test)]
fn validate_level_json(json: &str) -> Result<ValidationResult> {
    let data: RawLevel = serde_json::from_str(json).context("Failed to parse level JSON")?;
    Ok(validate_level_data(data))
}

fn validate_level_data(data: RawLevel) -> ValidationResult {
    let default_depth = data.default_depth.unwrap_or(DEFAULT_DEPTH);

    let contours: Vec<LightContour> = data
        .contours
        .iter()
        .map(|c| {
            let points = c
                .polygon
                .as_ref()
                .or(c.control_points.as_ref())
                .cloned()
                .unwrap_or_default();

            let mut flat = Vec::with_capacity(points.len() * 2);
            for [x, y] in points {
                flat.push(x);
                flat.push(y);
            }

            ensure_ccw(LightContour {
                height: c.height,
                num_points: flat.len() / 2,
                points: flat,
            })
        })
        .collect();

    validate_contours(contours, default_depth)
}

fn validate_contours(contours: Vec<LightContour>, default_depth: f64) -> ValidationResult {
    let mut errors = Vec::new();
    let mut warnings = Vec::new();

    if contours.is_empty() {
        return ValidationResult {
            errors,
            warnings,
            contour_count: 0,
            root_count: 0,
            max_depth: 0,
        };
    }

    let bboxes: Vec<BBox> = contours.iter().map(compute_bbox).collect();

    // Check 1: no overlap between contours at different heights.
    let max_overlap_reports = 10;
    let overlap_errors = find_overlaps_with_grid(&contours, &bboxes, max_overlap_reports);
    errors.extend(overlap_errors);

    if errors.len() >= max_overlap_reports {
        warnings.push(format!(
            "Stopped checking after {} overlap errors (there may be more)",
            format_int(max_overlap_reports)
        ));
    }

    // Check 2: nesting transitions must not cross zero without an h=0 contour.
    let (nodes, max_depth) = build_light_contour_tree(&contours, &bboxes);

    let mut tree_error_count = 0usize;
    let max_tree_errors = 10usize;
    for (idx, node) in nodes.iter().enumerate() {
        let height = contours[idx].height;
        let parent_height = if node.parent_index >= 0 {
            contours[node.parent_index as usize].height
        } else {
            default_depth
        };

        let bad = (height > 0.0 && parent_height < 0.0) || (height < 0.0 && parent_height > 0.0);
        if bad {
            tree_error_count += 1;
            if tree_error_count <= max_tree_errors {
                let parent_desc = if node.parent_index >= 0 {
                    format!(
                        "contour {} (h={}ft)",
                        format_int(node.parent_index),
                        format_height(parent_height)
                    )
                } else {
                    format!("ocean (h={}ft)", format_height(parent_height))
                };

                errors.push(ValidationError {
                    error_type: ValidationErrorType::Tree,
                    message: format!(
                        "Contour {} (h={}ft) has parent {} — height crosses zero without a h=0 contour between them",
                        format_int(idx),
                        format_height(height),
                        parent_desc
                    ),
                });
            }
        }
    }

    if tree_error_count > max_tree_errors {
        warnings.push(format!(
            "{} more tree nesting errors not shown",
            format_int(tree_error_count - max_tree_errors)
        ));
    }

    let root_count = nodes.iter().filter(|n| n.parent_index < 0).count();

    ValidationResult {
        errors,
        warnings,
        contour_count: contours.len(),
        root_count,
        max_depth,
    }
}

fn format_height(h: f64) -> String {
    let rounded = (h * 1000.0).round() / 1000.0;
    if rounded.fract().abs() < 1e-9 {
        format!("{rounded:.0}")
    } else {
        format!("{rounded:.3}")
    }
}

fn compute_bbox(c: &LightContour) -> BBox {
    let mut min_x = f64::INFINITY;
    let mut min_y = f64::INFINITY;
    let mut max_x = f64::NEG_INFINITY;
    let mut max_y = f64::NEG_INFINITY;

    for i in 0..c.num_points {
        let x = c.points[i * 2];
        let y = c.points[i * 2 + 1];
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x);
        max_y = max_y.max(y);
    }

    BBox {
        min_x,
        min_y,
        max_x,
        max_y,
    }
}

fn bbox_overlaps(a: BBox, b: BBox) -> bool {
    a.min_x <= b.max_x && a.max_x >= b.min_x && a.min_y <= b.max_y && a.max_y >= b.min_y
}

fn bbox_contains(outer: BBox, inner: BBox) -> bool {
    outer.min_x <= inner.min_x
        && outer.max_x >= inner.max_x
        && outer.min_y <= inner.min_y
        && outer.max_y >= inner.max_y
}

fn segments_intersect(
    p1x: f64,
    p1y: f64,
    p2x: f64,
    p2y: f64,
    p3x: f64,
    p3y: f64,
    p4x: f64,
    p4y: f64,
) -> bool {
    let d1x = p2x - p1x;
    let d1y = p2y - p1y;
    let d2x = p4x - p3x;
    let d2y = p4y - p3y;

    let denom = d1x * d2y - d1y * d2x;
    if denom.abs() < 1e-12 {
        return false;
    }

    let t = ((p3x - p1x) * d2y - (p3y - p1y) * d2x) / denom;
    let u = ((p3x - p1x) * d1y - (p3y - p1y) * d1x) / denom;

    let eps = 1e-9;
    t > eps && t < 1.0 - eps && u > eps && u < 1.0 - eps
}

fn find_overlaps_with_grid(
    contours: &[LightContour],
    bboxes: &[BBox],
    max_errors: usize,
) -> Vec<ValidationError> {
    let mut errors = Vec::new();
    if contours.is_empty() {
        return errors;
    }

    let mut g_min_x = f64::INFINITY;
    let mut g_min_y = f64::INFINITY;
    let mut g_max_x = f64::NEG_INFINITY;
    let mut g_max_y = f64::NEG_INFINITY;
    for bb in bboxes {
        g_min_x = g_min_x.min(bb.min_x);
        g_min_y = g_min_y.min(bb.min_y);
        g_max_x = g_max_x.max(bb.max_x);
        g_max_y = g_max_y.max(bb.max_y);
    }

    let total_segs: usize = contours.iter().map(|c| c.num_points).sum();
    if total_segs == 0 {
        return errors;
    }

    let area = ((g_max_x - g_min_x) * (g_max_y - g_min_y)).abs();
    let target_per_cell = (total_segs as f64 / 8.0).max(1.0);
    let cell_size = ((area / target_per_cell).sqrt()).max(50.0).max(1e-9);

    let cols = (((g_max_x - g_min_x) / cell_size).ceil() as usize)
        .saturating_add(1)
        .max(1);
    let rows = (((g_max_y - g_min_y) / cell_size).ceil() as usize)
        .saturating_add(1)
        .max(1);
    let num_cells = cols * rows;

    let mut cell_counts = vec![0u32; num_cells];

    for contour in contours {
        if contour.num_points == 0 {
            continue;
        }
        for seg_index in 0..contour.num_points {
            let next = (seg_index + 1) % contour.num_points;
            let x1 = contour.points[seg_index * 2];
            let y1 = contour.points[seg_index * 2 + 1];
            let x2 = contour.points[next * 2];
            let y2 = contour.points[next * 2 + 1];

            let min_cx = clamp_cell((x1.min(x2) - g_min_x) / cell_size, cols);
            let max_cx = clamp_cell((x1.max(x2) - g_min_x) / cell_size, cols);
            let min_cy = clamp_cell((y1.min(y2) - g_min_y) / cell_size, rows);
            let max_cy = clamp_cell((y1.max(y2) - g_min_y) / cell_size, rows);

            for cy in min_cy..=max_cy {
                for cx in min_cx..=max_cx {
                    cell_counts[cy * cols + cx] += 1;
                }
            }
        }
    }

    let mut cell_offsets = vec![0u32; num_cells + 1];
    for i in 0..num_cells {
        cell_offsets[i + 1] = cell_offsets[i] + cell_counts[i];
    }

    let total_entries = cell_offsets[num_cells] as usize;
    let mut entries = vec![0u64; total_entries];
    let mut fill = vec![0u32; num_cells];

    for (contour_idx, contour) in contours.iter().enumerate() {
        if contour.num_points == 0 {
            continue;
        }

        for seg_index in 0..contour.num_points {
            let next = (seg_index + 1) % contour.num_points;
            let x1 = contour.points[seg_index * 2];
            let y1 = contour.points[seg_index * 2 + 1];
            let x2 = contour.points[next * 2];
            let y2 = contour.points[next * 2 + 1];

            let min_cx = clamp_cell((x1.min(x2) - g_min_x) / cell_size, cols);
            let max_cx = clamp_cell((x1.max(x2) - g_min_x) / cell_size, cols);
            let min_cy = clamp_cell((y1.min(y2) - g_min_y) / cell_size, rows);
            let max_cy = clamp_cell((y1.max(y2) - g_min_y) / cell_size, rows);

            let packed = ((contour_idx as u64) << 32) | seg_index as u64;
            for cy in min_cy..=max_cy {
                for cx in min_cx..=max_cx {
                    let cell = cy * cols + cx;
                    let pos = cell_offsets[cell] + fill[cell];
                    entries[pos as usize] = packed;
                    fill[cell] += 1;
                }
            }
        }
    }

    let mut reported_pairs = HashSet::new();

    for cell in 0..num_cells {
        if errors.len() >= max_errors {
            break;
        }

        let start = cell_offsets[cell] as usize;
        let end = cell_offsets[cell + 1] as usize;
        if end.saturating_sub(start) < 2 {
            continue;
        }

        for i in start..end {
            if errors.len() >= max_errors {
                break;
            }

            let packed_a = entries[i];
            let ci_a = (packed_a >> 32) as usize;
            let si_a = (packed_a & 0xffff_ffff) as usize;
            let h_a = contours[ci_a].height;

            for packed_b in entries.iter().take(end).skip(i + 1).copied() {
                let ci_b = (packed_b >> 32) as usize;
                if ci_a == ci_b || contours[ci_b].height == h_a {
                    continue;
                }

                if !bbox_overlaps(bboxes[ci_a], bboxes[ci_b]) {
                    continue;
                }

                let lo = ci_a.min(ci_b) as u64;
                let hi = ci_a.max(ci_b) as u64;
                let pair_key = (lo << 32) | hi;
                if reported_pairs.contains(&pair_key) {
                    continue;
                }

                let si_b = (packed_b & 0xffff_ffff) as usize;
                let contour_a = &contours[ci_a];
                let contour_b = &contours[ci_b];
                let si_a2 = (si_a + 1) % contour_a.num_points;
                let si_b2 = (si_b + 1) % contour_b.num_points;

                if segments_intersect(
                    contour_a.points[si_a * 2],
                    contour_a.points[si_a * 2 + 1],
                    contour_a.points[si_a2 * 2],
                    contour_a.points[si_a2 * 2 + 1],
                    contour_b.points[si_b * 2],
                    contour_b.points[si_b * 2 + 1],
                    contour_b.points[si_b2 * 2],
                    contour_b.points[si_b2 * 2 + 1],
                ) {
                    reported_pairs.insert(pair_key);
                    let mx = (contour_a.points[si_a * 2] + contour_a.points[si_a2 * 2]) * 0.5;
                    let my =
                        (contour_a.points[si_a * 2 + 1] + contour_a.points[si_a2 * 2 + 1]) * 0.5;
                    errors.push(ValidationError {
                        error_type: ValidationErrorType::Overlap,
                        message: format!(
                            "Contour {} (h={}ft) and contour {} (h={}ft) intersect near ({:.0}, {:.0})",
                            format_int(ci_a),
                            format_height(contours[ci_a].height),
                            format_int(ci_b),
                            format_height(contours[ci_b].height),
                            mx,
                            my
                        ),
                    });
                    if errors.len() >= max_errors {
                        break;
                    }
                }
            }
        }
    }

    errors
}

fn clamp_cell(value: f64, size: usize) -> usize {
    let idx = value.floor() as isize;
    idx.clamp(0, size as isize - 1) as usize
}

fn point_in_polygon(px: f64, py: f64, poly: &[f64], num_points: usize) -> bool {
    if num_points < 3 {
        return false;
    }

    let mut inside = false;
    let mut j = num_points - 1;
    for i in 0..num_points {
        let xi = poly[i * 2];
        let yi = poly[i * 2 + 1];
        let xj = poly[j * 2];
        let yj = poly[j * 2 + 1];

        if (yi > py) != (yj > py) && px < ((xj - xi) * (py - yi) / (yj - yi)) + xi {
            inside = !inside;
        }

        j = i;
    }

    inside
}

fn signed_area(points: &[f64], num_points: usize) -> f64 {
    let mut area = 0.0;
    for i in 0..num_points {
        let j = (i + 1) % num_points;
        area += points[i * 2] * points[j * 2 + 1] - points[j * 2] * points[i * 2 + 1];
    }
    area * 0.5
}

fn ensure_ccw(mut contour: LightContour) -> LightContour {
    if contour.num_points < 3 {
        return contour;
    }

    if signed_area(&contour.points, contour.num_points) >= 0.0 {
        return contour;
    }

    let mut reversed = vec![0.0; contour.points.len()];
    for i in 0..contour.num_points {
        let ri = contour.num_points - 1 - i;
        reversed[i * 2] = contour.points[ri * 2];
        reversed[i * 2 + 1] = contour.points[ri * 2 + 1];
    }
    contour.points = reversed;
    contour
}

fn build_light_contour_tree(contours: &[LightContour], bboxes: &[BBox]) -> (Vec<TreeNode>, usize) {
    if contours.is_empty() {
        return (Vec::new(), 0);
    }

    #[derive(Debug)]
    struct WorkingNode {
        contour_index: isize,
        parent_index: isize,
        children: Vec<WorkingNode>,
    }

    fn is_inside(
        inner_idx: usize,
        outer_idx: usize,
        contours: &[LightContour],
        bboxes: &[BBox],
    ) -> bool {
        if !bbox_contains(bboxes[outer_idx], bboxes[inner_idx]) {
            return false;
        }

        let inner = &contours[inner_idx];
        if inner.num_points == 0 {
            return false;
        }

        point_in_polygon(
            inner.points[0],
            inner.points[1],
            &contours[outer_idx].points,
            contours[outer_idx].num_points,
        )
    }

    fn insert_contour(
        parent: &mut WorkingNode,
        new_idx: usize,
        contours: &[LightContour],
        bboxes: &[BBox],
    ) {
        for child in &mut parent.children {
            if is_inside(new_idx, child.contour_index as usize, contours, bboxes) {
                insert_contour(child, new_idx, contours, bboxes);
                return;
            }
        }

        let mut new_node = WorkingNode {
            contour_index: new_idx as isize,
            parent_index: parent.contour_index,
            children: Vec::new(),
        };

        let mut keep = Vec::with_capacity(parent.children.len());
        for mut child in parent.children.drain(..) {
            if is_inside(child.contour_index as usize, new_idx, contours, bboxes) {
                child.parent_index = new_idx as isize;
                new_node.children.push(child);
            } else {
                keep.push(child);
            }
        }

        parent.children = keep;
        parent.children.push(new_node);
    }

    fn write_nodes(node: &WorkingNode, nodes: &mut [TreeNode]) {
        for child in &node.children {
            let idx = child.contour_index as usize;
            nodes[idx].parent_index = child.parent_index;
            nodes[idx].children = child
                .children
                .iter()
                .map(|c| c.contour_index as usize)
                .collect();
            write_nodes(child, nodes);
        }
    }

    let mut root = WorkingNode {
        contour_index: -1,
        parent_index: -1,
        children: Vec::new(),
    };

    for idx in 0..contours.len() {
        insert_contour(&mut root, idx, contours, bboxes);
    }

    let mut nodes = vec![
        TreeNode {
            parent_index: -1,
            children: Vec::new(),
            depth: 0,
        };
        contours.len()
    ];

    write_nodes(&root, &mut nodes);

    let mut max_depth = 0usize;
    let mut queue: Vec<usize> = nodes
        .iter()
        .enumerate()
        .filter_map(|(i, node)| (node.parent_index < 0).then_some(i))
        .collect();

    let mut q_index = 0usize;
    while q_index < queue.len() {
        let idx = queue[q_index];
        q_index += 1;

        let depth = if nodes[idx].parent_index >= 0 {
            nodes[nodes[idx].parent_index as usize].depth + 1
        } else {
            0
        };
        nodes[idx].depth = depth;
        max_depth = max_depth.max(depth);

        let children = nodes[idx].children.clone();
        queue.extend(children);
    }

    (nodes, max_depth)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(json: &str) -> ValidationResult {
        validate_level_json(json).expect("validation parse should succeed")
    }

    #[test]
    fn detects_overlap_between_different_heights() {
        let json = r#"{
            "version": 1,
            "defaultDepth": -300,
            "contours": [
                {"height": 0, "polygon": [[0,0],[10,0],[10,10],[0,10]]},
                {"height": 10, "polygon": [[5,-1],[15,-1],[15,9],[5,9]]}
            ]
        }"#;

        let result = run(json);
        assert!(result
            .errors
            .iter()
            .any(|e| e.error_type == ValidationErrorType::Overlap));
    }

    #[test]
    fn detects_tree_zero_crossing_errors() {
        let json = r#"{
            "version": 1,
            "defaultDepth": -300,
            "contours": [
                {"height": 100, "polygon": [[0,0],[10,0],[10,10],[0,10]]}
            ]
        }"#;

        let result = run(json);
        assert!(result
            .errors
            .iter()
            .any(|e| e.error_type == ValidationErrorType::Tree));
    }

    #[test]
    fn passes_simple_valid_level() {
        let json = r#"{
            "version": 1,
            "defaultDepth": -300,
            "contours": [
                {"height": -100, "polygon": [[0,0],[20,0],[20,20],[0,20]]},
                {"height": -50, "polygon": [[5,5],[10,5],[10,10],[5,10]]}
            ]
        }"#;

        let result = run(json);
        assert!(result.errors.is_empty());
        assert_eq!(result.contour_count, 2);
    }
}
