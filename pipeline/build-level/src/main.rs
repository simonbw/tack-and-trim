mod build_grid;
mod constrained_simplify;
mod download;
mod extract;
mod geo;
mod marching;
mod region;
mod segment_index;
mod simplify;
mod trees;
mod validate;

use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use clap::{Parser, Subcommand};
use terrain_core::humanize::format_int;
use terrain_core::level::parse_level_file;
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

    /// Level slug from resources/levels/<slug>.level.json.
    /// Works with all commands. Terrain commands infer --region from terrainFile.
    #[arg(long, global = true)]
    level: Option<String>,
}

#[derive(Subcommand)]
enum Commands {
    /// Run full pipeline (download → build-grid → extract → wave/wind mesh)
    #[command(alias = "import")]
    Build(CommonRegionArgs),
    /// Build wave mesh (.wavemesh) for level(s)
    WaveMesh,
    /// Build wind mesh (.windmesh) for level(s)
    WindMesh,
    /// Generate tree positions (.trees) for level(s)
    Trees,
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
    let level_filter = cli.level.as_deref();

    match cli.command {
        None => run_build(None, level_filter, &view),
        Some(Commands::Build(args)) => run_build(args.region.as_deref(), level_filter, &view),
        Some(Commands::WaveMesh) => run_wave_mesh(level_filter, &view),
        Some(Commands::WindMesh) => run_wind_mesh(level_filter, &view),
        Some(Commands::Trees) => run_trees(level_filter, &view),
        Some(Commands::Extract(args)) => {
            let region = resolve_region_for_terrain_command(
                "extract",
                args.region.as_deref(),
                level_filter,
            )?;
            run_for_each_region(region.as_deref(), "Extracting", &view, |slug, v| {
                run_extract(Some(slug), v)
            })
        }
        Some(Commands::Download(args)) => {
            let region = resolve_region_for_terrain_command(
                "download",
                args.region.as_deref(),
                level_filter,
            )?;
            run_for_each_region(region.as_deref(), "Downloading", &view, |slug, v| {
                run_download(Some(slug), v)
            })
        }
        Some(Commands::BuildGrid(args)) => {
            let region = resolve_region_for_terrain_command(
                "build-grid",
                args.region.as_deref(),
                level_filter,
            )?;
            run_for_each_region(region.as_deref(), "Building grid for", &view, |slug, v| {
                run_build_grid(Some(slug), args.force, v)
            })
        }
        Some(Commands::Clean(args)) => {
            let region =
                resolve_region_for_terrain_command("clean", args.region.as_deref(), level_filter)?;
            run_clean(region.as_deref(), &view)
        }
        Some(Commands::Validate(args)) => run_validate(args, level_filter, &view),
        Some(Commands::ListLevels) => run_list_levels(),
        Some(Commands::ListRegions) => run_list_regions(),
    }
}

fn run_build(region_arg: Option<&str>, level_filter: Option<&str>, view: &StepView) -> Result<()> {
    if region_arg.is_some() && level_filter.is_some() {
        bail!("Specify either --region <slug> or --level <name>, not both");
    }

    if let Some(level_slug) = level_filter {
        let level_path = resolve_level_file_for_slug(level_slug)?;
        if let Some(region_slug) = terrain_region_from_level_path(&level_path)? {
            run_build_for_region_and_level(&region_slug, &level_path, view)?;
        } else {
            view.info(format!(
                "Level \"{level_slug}\" has inline terrain; skipping terrain pipeline steps."
            ));
            run_all_meshes_for_level(&level_path, level_slug, view)?;
        }
        view.info("Done.");
        return Ok(());
    }

    if let Some(slug) = region_arg {
        let level_path = resolve_level_file_for_slug(slug)?;
        run_build_for_region_and_level(slug, &level_path, view)?;
        view.info("Done.");
        return Ok(());
    }

    let regions = list_regions()?;
    if regions.is_empty() {
        bail!("No regions found. Create assets/terrain/<name>/region.json first.");
    }

    view.info(format!("Building {} regions", format_int(regions.len())));
    for (idx, slug) in regions.iter().enumerate() {
        view.header(&format!(
            "region {}/{}: {}",
            format_int(idx + 1),
            format_int(regions.len()),
            slug
        ));
        let level_path = resolve_level_file_for_slug(slug)?;
        run_build_for_region_and_level(slug, &level_path, &view.indented())?;
    }

    view.info("Done.");
    Ok(())
}

fn run_wave_mesh(level_filter: Option<&str>, view: &StepView) -> Result<()> {
    let level_paths = resolve_level_paths(level_filter)?;
    if level_paths.is_empty() {
        view.info("No level files found.");
        return Ok(());
    }

    view.info(format!(
        "Building wave mesh for {} level(s)",
        format_int(level_paths.len())
    ));

    for level_path in &level_paths {
        view.header(&level_slug_from_path(level_path));
        run_wave_mesh_for_level(level_path, &level_slug_from_path(level_path), &view.indented())?;
    }

    view.info("Done.");
    Ok(())
}

