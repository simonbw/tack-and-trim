use std::collections::HashSet;
use std::path::Path;

use anyhow::{bail, Context, Result};
use gdal::Dataset;
use rayon::prelude::*;

use pipeline_core::humanize::format_int;
use pipeline_core::level::ElevationSchedule;
use pipeline_core::polygon_math::{point_in_polygon_tuples, ring_perimeter_tuples, signed_area_tuples};
use pipeline_core::step::{format_ms, StepView};

use crate::constrained_simplify::constrained_simplify_closed_ring;
use crate::geo::{bbox_center, lat_lon_to_feet, meters_to_feet, point_in_latlon_polygon};
use crate::marching_squares::{build_block_index, build_closed_rings, march_contours, ScalarGrid};
use crate::region::{
    display_path, grid_cache_dir, load_region_config, resolve_region, terrain_output_path,
};
use crate::segment_index::SegmentIndex;
use crate::validate::validate_terrain_binary;

/// 2D point as `(x, y)`. Canonical ring representation in build-level.
type Point = (f64, f64);

const DEFAULT_DEPTH: f64 = -300.0;

struct TerrainContourJson {
    height: f64,
    polygon: Vec<[f64; 2]>,
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
    seam_fills: usize,
    depth_fills: usize,
}

pub fn run_extract(region_arg: Option<&str>, view: &StepView) -> Result<()> {
    let slug = resolve_region(region_arg)?;
    let config = load_region_config(&slug)?;

    let merged_path = grid_cache_dir(&slug).join("merged.tif");
    if !merged_path.exists() {
        bail!(
            "No merged grid found at {}. Run build-grid step first.",
            merged_path.display()
        );
    }

    let mut loaded = load_merged_grid(&merged_path, view)?;

    view.info(format!("Region: {}", slug));
    view.info(format!(
        "Settings: interval {}, simplify {}, scale {}, minPerimeter {}ft, minPoints {}",
        format_schedule(&config.interval, "ft"),
        format_schedule(&config.simplify, "ft"),
        config.scale,
        config.min_perimeter,
        format_int(config.min_points)
    ));

    // When polygon bounds are specified, mask grid cells outside the polygon
    // to DEFAULT_DEPTH so marching squares never generates contours there.
    if let Some(ref bounds) = config.bounds {
        let (masked_count, new_min, new_max) = view.run_step(
            "Masking grid to polygon bounds",
            || {
                mask_grid_to_polygon(
                    &mut loaded.grid,
                    loaded.origin_lon,
                    loaded.origin_lat,
                    loaded.lon_step,
                    loaded.lat_step,
                    bounds,
                )
            },
            |(masked, _, _), d| {
                format!(
                    "Masked {} cells outside polygon ({}ms)",
                    format_int(*masked),
                    format_ms(d)
                )
            },
        );
        if masked_count > 0 {
            loaded.min_feet = new_min;
            loaded.max_feet = new_max;
        }
    }

    let effective_bbox = config.effective_bbox();
    let clamped_min = loaded.min_feet.max(DEFAULT_DEPTH);
    let levels = quantize_levels(clamped_min, loaded.max_feet, &config.interval);
    let (center_lat, center_lon) = bbox_center(&effective_bbox);

    let bbox_min_lon = loaded.origin_lon - loaded.lon_step;
    let bbox_max_lat = loaded.origin_lat + loaded.lat_step;

    let blocks = view.run_step(
        "Building block index",
        || build_block_index(&loaded.grid),
        |blocks, d| {
            format!(
                "Block index: {}x{} blocks  ({}ms)",
                format_int(blocks.block_cols),
                format_int(blocks.block_rows),
                format_ms(d)
            )
        },
    );

    let all_rings = view.run_step_with_progress(
        "Marching contours",
        Some(levels.len()),
        |progress| {
            // Process each level in parallel, then flatten in level order.
            let per_level: Vec<Vec<RawRing>> = levels
                .par_iter()
                .map(|level_feet| {
                    let segments = march_contours(&loaded.grid, &blocks, *level_feet);
                    let rings = build_closed_rings(&segments);

                    let mut level_rings = Vec::new();
                    for ring in rings {
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
                            let (x_feet, y_feet) =
                                lat_lon_to_feet(lat, lon, center_lat, center_lon);
                            let fy = if config.flip_y { -y_feet } else { y_feet };
                            feet_points.push((x_feet, fy));

                            bbox.min_x = bbox.min_x.min(x_feet);
                            bbox.max_x = bbox.max_x.max(x_feet);
                            bbox.min_y = bbox.min_y.min(fy);
                            bbox.max_y = bbox.max_y.max(fy);
                        }

                        if ring_perimeter_tuples(&feet_points) < config.min_perimeter {
                            continue;
                        }
                        if feet_points.len() < config.min_points {
                            continue;
                        }

                        level_rings.push(RawRing {
                            height: *level_feet,
                            points: feet_points,
                            bbox,
                        });
                    }

                    progress.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    level_rings
                })
                .collect();

            per_level.into_iter().flatten().collect()
        },
        |rings: &Vec<RawRing>, d| {
            format!(
                "Marched {} levels → {} rings ({}ms)",
                format_int(levels.len()),
                format_int(rings.len()),
                format_ms(d)
            )
        },
    );

    if all_rings.is_empty() {
        let output_path = terrain_output_path(&slug);
        write_terrain_file(&output_path, Vec::new())?;
        view.info(format!(
            "Wrote empty contour set to {}",
            display_path(&output_path)
        ));
        return Ok(());
    }

    let tree_roots = view.run_step(
        "Building containment tree",
        || build_containment_tree(&all_rings),
        |roots, d| {
            format!(
                "Containment tree: {} roots ({}ms)",
                format_int(roots.len()),
                format_ms(d)
            )
        },
    );

    let order = bfs_order(&tree_roots);

    let contours = view.run_step(
        "Simplifying contours",
        || {
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

            let mut seg_index = SegmentIndex::new(
                g_min_x,
                g_min_y,
                g_max_x,
                g_max_y,
                cell_size,
                all_rings.len(),
            );
            for (idx, ring) in all_rings.iter().enumerate() {
                seg_index.add_contour_segments(idx, &ring.points);
            }

            let mut contours = Vec::new();

            for ring_idx in order {
                let ring = &all_rings[ring_idx];
                let tolerance = config.simplify.interp_at(ring.height);
                let simplified = constrained_simplify_closed_ring(
                    &ring.points,
                    tolerance,
                    ring_idx,
                    &seg_index,
                );

                if simplified.len() < config.min_points {
                    continue;
                }

                seg_index.remove_contour_segments(ring_idx);
                seg_index.add_contour_segments(ring_idx, &simplified);

                let mut scaled: Vec<Point> = simplified
                    .iter()
                    .map(|(x, y)| (x / config.scale, y / config.scale))
                    .collect();

                if signed_area_tuples(&scaled) < 0.0 {
                    scaled.reverse();
                }

                contours.push(TerrainContourJson {
                    height: round3(ring.height),
                    polygon: scaled
                        .iter()
                        .map(|(x, y)| [round3(*x), round3(*y)])
                        .collect(),
                });
            }

            contours
        },
        |contours, d| {
            let final_points: usize = contours.iter().map(|c| c.polygon.len()).sum();
            format!(
                "Simplified: {} → {} contours ({} pts, {}ms)",
                format_int(all_rings.len()),
                format_int(contours.len()),
                format_int(final_points),
                format_ms(d)
            )
        },
    );

    let mut contours = contours;
    contours.sort_by(|a, b| {
        a.height
            .partial_cmp(&b.height)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                let pa = a.polygon.first().unwrap_or(&[0.0, 0.0]);
                let pb = b.polygon.first().unwrap_or(&[0.0, 0.0]);
                pa[0].total_cmp(&pb[0]).then(pa[1].total_cmp(&pb[1]))
            })
    });

    let pre_prune = contours.len();
    prune_zero_crossing_orphans(&mut contours, DEFAULT_DEPTH);
    let pruned = pre_prune - contours.len();
    if pruned > 0 {
        view.info(format!(
            "Pruned {} contour(s) orphaned by missing 0ft intermediate",
            format_int(pruned)
        ));
    }

    let output_path = terrain_output_path(&slug);
    view.try_run_step(
        "Writing terrain file",
        || write_terrain_file(&output_path, contours),
        |_, d| {
            format!(
                "Wrote contours to {}  ({}ms)",
                display_path(&output_path),
                format_ms(d)
            )
        },
    )?;

    let validation = view.try_run_step(
        "Validating output",
        || validate_terrain_binary(&output_path),
        |v, d| {
            let mut msg = format!(
                "Validated: {} contours, {} roots, max depth {} ({}ms)",
                format_int(v.contour_count),
                format_int(v.root_count),
                format_int(v.max_depth),
                format_ms(d)
            );
            if !v.warnings.is_empty() {
                for w in &v.warnings {
                    msg.push_str(&format!("\n  WARNING: {w}"));
                }
            }
            if v.errors.is_empty() {
                msg.push_str(" — PASS");
            } else {
                msg.push_str(&format!(" — FAIL: {} error(s)", format_int(v.errors.len())));
                for e in &v.errors {
                    msg.push_str(&format!("\n  [{:?}] {}", e.error_type, e.message));
                }
            }
            msg
        },
    )?;

    if !validation.errors.is_empty() {
        bail!("extracted level failed validation");
    }

    Ok(())
}

