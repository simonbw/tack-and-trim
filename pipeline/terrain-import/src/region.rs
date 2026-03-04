use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct BoundingBox {
    #[serde(rename = "minLat")]
    pub min_lat: f64,
    #[serde(rename = "minLon")]
    pub min_lon: f64,
    #[serde(rename = "maxLat")]
    pub max_lat: f64,
    #[serde(rename = "maxLon")]
    pub max_lon: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type")]
pub enum DataSourceConfig {
    #[serde(rename = "cudem")]
    Cudem {
        #[serde(rename = "datasetPath")]
        dataset_path: String,
    },
    #[serde(rename = "usace-s3")]
    UsaceS3 {
        #[serde(rename = "baseUrl")]
        base_url: String,
        #[serde(rename = "statePrefix")]
        state_prefix: String,
        #[serde(rename = "urlList")]
        url_list: String,
    },
    #[serde(rename = "emodnet-wcs")]
    EmodnetWcs {
        #[serde(rename = "coverageId")]
        coverage_id: String,
    },
}

#[derive(Debug, Clone, Deserialize)]
pub struct RegionConfig {
    pub name: String,
    #[serde(rename = "datasetPath")]
    pub dataset_path: Option<String>,
    #[serde(rename = "dataSource")]
    pub data_source: Option<DataSourceConfig>,
    pub bbox: BoundingBox,
    pub interval: f64,
    pub simplify: f64,
    pub scale: f64,
    #[serde(rename = "minPerimeter")]
    pub min_perimeter: f64,
    #[serde(rename = "minPoints")]
    pub min_points: usize,
    #[serde(rename = "flipY")]
    pub flip_y: bool,
    pub output: String,
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

    bail!(
        "Region \"{}\" must have either dataSource or datasetPath",
        config.name
    )
}

pub fn assets_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../assets/terrain")
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

pub fn load_region_config(slug: &str) -> Result<RegionConfig> {
    let config_path = region_dir(slug).join("region.json");
    let json = fs::read_to_string(&config_path)
        .with_context(|| format!("No region.json found at {}", config_path.display()))?;
    Ok(serde_json::from_str(&json)
        .with_context(|| format!("Failed to parse region config at {}", config_path.display()))?)
}

pub fn list_regions() -> Result<Vec<String>> {
    let root = assets_root();
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut regions = Vec::new();
    for entry in
        fs::read_dir(&root).with_context(|| format!("Failed to read {}", root.display()))?
    {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }

        let region_name = entry.file_name().to_string_lossy().to_string();
        let config_path = root.join(&region_name).join("region.json");
        if config_path.exists() {
            regions.push(region_name);
        }
    }

    regions.sort();
    Ok(regions)
}

pub fn resolve_region(region: Option<&str>) -> Result<String> {
    if let Some(slug) = region {
        let config_path = region_dir(slug).join("region.json");
        if !config_path.exists() {
            let available = list_regions()?.join(", ");
            bail!("Unknown region \"{}\". Available: {}", slug, available);
        }
        return Ok(slug.to_string());
    }

    let regions = list_regions()?;
    match regions.as_slice() {
        [] => bail!("No regions found. Create assets/terrain/<name>/region.json first."),
        [only] => {
            println!("Auto-selected region: {only}");
            Ok(only.clone())
        }
        _ => bail!(
            "Multiple regions available. Specify --region <name>: {}",
            regions.join(", ")
        ),
    }
}

pub fn resolve_level_path(level: Option<&Path>, region: Option<&str>) -> Result<PathBuf> {
    if let Some(path) = level {
        if region.is_some() {
            bail!("Specify either <level-path> or --region <name>, not both")
        }
        return Ok(path.to_path_buf());
    }

    let slug = resolve_region(region)?;
    let config = load_region_config(&slug)?;
    Ok(PathBuf::from(config.output))
}
