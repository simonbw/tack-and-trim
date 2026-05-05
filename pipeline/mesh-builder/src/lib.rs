mod bounds;
mod config;
mod decimate;
mod ray_march;
mod physics;
mod refine;
mod triangulate;
mod wavefront;
mod wavemesh_file;
mod windmesh;
mod windmesh_file;
pub mod tidemesh;
mod tidemesh_file;

use std::sync::Arc;

use anyhow::{bail, Context};
use pipeline_core::humanize::format_int;
use pipeline_core::level;
use pipeline_core::step::{format_ms, StepView};
use pipeline_core::terrain::{self, ContourLookupGrid, ParsedContour};

pub fn run(level_paths: Vec<String>, output: Option<String>) -> anyhow::Result<()> {
    let config = config::resolve_config();
    let view = StepView::new();

    // Initialize rayon thread pool once, before processing any levels.
    let num_threads = std::env::var("WAVEMESH_THREADS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(4)
        });
    rayon::ThreadPoolBuilder::new()
        .num_threads(num_threads)
        .build_global()
        .context("failed to initialize rayon thread pool")?;
    view.info(format!("Using {} rayon threads", format_int(num_threads)));

    let level_paths: Vec<String> = if level_paths.is_empty() {
        glob::glob("resources/levels/*.level.json")
            .context("invalid glob pattern")?
            .filter_map(|p| p.ok().map(|p| p.to_string_lossy().to_string()))
            .collect()
    } else {
        level_paths
    };

    if let Some(ref _output) = output {
        if level_paths.len() > 1 {
            bail!("--output can only be used with a single --level");
        }
    }

    for level_path in &level_paths {
        let level_name = std::path::Path::new(level_path)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .replace(".level", "");
        let wavemesh_path = output
            .clone()
            .unwrap_or_else(|| level_path.replace(".level.json", ".wavemesh"));

        view.header(&level_name);
        view.info(format!("Level: {}", short_path(level_path)));

        process_level(level_path, &wavemesh_path, &config, &view)?;
    }

    view.info("Done.");
    Ok(())
}

pub fn build_wavemesh_for_level(level_path: &str, output: Option<&str>) -> anyhow::Result<()> {
    build_wavemesh_for_level_with_view(level_path, output, None)
}

pub fn build_wavemesh_for_level_with_view(
    level_path: &str,
    output: Option<&str>,
    view: Option<&StepView>,
) -> anyhow::Result<()> {
    let config = config::resolve_config();
    let owned_view;
    let view = match view {
        Some(v) => v,
        None => {
            owned_view = StepView::new();
            &owned_view
        }
    };

    // Initialize rayon thread pool (no-op if already initialized by run()).
    let num_threads = std::env::var("WAVEMESH_THREADS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| {
            std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(4)
        });
    let _ = rayon::ThreadPoolBuilder::new()
        .num_threads(num_threads)
        .build_global();

    let wavemesh_path = output
        .map(std::string::ToString::to_string)
        .unwrap_or_else(|| level_path.replace(".level.json", ".wavemesh"));
    process_level(level_path, &wavemesh_path, &config, &view)
}

