use std::collections::hash_map::DefaultHasher;
use std::fs::{self, File};
use std::hash::{Hash, Hasher};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use anyhow::{bail, Context, Result};
use rayon::prelude::*;
use rayon::ThreadPoolBuilder;
use reqwest::blocking::Client;
use reqwest::Url;
use terrain_core::humanize::format_int;
use terrain_core::step::StepView;

use crate::geo::{bbox_intersects, normalize_dataset_path, parse_tile_coverage_from_name};
use crate::region::{
    display_path, grid_cache_dir, load_region_config, resolve_data_source, resolve_region,
    tiles_dir, BoundingBox, DataSourceConfig,
};

const CUDEM_BASE_URL: &str =
    "https://coast.noaa.gov/htdata/raster2/elevation/NCEI_ninth_Topobathy_2014_8483/";
const EMODNET_WCS_BASE: &str = "https://ows.emodnet-bathymetry.eu/wcs";
const DEFAULT_DOWNLOAD_CONCURRENCY: usize = 8;
const URL_LIST_CACHE_TTL: Duration = Duration::from_secs(24 * 60 * 60);

struct DownloadJob {
    url: String,
    destination: PathBuf,
}

struct DownloadProgress {
    completed: usize,
    downloaded: usize,
    skipped: usize,
    max_line_len: usize,
}

struct CachedUrlList {
    text: String,
    age: Duration,
    is_fresh: bool,
}