fn load_merged_grid(merged_path: &Path, view: &StepView) -> Result<LoadedGrid> {
    let merged_display = display_path(merged_path);

    let (width, height, transform, no_data_value, raw_data) = view.try_run_step(
        &format!("Reading raster from {merged_display}"),
        || -> Result<_> {
            let dataset = Dataset::open(merged_path)
                .with_context(|| format!("Failed to open {}", merged_path.display()))?;
            let band = dataset
                .rasterband(1)
                .context("Failed to read raster band 1")?;
            let (w, h) = band.size();
            let tf = dataset.geo_transform().context("Missing geotransform")?;
            let ndv = band.no_data_value();
            let buf = band
                .read_as::<f64>((0, 0), (w, h), (w, h), None)
                .context("Failed to read raster")?;
            Ok((w, h, tf, ndv, buf))
        },
        |(w, h, ..), d| {
            format!(
                "Read raster: {}x{} ({}ms)",
                format_int(*w),
                format_int(*h),
                format_ms(d)
            )
        },
    )?;

    let loaded = view.run_step(
        "Processing grid",
        || {
            let pad_w = width + 2;
            let pad_h = height + 2;
            let raw = raw_data.data();

            // Pass 1 (parallel): convert to feet, write directly into padded buffer.
            // Use NAN as sentinel for nodata cells; border stays DEFAULT_DEPTH.
            let mut padded = vec![DEFAULT_DEPTH; pad_w * pad_h];
            padded
                .par_chunks_mut(pad_w)
                .skip(1)
                .take(height)
                .enumerate()
                .for_each(|(src_y, pad_row)| {
                    let row_start = src_y * width;
                    for x in 0..width {
                        let v = raw[row_start + x];
                        if !v.is_finite()
                            || no_data_value
                                .map(|nd| (v - nd).abs() < 1e-6)
                                .unwrap_or(false)
                        {
                            pad_row[x + 1] = f64::NAN;
                        } else {
                            pad_row[x + 1] = meters_to_feet(v);
                        }
                    }
                });

            // Pass 2 (sequential): seam fill — interpolate single-row nodata gaps.
            // Only ~2,581 cells on this dataset, so sequential is fine.
            let mut seam_fills = 0usize;
            for y in 2..pad_h.saturating_sub(2) {
                for x in 1..=width {
                    let idx = y * pad_w + x;
                    if !padded[idx].is_nan() {
                        continue;
                    }
                    let above = (y - 1) * pad_w + x;
                    let below = (y + 1) * pad_w + x;
                    if !padded[above].is_nan() && !padded[below].is_nan() {
                        padded[idx] = (padded[above] + padded[below]) * 0.5;
                        seam_fills += 1;
                    }
                }
            }

            // Pass 3 (parallel): replace remaining NAN with DEFAULT_DEPTH, compute min/max.
            let (min_feet, max_feet, depth_fills) = padded
                .par_chunks_mut(pad_w)
                .skip(1)
                .take(height)
                .map(|pad_row| {
                    let mut local_min = f64::INFINITY;
                    let mut local_max = f64::NEG_INFINITY;
                    let mut local_fills = 0usize;
                    for x in 1..=width {
                        if pad_row[x].is_nan() {
                            pad_row[x] = DEFAULT_DEPTH;
                            local_fills += 1;
                        }
                        local_min = local_min.min(pad_row[x]);
                        local_max = local_max.max(pad_row[x]);
                    }
                    (local_min, local_max, local_fills)
                })
                .reduce(
                    || (f64::INFINITY, f64::NEG_INFINITY, 0usize),
                    |(min1, max1, f1), (min2, max2, f2)| (min1.min(min2), max1.max(max2), f1 + f2),
                );

            LoadedGrid {
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
                seam_fills,
                depth_fills,
            }
        },
        |loaded, d| {
            let mut msg = format!(
                "Processed grid: {:.1}ft to {:.1}ft ({}ms)",
                loaded.min_feet,
                loaded.max_feet,
                format_ms(d)
            );
            if loaded.seam_fills > 0 {
                msg.push_str(&format!(", {} seam fills", format_int(loaded.seam_fills)));
            }
            if loaded.depth_fills > 0 {
                msg.push_str(&format!(", {} depth fills", format_int(loaded.depth_fills)));
            }
            msg
        },
    );

    Ok(loaded)
}