fn process_level(
    level_path: &str,
    wavemesh_path: &str,
    config: &config::MeshBuildConfig,
    view: &StepView,
) -> anyhow::Result<()> {
    let (terrain_data, wave_sources) = view.try_run_step(
        "Parsing level",
        || -> anyhow::Result<_> {
            let json_str = std::fs::read_to_string(level_path)
                .with_context(|| format!("failed to read level file: {level_path}"))?;
            let level_file = level::parse_level_file(&json_str)
                .with_context(|| format!("failed to parse level JSON: {level_path}"))?;
            let wave_sources: Vec<level::WaveSource> = level_file
                .waves
                .as_ref()
                .map(|w| w.sources.iter().map(level::WaveSource::from).collect())
                .unwrap_or_else(level::default_wave_sources);

            // Load terrain: prefer precomputed binary, fall back to building from contours
            let terrain = if let Some(terrain_path) =
                level::resolve_terrain_path(&level_file, std::path::Path::new(level_path))?
            {
                let bytes = std::fs::read(&terrain_path).with_context(|| {
                    format!("failed to read terrain file: {}", terrain_path.display())
                })?;
                level::read_terrain_binary(&bytes).with_context(|| {
                    format!("failed to parse terrain file: {}", terrain_path.display())
                })?
            } else {
                let mut lf = level_file;
                level::resolve_level_terrain(&mut lf, std::path::Path::new(level_path))?;
                level::build_terrain_data(&lf)
            };

            Ok((terrain, wave_sources))
        },
        |(td, ws), d| {
            format!(
                "Parsed level: {}ms ({} contours, {} wave sources)",
                format_ms(d),
                format_int(td.contour_count),
                format_int(ws.len())
            )
        },
    )?;

    if wave_sources.is_empty() {
        view.info("No wave sources — skipping");
        return Ok(());
    }

    let (contours, lookup_grid) = view.run_step(
        "Building terrain grids",
        || terrain::parse_contours(&terrain_data),
        |_, d| format!("Built terrain grids: {}ms", format_ms(d)),
    );

    let tide_height = 0.0;
    let input_hash = wavemesh_file::compute_input_hash(&wave_sources, &terrain_data, tide_height);
    view.info(format!(
        "Input hash: 0x{:08x}{:08x}",
        input_hash[0], input_hash[1]
    ));

    let mut meshes = Vec::new();

    for (i, ws) in wave_sources.iter().enumerate() {
        let dir_deg = ws.direction * 180.0 / std::f64::consts::PI;
        let label = format!(
            "Wave {} (λ={}ft, dir={:.1}°)",
            format_int(i),
            ws.wavelength,
            dir_deg
        );

        let mesh = view.run_step(
            &label,
            || build_wave_mesh(ws, &terrain_data, &contours, &lookup_grid, config, view),
            |_mesh, d| format!("{} — {:.1}s", label, d.as_secs_f64()),
        );
        meshes.push(mesh);
    }

    view.try_run_step(
        "Writing wavemesh",
        || -> anyhow::Result<_> {
            let buffer = wavemesh_file::build_wavemesh_buffer(&meshes, input_hash);
            std::fs::write(wavemesh_path, &buffer)
                .with_context(|| format!("failed to write wavemesh file: {wavemesh_path}"))?;
            Ok(buffer)
        },
        |buffer, d| {
            format!(
                "Wrote {} ({:.1} KB) in {}ms",
                short_path(wavemesh_path),
                buffer.len() as f64 / 1024.0,
                format_ms(d)
            )
        },
    )?;

    Ok(())
}

fn build_wave_mesh(
    ws: &level::WaveSource,
    terrain: &level::TerrainCPUData,
    contours: &[ParsedContour],
    lookup_grid: &ContourLookupGrid,
    config: &config::MeshBuildConfig,
    view: &StepView,
) -> wavefront::WavefrontMeshData {
    let wave_params = wavefront::WaveParams::from_source(ws, config);
    let inner = view.indented();

    let wave_bounds = bounds::compute_bounds(terrain, &wave_params, &config.bounds);
    let first_wf = ray_march::generate_initial_wavefront(&wave_bounds, &wave_params);

    let num_rays = first_wf.len();
    let domain_length = wave_bounds.max_proj - wave_bounds.min_proj;
    let _domain_width = wave_bounds.max_perp - wave_bounds.min_perp;
    let estimated_steps = (domain_length / wave_params.step_size).ceil() as usize;

    let march_result = inner.run_step_with_progress(
        "Marching wavefronts",
        None,
        |progress: Arc<std::sync::atomic::AtomicUsize>| {
            ray_march::march_wavefronts(
                first_wf,
                &wave_params,
                &wave_bounds,
                terrain,
                contours,
                lookup_grid,
                config,
                Some(&progress),
            )
        },
        |result, d| {
            format!(
                "Marched {} rays × ~{} steps → {} tracks ({:.1}s)",
                format_int(num_rays),
                format_int(estimated_steps),
                format_int(result.tracks.len()),
                d.as_secs_f64()
            )
        },
    );

    let mesh = inner.run_step(
        "Triangulating",
        || {
            triangulate::build_mesh_data_from_tracks(
                &march_result.tracks,
                &wave_params,
                &wave_bounds,
            )
        },
        |mesh, d| {
            format!(
                "Triangulated: {} verts, {} tris ({}ms)",
                format_int(mesh.vertex_count),
                format_int(mesh.index_count / 3),
                format_ms(d)
            )
        },
    );

    inner.info(format!(
        "splits: {}, merges: {}, verts: {} → {} ({:.0}% reduction)",
        format_int(march_result.splits),
        format_int(march_result.merges),
        format_int(march_result.marched_vertices_before_decimation),
        format_int(mesh.vertex_count),
        100.0
            * (1.0
                - mesh.vertex_count as f64
                    / march_result.marched_vertices_before_decimation.max(1) as f64)
    ));

    mesh
}

