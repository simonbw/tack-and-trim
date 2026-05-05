//! Diagnostic tool: renders terrain height as PNG images to visually compare
//! the IDW grid-accelerated path vs. the brute-force fallback path.
//!
//! Produces three images:
//!   - terrain_with_grid.png    — height from the normal (grid-accelerated) path
//!   - terrain_without_grid.png — height from the brute-force fallback path
//!   - terrain_diff.png         — amplified absolute difference between the two
//!
//! Usage:
//!   cargo run -p pipeline-core --features image --bin idw-grid-check -- <path-to-level-file> [resolution]
//!
//! Examples:
//!   cargo run -p pipeline-core --features image --bin idw-grid-check -- resources/levels/default.level.json
//!   cargo run -p pipeline-core --features image --bin idw-grid-check -- resources/levels/default.level.json 2048

use std::path::Path;
use std::time::Instant;

use image::{GrayImage, Luma, Rgb, RgbImage};
use pipeline_core::level::{build_terrain_data, parse_level_file, resolve_level_terrain};
use pipeline_core::terrain::{
    compute_terrain_height_and_gradient_ex, parse_contours, ParsedContour,
};

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!(
            "Usage: {} <path-to-level-file> [resolution]",
            args[0]
        );
        eprintln!();
        eprintln!("Examples:");
        eprintln!("  cargo run -p pipeline-core --features image --bin idw-grid-check -- resources/levels/default.level.json");
        eprintln!("  cargo run -p pipeline-core --features image --bin idw-grid-check -- resources/levels/default.level.json 2048");
        std::process::exit(1);
    }

    let level_path = Path::new(&args[1]);
    let resolution: u32 = if args.len() >= 3 {
        args[2].parse().unwrap_or(1024)
    } else {
        1024
    };

    // Load and parse level
    let json_str = std::fs::read_to_string(level_path)
        .map_err(|e| anyhow::anyhow!("Failed to read {}: {}", level_path.display(), e))?;
    let mut level = parse_level_file(&json_str)?;
    resolve_level_terrain(&mut level, level_path)?;

    if level.contours.is_empty() {
        anyhow::bail!("Level has no contours");
    }

    println!("Loaded {} contours from {}", level.contours.len(), level_path.display());

    // Build terrain data
    let terrain = build_terrain_data(&level);
    let (contours, lookup_grid) = parse_contours(&terrain);

    // Count contours with IDW grids and children
    let with_grid = contours.iter().filter(|c| c.idw_grid.is_some()).count();
    let with_children = contours.iter().filter(|c| c.child_count > 0).count();
    println!(
        "  {} contours total, {} with children, {} with IDW grids",
        contours.len(),
        with_children,
        with_grid
    );

    // Compute bounding box from all contours
    let (min_x, min_y, max_x, max_y) = compute_bounds(&contours);
    let width = max_x - min_x;
    let height = max_y - min_y;

    // Determine image dimensions preserving aspect ratio
    let (img_w, img_h) = if width > height {
        let h = ((resolution as f64) * height / width).round() as u32;
        (resolution, h.max(1))
    } else {
        let w = ((resolution as f64) * width / height).round() as u32;
        (w.max(1), resolution)
    };

    // Add a small margin (5%) to avoid clipping contour edges
    let margin = 0.05;
    let render_min_x = min_x - width * margin;
    let render_min_y = min_y - height * margin;
    let render_w = width * (1.0 + 2.0 * margin);
    let render_h = height * (1.0 + 2.0 * margin);

    println!("Rendering {}x{} images...", img_w, img_h);
    println!(
        "  Terrain bounds: ({:.1}, {:.1}) to ({:.1}, {:.1})",
        min_x, min_y, max_x, max_y
    );

    // Render with grid (normal path)
    let t0 = Instant::now();
    let heights_grid = render_height_field(
        img_w,
        img_h,
        render_min_x,
        render_min_y,
        render_w,
        render_h,
        &terrain,
        &contours,
        &lookup_grid,
        true,
    );
    let elapsed_grid = t0.elapsed();
    println!("  With grid:    {:.1}s", elapsed_grid.as_secs_f64());

    // Render without grid (fallback path)
    let t0 = Instant::now();
    let heights_fallback = render_height_field(
        img_w,
        img_h,
        render_min_x,
        render_min_y,
        render_w,
        render_h,
        &terrain,
        &contours,
        &lookup_grid,
        false,
    );
    let elapsed_fallback = t0.elapsed();
    println!("  Without grid: {:.1}s", elapsed_fallback.as_secs_f64());

    // Compute global height range for consistent colorization
    let (h_min, h_max) = {
        let mut lo = f64::MAX;
        let mut hi = f64::MIN;
        for &h in heights_grid.iter().chain(heights_fallback.iter()) {
            if h < lo {
                lo = h;
            }
            if h > hi {
                hi = h;
            }
        }
        (lo, hi)
    };
    println!(
        "  Height range: {:.2} to {:.2}",
        h_min, h_max
    );

    // Compute difference statistics
    let mut max_diff: f64 = 0.0;
    let mut sum_diff: f64 = 0.0;
    let mut nonzero_count: usize = 0;
    let total_pixels = (img_w * img_h) as usize;
    let diffs: Vec<f64> = heights_grid
        .iter()
        .zip(heights_fallback.iter())
        .map(|(&a, &b)| {
            let d = (a - b).abs();
            if d > max_diff {
                max_diff = d;
            }
            if d > 1e-12 {
                sum_diff += d;
                nonzero_count += 1;
            }
            d
        })
        .collect();

    let mean_diff = if nonzero_count > 0 {
        sum_diff / nonzero_count as f64
    } else {
        0.0
    };

    println!();
    println!("Difference statistics:");
    println!("  Max absolute diff: {:.6e}", max_diff);
    println!(
        "  Mean diff (non-zero pixels): {:.6e} ({} of {} pixels differ)",
        mean_diff, nonzero_count, total_pixels
    );

    // Save heightmap images
    let stem = level_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .replace(".level", "");
    let out_dir = level_path.parent().unwrap_or(Path::new("."));

    let grid_path = out_dir.join(format!("{}_terrain_with_grid.png", stem));
    let fallback_path = out_dir.join(format!("{}_terrain_without_grid.png", stem));
    let diff_path = out_dir.join(format!("{}_terrain_diff.png", stem));

    save_heightmap(&heights_grid, img_w, img_h, h_min, h_max, &grid_path)?;
    println!("Saved: {}", grid_path.display());

    save_heightmap(
        &heights_fallback,
        img_w,
        img_h,
        h_min,
        h_max,
        &fallback_path,
    )?;
    println!("Saved: {}", fallback_path.display());

    save_diff_image(&diffs, img_w, img_h, max_diff, &diff_path)?;
    println!("Saved: {}", diff_path.display());

    if max_diff < 1e-10 {
        println!();
        println!("Result: IDENTICAL — grid and fallback produce the same heights.");
    } else {
        println!();
        println!(
            "Result: DIFFERENCES FOUND — max {:.6e}, check {} for visualization.",
            max_diff,
            diff_path.display()
        );
    }

    Ok(())
}