pub fn run_download(region_arg: Option<&str>, view: &StepView) -> Result<()> {
    let slug = resolve_region(region_arg)?;
    let config = load_region_config(&slug)?;
    let source = resolve_data_source(&config)?;
    let cache_dir = grid_cache_dir(&slug);
    let out_dir = tiles_dir(&slug);

    let bbox = config.effective_bbox();
    view.info(format!("Region: {}", slug));
    view.info(format!(
        "BBOX: {:.4},{:.4} -> {:.4},{:.4}",
        bbox.min_lat, bbox.min_lon, bbox.max_lat, bbox.max_lon
    ));

    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .context("Failed to create HTTP client")?;

    match source {
        DataSourceConfig::Cudem { dataset_path } => download_cudem(
            &client,
            &dataset_path,
            &bbox,
            &cache_dir,
            &out_dir,
            view,
        ),
        DataSourceConfig::UsaceS3 {
            base_url,
            state_prefix,
            url_list,
        } => download_usace_s3(
            &client,
            &base_url,
            &state_prefix,
            &url_list,
            &cache_dir,
            &out_dir,
            view,
        ),
        DataSourceConfig::EmodnetWcs { coverage_id } => {
            download_emodnet_wcs(&client, &coverage_id, &bbox, &out_dir, view)
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

/// Render download progress. Uses raw stderr writes with `\r` for interactive
/// mode, so takes the prefix string directly rather than a `&StepView`
/// (this is called from inside rayon parallel closures).
fn render_download_progress(
    completed: usize,
    total: usize,
    downloaded: usize,
    skipped: usize,
    max_line_len: &mut usize,
    interactive: bool,
    prefix: &str,
) -> Result<()> {
    let line = format!(
        "{prefix}[{}/{}] completed (downloaded: {}, skipped: {})",
        format_int(completed),
        format_int(total),
        format_int(downloaded),
        format_int(skipped)
    );

    if interactive {
        let mut stderr = io::stderr().lock();
        let padding = " ".repeat(max_line_len.saturating_sub(line.len()));
        write!(stderr, "\r{line}{padding}").context("Failed to write progress output")?;
        stderr.flush().context("Failed to flush progress output")?;
        *max_line_len = (*max_line_len).max(line.len());
    } else if completed == total || completed % 25 == 0 {
        eprintln!("{line}");
    }

    Ok(())
}

fn download_tiles(
    client: &Client,
    tiff_urls: &[String],
    out_dir: &Path,
    view: &StepView,
) -> Result<()> {
    fs::create_dir_all(out_dir)
        .with_context(|| format!("Failed to create {}", out_dir.display()))?;

    view.info(format!(
        "Found {} matching tiles",
        format_int(tiff_urls.len())
    ));
    let tile_dir_display = display_path(out_dir);
    let download_start = std::time::Instant::now();

    // Capture these for use inside rayon closures (StepView isn't Send+Sync)
    let interactive = view.is_interactive();
    let prefix = view.prefix();

    let mut downloaded = 0usize;
    let mut skipped = 0usize;
    let mut completed = 0usize;
    let mut max_progress_line_len = 0usize;
    let mut jobs = Vec::new();

    for tiff_url in tiff_urls {
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
            completed += 1;
            render_download_progress(
                completed,
                tiff_urls.len(),
                downloaded,
                skipped,
                &mut max_progress_line_len,
                interactive,
                &prefix,
            )?;
            continue;
        }

        jobs.push(DownloadJob {
            url: tiff_url.clone(),
            destination,
        });
    }

    if !jobs.is_empty() {
        let worker_count = DEFAULT_DOWNLOAD_CONCURRENCY.min(jobs.len());
        let pool = ThreadPoolBuilder::new()
            .num_threads(worker_count)
            .build()
            .context("Failed to create download worker pool")?;
        let progress = Arc::new(Mutex::new(DownloadProgress {
            completed,
            downloaded,
            skipped,
            max_line_len: max_progress_line_len,
        }));
        let first_error = Arc::new(Mutex::new(None::<anyhow::Error>));

        pool.install(|| {
            jobs.par_iter().for_each(|job| {
                let result = download_file(client, &job.url, &job.destination)
                    .with_context(|| format!("Failed to download {}", job.url));

                let mut candidate_error: Option<anyhow::Error> = None;
                {
                    let mut progress_state = progress
                        .lock()
                        .expect("download progress mutex should not be poisoned");
                    progress_state.completed += 1;
                    match result {
                        Ok(()) => progress_state.downloaded += 1,
                        Err(err) => candidate_error = Some(err),
                    }

                    if let Err(err) = render_download_progress(
                        progress_state.completed,
                        tiff_urls.len(),
                        progress_state.downloaded,
                        progress_state.skipped,
                        &mut progress_state.max_line_len,
                        interactive,
                        &prefix,
                    ) {
                        candidate_error.get_or_insert(err);
                    }
                }

                if let Some(err) = candidate_error {
                    let mut first_error_state = first_error
                        .lock()
                        .expect("download error mutex should not be poisoned");
                    if first_error_state.is_none() {
                        *first_error_state = Some(err);
                    }
                }
            });
        });

        {
            let progress_state = progress
                .lock()
                .expect("download progress mutex should not be poisoned");
            downloaded = progress_state.downloaded;
        }

        let first_error = first_error
            .lock()
            .expect("download error mutex should not be poisoned")
            .take();
        if let Some(err) = first_error {
            if interactive {
                eprintln!();
            }
            return Err(err);
        }
    }

    let summary = format!(
        "downloaded tiles into {} — {}ms (downloaded: {}, skipped: {})",
        tile_dir_display,
        format_int(download_start.elapsed().as_millis()),
        format_int(downloaded),
        format_int(skipped)
    );
    if interactive && !tiff_urls.is_empty() {
        let mut stderr = io::stderr().lock();
        let progress_line = format!(
            "{}[{}/{}] completed (downloaded: {}, skipped: {})",
            prefix,
            format_int(tiff_urls.len()),
            format_int(tiff_urls.len()),
            format_int(downloaded),
            format_int(skipped)
        );
        let full_summary = format!("{prefix}{summary}");
        let padding = " ".repeat(progress_line.len().saturating_sub(full_summary.len()));
        write!(stderr, "\r{full_summary}{padding}\n")
            .context("Failed to write download summary")?;
        stderr.flush().context("Failed to flush download summary")?;
    } else {
        view.info(&summary);
    }

    Ok(())
}

fn parse_url_list_lines(text: &str) -> Vec<String> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn is_url_list_cache_fresh(age: Duration) -> bool {
    age <= URL_LIST_CACHE_TTL
}

fn format_cache_age(age: Duration) -> String {
    let seconds = age.as_secs();
    if seconds < 60 {
        format!("{}s", format_int(seconds))
    } else if seconds < 3600 {
        format!("{:.1}m", seconds as f64 / 60.0)
    } else if seconds < 86_400 {
        format!("{:.1}h", seconds as f64 / 3600.0)
    } else {
        format!("{:.1}d", seconds as f64 / 86_400.0)
    }
}

fn url_list_cache_path(cache_dir: &Path, kind: &str, source_url: &Url) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    source_url.as_str().hash(&mut hasher);
    let cache_key = hasher.finish();
    cache_dir.join(format!("{kind}-{cache_key:016x}.txt"))
}

fn read_url_list_cache(cache_path: &Path) -> Result<Option<CachedUrlList>> {
    let text = match fs::read_to_string(cache_path) {
        Ok(text) => text,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            return Err(err)
                .with_context(|| format!("Failed to read URL list cache {}", cache_path.display()))
        }
    };

    let age = fs::metadata(cache_path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .unwrap_or(Duration::MAX);

    Ok(Some(CachedUrlList {
        text,
        age,
        is_fresh: is_url_list_cache_fresh(age),
    }))
}

fn write_url_list_cache(cache_path: &Path, text: &str) -> Result<()> {
    if let Some(parent) = cache_path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("Failed to create {}", parent.display()))?;
    }

    fs::write(cache_path, text)
        .with_context(|| format!("Failed to write URL list cache {}", cache_path.display()))?;
    Ok(())
}

