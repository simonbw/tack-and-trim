use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};
use pipeline_core::humanize::format_int;
use pipeline_core::step::{format_ms, StepView};

use crate::geo::{bbox_intersects, parse_tile_coverage_from_name};
use crate::region::{
    display_path, grid_cache_dir, load_region_config, resolve_region, tiles_dir, BoundingBox,
};

pub fn run_build_grid(region_arg: Option<&str>, force: bool, view: &StepView) -> Result<()> {
    let slug = resolve_region(region_arg)?;
    let config = load_region_config(&slug)?;

    let bbox = config.effective_bbox();
    view.info(format!("Region: {}", slug));
    view.info(format!(
        "BBOX: {:.4},{:.4} -> {:.4},{:.4}",
        bbox.min_lat, bbox.min_lon, bbox.max_lat, bbox.max_lon
    ));

    let local_tile_paths = list_local_tiles(&tiles_dir(&slug), &bbox)?;
    if local_tile_paths.is_empty() {
        bail!(
            "No matching GeoTIFF files in {}. Run download step first.",
            tiles_dir(&slug).display()
        );
    }

    let cache_dir = grid_cache_dir(&slug);
    let output_path = cache_dir.join("merged.tif");

    if !force && output_path.exists() {
        view.info(format!(
            "Merged grid already exists: {}",
            display_path(&output_path)
        ));
        view.info("Use --force to rebuild.");
        return Ok(());
    }

    fs::create_dir_all(&cache_dir)
        .with_context(|| format!("Failed to create {}", cache_dir.display()))?;

    let label = format!(
        "Merging {} tiles with gdalwarp",
        format_int(local_tile_paths.len())
    );
    view.try_run_step(
        &label,
        || {
            let mut cmd = Command::new("gdalwarp");
            cmd.arg("-t_srs")
                .arg("EPSG:4326")
                .arg("-te")
                .arg(bbox.min_lon.to_string())
                .arg(bbox.min_lat.to_string())
                .arg(bbox.max_lon.to_string())
                .arg(bbox.max_lat.to_string())
                .arg("-overwrite");

            for path in &local_tile_paths {
                cmd.arg(path);
            }
            cmd.arg(&output_path);

            let status = cmd
                .status()
                .context("Failed to execute gdalwarp. Install GDAL (brew install gdal)")?;

            if !status.success() {
                bail!("gdalwarp failed with status {status}");
            }
            Ok(())
        },
        |_, d| {
            format!(
                "Merged grid: {}  ({}ms)",
                display_path(&output_path),
                format_ms(d)
            )
        },
    )
}

pub fn list_local_tiles(tiles_dir: &Path, target_bbox: &BoundingBox) -> Result<Vec<PathBuf>> {
    if !tiles_dir.exists() {
        return Ok(Vec::new());
    }

    let mut paths = Vec::new();
    for entry in fs::read_dir(tiles_dir)
        .with_context(|| format!("Failed to read {}", tiles_dir.display()))?
    {
        let entry = entry?;
        let path = entry.path();

        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };

        if !name.to_ascii_lowercase().ends_with(".tif") {
            continue;
        }

        let include = if let Some(coverage) = parse_tile_coverage_from_name(name) {
            bbox_intersects(&coverage, target_bbox)
        } else {
            true
        };

        if include {
            paths.push(path);
        }
    }

    paths.sort();
    Ok(paths)
}