/// Generate contour levels across [min, max] using an elevation schedule.
///
/// Levels are anchored at 0 ft and walked outward, using `schedule.step_at(h)`
/// to determine the spacing at each height. This keeps the 0 ft coastline
/// always on the grid, and makes every band sample at a consistent phase.
/// One "cap" level is added on each end if min/max don't align exactly with
/// the grid (needed so the containment tree closes cleanly at boundaries).
fn quantize_levels(min: f64, max: f64, schedule: &ElevationSchedule) -> Vec<f64> {
    if !min.is_finite() || !max.is_finite() || min > max {
        return Vec::new();
    }
    let eps = 1e-9;
    let mut candidates: Vec<f64> = Vec::new();

    // Upward walk from 0. Sample a bit past max so we have a cap level available.
    let upper_cap = max + schedule.step_at(max.max(0.0)) * 1.1;
    let mut level = 0.0f64;
    while level <= upper_cap + eps {
        candidates.push(round6(level));
        let step = schedule.step_at(level);
        if !(step > 0.0) || !step.is_finite() {
            break;
        }
        level += step;
    }

    // Downward walk from 0.
    let lower_cap = min - schedule.step_at(min.min(0.0) - eps) * 1.1;
    let mut level = 0.0f64;
    loop {
        let step = schedule.step_at(level - eps);
        if !(step > 0.0) || !step.is_finite() {
            break;
        }
        level -= step;
        if level < lower_cap - eps {
            break;
        }
        candidates.push(round6(level));
    }

    candidates.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    candidates.dedup_by(|a, b| (*a - *b).abs() < 1e-6);

    let first_in = candidates.iter().position(|&l| l >= min - eps);
    let last_in = candidates.iter().rposition(|&l| l <= max + eps);
    let (first, last) = match (first_in, last_in) {
        (Some(f), Some(l)) if f <= l => (f, l),
        _ => return Vec::new(),
    };

    // Extend by one cap on each side if min/max aren't aligned to the grid.
    let start_idx = if first > 0 && (candidates[first] - min).abs() > eps {
        first - 1
    } else {
        first
    };
    let end_idx = if last + 1 < candidates.len() && (candidates[last] - max).abs() > eps {
        last + 1
    } else {
        last
    };

    candidates[start_idx..=end_idx].to_vec()
}