fn serialize_url_list(urls: &[String]) -> String {
    if urls.is_empty() {
        String::new()
    } else {
        let mut text = urls.join("\n");
        text.push('\n');
        text
    }
}

fn cudem_dataset_url(dataset_path: &str) -> Result<Url> {
    let base_url = Url::parse(CUDEM_BASE_URL).context("Invalid CUDEM base URL")?;
    base_url
        .join(dataset_path)
        .with_context(|| format!("Invalid CUDEM dataset path: {dataset_path}"))
}

fn parse_cudem_tiff_urls(dataset_url: &Url, html: &str) -> Vec<String> {
    parse_directory_links(html)
        .into_iter()
        .filter(|href| href.to_ascii_lowercase().ends_with(".tif"))
        .filter_map(|href| dataset_url.join(&href).ok().map(|u| u.to_string()))
        .collect()
}

fn fetch_cudem_tiff_urls(client: &Client, dataset_url: &Url) -> Result<Vec<String>> {
    let response = client
        .get(dataset_url.clone())
        .send()
        .with_context(|| format!("Failed to list dataset directory {dataset_url}"))?;

    if !response.status().is_success() {
        bail!(
            "Failed to list dataset directory {dataset_url}: HTTP {}",
            response.status()
        );
    }

    let html = response
        .text()
        .context("Failed to read CUDEM directory HTML")?;

    Ok(parse_cudem_tiff_urls(dataset_url, &html))
}