pub fn build_windmesh_for_level_with_view(
    level_path: &str,
    output: Option<&str>,
    view: Option<&StepView>,
) -> anyhow::Result<()> {
    let owned_view;
    let view = match view {
        Some(v) => v,
        None => {
            owned_view = StepView::new();
            &owned_view
        }
    };

    let windmesh_path = output
        .map(std::string::ToString::to_string)
        .unwrap_or_else(|| level_path.replace(".level.json", ".windmesh"));

    let (terrain_data, wind_sources) = view.try_run_step(
        "Parsing level for wind mesh",
        || -> anyhow::Result<_> {
            let json_str = std::fs::read_to_string(level_path)
                .with_context(|| format!("failed to read level file: {level_path}"))?;
            let level_file = level::parse_level_file(&json_str)
                .with_context(|| format!("failed to parse level JSON: {level_path}"))?;
            let wind_sources: Vec<level::WindSource> = level_file
                .wind
                .as_ref()
                .map(|w| w.sources.iter().map(level::WindSource::from).collect())
                .unwrap_or_else(level::default_wind_sources);

            // Load terrain: prefer precomputed binary, fall back to building from contours
            let terrain = if let Some(terrain_path) =
                level::resolve_terrain_path(&level_file, std::path::Path::new(level_path))?
            {
                let bytes = std::fs::read(&terrain_path).with_context(|| {
                    format!("failed to read terrain file: {}", terrain_path.display())
                })?;
                level::read_terrain_binary(&bytes).with_context(|| {
                    format!("failed to parse terrain file: {}", terrain_path.display())
                })?
            } else {
                let mut lf = level_file;
                level::resolve_level_terrain(&mut lf, std::path::Path::new(level_path))?;
                level::build_terrain_data(&lf)
            };

            Ok((terrain, wind_sources))
        },
        |(td, ws), d| {
            format!(
                "Parsed level: {}ms ({} contours, {} wind sources)",
                format_ms(d),
                format_int(td.contour_count),
                format_int(ws.len())
            )
        },
    )?;

    // Load tree data if a .trees file exists alongside the level
    let trees_path = level_path.replace(".level.json", ".trees");
    // Try static/levels/ path convention (used by build pipeline)
    let trees_static_path = {
        let p = std::path::Path::new(level_path);
        let slug = p
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy()
            .replace(".level", "");
        format!("static/levels/{}.trees", slug)
    };
    let _tree_data = if std::path::Path::new(&trees_static_path).exists() {
        match std::fs::read(&trees_static_path) {
            Ok(data) => {
                let tree_count = if data.len() >= 16 {
                    u32::from_le_bytes([data[8], data[9], data[10], data[11]]) as usize
                } else {
                    0
                };
                view.info(format!(
                    "Loaded tree data: {} trees from {}",
                    format_int(tree_count),
                    short_path(&trees_static_path)
                ));
                Some(data)
            }
            Err(e) => {
                view.info(format!(
                    "Could not load tree data from {}: {}",
                    trees_static_path, e
                ));
                None
            }
        }
    } else if std::path::Path::new(&trees_path).exists() {
        match std::fs::read(&trees_path) {
            Ok(data) => {
                let tree_count = if data.len() >= 16 {
                    u32::from_le_bytes([data[8], data[9], data[10], data[11]]) as usize
                } else {
                    0
                };
                view.info(format!(
                    "Loaded tree data: {} trees from {}",
                    format_int(tree_count),
                    short_path(&trees_path)
                ));
                Some(data)
            }
            Err(e) => {
                view.info(format!(
                    "Could not load tree data from {}: {}",
                    trees_path, e
                ));
                None
            }
        }
    } else {
        view.info("No tree data available (wind mesh will not account for trees)".to_string());
        None
    };

    let wind_directions: Vec<f64> = wind_sources.iter().map(|s| s.direction).collect();
    let input_hash = windmesh_file::compute_wind_input_hash(&terrain_data, &wind_directions);
    view.info(format!(
        "Input hash: 0x{:08x}{:08x}",
        input_hash[0], input_hash[1]
    ));

    const GRID_SPACING: f64 = 200.0;

    let meshes: Vec<windmesh::WindMeshData> = wind_sources
        .iter()
        .enumerate()
        .map(|(i, ws)| {
            let dir_deg = ws.direction * 180.0 / std::f64::consts::PI;
            let label = format!("Wind source {} (dir={:.1}°)", format_int(i), dir_deg);

            view.run_step(
                &label,
                || windmesh::build_wind_grid(&terrain_data, GRID_SPACING, ws.direction),
                |mesh, d| {
                    format!(
                        "{}: {} verts, {} tris ({}ms)",
                        label,
                        format_int(mesh.vertex_count),
                        format_int(mesh.index_count / 3),
                        format_ms(d)
                    )
                },
            )
        })
        .collect();

    view.try_run_step(
        "Writing windmesh",
        || -> anyhow::Result<_> {
            let buffer = windmesh_file::build_windmesh_buffer(&meshes, input_hash);
            std::fs::write(&windmesh_path, &buffer)
                .with_context(|| format!("failed to write windmesh file: {windmesh_path}"))?;
            Ok(buffer)
        },
        |buffer, d| {
            format!(
                "Wrote {} ({:.1} KB, {} sources) in {}ms",
                short_path(&windmesh_path),
                buffer.len() as f64 / 1024.0,
                format_int(meshes.len()),
                format_ms(d)
            )
        },
    )?;

    Ok(())
}