fn run_wind_mesh(level_filter: Option<&str>, view: &StepView) -> Result<()> {
    let level_paths = resolve_level_paths(level_filter)?;
    if level_paths.is_empty() {
        view.info("No level files found.");
        return Ok(());
    }

    view.info(format!(
        "Building wind mesh for {} level(s)",
        format_int(level_paths.len())
    ));

    for level_path in &level_paths {
        view.header(&level_slug_from_path(level_path));
        run_wind_mesh_for_level(level_path, &level_slug_from_path(level_path), &view.indented())?;
    }

    view.info("Done.");
    Ok(())
}

fn run_trees(level_filter: Option<&str>, view: &StepView) -> Result<()> {
    let level_paths = resolve_level_paths(level_filter)?;
    if level_paths.is_empty() {
        view.info("No level files found.");
        return Ok(());
    }

    view.info(format!(
        "Generating trees for {} level(s)",
        format_int(level_paths.len())
    ));

    for level_path in &level_paths {
        let slug = level_slug_from_path(level_path);
        view.header(&slug);
        run_trees_for_level(level_path, &slug, &view.indented())?;
    }

    view.info("Done.");
    Ok(())
}

fn resolve_level_paths(level_filter: Option<&str>) -> Result<Vec<PathBuf>> {
    if let Some(level_slug) = level_filter {
        return Ok(vec![resolve_level_file_for_slug(level_slug)?]);
    }

    let mut paths: Vec<_> = glob::glob("resources/levels/*.level.json")
        .context("invalid glob pattern")?
        .filter_map(|p| p.ok())
        .collect();
    paths.sort();
    Ok(paths)
}

fn resolve_level_file_for_slug(level_slug: &str) -> Result<PathBuf> {
    let level_path = level_path_for_slug(level_slug);
    if !level_path.exists() {
        bail!("Level file not found: {}", display_path(&level_path));
    }
    Ok(level_path)
}

fn terrain_region_from_level_path(level_path: &Path) -> Result<Option<String>> {
    let level_json = fs::read_to_string(level_path)
        .with_context(|| format!("Failed to read {}", display_path(level_path)))?;
    let level = parse_level_file(&level_json)
        .with_context(|| format!("Failed to parse {}", display_path(level_path)))?;
    Ok(level.terrain_file)
}

fn resolve_region_for_terrain_command(
    command_name: &str,
    region_arg: Option<&str>,
    level_filter: Option<&str>,
) -> Result<Option<String>> {
    if region_arg.is_some() && level_filter.is_some() {
        bail!("`{command_name}` accepts either --region <slug> or --level <name>, not both");
    }

    if let Some(region_slug) = region_arg {
        return Ok(Some(region_slug.to_string()));
    }

    let Some(level_slug) = level_filter else {
        return Ok(None);
    };

    let level_path = resolve_level_file_for_slug(level_slug)?;
    let Some(region_slug) = terrain_region_from_level_path(&level_path)? else {
        bail!(
            "Level \"{level_slug}\" does not specify terrainFile; `{command_name}` needs --region or a level with terrainFile."
        );
    };

    Ok(Some(region_slug))
}

fn level_slug_from_path(path: &Path) -> String {
    path.file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .replace(".level", "")
}

fn run_wave_mesh_for_level(level_path: &Path, slug: &str, view: &StepView) -> Result<()> {
    let level_path_str = level_path
        .to_str()
        .ok_or_else(|| anyhow!("Invalid level path"))?;
    let output_path = region::wavemesh_output_path(slug);
    let output_str = output_path
        .to_str()
        .ok_or_else(|| anyhow!("Invalid wavemesh output path"))?;
    let inner = view.indented();
    let _s = view.section("build-wavemesh");
    wavemesh_builder::build_wavemesh_for_level_with_view(
        level_path_str,
        Some(output_str),
        Some(&inner),
    )?;
    drop(_s);
    Ok(())
}

fn run_wind_mesh_for_level(level_path: &Path, slug: &str, view: &StepView) -> Result<()> {
    let level_path_str = level_path
        .to_str()
        .ok_or_else(|| anyhow!("Invalid level path"))?;
    let output_path = region::windmesh_output_path(slug);
    let output_str = output_path
        .to_str()
        .ok_or_else(|| anyhow!("Invalid windmesh output path"))?;
    let inner = view.indented();
    let _s = view.section("build-windmesh");
    wavemesh_builder::build_windmesh_for_level_with_view(
        level_path_str,
        Some(output_str),
        Some(&inner),
    )?;
    drop(_s);
    Ok(())
}

fn run_trees_for_level(level_path: &Path, slug: &str, view: &StepView) -> Result<()> {
    let output_path = region::trees_output_path(slug);
    let inner = view.indented();
    let _s = view.section("generate-trees");
    trees::run_generate_trees(level_path, &output_path, &inner)?;
    drop(_s);
    Ok(())
}