fn list_cudem_tiff_urls(
    client: &Client,
    dataset_path: &str,
    cache_dir: &Path,
    view: &StepView,
) -> Result<Vec<String>> {
    let dataset_url = cudem_dataset_url(dataset_path)?;
    let cache_path = url_list_cache_path(cache_dir, "cudem-url-list", &dataset_url);
    let cached = read_url_list_cache(&cache_path)?;

    match cached {
        Some(cached) if cached.is_fresh => {
            view.info(format!(
                "Using cached CUDEM URL list: {} (age {})",
                display_path(&cache_path),
                format_cache_age(cached.age)
            ));
            Ok(parse_url_list_lines(&cached.text))
        }
        Some(cached) => {
            view.info(format!(
                "Refreshing stale CUDEM URL list cache: {} (age {})",
                display_path(&cache_path),
                format_cache_age(cached.age)
            ));
            match fetch_cudem_tiff_urls(client, &dataset_url) {
                Ok(urls) => {
                    let text = serialize_url_list(&urls);
                    if let Err(err) = write_url_list_cache(&cache_path, &text) {
                        eprintln!("Warning: {err}");
                    } else {
                        view.info(format!(
                            "Updated CUDEM URL list cache: {}",
                            display_path(&cache_path)
                        ));
                    }
                    Ok(urls)
                }
                Err(err) => {
                    eprintln!(
                        "Warning: {err}. Falling back to stale CUDEM URL list cache at {}.",
                        display_path(&cache_path)
                    );
                    Ok(parse_url_list_lines(&cached.text))
                }
            }
        }
        None => {
            let urls = fetch_cudem_tiff_urls(client, &dataset_url)?;
            let text = serialize_url_list(&urls);
            if let Err(err) = write_url_list_cache(&cache_path, &text) {
                eprintln!("Warning: {err}");
            } else {
                view.info(format!(
                    "Cached CUDEM URL list: {}",
                    display_path(&cache_path)
                ));
            }
            Ok(urls)
        }
    }
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
    cache_dir: &Path,
    out_dir: &Path,
    view: &StepView,
) -> Result<()> {
    let dataset_path = normalize_dataset_path(dataset_path);
    view.info(format!("Dataset: {dataset_path}"));

    let all_tiff_urls = list_cudem_tiff_urls(client, &dataset_path, cache_dir, view)?;
    if all_tiff_urls.is_empty() {
        bail!("No GeoTIFF files found in dataset path: {dataset_path}");
    }

    let selected = select_cudem_urls_by_bbox(&all_tiff_urls, bbox);
    if selected.is_empty() {
        bail!("No matching tiles found for the target bbox. Check the datasetPath in the level file's region config.");
    }

    download_tiles(client, &selected, out_dir, view)
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

fn fetch_usace_url_list_text(
    client: &Client,
    url_list_url: &Url,
    view: &StepView,
) -> Result<String> {
    view.info(format!("Fetching URL list: {url_list_url}"));

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

    response.text().context("Failed to read USACE URL list")
}

fn download_usace_s3(
    client: &Client,
    base_url: &str,
    state_prefix: &str,
    url_list: &str,
    cache_dir: &Path,
    out_dir: &Path,
    view: &StepView,
) -> Result<()> {
    let url_list_url = Url::parse(base_url)
        .with_context(|| format!("Invalid baseUrl: {base_url}"))?
        .join(url_list)
        .with_context(|| format!("Invalid urlList path: {url_list}"))?;
    let cache_path = url_list_cache_path(cache_dir, "usace-url-list", &url_list_url);
    let cached = read_url_list_cache(&cache_path)?;

    let text = match cached {
        Some(cached) if cached.is_fresh => {
            view.info(format!(
                "Using cached URL list: {} (age {})",
                display_path(&cache_path),
                format_cache_age(cached.age)
            ));
            cached.text
        }
        Some(cached) => {
            view.info(format!(
                "Refreshing stale URL list cache: {} (age {})",
                display_path(&cache_path),
                format_cache_age(cached.age)
            ));
            match fetch_usace_url_list_text(client, &url_list_url, view) {
                Ok(text) => {
                    if let Err(err) = write_url_list_cache(&cache_path, &text) {
                        eprintln!("Warning: {err}");
                    } else {
                        view.info(format!(
                            "Updated URL list cache: {}",
                            display_path(&cache_path)
                        ));
                    }
                    text
                }
                Err(err) => {
                    eprintln!(
                        "Warning: {err}. Falling back to stale URL list cache at {}.",
                        display_path(&cache_path)
                    );
                    cached.text
                }
            }
        }
        None => {
            let text = fetch_usace_url_list_text(client, &url_list_url, view)?;
            if let Err(err) = write_url_list_cache(&cache_path, &text) {
                eprintln!("Warning: {err}");
            } else {
                view.info(format!("Cached URL list: {}", display_path(&cache_path)));
            }
            text
        }
    };

    let all_urls = parse_url_list_lines(&text);

    let tif_urls = filter_usace_urls(&all_urls, state_prefix);
    if tif_urls.is_empty() {
        bail!(
            "No .tif files found matching prefix \"{}\" in URL list",
            state_prefix
        );
    }

    view.info(format!(
        "Filtered URL list by prefix \"{}\" ({} total entries)",
        state_prefix,
        format_int(all_urls.len())
    ));

    download_tiles(client, &tif_urls, out_dir, view)
}

fn download_emodnet_wcs(
    client: &Client,
    coverage_id: &str,
    bbox: &BoundingBox,
    out_dir: &Path,
    view: &StepView,
) -> Result<()> {
    fs::create_dir_all(out_dir)
        .with_context(|| format!("Failed to create {}", out_dir.display()))?;

    let filename = format!("{coverage_id}.tif");
    let destination = out_dir.join(&filename);
    if destination.exists() {
        view.info(format!("Already downloaded: {filename}"));
        view.info(format!("Tiles: {}", display_path(out_dir)));
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

    let timer = std::time::Instant::now();
    let prefix = view.prefix();
    eprint!("{prefix}Requesting WCS coverage {coverage_id}...");
    io::stderr()
        .flush()
        .context("Failed to flush WCS progress output")?;
    download_file(client, url.as_ref(), &destination)?;

    if view.is_interactive() {
        eprintln!(
            "\r{prefix}Requested WCS coverage {coverage_id} — {}ms",
            format_int(timer.elapsed().as_millis())
        );
    } else {
        eprintln!(
            "{prefix}Requested WCS coverage {coverage_id} — {}ms",
            format_int(timer.elapsed().as_millis())
        );
    }
    view.info(format!("Downloaded: {filename}"));
    view.info(format!("Tiles: {}", display_path(out_dir)));
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
    fn parses_cudem_tiff_urls_into_absolute_urls() {
        let dataset_url =
            Url::parse("https://example.com/cudem/wash_bellingham/").expect("valid url");
        let html = r#"
            <a href="../">../</a>
            <a href="?C=N;O=D">sort</a>
            <a href="tile-a.tif">tile-a.tif</a>
            <a href="tile-b.TIF">tile-b.TIF</a>
            <a href="readme.txt">readme</a>
        "#;

        let urls = parse_cudem_tiff_urls(&dataset_url, html);
        assert_eq!(
            urls,
            vec![
                "https://example.com/cudem/wash_bellingham/tile-a.tif".to_string(),
                "https://example.com/cudem/wash_bellingham/tile-b.TIF".to_string(),
            ]
        );
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

    #[test]
    fn parses_url_list_lines_and_ignores_empty_rows() {
        let text = " https://example.com/a.tif \n\n\t\nhttps://example.com/b.tif\n";
        let lines = parse_url_list_lines(text);
        assert_eq!(
            lines,
            vec![
                "https://example.com/a.tif".to_string(),
                "https://example.com/b.tif".to_string()
            ]
        );
    }

    #[test]
    fn cache_freshness_uses_ttl_boundary() {
        assert!(is_url_list_cache_fresh(Duration::from_secs(10)));
        assert!(is_url_list_cache_fresh(URL_LIST_CACHE_TTL));
        assert!(!is_url_list_cache_fresh(
            URL_LIST_CACHE_TTL + Duration::from_secs(1)
        ));
    }

    #[test]
    fn cache_path_changes_with_url() {
        let cache_dir = Path::new("/tmp/cache");
        let url_a = Url::parse("https://example.com/one/list.txt").expect("valid url");
        let url_b = Url::parse("https://example.com/two/list.txt").expect("valid url");

        let path_a = url_list_cache_path(cache_dir, "usace-url-list", &url_a);
        let path_b = url_list_cache_path(cache_dir, "usace-url-list", &url_b);

        assert_ne!(path_a, path_b);
        assert!(path_a
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.starts_with("usace-url-list-"))
            .unwrap_or(false));
    }

    #[test]
    fn cache_path_changes_with_kind() {
        let cache_dir = Path::new("/tmp/cache");
        let url = Url::parse("https://example.com/list.txt").expect("valid url");

        let usace_path = url_list_cache_path(cache_dir, "usace-url-list", &url);
        let cudem_path = url_list_cache_path(cache_dir, "cudem-url-list", &url);

        assert_ne!(usace_path, cudem_path);
    }
}