pub fn build_tidemesh_for_level_with_view(
    level_path: &str,
    output: Option<&str>,
    view: Option<&StepView>,
) -> anyhow::Result<()> {
    let owned_view;
    let view = match view {
        Some(v) => v,
        None => {
            owned_view = StepView::new();
            &owned_view
        }
    };

    let tidemesh_path = output
        .map(std::string::ToString::to_string)
        .unwrap_or_else(|| level_path.replace(".level.json", ".tidemesh"));

    let terrain_data = view.try_run_step(
        "Parsing level for tide mesh",
        || -> anyhow::Result<_> {
            let json_str = std::fs::read_to_string(level_path)
                .with_context(|| format!("failed to read level file: {level_path}"))?;
            let level_file = level::parse_level_file(&json_str)
                .with_context(|| format!("failed to parse level JSON: {level_path}"))?;

            // Load terrain: prefer precomputed binary, fall back to building from contours
            let terrain = if let Some(terrain_path) =
                level::resolve_terrain_path(&level_file, std::path::Path::new(level_path))?
            {
                let bytes = std::fs::read(&terrain_path).with_context(|| {
                    format!("failed to read terrain file: {}", terrain_path.display())
                })?;
                level::read_terrain_binary(&bytes).with_context(|| {
                    format!("failed to parse terrain file: {}", terrain_path.display())
                })?
            } else {
                let mut lf = level_file;
                level::resolve_level_terrain(&mut lf, std::path::Path::new(level_path))?;
                level::build_terrain_data(&lf)
            };

            Ok(terrain)
        },
        |td, d| {
            format!(
                "Parsed level: {}ms ({} contours)",
                format_ms(d),
                format_int(td.contour_count),
            )
        },
    )?;

    let config = tidemesh::resolve_tidemesh_config();
    let input_hash =
        tidemesh_file::compute_tide_input_hash(&terrain_data, &config.tide_levels);
    view.info(format!(
        "Input hash: 0x{:08x}{:08x}",
        input_hash[0], input_hash[1]
    ));
    view.info(format!(
        "Tide levels: {:?}",
        config.tide_levels
    ));

    let mesh = view.run_step(
        "Building tide mesh",
        || tidemesh::build_tide_mesh(&terrain_data, &config),
        |mesh, d| {
            format!(
                "Built tide mesh: {} verts, {} tris, {} tide levels ({:.1}s)",
                format_int(mesh.vertex_count),
                format_int(mesh.triangle_count),
                format_int(mesh.tide_levels.len()),
                d.as_secs_f64()
            )
        },
    );

    view.try_run_step(
        "Writing tidemesh",
        || -> anyhow::Result<_> {
            let buffer = tidemesh_file::build_tidemesh_buffer(&mesh, input_hash);
            std::fs::write(&tidemesh_path, &buffer)
                .with_context(|| format!("failed to write tidemesh file: {tidemesh_path}"))?;
            Ok(buffer)
        },
        |buffer, d| {
            format!(
                "Wrote {} ({:.1} KB) in {}ms",
                short_path(&tidemesh_path),
                buffer.len() as f64 / 1024.0,
                format_ms(d)
            )
        },
    )?;

    Ok(())
}

/// Strip the current working directory prefix from a path for cleaner logs.
fn short_path(path: &str) -> String {
    let path = std::path::Path::new(path);
    if let Ok(cwd) = std::env::current_dir() {
        if let Ok(canonical) = path.canonicalize() {
            if let Ok(rel) = canonical.strip_prefix(&cwd) {
                return rel.display().to_string();
            }
        }
    }
    path.display().to_string()
}