fn format_schedule(schedule: &ElevationSchedule, unit: &str) -> String {
    if schedule.is_scalar() {
        format!("{}{}", schedule.breakpoints()[0].1, unit)
    } else {
        let bps = schedule.breakpoints();
        let min_h = bps.first().map(|p| p.0).unwrap_or(0.0);
        let max_h = bps.last().map(|p| p.0).unwrap_or(0.0);
        format!(
            "{}-band schedule over {}..{}ft",
            bps.len(),
            min_h,
            max_h
        )
    }
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
        point_in_polygon_tuples(px, py, &rings[outer_idx].points)
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

/// Build terrain CPU data from polygon contours and write as v2 binary format.
fn write_terrain_file(output_path: &Path, contours: Vec<TerrainContourJson>) -> Result<()> {
    let polygon_contours: Vec<pipeline_core::level::PolygonContour> = contours
        .into_iter()
        .map(|c| pipeline_core::level::PolygonContour {
            height: c.height,
            polygon: c.polygon,
        })
        .collect();

    let terrain =
        pipeline_core::level::build_terrain_data_from_polygons(&polygon_contours, DEFAULT_DEPTH);
    pipeline_core::level::write_terrain_binary(output_path, &terrain)?;

    Ok(())
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

fn round6(v: f64) -> f64 {
    (v * 1_000_000.0).round() / 1_000_000.0
}

/// Mask grid cells outside the polygon to DEFAULT_DEPTH.
/// Returns (masked_count, new_min_feet, new_max_feet).
fn mask_grid_to_polygon(
    grid: &mut ScalarGrid,
    origin_lon: f64,
    origin_lat: f64,
    lon_step: f64,
    lat_step: f64,
    polygon: &[[f64; 2]],
) -> (usize, f64, f64) {
    // The grid has a 1-cell padding border. Interior cells start at (1,1).
    // Grid coords to lat/lon (matching load_merged_grid's transform):
    //   lon = (origin_lon - lon_step) + gx * lon_step
    //   lat = (origin_lat + lat_step) - gy * lat_step
    let base_lon = origin_lon - lon_step;
    let base_lat = origin_lat + lat_step;

    let width = grid.width;

    use rayon::prelude::*;

    let results: Vec<(usize, f64, f64)> = grid
        .values
        .par_chunks_mut(width)
        .enumerate()
        .map(|(gy, row)| {
            let lat = base_lat - (gy as f64) * lat_step;
            let mut masked = 0usize;
            let mut row_min = f64::INFINITY;
            let mut row_max = f64::NEG_INFINITY;
            for gx in 0..width {
                let lon = base_lon + (gx as f64) * lon_step;
                if !point_in_latlon_polygon(lat, lon, polygon) {
                    if row[gx] != DEFAULT_DEPTH {
                        row[gx] = DEFAULT_DEPTH;
                        masked += 1;
                    }
                }
                row_min = row_min.min(row[gx]);
                row_max = row_max.max(row[gx]);
            }
            (masked, row_min, row_max)
        })
        .collect();

    let mut total_masked = 0usize;
    let mut min_feet = f64::INFINITY;
    let mut max_feet = f64::NEG_INFINITY;
    for (m, rmin, rmax) in results {
        total_masked += m;
        min_feet = min_feet.min(rmin);
        max_feet = max_feet.max(rmax);
    }

    (total_masked, min_feet, max_feet)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schedule_from(pairs: &[(f64, f64)]) -> ElevationSchedule {
        ElevationSchedule::from_breakpoints(pairs.to_vec()).expect("valid schedule")
    }

    fn approx_eq(a: &[f64], b: &[f64]) -> bool {
        a.len() == b.len() && a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-6)
    }

    #[test]
    fn scalar_matches_old_uniform_behavior() {
        let s = ElevationSchedule::scalar(5.0);
        // Old code for (min=-12, max=17, interval=5): start=-15, end=20 inclusive.
        let levels = quantize_levels(-12.0, 17.0, &s);
        let expected = vec![-15.0, -10.0, -5.0, 0.0, 5.0, 10.0, 15.0, 20.0];
        assert!(approx_eq(&levels, &expected), "got {:?}", levels);
    }

    #[test]
    fn scalar_with_aligned_boundaries() {
        // When min/max land exactly on a grid line, no caps are added.
        let s = ElevationSchedule::scalar(25.0);
        let levels = quantize_levels(0.0, 300.0, &s);
        assert!((levels.first().copied().unwrap_or(f64::NAN) - 0.0).abs() < 1e-6);
        assert!((levels.last().copied().unwrap_or(f64::NAN) - 300.0).abs() < 1e-6);
        assert_eq!(levels.len(), 13);
    }

    #[test]
    fn scalar_entirely_underwater_range() {
        let s = ElevationSchedule::scalar(5.0);
        let levels = quantize_levels(-12.0, -5.0, &s);
        let expected = vec![-15.0, -10.0, -5.0];
        assert!(approx_eq(&levels, &expected), "got {:?}", levels);
    }

    #[test]
    fn scalar_entirely_above_range() {
        let s = ElevationSchedule::scalar(25.0);
        let levels = quantize_levels(5.0, 100.0, &s);
        // Matches old: start=0, end=100, pushes 0,25,50,75,100
        let expected = vec![0.0, 25.0, 50.0, 75.0, 100.0];
        assert!(approx_eq(&levels, &expected), "got {:?}", levels);
    }

    #[test]
    fn schedule_dense_near_sea_level() {
        let s = schedule_from(&[(-300.0, 50.0), (-50.0, 10.0), (0.0, 5.0), (25.0, 25.0)]);
        let levels = quantize_levels(-300.0, 100.0, &s);
        // 0 ft must be present.
        assert!(levels.iter().any(|&l| (l - 0.0).abs() < 1e-6));
        // Near sea level (0-25) should have 5 ft spacing.
        let near_zero: Vec<f64> = levels.iter().copied().filter(|&l| (0.0..=25.0).contains(&l)).collect();
        let expected_near_zero = vec![0.0, 5.0, 10.0, 15.0, 20.0, 25.0];
        assert!(approx_eq(&near_zero, &expected_near_zero), "near zero: {:?}", near_zero);
        // Deep water (-50 to -300) should have 50 ft spacing.
        let deep: Vec<f64> = levels.iter().copied().filter(|&l| l <= -50.0).collect();
        let expected_deep = vec![-300.0, -250.0, -200.0, -150.0, -100.0, -50.0];
        assert!(approx_eq(&deep, &expected_deep), "deep: {:?}", deep);
        // Mid water (-50 to 0) should have 10 ft spacing.
        let mid: Vec<f64> = levels.iter().copied()
            .filter(|&l| (-50.0 < l) && (l < 0.0))
            .collect();
        let expected_mid = vec![-40.0, -30.0, -20.0, -10.0];
        assert!(approx_eq(&mid, &expected_mid), "mid: {:?}", mid);
        // Above 25 ft (up to 100) should have 25 ft spacing.
        let above: Vec<f64> = levels.iter().copied().filter(|&l| l > 25.0).collect();
        let expected_above = vec![50.0, 75.0, 100.0];
        assert!(approx_eq(&above, &expected_above), "above: {:?}", above);
    }

    #[test]
    fn schedule_monotonic_ascending() {
        let s = schedule_from(&[(-300.0, 50.0), (-50.0, 10.0), (0.0, 5.0), (25.0, 25.0)]);
        let levels = quantize_levels(-300.0, 500.0, &s);
        for pair in levels.windows(2) {
            assert!(pair[1] > pair[0], "not strictly increasing: {:?}", pair);
        }
    }

    #[test]
    fn schedule_covers_range() {
        let s = schedule_from(&[(-300.0, 50.0), (-50.0, 10.0), (0.0, 5.0), (25.0, 25.0)]);
        let levels = quantize_levels(-250.0, 200.0, &s);
        // First level should be at or just below min.
        assert!(levels.first().copied().unwrap() <= -250.0);
        // Last level should be at or just above max.
        assert!(levels.last().copied().unwrap() >= 200.0);
    }

    #[test]
    fn empty_range_returns_empty() {
        let s = ElevationSchedule::scalar(5.0);
        let levels = quantize_levels(10.0, 5.0, &s);
        assert!(levels.is_empty());
        let levels = quantize_levels(f64::NAN, 5.0, &s);
        assert!(levels.is_empty());
    }
}
