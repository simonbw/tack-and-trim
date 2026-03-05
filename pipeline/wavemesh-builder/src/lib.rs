#![allow(dead_code)]

mod bounds;
mod config;
mod decimate;
mod humanize;
mod level;
mod marching;
mod physics;
mod post;
mod refine;
mod terrain;
mod triangulate;
mod wavefront;
mod wavemesh_file;

use std::sync::Arc;

use anyhow::{bail, Context};
use humanize::format_int;
use terrain_core::step::{format_ms, StepView};

use terrain::{ContourLookupGrid, ParsedContour};

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
        view.info(format!("Level: {level_path}"));

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
    let (level_file, wave_sources) = view.try_run_step(
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
            Ok((level_file, wave_sources))
        },
        |(_lf, ws), d| {
            format!(
                "Parsed level: {}ms ({} contours, {} wave sources)",
                format_ms(d),
                format_int(_lf.contours.len()),
                format_int(ws.len())
            )
        },
    )?;

    if wave_sources.is_empty() {
        view.info("No wave sources — skipping");
        return Ok(());
    }

    let (terrain_data, contours, lookup_grid) = view.run_step(
        "Building terrain",
        || {
            let terrain = level::build_terrain_data(&level_file);
            let (contours, lookup_grid) = terrain::parse_contours(&terrain);
            (terrain, contours, lookup_grid)
        },
        |_, d| format!("Built terrain data: {}ms", format_ms(d)),
    );

    let tide_height = 0.0;
    let input_hash = wavemesh_file::compute_input_hash(&wave_sources, &terrain_data, tide_height);
    view.info(format!(
        "Input hash: 0x{:08x}{:08x}",
        input_hash[0], input_hash[1]
    ));

    let mut meshes = Vec::new();
    let total_timer = std::time::Instant::now();

    for (i, ws) in wave_sources.iter().enumerate() {
        let dir_deg = ws.direction * 180.0 / std::f64::consts::PI;
        view.info(format!(
            "Wave {}: λ={}ft, dir={:.1}°",
            format_int(i),
            ws.wavelength,
            dir_deg
        ));

        let mesh = build_wave_mesh(ws, &terrain_data, &contours, &lookup_grid, config, view);
        meshes.push(mesh);
    }

    let total_build_time = total_timer.elapsed();
    view.info(format!(
        "Total build time: {}ms",
        format_int(total_build_time.as_millis())
    ));

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
                wavemesh_path,
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
    let first_wf = marching::generate_initial_wavefront(&wave_bounds, &wave_params);

    let num_rays = first_wf.len();
    let domain_length = wave_bounds.max_proj - wave_bounds.min_proj;
    let domain_width = wave_bounds.max_perp - wave_bounds.min_perp;
    let estimated_steps = (domain_length / wave_params.step_size).ceil() as usize;
    inner.info(format!(
        "[marching] domain — rays: {}, {}ft × {}ft, ~{} steps",
        format_int(num_rays),
        format_int(domain_length as i64),
        format_int(domain_width as i64),
        format_int(estimated_steps)
    ));

    let march_result = inner.run_step_with_progress(
        "Marching wavefronts",
        None,
        |progress: Arc<std::sync::atomic::AtomicUsize>| {
            marching::march_wavefronts(
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
                "Marching complete — {} tracks, {:.1}s",
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
