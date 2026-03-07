mod build_grid;
mod constrained_simplify;
mod download;
mod extract;
mod geo;
mod marching;
mod region;
mod segment_index;
mod simplify;
mod validate;

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use terrain_core::humanize::format_int;
use terrain_core::step::StepView;

use build_grid::run_build_grid;
use download::run_download;
use extract::run_extract;
use region::{
    display_path, grid_cache_dir, level_path_for_slug, list_regions, load_region_config,
    resolve_level_path, terrain_output_path, tiles_dir,
};
use validate::{validate_level_file, ValidationErrorType};

#[derive(Parser)]
#[command(name = "build-level")]
#[command(about = "Level build pipeline")]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    /// Build meshes for a specific level (default: all)
    #[arg(long)]
    level: Option<String>,
}

#[derive(Subcommand)]
enum Commands {
    /// Run full terrain pipeline + mesh build for a region
    Import(CommonRegionArgs),
    /// Extract terrain → .terrain.json
    Extract(CommonRegionArgs),
    /// Download elevation tiles
    Download(CommonRegionArgs),
    /// Build merged elevation grid
    BuildGrid(BuildGridArgs),
    /// Clean generated outputs
    Clean(CommonRegionArgs),
    /// Validate level or terrain file
    Validate(ValidateArgs),
    /// List available levels
    ListLevels,
    /// List available regions
    ListRegions,
}

#[derive(Parser)]
struct CommonRegionArgs {
    #[arg(long)]
    region: Option<String>,
}

#[derive(Parser)]
struct ValidateArgs {
    /// Path to .level.json or .terrain.json file
    level_path: Option<PathBuf>,

    /// Region slug from assets/terrain/<slug>/region.json
    #[arg(long)]
    region: Option<String>,
}

#[derive(Parser)]
struct BuildGridArgs {
    #[arg(long)]
    region: Option<String>,

    #[arg(long)]
    force: bool,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let view = StepView::new();

    match cli.command {
        None => run_build_all(cli.level.as_deref(), &view),
        Some(Commands::Import(args)) => run_import(args.region.as_deref(), &view),
        Some(Commands::Extract(args)) => run_extract(args.region.as_deref(), &view),
        Some(Commands::Download(args)) => run_download(args.region.as_deref(), &view),
        Some(Commands::BuildGrid(args)) => {
            run_build_grid(args.region.as_deref(), args.force, &view)
        }
        Some(Commands::Clean(args)) => run_clean(args.region.as_deref(), &view),
        Some(Commands::Validate(args)) => run_validate(args, &view),
        Some(Commands::ListLevels) => run_list_levels(),
        Some(Commands::ListRegions) => run_list_regions(),
    }
}

/// Default command: build meshes for all levels (or a specific one).
fn run_build_all(level_filter: Option<&str>, view: &StepView) -> Result<()> {
    let level_paths: Vec<String> = if let Some(name) = level_filter {
        let path = level_path_for_slug(name);
        if !path.exists() {
            bail!("Level file not found: {}", path.display());
        }
        vec![path.to_string_lossy().to_string()]
    } else {
        glob::glob("resources/levels/*.level.json")
            .context("invalid glob pattern")?
            .filter_map(|p| p.ok().map(|p| p.to_string_lossy().to_string()))
            .collect()
    };

    if level_paths.is_empty() {
        view.info("No level files found.");
        return Ok(());
    }

    view.info(format!(
        "Building meshes for {} level(s)",
        format_int(level_paths.len())
    ));

    for level_path in &level_paths {
        let level_name = std::path::Path::new(level_path)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .replace(".level", "");
        view.header(&level_name);

        let inner = view.indented();

        let _s = view.section("build-wavemesh");
        wavemesh_builder::build_wavemesh_for_level_with_view(level_path, None, Some(&inner))?;
        drop(_s);

        let _s = view.section("build-windmesh");
        wavemesh_builder::build_windmesh_for_level_with_view(level_path, None, Some(&inner))?;
        drop(_s);
    }

    view.info("Done.");
    Ok(())
}

fn run_list_levels() -> Result<()> {
    let paths: Vec<_> = glob::glob("resources/levels/*.level.json")
        .context("invalid glob pattern")?
        .filter_map(|p| p.ok())
        .collect();

    for path in paths {
        let name = path
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .replace(".level", "");
        println!("{}", name);
    }
    Ok(())
}

fn run_list_regions() -> Result<()> {
    let regions = list_regions()?;
    for region in regions {
        println!("{}", region);
    }
    Ok(())
}

#[derive(Default, Clone, Copy)]
struct CleanStats {
    removed: usize,
    skipped_protected: usize,
}

fn run_clean(region_arg: Option<&str>, view: &StepView) -> Result<()> {
    if let Some(slug) = region_arg {
        clean_region_outputs(slug, view)?;
        view.info("Done.");
        return Ok(());
    }

    let regions = list_regions()?;
    if regions.is_empty() {
        bail!("No regions found. Create assets/terrain/<name>/region.json first.");
    }

    view.info(format!("Cleaning {} regions", format_int(regions.len())));

    let mut totals = CleanStats::default();
    for (idx, slug) in regions.iter().enumerate() {
        view.header(&format!(
            "region {}/{}: {}",
            format_int(idx + 1),
            format_int(regions.len()),
            slug
        ));
        let stats = clean_region_outputs(slug, &view.indented())?;
        totals.removed += stats.removed;
        totals.skipped_protected += stats.skipped_protected;
    }

    view.info(format!(
        "Removed {} path(s) total (skipped {} protected path(s)).",
        format_int(totals.removed),
        format_int(totals.skipped_protected)
    ));
    view.info("Done.");
    Ok(())
}

