use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, BufWriter, Write};
use std::path::Path;
use std::time::Instant;

use anyhow::{bail, Context, Result};
use gdal::Dataset;
use serde::Serialize;
use terrain_core::humanize::format_int;

use crate::constrained_simplify::constrained_simplify_closed_ring;
use crate::geo::{bbox_center, lat_lon_to_feet, meters_to_feet};
use crate::marching::{
    build_block_index, build_closed_rings, march_contours, BlockIndex, ScalarGrid,
};
use crate::region::{
    assets_root, grid_cache_dir, load_region_config, resolve_region, resolve_repo_path,
};
use crate::segment_index::SegmentIndex;
use crate::simplify::{ring_perimeter, signed_area, Point};
use crate::validate::validate_level_file;

const DEFAULT_DEPTH: f64 = -300.0;

#[derive(Serialize)]
struct TerrainContourJson {
    height: f64,
    polygon: Vec<[f64; 2]>,
}

#[derive(Serialize)]
struct LevelJson {
    version: u32,
    #[serde(rename = "defaultDepth")]
    default_depth: f64,
    contours: Vec<TerrainContourJson>,
}

#[derive(Clone)]
struct RawRing {
    height: f64,
    points: Vec<Point>,
    bbox: RingBBox,
}

#[derive(Clone, Copy)]
struct RingBBox {
    min_x: f64,
    min_y: f64,
    max_x: f64,
    max_y: f64,
}

#[derive(Clone)]
struct ContourNode {
    ring_index: usize,
    children: Vec<ContourNode>,
}

struct LoadedGrid {
    grid: ScalarGrid,
    min_feet: f64,
    max_feet: f64,
    lon_step: f64,
    lat_step: f64,
    origin_lon: f64,
    origin_lat: f64,
}

