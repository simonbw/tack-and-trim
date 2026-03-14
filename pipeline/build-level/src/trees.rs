//! Tree generation step for the build pipeline.

use std::path::Path;

use anyhow::{anyhow, Context, Result};
use terrain_core::level::{
    build_terrain_data, parse_level_file, read_terrain_binary, resolve_level_terrain,
    resolve_terrain_path,
};
use terrain_core::step::StepView;
use terrain_core::trees::{build_tree_buffer, generate_trees};

/// Default seed for deterministic tree placement.
const DEFAULT_SEED: u64 = 42;

/// Generate trees for a level and write the binary `.trees` file.
pub fn run_generate_trees(level_path: &Path, output_path: &Path, view: &StepView) -> Result<()> {
    let level_path_str = level_path
        .to_str()
        .ok_or_else(|| anyhow!("Invalid level path"))?;

    let terrain_data = view.try_run_step(
        "Loading terrain for tree generation",
        || -> Result<_> {
            let json_str = std::fs::read_to_string(level_path)
                .with_context(|| format!("failed to read level file: {level_path_str}"))?;
            let level_file = parse_level_file(&json_str)
                .with_context(|| format!("failed to parse level JSON: {level_path_str}"))?;

            // Load terrain: prefer precomputed binary, fall back to building from contours
            if let Some(terrain_path) = resolve_terrain_path(&level_file, level_path)? {
                let bytes = std::fs::read(&terrain_path).with_context(|| {
                    format!("failed to read terrain file: {}", terrain_path.display())
                })?;
                read_terrain_binary(&bytes).with_context(|| {
                    format!("failed to parse terrain file: {}", terrain_path.display())
                })
            } else {
                let mut lf = level_file;
                resolve_level_terrain(&mut lf, level_path)?;
                Ok(build_terrain_data(&lf))
            }
        },
        |td, d| {
            format!(
                "Loaded terrain for trees: {}ms ({} contours)",
                d.as_millis(),
                td.contour_count,
            )
        },
    )?;

    let tree_data = view.run_step(
        "Generating tree positions",
        || generate_trees(&terrain_data, DEFAULT_SEED),
        |td, d| {
            format!(
                "Generated {} trees ({}ms)",
                td.positions.len(),
                d.as_millis(),
            )
        },
    );

    view.try_run_step(
        "Writing .trees file",
        || -> Result<_> {
            let buffer = build_tree_buffer(&tree_data);
            let output_str = output_path.display().to_string();
            std::fs::write(output_path, &buffer)
                .with_context(|| format!("failed to write trees file: {output_str}"))?;
            Ok(buffer)
        },
        |buffer, d| {
            format!(
                "Wrote {} ({:.1} KB, {} trees) in {}ms",
                output_path.display(),
                buffer.len() as f64 / 1024.0,
                tree_data.positions.len(),
                d.as_millis(),
            )
        },
    )?;

    Ok(())
}
