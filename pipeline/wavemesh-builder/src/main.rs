#![allow(dead_code)]

mod bounds;
mod config;
mod decimate;
mod level;
mod marching;
mod physics;
mod post;
mod refine;
mod terrain;
mod triangulate;
mod wavefront;
mod wavemesh_file;

use std::time::Instant;

use anyhow::{bail, Context};
use clap::Parser;

/// CLI for the wavemesh-builder binary.
#[derive(Parser)]
#[command(name = "wavemesh-builder")]
struct Cli {
    /// Level JSON file path (repeatable; default: all levels in resources/levels/)
    #[arg(short, long)]
    level: Vec<String>,

    /// Output .wavemesh path (only valid with single --level)
    #[arg(short, long)]
    output: Option<String>,
}

fn main() -> anyhow::Result<()> {
    let cli = Cli::parse();
    let config = config::resolve_config();

    let level_paths: Vec<String> = if cli.level.is_empty() {
        glob::glob("resources/levels/*.level.json")
            .context("invalid glob pattern")?
            .filter_map(|p| p.ok().map(|p| p.to_string_lossy().to_string()))
            .collect()
    } else {
        cli.level
    };

    if let Some(ref _output) = cli.output {
        if level_paths.len() > 1 {
            bail!("--output can only be used with a single --level");
        }
    }

    for level_path in &level_paths {
        let level_name = std::path::Path::new(level_path)
            .file_stem().unwrap_or_default()
            .to_string_lossy()
            .replace(".level", "");
        let wavemesh_path = cli.output.clone().unwrap_or_else(|| {
            level_path.replace(".level.json", ".wavemesh")
        });

        eprintln!("\n=== {level_name} ===");
        eprintln!("  Level: {level_path}");

        process_level(level_path, &wavemesh_path, &config)?;
    }

    eprintln!("\nDone.");
    Ok(())
}

fn process_level(level_path: &str, wavemesh_path: &str, config: &config::MeshBuildConfig) -> anyhow::Result<()> {
    let t0 = Instant::now();
    let json_str = std::fs::read_to_string(level_path)
        .with_context(|| format!("failed to read level file: {level_path}"))?;
    let level_file = level::parse_level_file(&json_str)
        .with_context(|| format!("failed to parse level JSON: {level_path}"))?;

    let wave_sources: Vec<level::WaveSource> = level_file.waves.as_ref()
        .map(|w| w.sources.iter().map(level::WaveSource::from).collect())
        .unwrap_or_else(level::default_wave_sources);

    eprintln!("  Parsed level: {}ms ({} contours, {} wave sources)",
        t0.elapsed().as_millis(), level_file.contours.len(), wave_sources.len());

    if wave_sources.is_empty() {
        eprintln!("  No wave sources — skipping");
        return Ok(());
    }

    let t1 = Instant::now();
    let terrain = level::build_terrain_data(&level_file);
    eprintln!("  Built terrain data: {}ms", t1.elapsed().as_millis());

    let tide_height = 0.0;
    let input_hash = wavemesh_file::compute_input_hash(&wave_sources, &terrain, tide_height);
    eprintln!("  Input hash: 0x{:08x}{:08x}", input_hash[0], input_hash[1]);

    let mut meshes = Vec::new();
    let total_timer = Instant::now();

    for (i, ws) in wave_sources.iter().enumerate() {
        let wave_timer = Instant::now();
        let dir_deg = ws.direction * 180.0 / std::f64::consts::PI;
        eprintln!("  Wave {}: λ={}ft, dir={:.1}°", i, ws.wavelength, dir_deg);

        let mesh = build_wave_mesh(ws, &terrain, config);
        let elapsed = wave_timer.elapsed();
        eprintln!("    Built in {:.0}ms — {} vertices, {} triangles",
            elapsed.as_secs_f64() * 1000.0,
            mesh.vertex_count,
            mesh.index_count / 3);
        meshes.push(mesh);
    }

    let total_build_time = total_timer.elapsed();
    eprintln!("  Total build time: {:.0}ms", total_build_time.as_secs_f64() * 1000.0);

    let t_write = Instant::now();
    let buffer = wavemesh_file::build_wavemesh_buffer(&meshes, input_hash);
    std::fs::write(wavemesh_path, &buffer)
        .with_context(|| format!("failed to write wavemesh file: {wavemesh_path}"))?;
    eprintln!("  Wrote {} ({:.1} KB) in {}ms",
        wavemesh_path, buffer.len() as f64 / 1024.0, t_write.elapsed().as_millis());
    Ok(())
}

fn build_wave_mesh(
    ws: &level::WaveSource,
    terrain: &level::TerrainCPUData,
    config: &config::MeshBuildConfig,
) -> wavefront::WavefrontMeshData {
    let wave_params = wavefront::WaveParams::from_source(ws, config);

    let wave_bounds = bounds::compute_bounds(terrain, &wave_params, &config.bounds);
    let first_wf = marching::generate_initial_wavefront(&wave_bounds, &wave_params);

    let num_rays = first_wf.len();
    let domain_length = wave_bounds.max_proj - wave_bounds.min_proj;
    let domain_width = wave_bounds.max_perp - wave_bounds.min_perp;
    let estimated_steps = (domain_length / wave_params.step_size).ceil() as usize;
    eprintln!("    [marching] domain — rays: {}, {}ft × {}ft, ~{} steps",
        num_rays, domain_length as i64, domain_width as i64, estimated_steps);

    let march_result = marching::march_wavefronts(
        first_wf, &wave_params, &wave_bounds, terrain, config,
    );

    let mesh = triangulate::build_mesh_data_from_tracks(
        &march_result.tracks, &wave_params, &wave_bounds,
    );

    eprintln!("    splits: {}, merges: {}, verts: {} → {} ({:.0}% reduction)",
        march_result.splits, march_result.merges,
        march_result.marched_vertices_before_decimation,
        mesh.vertex_count,
        100.0 * (1.0 - mesh.vertex_count as f64 / march_result.marched_vertices_before_decimation.max(1) as f64));

    mesh
}
