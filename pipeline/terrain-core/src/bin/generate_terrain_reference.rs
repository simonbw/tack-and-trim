//! Generates a JSON file with reference terrain height/gradient values for
//! a grid of sample points. Intended for cross-validation against the GPU
//! terrain shader (which operates in f32).
//!
//! Usage:
//!   cargo run -p terrain-core --bin generate-terrain-reference -- <path-to-level-file> <output-json-path>
//!
//! Example:
//!   cargo run -p terrain-core --bin generate-terrain-reference -- resources/levels/default.level.json reference.json

use std::path::Path;

use serde::Serialize;
use terrain_core::level::{build_terrain_data, parse_level_file, resolve_level_terrain};
use terrain_core::terrain::{
    compute_terrain_height_and_gradient_ex, parse_contours, ParsedContour,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReferenceOutput {
    level: String,
    default_depth: f32,
    contour_count: usize,
    points: Vec<ReferencePoint>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ReferencePoint {
    x: f32,
    y: f32,
    height: f32,
    gradient_x: f32,
    gradient_y: f32,
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

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!(
            "Usage: {} <path-to-level-file> <output-json-path>",
            args[0]
        );
        eprintln!();
        eprintln!("Example:");
        eprintln!("  cargo run -p terrain-core --bin generate-terrain-reference -- resources/levels/default.level.json reference.json");
        std::process::exit(1);
    }

    let level_path = Path::new(&args[1]);
    let output_path = Path::new(&args[2]);

    // Load and parse level
    let json_str = std::fs::read_to_string(level_path)
        .map_err(|e| anyhow::anyhow!("Failed to read {}: {}", level_path.display(), e))?;
    let mut level = parse_level_file(&json_str)?;
    resolve_level_terrain(&mut level, level_path)?;

    if level.contours.is_empty() {
        anyhow::bail!("Level has no contours");
    }

    let default_depth = level.default_depth.unwrap_or(-300.0);
    let level_name = level_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .replace(".level", "");

    println!(
        "Loaded {} contours from {}",
        level.contours.len(),
        level_path.display()
    );

    // Build terrain data
    let terrain = build_terrain_data(&level);
    let (contours, lookup_grid) = parse_contours(&terrain);

    println!(
        "  {} contours parsed, default depth: {}",
        contours.len(),
        default_depth
    );

    // Compute bounding box with 5% margin
    let (min_x, min_y, max_x, max_y) = compute_bounds(&contours);
    let width = max_x - min_x;
    let height = max_y - min_y;
    let margin = 0.05;
    let render_min_x = min_x - width * margin;
    let render_min_y = min_y - height * margin;
    let render_w = width * (1.0 + 2.0 * margin);
    let render_h = height * (1.0 + 2.0 * margin);

    println!(
        "  Terrain bounds: ({:.1}, {:.1}) to ({:.1}, {:.1})",
        min_x, min_y, max_x, max_y
    );

    // Sample a 128x128 grid
    const GRID_SIZE: usize = 128;
    let mut points = Vec::with_capacity(GRID_SIZE * GRID_SIZE);

    println!("Sampling {}x{} grid...", GRID_SIZE, GRID_SIZE);

    for row in 0..GRID_SIZE {
        for col in 0..GRID_SIZE {
            let px = render_min_x + (col as f64 + 0.5) / GRID_SIZE as f64 * render_w;
            let py = render_min_y + (row as f64 + 0.5) / GRID_SIZE as f64 * render_h;

            let result = compute_terrain_height_and_gradient_ex(
                px,
                py,
                &terrain,
                &contours,
                &lookup_grid,
                true,
            );

            // Cast to f32 for fair GPU comparison
            points.push(ReferencePoint {
                x: px as f32,
                y: py as f32,
                height: result.height as f32,
                gradient_x: result.gradient_x as f32,
                gradient_y: result.gradient_y as f32,
            });
        }
    }

    let output = ReferenceOutput {
        level: level_name,
        default_depth: default_depth as f32,
        contour_count: contours.len(),
        points,
    };

    let json = serde_json::to_string_pretty(&output)?;
    std::fs::write(output_path, &json)
        .map_err(|e| anyhow::anyhow!("Failed to write {}: {}", output_path.display(), e))?;

    println!(
        "Wrote {} points to {}",
        GRID_SIZE * GRID_SIZE,
        output_path.display()
    );

    Ok(())
}