pub fn run_extract(region_arg: Option<&str>) -> Result<()> {
    let slug = resolve_region(region_arg)?;
    let config = load_region_config(&slug)?;

    let merged_path = grid_cache_dir(&slug).join("merged.tif");
    if !merged_path.exists() {
        bail!(
            "No merged grid found at {}. Run build-grid step first.",
            merged_path.display()
        );
    }

    let merged_display = terrain_relative_path(&merged_path);
    print!("Loading merged grid from {merged_display}...");
    let _ = io::stdout().flush();
    let mut timer = Instant::now();
    let loaded = load_merged_grid(&merged_path, &merged_display)?;
    println!("Load grid: {}ms", format_int(timer.elapsed().as_millis()));

    println!("Region: {}", config.name);
    println!(
        "Grid: {}x{}, elevation range {:.1}ft to {:.1}ft",
        format_int(loaded.grid.width),
        format_int(loaded.grid.height),
        loaded.min_feet,
        loaded.max_feet
    );
    println!(
        "Settings: interval {}ft, simplify {}ft, scale {}, minPerimeter {}ft, minPoints {}",
        config.interval,
        config.simplify,
        config.scale,
        config.min_perimeter,
        format_int(config.min_points)
    );

    let clamped_min = loaded.min_feet.max(DEFAULT_DEPTH);
    let levels = quantize_levels(clamped_min, loaded.max_feet, config.interval);
    let (center_lat, center_lon) = bbox_center(&config.bbox);

    let bbox_min_lon = loaded.origin_lon - loaded.lon_step;
    let bbox_max_lat = loaded.origin_lat + loaded.lat_step;

    timer = Instant::now();
    let blocks = build_block_index(&loaded.grid);
    print_block_index_stats(&blocks, timer.elapsed().as_secs_f64() * 1000.0);

    let mut all_rings = Vec::new();
    let mut total_march_ms = 0.0;
    let mut total_rings_ms = 0.0;
    let mut total_raw_rings = 0usize;

    for (li, level_feet) in levels.iter().enumerate() {
        timer = Instant::now();
        let segments = march_contours(&loaded.grid, &blocks, *level_feet);
        let march_ms = timer.elapsed().as_secs_f64() * 1000.0;
        total_march_ms += march_ms;

        timer = Instant::now();
        let rings = build_closed_rings(&segments);

        let mut ring_count = 0usize;
        let mut kept_count = 0usize;

        for ring in rings {
            ring_count += 1;

            let mut feet_points = Vec::with_capacity(ring.len());
            let mut bbox = RingBBox {
                min_x: f64::INFINITY,
                min_y: f64::INFINITY,
                max_x: f64::NEG_INFINITY,
                max_y: f64::NEG_INFINITY,
            };

            for (gx, gy) in ring {
                let lon = bbox_min_lon + gx * loaded.lon_step;
                let lat = bbox_max_lat - gy * loaded.lat_step;
                let (x_feet, y_feet) = lat_lon_to_feet(lat, lon, center_lat, center_lon);
                let fy = if config.flip_y { -y_feet } else { y_feet };
                feet_points.push((x_feet, fy));

                bbox.min_x = bbox.min_x.min(x_feet);
                bbox.max_x = bbox.max_x.max(x_feet);
                bbox.min_y = bbox.min_y.min(fy);
                bbox.max_y = bbox.max_y.max(fy);
            }

            if ring_perimeter(&feet_points) < config.min_perimeter {
                continue;
            }
            if feet_points.len() < config.min_points {
                continue;
            }

            all_rings.push(RawRing {
                height: *level_feet,
                points: feet_points,
                bbox,
            });
            kept_count += 1;
        }

        let rings_ms = timer.elapsed().as_secs_f64() * 1000.0;
        total_rings_ms += rings_ms;
        total_raw_rings += ring_count;

        println!(
            "[{}/{}] {:.3}ft: {} rings -> {} kept  (march {}ms, convert {}ms)",
            format_int(li + 1),
            format_int(levels.len()),
            level_feet,
            format_int(ring_count),
            format_int(kept_count),
            format_int(march_ms.round() as u64),
            format_int(rings_ms.round() as u64)
        );
    }

    println!(
        "\nPhase 1: {} raw rings -> {} pre-filtered  (march {}ms, convert {}ms)",
        format_int(total_raw_rings),
        format_int(all_rings.len()),
        format_int(total_march_ms.round() as u64),
        format_int(total_rings_ms.round() as u64)
    );

    if all_rings.is_empty() {
        let output_path = resolve_repo_path(&config.output);
        write_level_file(&output_path, Vec::new())?;
        println!("Wrote empty contour set to {}", output_path.display());
        return Ok(());
    }

    timer = Instant::now();
    let tree_roots = build_containment_tree(&all_rings);
    let order = bfs_order(&tree_roots);
    println!(
        "Containment tree: {} roots, BFS order computed  ({}ms)",
        format_int(tree_roots.len()),
        format_int(timer.elapsed().as_millis())
    );

    let mut g_min_x = f64::INFINITY;
    let mut g_min_y = f64::INFINITY;
    let mut g_max_x = f64::NEG_INFINITY;
    let mut g_max_y = f64::NEG_INFINITY;
    let mut total_points = 0usize;

    for ring in &all_rings {
        g_min_x = g_min_x.min(ring.bbox.min_x);
        g_min_y = g_min_y.min(ring.bbox.min_y);
        g_max_x = g_max_x.max(ring.bbox.max_x);
        g_max_y = g_max_y.max(ring.bbox.max_y);
        total_points += ring.points.len();
    }

    let area = ((g_max_x - g_min_x) * (g_max_y - g_min_y)).abs();
    let cell_size = (area / ((total_points as f64 / 8.0).max(1.0)))
        .sqrt()
        .max(50.0)
        .max(1e-6);

    let mut seg_index = SegmentIndex::new(g_min_x, g_min_y, g_max_x, g_max_y, cell_size);
    for (idx, ring) in all_rings.iter().enumerate() {
        seg_index.add_contour_segments(idx, &ring.points);
    }

    timer = Instant::now();
    let mut contours = Vec::new();
    let mut constrained_kept = 0usize;

    for ring_idx in order {
        let ring = &all_rings[ring_idx];
        let simplified =
            constrained_simplify_closed_ring(&ring.points, config.simplify, ring_idx, &seg_index);

        if simplified.len() < config.min_points {
            continue;
        }

        seg_index.remove_contour_segments(ring_idx);
        seg_index.add_contour_segments(ring_idx, &simplified);

        let mut scaled: Vec<Point> = simplified
            .iter()
            .map(|(x, y)| (x / config.scale, y / config.scale))
            .collect();

        if signed_area(&scaled) < 0.0 {
            scaled.reverse();
        }

        contours.push(TerrainContourJson {
            height: round3(ring.height),
            polygon: scaled
                .iter()
                .map(|(x, y)| [round3(*x), round3(*y)])
                .collect(),
        });
        constrained_kept += 1;
    }

    let final_points: usize = contours.iter().map(|c| c.polygon.len()).sum();
    println!(
        "Phase 2: {} -> {} contours ({} pts)  (simplify {}ms)",
        format_int(all_rings.len()),
        format_int(constrained_kept),
        format_int(final_points),
        format_int(timer.elapsed().as_millis())
    );

    contours.sort_by(|a, b| {
        a.height
            .partial_cmp(&b.height)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // Prune contours orphaned by a missing 0ft intermediate. This happens
    // when a small 0ft ring was filtered by perimeter or simplified away,
    // leaving inner contours (which are even tinier) parented across zero.
    let pre_prune = contours.len();
    prune_zero_crossing_orphans(&mut contours, DEFAULT_DEPTH);
    let pruned = pre_prune - contours.len();
    if pruned > 0 {
        println!(
            "Pruned {} contour(s) orphaned by missing 0ft intermediate",
            format_int(pruned)
        );
    }

    let output_path = resolve_repo_path(&config.output);
    timer = Instant::now();
    write_level_file(&output_path, contours)?;
    println!(
        "Wrote contours to {}  (write {}ms)",
        output_path.display(),
        format_int(timer.elapsed().as_millis())
    );

    println!("\nValidating output...");
    let validation = validate_level_file(&output_path)?;
    println!(
        "  {} contours, {} roots, max depth {}",
        format_int(validation.contour_count),
        format_int(validation.root_count),
        format_int(validation.max_depth)
    );
    for warning in &validation.warnings {
        println!("  WARNING: {warning}");
    }

    if validation.errors.is_empty() {
        println!("  PASS: No errors found");
        return Ok(());
    }

    println!("  FAIL: {} error(s):", format_int(validation.errors.len()));
    for error in &validation.errors {
        println!("    [{:?}] {}", error.error_type, error.message);
    }
    bail!("extracted level failed validation")
}

fn load_merged_grid(merged_path: &Path, merged_display: &str) -> Result<LoadedGrid> {
    let dataset = Dataset::open(merged_path)
        .with_context(|| format!("Failed to open {}", merged_path.display()))?;
    let band = dataset
        .rasterband(1)
        .context("Failed to read raster band 1")?;

    let (width, height) = band.size();
    let transform = dataset.geo_transform().context("Missing geotransform")?;
    let no_data_value = band.no_data_value();

    let read_timer = Instant::now();
    let buffer = band
        .read_as::<f64>((0, 0), (width, height), (width, height), None)
        .context("Failed to read raster")?;
    println!(
        "\rLoaded merged grid from {} in {}ms",
        merged_display,
        format_int(read_timer.elapsed().as_millis())
    );
    print!("Preprocessing merged grid...");
    let _ = io::stdout().flush();
    let preprocess_timer = Instant::now();

    let mut values = vec![0.0; width * height];
    let mut nodata_mask = vec![0u8; width * height];

    for i in 0..values.len() {
        let v = buffer.data()[i];
        if !v.is_finite()
            || no_data_value
                .map(|no_data| (v - no_data).abs() < 1e-6)
                .unwrap_or(false)
        {
            nodata_mask[i] = 1;
            values[i] = 0.0;
        } else {
            values[i] = meters_to_feet(v);
        }
    }

    let mut seam_fills = 0usize;
    for y in 1..height.saturating_sub(1) {
        for x in 0..width {
            let idx = y * width + x;
            if nodata_mask[idx] == 0 {
                continue;
            }

            let above = (y - 1) * width + x;
            let below = (y + 1) * width + x;
            if nodata_mask[above] == 0 && nodata_mask[below] == 0 {
                values[idx] = (values[above] + values[below]) * 0.5;
                nodata_mask[idx] = 0;
                seam_fills += 1;
            }
        }
    }

    let mut depth_fills = 0usize;
    for i in 0..values.len() {
        if nodata_mask[i] != 0 {
            values[i] = DEFAULT_DEPTH;
            nodata_mask[i] = 0;
            depth_fills += 1;
        }
    }

    let pad_w = width + 2;
    let pad_h = height + 2;
    let mut padded = vec![DEFAULT_DEPTH; pad_w * pad_h];
    for y in 0..height {
        let src = y * width;
        let dst = (y + 1) * pad_w + 1;
        padded[dst..dst + width].copy_from_slice(&values[src..src + width]);
    }

    let mut min_feet = f64::INFINITY;
    let mut max_feet = f64::NEG_INFINITY;
    for &v in &values {
        min_feet = min_feet.min(v);
        max_feet = max_feet.max(v);
    }

    println!(
        "\rPreprocessed merged grid in {}ms",
        format_int(preprocess_timer.elapsed().as_millis())
    );
    if seam_fills > 0 {
        println!(
            "Interpolated {} tile-seam nodata cells",
            format_int(seam_fills)
        );
    }
    if depth_fills > 0 {
        println!(
            "Filled {} remaining nodata cells with {}ft",
            format_int(depth_fills),
            DEFAULT_DEPTH
        );
    }

    Ok(LoadedGrid {
        grid: ScalarGrid {
            width: pad_w,
            height: pad_h,
            values: padded,
        },
        min_feet,
        max_feet,
        lon_step: transform[1].abs(),
        lat_step: transform[5].abs(),
        origin_lon: transform[0],
        origin_lat: transform[3],
    })
}

fn terrain_relative_path(path: &Path) -> String {
    path.strip_prefix(assets_root())
        .map(|rel| rel.display().to_string())
        .unwrap_or_else(|_| path.display().to_string())
}

fn quantize_levels(min: f64, max: f64, interval: f64) -> Vec<f64> {
    let mut levels = Vec::new();
    let start = (min / interval).floor() * interval;
    let end = (max / interval).ceil() * interval;

    let mut level = start;
    while level <= end + interval * 0.1 {
        levels.push(round6(level));
        level += interval;
    }

    levels
}

fn point_in_polygon(px: f64, py: f64, poly: &[Point]) -> bool {
    if poly.len() < 3 {
        return false;
    }

    let mut inside = false;
    let mut j = poly.len() - 1;
    for i in 0..poly.len() {
        let (xi, yi) = poly[i];
        let (xj, yj) = poly[j];
        if (yi > py) != (yj > py) && px < ((xj - xi) * (py - yi) / (yj - yi)) + xi {
            inside = !inside;
        }
        j = i;
    }

    inside
}

fn build_containment_tree(rings: &[RawRing]) -> Vec<ContourNode> {
    fn bbox_contains(outer: RingBBox, inner: RingBBox) -> bool {
        outer.min_x <= inner.min_x
            && outer.max_x >= inner.max_x
            && outer.min_y <= inner.min_y
            && outer.max_y >= inner.max_y
    }

    fn is_inside(inner_idx: usize, outer_idx: usize, rings: &[RawRing]) -> bool {
        if !bbox_contains(rings[outer_idx].bbox, rings[inner_idx].bbox) {
            return false;
        }
        if rings[inner_idx].points.is_empty() {
            return false;
        }

        let (px, py) = rings[inner_idx].points[0];
        point_in_polygon(px, py, &rings[outer_idx].points)
    }

    fn insert_contour(parent: &mut Vec<ContourNode>, new_index: usize, rings: &[RawRing]) {
        for child in parent.iter_mut() {
            if is_inside(new_index, child.ring_index, rings) {
                insert_contour(&mut child.children, new_index, rings);
                return;
            }
        }

        let mut new_node = ContourNode {
            ring_index: new_index,
            children: Vec::new(),
        };

        let mut keep = Vec::with_capacity(parent.len());
        for child in parent.drain(..) {
            if is_inside(child.ring_index, new_index, rings) {
                new_node.children.push(child);
            } else {
                keep.push(child);
            }
        }

        *parent = keep;
        parent.push(new_node);
    }

    let mut roots = Vec::new();
    for idx in 0..rings.len() {
        insert_contour(&mut roots, idx, rings);
    }
    roots
}

/// Remove output contours whose parent crosses zero without an intermediate
/// 0ft contour. Builds a temporary containment tree from the output polygons
/// to detect the orphaned subtrees.
fn prune_zero_crossing_orphans(contours: &mut Vec<TerrainContourJson>, default_depth: f64) {
    if contours.is_empty() {
        return;
    }

    // Build temporary RawRings from the output contours for the tree.
    let rings: Vec<RawRing> = contours
        .iter()
        .map(|c| {
            let points: Vec<Point> = c.polygon.iter().map(|p| (p[0], p[1])).collect();
            let mut bbox = RingBBox {
                min_x: f64::INFINITY,
                min_y: f64::INFINITY,
                max_x: f64::NEG_INFINITY,
                max_y: f64::NEG_INFINITY,
            };
            for &(x, y) in &points {
                bbox.min_x = bbox.min_x.min(x);
                bbox.min_y = bbox.min_y.min(y);
                bbox.max_x = bbox.max_x.max(x);
                bbox.max_y = bbox.max_y.max(y);
            }
            RawRing {
                height: c.height,
                points,
                bbox,
            }
        })
        .collect();

    let tree_roots = build_containment_tree(&rings);

    let mut to_remove = HashSet::new();
    find_zero_orphans_recursive(&tree_roots, &rings, default_depth, &mut to_remove);

    if !to_remove.is_empty() {
        let mut idx = 0;
        contours.retain(|_| {
            let keep = !to_remove.contains(&idx);
            idx += 1;
            keep
        });
    }
}

fn find_zero_orphans_recursive(
    nodes: &[ContourNode],
    rings: &[RawRing],
    parent_height: f64,
    result: &mut HashSet<usize>,
) {
    for node in nodes {
        let height = rings[node.ring_index].height;
        let crosses_zero =
            (height > 0.0 && parent_height < 0.0) || (height < 0.0 && parent_height > 0.0);
        if crosses_zero {
            collect_subtree(node, result);
        } else {
            find_zero_orphans_recursive(&node.children, rings, height, result);
        }
    }
}

fn collect_subtree(node: &ContourNode, result: &mut HashSet<usize>) {
    result.insert(node.ring_index);
    for child in &node.children {
        collect_subtree(child, result);
    }
}

fn bfs_order(roots: &[ContourNode]) -> Vec<usize> {
    let mut order = Vec::new();
    let mut queue: Vec<ContourNode> = roots.to_vec();
    let mut qi = 0usize;

    while qi < queue.len() {
        let node = queue[qi].clone();
        qi += 1;

        order.push(node.ring_index);
        queue.extend(node.children);
    }

    order
}

fn write_level_file(output_path: &Path, contours: Vec<TerrainContourJson>) -> Result<()> {
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create {}", parent.display()))?;
    }

    let level = LevelJson {
        version: 1,
        default_depth: DEFAULT_DEPTH,
        contours,
    };

    let file = File::create(output_path)
        .with_context(|| format!("Failed to create {}", output_path.display()))?;
    let writer = BufWriter::new(file);
    serde_json::to_writer_pretty(writer, &level)
        .with_context(|| format!("Failed to write {}", output_path.display()))?;
    Ok(())
}

fn print_block_index_stats(blocks: &BlockIndex, elapsed_ms: f64) {
    println!(
        "Block index: {}x{} blocks  ({}ms)",
        format_int(blocks.block_cols),
        format_int(blocks.block_rows),
        format_int(elapsed_ms.round() as u64)
    );
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

fn round6(v: f64) -> f64 {
    (v * 1_000_000.0).round() / 1_000_000.0
}
