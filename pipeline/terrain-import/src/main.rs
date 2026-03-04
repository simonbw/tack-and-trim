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

use std::path::PathBuf;

use anyhow::{bail, Result};
use clap::{Parser, Subcommand};
use terrain_core::humanize::format_int;

use build_grid::run_build_grid;
use download::run_download;
use extract::run_extract;
use region::{list_regions, load_region_config, resolve_level_path, resolve_repo_path};
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
        Commands::Import(args) => run_import(args.region.as_deref()),
    }
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
