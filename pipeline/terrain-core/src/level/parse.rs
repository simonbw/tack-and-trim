//! JSON parsing entry points and `.terrain` reference resolution.

use anyhow::Context;

use super::binary::{read_terrain_binary, terrain_cpu_data_to_contours};
use super::format::{LevelFileJSON, TerrainFileJSON};

/// Parse a level JSON string into a `LevelFileJSON`.
pub fn parse_level_file(json_str: &str) -> anyhow::Result<LevelFileJSON> {
    Ok(serde_json::from_str(json_str)?)
}

/// Parse a terrain JSON string into a `TerrainFileJSON`.
pub fn parse_terrain_file(json_str: &str) -> anyhow::Result<TerrainFileJSON> {
    Ok(serde_json::from_str(json_str)?)
}

/// Resolve terrain references: if the level has a `region`, find the
/// binary `.terrain` path. Returns the path if a region is defined.
pub fn resolve_terrain_path(
    level: &LevelFileJSON,
    level_path: &std::path::Path,
) -> anyhow::Result<Option<std::path::PathBuf>> {
    if level.region.is_some() {
        let slug = level_slug_from_path(level_path);
        Ok(Some(find_terrain_file(&slug, level_path)?))
    } else {
        Ok(None)
    }
}

/// Resolve terrain references: if the level has a `region`, read the
/// binary `.terrain` file from `static/levels/` and merge its contours and
/// defaultDepth into the level.
pub fn resolve_level_terrain(
    level: &mut LevelFileJSON,
    level_path: &std::path::Path,
) -> anyhow::Result<()> {
    if level.region.is_some() {
        let slug = level_slug_from_path(level_path);
        let terrain_path = find_terrain_file(&slug, level_path)?;
        let bytes = std::fs::read(&terrain_path).with_context(|| {
            format!(
                "failed to read terrain file: {} (referenced by {})",
                terrain_path.display(),
                level_path.display()
            )
        })?;
        let terrain = read_terrain_binary(&bytes).with_context(|| {
            format!("failed to parse terrain file: {}", terrain_path.display())
        })?;
        if level.default_depth.is_none() {
            level.default_depth = Some(terrain.default_depth);
        }
        // Reconstruct TerrainContourJSON from the binary data
        level.contours = terrain_cpu_data_to_contours(&terrain);
    }
    Ok(())
}

/// Extract a level slug from its file path (e.g. "vendovi-island" from "vendovi-island.level.json").
fn level_slug_from_path(level_path: &std::path::Path) -> String {
    level_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .replace(".level", "")
}

/// Find the binary .terrain file for a slug by checking:
/// 1. `static/levels/<slug>.terrain` relative to the level file's grandparent (repo root)
/// 2. Walking up from the level file looking for a `static/` directory
fn find_terrain_file(
    slug: &str,
    level_path: &std::path::Path,
) -> anyhow::Result<std::path::PathBuf> {
    let filename = format!("{}.terrain", slug);

    // The level file is typically at <repo>/resources/levels/<name>.level.json
    // So the repo root is two directories up, and static/ is at <repo>/static/levels/
    if let Some(levels_dir) = level_path.parent() {
        if let Some(resources_dir) = levels_dir.parent() {
            if let Some(repo_root) = resources_dir.parent() {
                let candidate = repo_root.join("static").join("levels").join(&filename);
                if candidate.exists() {
                    return Ok(candidate);
                }
            }
        }
        // Also try sibling static/levels/ from the level file's directory
        let candidate = levels_dir.join(&filename);
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    anyhow::bail!(
        "terrain file not found: static/levels/{} (referenced by {})",
        filename,
        level_path.display()
    )
}
