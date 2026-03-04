use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

use anyhow::{bail, Context, Result};
use reqwest::blocking::Client;
use reqwest::Url;

use crate::geo::{bbox_intersects, normalize_dataset_path, parse_tile_coverage_from_name};
use crate::region::{
    load_region_config, resolve_data_source, resolve_region, tiles_dir, BoundingBox,
    DataSourceConfig,
};

const CUDEM_BASE_URL: &str =
    "https://coast.noaa.gov/htdata/raster2/elevation/NCEI_ninth_Topobathy_2014_8483/";
const EMODNET_WCS_BASE: &str = "https://ows.emodnet-bathymetry.eu/wcs";

pub fn run_download(region_arg: Option<&str>) -> Result<()> {
    let slug = resolve_region(region_arg)?;
    let config = load_region_config(&slug)?;
    let source = resolve_data_source(&config)?;
    let out_dir = tiles_dir(&slug);

    println!("Region: {}", config.name);
    println!(
        "BBOX: {:.4},{:.4} -> {:.4},{:.4}",
        config.bbox.min_lat, config.bbox.min_lon, config.bbox.max_lat, config.bbox.max_lon
    );

    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .context("Failed to create HTTP client")?;

    match source {
        DataSourceConfig::Cudem { dataset_path } => {
            download_cudem(&client, &dataset_path, &config.bbox, &out_dir)
        }
        DataSourceConfig::UsaceS3 {
            base_url,
            state_prefix,
            url_list,
        } => download_usace_s3(&client, &base_url, &state_prefix, &url_list, &out_dir),
        DataSourceConfig::EmodnetWcs { coverage_id } => {
            download_emodnet_wcs(&client, &coverage_id, &config.bbox, &out_dir)
        }
    }
}

