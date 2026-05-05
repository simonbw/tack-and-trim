use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use pipeline_core::level::parse_level_file;

// Re-export region types from pipeline-core so other modules can import from here.
pub use pipeline_core::level::{BoundingBox, DataSourceConfig, RegionConfig};

/// Convention-based path for a region's terrain output file.
pub fn terrain_output_path(slug: &str) -> PathBuf {
    repo_root().join(format!("static/levels/{}.terrain", slug))
}

/// Convention-based path for a region's wavemesh output file.
pub fn wavemesh_output_path(slug: &str) -> PathBuf {
    repo_root().join(format!("static/levels/{}.wavemesh", slug))
}

/// Convention-based path for a region's windmesh output file.
pub fn windmesh_output_path(slug: &str) -> PathBuf {
    repo_root().join(format!("static/levels/{}.windmesh", slug))
}

/// Convention-based path for a region's tidemesh output file.
pub fn tidemesh_output_path(slug: &str) -> PathBuf {
    repo_root().join(format!("static/levels/{}.tidemesh", slug))
}

/// Convention-based path for a region's trees output file.
pub fn trees_output_path(slug: &str) -> PathBuf {
    repo_root().join(format!("static/levels/{}.trees", slug))
}

/// Convention-based path for a level file.
pub fn level_path_for_slug(slug: &str) -> PathBuf {
    repo_root().join(format!("resources/levels/{}.level.json", slug))
}

pub fn resolve_data_source(config: &RegionConfig) -> Result<DataSourceConfig> {
    if let Some(source) = &config.data_source {
        return Ok(source.clone());
    }

    if let Some(dataset_path) = &config.dataset_path {
        return Ok(DataSourceConfig::Cudem {
            dataset_path: dataset_path.clone(),
        });
    }

    bail!("Region must have either dataSource or datasetPath")
}

pub fn assets_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../assets/terrain")
}

pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

pub fn region_dir(slug: &str) -> PathBuf {
    assets_root().join(slug)
}

pub fn tiles_dir(slug: &str) -> PathBuf {
    region_dir(slug).join("tiles")
}

pub fn grid_cache_dir(slug: &str) -> PathBuf {
    region_dir(slug).join("cache")
}

/// Load the region config from the level file's `region` field.
pub fn load_region_config(slug: &str) -> Result<RegionConfig> {
    let level_path = level_path_for_slug(slug);
    let json = fs::read_to_string(&level_path)
        .with_context(|| format!("Failed to read level file at {}", display_path(&level_path)))?;
    let level = parse_level_file(&json)
        .with_context(|| format!("Failed to parse level file at {}", display_path(&level_path)))?;
    level.region.ok_or_else(|| {
        anyhow::anyhow!(
            "Level \"{}\" has no region config (no external terrain)",
            slug
        )
    })
}

/// Resolve a region slug, validating that the level file exists and has a region.
/// When called with None, auto-selects if there is exactly one region.
pub fn resolve_region(slug: Option<&str>) -> Result<String> {
    if let Some(slug) = slug {
        let level_path = level_path_for_slug(slug);
        if !level_path.exists() {
            let available = list_regions()?.join(", ");
            bail!(
                "No level file found for \"{}\". Available levels with regions: {}",
                slug,
                available
            );
        }
        return Ok(slug.to_string());
    }

    let regions = list_regions()?;
    match regions.as_slice() {
        [] => bail!("No levels with region config found."),
        [only] => {
            println!("Auto-selected region: {only}");
            Ok(only.clone())
        }
        _ => bail!(
            "Multiple levels with regions available. Specify --level <name>: {}",
            regions.join(", ")
        ),
    }
}

/// List level slugs that have a `region` field (i.e. external terrain).
pub fn list_regions() -> Result<Vec<String>> {
    let levels_dir = repo_root().join("resources/levels");
    if !levels_dir.exists() {
        return Ok(Vec::new());
    }

    let mut regions = Vec::new();
    for entry in fs::read_dir(&levels_dir)
        .with_context(|| format!("Failed to read {}", levels_dir.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.ends_with(".level.json") {
            continue;
        }

        let json = fs::read_to_string(&path)
            .with_context(|| format!("Failed to read {}", path.display()))?;
        let level = parse_level_file(&json)
            .with_context(|| format!("Failed to parse {}", path.display()))?;

        if level.region.is_some() {
            let slug = name.strip_suffix(".level.json").unwrap().to_string();
            regions.push(slug);
        }
    }

    regions.sort();
    Ok(regions)
}

/// Display a path relative to the repo root for cleaner log output.
/// Falls back to the original path if it's not under the repo root.
pub fn display_path(path: &Path) -> String {
    let canonical_repo = repo_root().canonicalize().ok();
    let canonical_path = path.canonicalize().ok();

    if let (Some(repo), Some(p)) = (canonical_repo, canonical_path) {
        if let Ok(rel) = p.strip_prefix(&repo) {
            return rel.display().to_string();
        }
    }

    path.display().to_string()
}
