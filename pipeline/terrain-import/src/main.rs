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

use build_grid::run_build_grid;
use download::run_download;
use extract::run_extract;
use region::{
    grid_cache_dir, list_regions, load_region_config, resolve_level_path, resolve_repo_path,
    tiles_dir,
};
use validate::{validate_level_file, ValidationErrorType};

#[derive(Parser)]
#[command(name = "terrain-import")]
#[command(about = "Rust terrain import pipeline")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    Download(CommonRegionArgs),
    BuildGrid(BuildGridArgs),
    Extract(CommonRegionArgs),
    Clean(CommonRegionArgs),
    Validate(ValidateArgs),
    Import(CommonRegionArgs),
}

#[derive(Parser)]
struct CommonRegionArgs {
    #[arg(long)]
    region: Option<String>,
}

#[derive(Parser)]
struct ValidateArgs {
    /// Path to .level.json file
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

    match cli.command {
        Commands::Validate(args) => run_validate(args),
        Commands::Extract(args) => run_extract(args.region.as_deref()),
        Commands::Download(args) => run_download(args.region.as_deref()),
        Commands::BuildGrid(args) => run_build_grid(args.region.as_deref(), args.force),
        Commands::Clean(args) => run_clean(args.region.as_deref()),
        Commands::Import(args) => run_import(args.region.as_deref()),
    }
}

#[derive(Default, Clone, Copy)]
struct CleanStats {
    removed: usize,
    skipped_protected: usize,
}

fn run_clean(region_arg: Option<&str>) -> Result<()> {
    if let Some(slug) = region_arg {
        clean_region_outputs(slug)?;
        println!("\nDone.");
        return Ok(());
    }

    let regions = list_regions()?;
    if regions.is_empty() {
        bail!("No regions found. Create assets/terrain/<name>/region.json first.");
    }

    println!("Cleaning {} regions", format_int(regions.len()));

    let mut totals = CleanStats::default();
    for (idx, slug) in regions.iter().enumerate() {
        println!(
            "\n=== region {}/{}: {} ===",
            format_int(idx + 1),
            format_int(regions.len()),
            slug
        );
        let stats = clean_region_outputs(slug)?;
        totals.removed += stats.removed;
        totals.skipped_protected += stats.skipped_protected;
    }

    println!(
        "\nRemoved {} path(s) total (skipped {} protected path(s)).",
        format_int(totals.removed),
        format_int(totals.skipped_protected)
    );
    println!("\nDone.");
    Ok(())
}

fn run_validate(args: ValidateArgs) -> Result<()> {
    let level_path = resolve_level_path(args.level_path.as_deref(), args.region.as_deref())?;

    println!("Validating: {}", level_path.display());

    let t0 = std::time::Instant::now();
    let result = validate_level_file(&level_path)?;
    let elapsed_ms = t0.elapsed().as_millis();

    println!(
        "  {} contours, {} roots, max depth {}  ({}ms)",
        format_int(result.contour_count),
        format_int(result.root_count),
        format_int(result.max_depth),
        format_int(elapsed_ms)
    );

    for warning in &result.warnings {
        println!("  WARNING: {warning}");
    }

    if result.errors.is_empty() {
        println!("  PASS: No errors found");
        return Ok(());
    }

    println!("  FAIL: {} error(s):", format_int(result.errors.len()));
    for error in &result.errors {
        let tag = match error.error_type {
            ValidationErrorType::Overlap => "overlap",
            ValidationErrorType::Tree => "tree",
        };
        println!("    [{tag}] {}", error.message);
    }

    bail!("validation failed")
}

fn run_import(region_arg: Option<&str>) -> Result<()> {
    if let Some(slug) = region_arg {
        run_import_for_region(slug)?;
        println!("\nDone.");
        return Ok(());
    }

    let regions = list_regions()?;
    if regions.is_empty() {
        bail!("No regions found. Create assets/terrain/<name>/region.json first.");
    }

    println!("Importing {} regions", format_int(regions.len()));
    for (idx, slug) in regions.iter().enumerate() {
        println!(
            "\n=== region {}/{}: {} ===",
            format_int(idx + 1),
            format_int(regions.len()),
            slug
        );
        run_import_for_region(slug)?;
    }

    println!("\nDone.");
    Ok(())
}

fn clean_region_outputs(slug: &str) -> Result<CleanStats> {
    let config = load_region_config(slug)?;
    let tiles_root = tiles_dir(slug);
    let cache_dir = grid_cache_dir(slug);
    let level_path = resolve_repo_path(&config.output);
    let wavemesh_path = resolve_repo_path(&config.output.replace(".level.json", ".wavemesh"));

    println!("Region: {}", config.name);

    let mut stats = CleanStats::default();
    remove_generated_path(&cache_dir, &tiles_root, "cache directory", &mut stats)?;
    remove_generated_path(&level_path, &tiles_root, "level file", &mut stats)?;
    if wavemesh_path != level_path {
        remove_generated_path(&wavemesh_path, &tiles_root, "wavemesh file", &mut stats)?;
    }

    println!(
        "Cleaned {} path(s) (skipped {} protected path(s))",
        format_int(stats.removed),
        format_int(stats.skipped_protected)
    );
    Ok(stats)
}

fn remove_generated_path(
    path: &Path,
    tiles_root: &Path,
    label: &str,
    stats: &mut CleanStats,
) -> Result<()> {
    if path == tiles_root || path.starts_with(tiles_root) {
        stats.skipped_protected += 1;
        println!(
            "Skipped {}: {} (inside downloaded tiles directory)",
            label,
            path.display()
        );
        return Ok(());
    }

    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            println!("Already clean {}: {}", label, path.display());
            return Ok(());
        }
        Err(err) => {
            return Err(err).with_context(|| format!("Failed to inspect {}", path.display()))
        }
    };

    if metadata.file_type().is_dir() {
        fs::remove_dir_all(path)
            .with_context(|| format!("Failed to remove directory {}", path.display()))?;
    } else {
        fs::remove_file(path)
            .with_context(|| format!("Failed to remove file {}", path.display()))?;
    }

    stats.removed += 1;
    println!("Removed {}: {}", label, path.display());
    Ok(())
}

fn run_import_for_region(slug: &str) -> Result<()> {
    let config = load_region_config(&slug)?;
    let level_path = resolve_repo_path(&config.output);

    println!("\n=== download ===\n");
    run_download(Some(slug))?;

    println!("\n=== build-grid ===\n");
    run_build_grid(Some(slug), false)?;

    println!("\n=== extract-contours ===\n");
    run_extract(Some(slug))?;

    println!("\n=== build-wavemesh ===\n");
    wavemesh_builder::build_wavemesh_for_level(
        level_path
            .to_str()
            .ok_or_else(|| anyhow::anyhow!("Invalid level path"))?,
        None,
    )?;
    Ok(())
}