fn parse_directory_links(html: &str) -> Vec<String> {
    let mut links = Vec::new();
    let re = regex::Regex::new(r#"href=\"([^\"]+)\""#).expect("valid href regex");

    for caps in re.captures_iter(html) {
        let href = caps.get(1).map(|m| m.as_str()).unwrap_or_default();
        if !href.starts_with('?') && href != "../" {
            links.push(href.to_string());
        }
    }

    links
}

fn download_file(client: &Client, url: &str, destination: &Path) -> Result<()> {
    let mut response = client
        .get(url)
        .send()
        .with_context(|| format!("Failed to download {url}"))?;

    if !response.status().is_success() {
        bail!("Failed to download {url}: HTTP {}", response.status());
    }

    let mut file = File::create(destination)
        .with_context(|| format!("Failed to create {}", destination.display()))?;
    std::io::copy(&mut response, &mut file)
        .with_context(|| format!("Failed to write {}", destination.display()))?;
    file.flush()
        .with_context(|| format!("Failed to flush {}", destination.display()))?;

    Ok(())
}

fn download_tiles(client: &Client, tiff_urls: &[String], out_dir: &Path) -> Result<()> {
    fs::create_dir_all(out_dir)
        .with_context(|| format!("Failed to create {}", out_dir.display()))?;

    println!("Found {} matching tiles", tiff_urls.len());

    let mut downloaded = 0usize;
    let mut skipped = 0usize;

    for (i, tiff_url) in tiff_urls.iter().enumerate() {
        let filename = Url::parse(tiff_url)
            .ok()
            .and_then(|url| {
                url.path_segments()
                    .and_then(|mut seg| seg.next_back().map(ToString::to_string))
            })
            .unwrap_or_else(|| {
                tiff_url
                    .split('/')
                    .next_back()
                    .unwrap_or("tile.tif")
                    .to_string()
            });

        let destination = out_dir.join(&filename);
        if destination.exists() {
            skipped += 1;
            println!("[{}/{}] skip {}", i + 1, tiff_urls.len(), filename);
            continue;
        }

        println!("[{}/{}] download {}", i + 1, tiff_urls.len(), filename);
        download_file(client, tiff_url, &destination)?;
        downloaded += 1;
    }

    println!("Done. Downloaded: {downloaded}, skipped: {skipped}");
    println!("Tiles: {}", out_dir.display());

    Ok(())
}

fn list_cudem_tiff_urls(client: &Client, dataset_path: &str) -> Result<Vec<String>> {
    let base_url = Url::parse(CUDEM_BASE_URL).context("Invalid CUDEM base URL")?;
    let url = base_url
        .join(dataset_path)
        .with_context(|| format!("Invalid CUDEM dataset path: {dataset_path}"))?;

    let response = client
        .get(url.clone())
        .send()
        .with_context(|| format!("Failed to list dataset directory {url}"))?;

    if !response.status().is_success() {
        bail!(
            "Failed to list dataset directory {url}: HTTP {}",
            response.status()
        );
    }

    let html = response
        .text()
        .context("Failed to read CUDEM directory HTML")?;
    let links = parse_directory_links(&html);

    Ok(links
        .into_iter()
        .filter(|href| href.to_ascii_lowercase().ends_with(".tif"))
        .filter_map(|href| url.join(&href).ok().map(|u| u.to_string()))
        .collect())
}

fn select_cudem_urls_by_bbox(all_urls: &[String], bbox: &BoundingBox) -> Vec<String> {
    all_urls
        .iter()
        .filter(|tiff_url| {
            let filename = tiff_url.split('/').next_back().unwrap_or_default();
            let Some(coverage) = parse_tile_coverage_from_name(filename) else {
                return false;
            };
            bbox_intersects(&coverage, bbox)
        })
        .cloned()
        .collect()
}

fn download_cudem(
    client: &Client,
    dataset_path: &str,
    bbox: &BoundingBox,
    out_dir: &Path,
) -> Result<()> {
    let dataset_path = normalize_dataset_path(dataset_path);
    println!("Dataset: {dataset_path}");

    let all_tiff_urls = list_cudem_tiff_urls(client, &dataset_path)?;
    if all_tiff_urls.is_empty() {
        bail!("No GeoTIFF files found in dataset path: {dataset_path}");
    }

    let selected = select_cudem_urls_by_bbox(&all_tiff_urls, bbox);
    if selected.is_empty() {
        bail!("No matching tiles found for the target bbox. Check the datasetPath in region.json.");
    }

    download_tiles(client, &selected, out_dir)
}

fn filter_usace_urls(all_urls: &[String], state_prefix: &str) -> Vec<String> {
    all_urls
        .iter()
        .filter(|url| {
            url.to_ascii_lowercase().ends_with(".tif") && url.contains(&format!("/{state_prefix}"))
        })
        .cloned()
        .collect()
}

fn download_usace_s3(
    client: &Client,
    base_url: &str,
    state_prefix: &str,
    url_list: &str,
    out_dir: &Path,
) -> Result<()> {
    let url_list_url = Url::parse(base_url)
        .with_context(|| format!("Invalid baseUrl: {base_url}"))?
        .join(url_list)
        .with_context(|| format!("Invalid urlList path: {url_list}"))?;

    println!("Fetching URL list: {url_list_url}");

    let response = client
        .get(url_list_url.clone())
        .send()
        .with_context(|| format!("Failed to fetch URL list {url_list_url}"))?;

    if !response.status().is_success() {
        bail!(
            "Failed to fetch URL list {}: HTTP {}",
            url_list_url,
            response.status()
        );
    }

    let text = response.text().context("Failed to read USACE URL list")?;
    let all_urls: Vec<String> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect();

    let tif_urls = filter_usace_urls(&all_urls, state_prefix);
    if tif_urls.is_empty() {
        bail!(
            "No .tif files found matching prefix \"{}\" in URL list",
            state_prefix
        );
    }

    println!(
        "Found {} tiles for prefix \"{}\" (from {} total entries)",
        tif_urls.len(),
        state_prefix,
        all_urls.len()
    );

    download_tiles(client, &tif_urls, out_dir)
}

fn download_emodnet_wcs(
    client: &Client,
    coverage_id: &str,
    bbox: &BoundingBox,
    out_dir: &Path,
) -> Result<()> {
    fs::create_dir_all(out_dir)
        .with_context(|| format!("Failed to create {}", out_dir.display()))?;

    let filename = format!("{coverage_id}.tif");
    let destination = out_dir.join(&filename);
    if destination.exists() {
        println!("Already downloaded: {filename}");
        println!("Tiles: {}", out_dir.display());
        return Ok(());
    }

    let mut url = Url::parse(EMODNET_WCS_BASE).context("Invalid EMODnet WCS base URL")?;
    url.query_pairs_mut()
        .append_pair("SERVICE", "WCS")
        .append_pair("VERSION", "2.0.1")
        .append_pair("REQUEST", "GetCoverage")
        .append_pair("COVERAGEID", coverage_id)
        .append_pair("FORMAT", "image/tiff")
        .append_pair("SUBSET", &format!("Lat({},{})", bbox.min_lat, bbox.max_lat))
        .append_pair(
            "SUBSET",
            &format!("Long({},{})", bbox.min_lon, bbox.max_lon),
        );

    println!("Requesting WCS coverage: {coverage_id}");
    download_file(client, url.as_ref(), &destination)?;

    println!("Downloaded: {filename}");
    println!("Tiles: {}", out_dir.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_directory_links_and_filters_special_entries() {
        let html = r#"
            <a href="../">../</a>
            <a href="?C=N;O=D">sort</a>
            <a href="tile-a.tif">tile-a.tif</a>
            <a href="tile-b.TIF">tile-b.TIF</a>
            <a href="readme.txt">readme</a>
        "#;

        let links = parse_directory_links(html);
        assert_eq!(links, vec!["tile-a.tif", "tile-b.TIF", "readme.txt"]);
    }

    #[test]
    fn filters_usace_urls_by_state_prefix_and_extension() {
        let all = vec![
            "https://example.com/wi/a.tif".to_string(),
            "https://example.com/wi/b.TIF".to_string(),
            "https://example.com/mn/c.tif".to_string(),
            "https://example.com/wi/d.txt".to_string(),
        ];

        let filtered = filter_usace_urls(&all, "wi");
        assert_eq!(
            filtered,
            vec![
                "https://example.com/wi/a.tif".to_string(),
                "https://example.com/wi/b.TIF".to_string(),
            ]
        );
    }
}