fn run_all_meshes_for_level(level_path: &Path, slug: &str, view: &StepView) -> Result<()> {
    run_wave_mesh_for_level(level_path, slug, view)?;
    // Generate trees before wind mesh so tree data is available for wind
    run_trees_for_level(level_path, slug, view)?;
    run_wind_mesh_for_level(level_path, slug, view)?;
    Ok(())
}

fn run_list_levels() -> Result<()> {
    let mut paths: Vec<_> = glob::glob("resources/levels/*.level.json")
        .context("invalid glob pattern")?
        .filter_map(|p| p.ok())
        .collect();
    paths.sort();

    for path in paths {
        println!("{}", level_slug_from_path(&path));
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

fn run_for_each_region(
    region: Option<&str>,
    verb: &str,
    view: &StepView,
    mut f: impl FnMut(&str, &StepView) -> Result<()>,
) -> Result<()> {
    if let Some(slug) = region {
        f(slug, view)?;
        view.info("Done.");
        return Ok(());
    }

    let regions = list_regions()?;
    if regions.is_empty() {
        bail!("No regions found. Create assets/terrain/<name>/region.json first.");
    }

    view.info(format!(
        "{verb} {} region(s)",
        format_int(regions.len())
    ));
    for (idx, slug) in regions.iter().enumerate() {
        view.header(&format!(
            "region {}/{}: {}",
            format_int(idx + 1),
            format_int(regions.len()),
            slug
        ));
        f(slug, &view.indented())?;
    }

    view.info("Done.");
    Ok(())
}

fn run_validate(args: ValidateArgs, level_filter: Option<&str>, view: &StepView) -> Result<()> {
    if level_filter.is_none() && args.level_path.is_none() && args.region.is_none() {
        let level_paths = resolve_level_paths(None)?;
        if level_paths.is_empty() {
            view.info("No level files found.");
            return Ok(());
        }

        view.info(format!(
            "Validating {} level(s)",
            format_int(level_paths.len())
        ));
        let mut failures = 0usize;
        for level_path in &level_paths {
            view.header(&level_slug_from_path(level_path));
            if !validate_and_report(level_path, &view.indented())? {
                failures += 1;
            }
        }
        if failures > 0 {
            bail!("{} level(s) failed validation", format_int(failures));
        }
        view.info("Done.");
        return Ok(());
    }

    let level_path = if let Some(level_slug) = level_filter {
        if args.level_path.is_some() || args.region.is_some() {
            bail!("Specify only one of --level <name>, [path], or --region <slug>");
        }
        resolve_level_file_for_slug(level_slug)?
    } else {
        resolve_level_path(args.level_path.as_deref(), args.region.as_deref())?
    };

    view.info(format!("Validating: {}", display_path(&level_path)));
    if !validate_and_report(&level_path, view)? {
        bail!("validation failed");
    }
    Ok(())
}

/// Returns true if validation passed, false if there were errors.
fn validate_and_report(level_path: &Path, view: &StepView) -> Result<bool> {
    let t0 = std::time::Instant::now();
    let result = validate_level_file(level_path)?;
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
        return Ok(true);
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

    Ok(false)
}

fn clean_region_outputs(slug: &str, view: &StepView) -> Result<CleanStats> {
    let config = load_region_config(slug)?;
    let tiles_root = tiles_dir(slug);
    let cache_dir = grid_cache_dir(slug);
    let terrain_path = terrain_output_path(slug);
    let wavemesh_path = region::wavemesh_output_path(slug);
    let windmesh_path = region::windmesh_output_path(slug);
    let trees_path = region::trees_output_path(slug);

    view.info(format!("Region: {}", config.name));

    let mut stats = CleanStats::default();
    remove_generated_path(&cache_dir, &tiles_root, "cache directory", &mut stats, view)?;
    remove_generated_path(&terrain_path, &tiles_root, "terrain file", &mut stats, view)?;
    remove_generated_path(
        &wavemesh_path,
        &tiles_root,
        "wavemesh file",
        &mut stats,
        view,
    )?;
    remove_generated_path(
        &windmesh_path,
        &tiles_root,
        "windmesh file",
        &mut stats,
        view,
    )?;
    remove_generated_path(
        &trees_path,
        &tiles_root,
        "trees file",
        &mut stats,
        view,
    )?;

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

fn run_build_for_region_and_level(
    region_slug: &str,
    level_path: &Path,
    view: &StepView,
) -> Result<()> {
    if !level_path.exists() {
        bail!("Level file not found: {}", display_path(level_path));
    }

    let inner = view.indented();

    let _s = view.section("download");
    run_download(Some(region_slug), &inner)?;
    drop(_s);

    let _s = view.section("build-grid");
    run_build_grid(Some(region_slug), false, &inner)?;
    drop(_s);

    let _s = view.section("extract-contours");
    run_extract(Some(region_slug), &inner)?;
    drop(_s);

    let slug = level_slug_from_path(level_path);
    run_all_meshes_for_level(level_path, &slug, view)
}