fn compute_bounds(contours: &[ParsedContour]) -> (f64, f64, f64, f64) {
    let mut min_x = f64::MAX;
    let mut min_y = f64::MAX;
    let mut max_x = f64::MIN;
    let mut max_y = f64::MIN;
    for c in contours {
        min_x = min_x.min(c.bbox_min_x as f64);
        min_y = min_y.min(c.bbox_min_y as f64);
        max_x = max_x.max(c.bbox_max_x as f64);
        max_y = max_y.max(c.bbox_max_y as f64);
    }
    (min_x, min_y, max_x, max_y)
}

fn render_height_field(
    img_w: u32,
    img_h: u32,
    render_min_x: f64,
    render_min_y: f64,
    render_w: f64,
    render_h: f64,
    terrain: &pipeline_core::level::TerrainCPUData,
    contours: &[ParsedContour],
    lookup_grid: &pipeline_core::terrain::ContourLookupGrid,
    use_idw_grid: bool,
) -> Vec<f64> {
    use rayon::prelude::*;

    let img_w = img_w as usize;
    let img_h = img_h as usize;

    (0..img_h)
        .into_par_iter()
        .flat_map_iter(move |row| {
            (0..img_w).map(move |col| {
                let px = render_min_x + (col as f64 + 0.5) / img_w as f64 * render_w;
                let py = render_min_y + (row as f64 + 0.5) / img_h as f64 * render_h;
                let result = compute_terrain_height_and_gradient_ex(
                    px,
                    py,
                    terrain,
                    contours,
                    lookup_grid,
                    use_idw_grid,
                );
                result.height
            })
        })
        .collect()
}