fn run_validate(args: ValidateArgs, view: &StepView) -> Result<()> {
    let level_path = resolve_level_path(args.level_path.as_deref(), args.region.as_deref())?;

    view.info(format!("Validating: {}", display_path(&level_path)));

    let t0 = std::time::Instant::now();
    let result = validate_level_file(&level_path)?;
    let elapsed_ms = t0.elapsed().as_millis();

    view.info(format!(
        "  {} contours, {} roots, max depth {}  ({}ms)",
        format_int(result.contour_count),
        format_int(result.root_count),
        format_int(result.max_depth),
        format_int(elapsed_ms)
    ));

    for warning in &result.warnings {
        view.info(format!("  WARNING: {warning}"));
    }

    if result.errors.is_empty() {
        view.info("  PASS: No errors found");
        return Ok(());
    }

    view.info(format!(
        "  FAIL: {} error(s):",
        format_int(result.errors.len())
    ));
    for error in &result.errors {
        let tag = match error.error_type {
            ValidationErrorType::Overlap => "overlap",
            ValidationErrorType::Tree => "tree",
        };
        view.info(format!("    [{tag}] {}", error.message));
    }

    bail!("validation failed")
}

fn run_import(region_arg: Option<&str>, view: &StepView) -> Result<()> {
    if let Some(slug) = region_arg {
        run_import_for_region(slug, view)?;
        view.info("Done.");
        return Ok(());
    }

    let regions = list_regions()?;
    if regions.is_empty() {
        bail!("No regions found. Create assets/terrain/<name>/region.json first.");
    }

    view.info(format!("Importing {} regions", format_int(regions.len())));
    for (idx, slug) in regions.iter().enumerate() {
        view.header(&format!(
            "region {}/{}: {}",
            format_int(idx + 1),
            format_int(regions.len()),
            slug
        ));
        run_import_for_region(slug, &view.indented())?;
    }

    view.info("Done.");
    Ok(())
}

fn clean_region_outputs(slug: &str, view: &StepView) -> Result<CleanStats> {
    let config = load_region_config(slug)?;
    let tiles_root = tiles_dir(slug);
    let cache_dir = grid_cache_dir(slug);
    let terrain_path = terrain_output_path(slug);
    let levels_dir = terrain_path.parent().unwrap();
    let wavemesh_path = levels_dir.join(format!("{}.wavemesh", slug));
    let windmesh_path = levels_dir.join(format!("{}.windmesh", slug));

    view.info(format!("Region: {}", config.name));

    let mut stats = CleanStats::default();
    remove_generated_path(&cache_dir, &tiles_root, "cache directory", &mut stats, view)?;
    remove_generated_path(&terrain_path, &tiles_root, "terrain file", &mut stats, view)?;
    remove_generated_path(&wavemesh_path, &tiles_root, "wavemesh file", &mut stats, view)?;
    remove_generated_path(&windmesh_path, &tiles_root, "windmesh file", &mut stats, view)?;

    view.info(format!(
        "Cleaned {} path(s) (skipped {} protected path(s))",
        format_int(stats.removed),
        format_int(stats.skipped_protected)
    ));
    Ok(stats)
}

fn remove_generated_path(
    path: &Path,
    tiles_root: &Path,
    label: &str,
    stats: &mut CleanStats,
    view: &StepView,
) -> Result<()> {
    if path == tiles_root || path.starts_with(tiles_root) {
        stats.skipped_protected += 1;
        view.info(format!(
            "Skipped {}: {} (inside downloaded tiles directory)",
            label,
            display_path(path)
        ));
        return Ok(());
    }

    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            view.info(format!("Already clean {}: {}", label, display_path(path)));
            return Ok(());
        }
        Err(err) => {
            return Err(err).with_context(|| format!("Failed to inspect {}", display_path(path)))
        }
    };

    if metadata.file_type().is_dir() {
        fs::remove_dir_all(path)
            .with_context(|| format!("Failed to remove directory {}", display_path(path)))?;
    } else {
        fs::remove_file(path)
            .with_context(|| format!("Failed to remove file {}", display_path(path)))?;
    }

    stats.removed += 1;
    view.info(format!("Removed {}: {}", label, display_path(path)));
    Ok(())
}

fn run_import_for_region(slug: &str, view: &StepView) -> Result<()> {
    let level_path = level_path_for_slug(slug);
    let inner = view.indented();

    let _s = view.section("download");
    run_download(Some(slug), &inner)?;
    drop(_s);

    let _s = view.section("build-grid");
    run_build_grid(Some(slug), false, &inner)?;
    drop(_s);

    let _s = view.section("extract-contours");
    run_extract(Some(slug), &inner)?;
    drop(_s);

    let _s = view.section("build-wavemesh");
    wavemesh_builder::build_wavemesh_for_level_with_view(
        level_path
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("Invalid level path"))?,
        None,
        Some(&inner),
    )?;
    drop(_s);

    let _s = view.section("build-windmesh");
    wavemesh_builder::build_windmesh_for_level_with_view(
        level_path
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("Invalid level path"))?,
        None,
        Some(&inner),
    )?;
    drop(_s);
    Ok(())
}
