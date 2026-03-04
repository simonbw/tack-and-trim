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

use build_grid::run_build_grid;
use download::run_download;
use extract::run_extract;
use region::resolve_level_path;
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
        Commands::Import(_) => bail!("import not implemented yet"),
    }
}

fn run_validate(args: ValidateArgs) -> Result<()> {
    let level_path = resolve_level_path(args.level_path.as_deref(), args.region.as_deref())?;

    println!("Validating: {}", level_path.display());

    let t0 = std::time::Instant::now();
    let result = validate_level_file(&level_path)?;
    let elapsed_ms = t0.elapsed().as_secs_f64() * 1000.0;

    println!(
        "  {} contours, {} roots, max depth {}  ({:.0}ms)",
        result.contour_count, result.root_count, result.max_depth, elapsed_ms
    );

    for warning in &result.warnings {
        println!("  WARNING: {warning}");
    }

    if result.errors.is_empty() {
        println!("  PASS: No errors found");
        return Ok(());
    }

    println!("  FAIL: {} error(s):", result.errors.len());
    for error in &result.errors {
        let tag = match error.error_type {
            ValidationErrorType::Overlap => "overlap",
            ValidationErrorType::Tree => "tree",
        };
        println!("    [{tag}] {}", error.message);
    }

    bail!("validation failed")
}