fn save_heightmap(
    heights: &[f64],
    img_w: u32,
    img_h: u32,
    h_min: f64,
    h_max: f64,
    path: &Path,
) -> anyhow::Result<()> {
    let range = (h_max - h_min).max(1e-9);
    let mut img = GrayImage::new(img_w, img_h);
    for (i, &h) in heights.iter().enumerate() {
        let x = (i as u32) % img_w;
        let y = (i as u32) / img_w;
        // Map height to 0-255: deeper = darker, higher = lighter
        let normalized = ((h - h_min) / range).clamp(0.0, 1.0);
        let pixel = (normalized * 255.0).round() as u8;
        img.put_pixel(x, y, Luma([pixel]));
    }
    img.save(path)
        .map_err(|e| anyhow::anyhow!("Failed to save {}: {}", path.display(), e))?;
    Ok(())
}

fn save_diff_image(
    diffs: &[f64],
    img_w: u32,
    img_h: u32,
    max_diff: f64,
    path: &Path,
) -> anyhow::Result<()> {
    let mut img = RgbImage::new(img_w, img_h);

    if max_diff < 1e-12 {
        // No differences — save all-black image
        img.save(path)
            .map_err(|e| anyhow::anyhow!("Failed to save {}: {}", path.display(), e))?;
        return Ok(());
    }

    // Use a heat-map style colorization for the diff:
    // - Black = zero difference
    // - Blue = tiny difference
    // - Green = moderate difference
    // - Yellow = significant difference
    // - Red = maximum difference
    //
    // Scale uses log10 to reveal tiny differences.
    // We map log10(diff) from [log10(max_diff) - 6, log10(max_diff)] to [0, 1].
    let log_max = max_diff.log10();
    let log_min = log_max - 6.0; // 6 orders of magnitude of dynamic range

    for (i, &d) in diffs.iter().enumerate() {
        let x = (i as u32) % img_w;
        let y = (i as u32) / img_w;

        if d < 1e-15 {
            img.put_pixel(x, y, Rgb([0, 0, 0]));
            continue;
        }

        let log_d = d.log10();
        let t = ((log_d - log_min) / (log_max - log_min)).clamp(0.0, 1.0);

        // Heat map: black -> blue -> cyan -> green -> yellow -> red
        let (r, g, b) = heatmap(t);
        img.put_pixel(x, y, Rgb([r, g, b]));
    }

    img.save(path)
        .map_err(|e| anyhow::anyhow!("Failed to save {}: {}", path.display(), e))?;
    Ok(())
}

/// Map t in [0, 1] to a heat map color.
fn heatmap(t: f64) -> (u8, u8, u8) {
    // 5-stop gradient: black -> blue -> cyan -> yellow -> red
    let (r, g, b) = if t < 0.25 {
        let s = t / 0.25;
        (0.0, 0.0, s) // black -> blue
    } else if t < 0.5 {
        let s = (t - 0.25) / 0.25;
        (0.0, s, 1.0) // blue -> cyan
    } else if t < 0.75 {
        let s = (t - 0.5) / 0.25;
        (s, 1.0, 1.0 - s) // cyan -> yellow
    } else {
        let s = (t - 0.75) / 0.25;
        (1.0, 1.0 - s, 0.0) // yellow -> red
    };
    (
        (r * 255.0).round() as u8,
        (g * 255.0).round() as u8,
        (b * 255.0).round() as u8,
    )
}
