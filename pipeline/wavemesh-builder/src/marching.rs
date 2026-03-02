//! Wavefront marching — initial wavefront generation, per-track marching,
//! and parallel orchestration via concurrent work queue.
//! Mirrors marching.ts.

use std::time::Instant;

use rayon::prelude::*;

use crate::config::MeshBuildConfig;
use crate::decimate::decimate_track_snapshots;
use crate::level::TerrainCPUData;
use crate::physics::{advance_interior_ray, advance_sentinel_ray, RayState};
use crate::refine::{refine_wavefront, RefineStats};
use crate::terrain::{parse_contours, ParsedContour};
use crate::wavefront::{SegmentTrack, SegmentTrackSnapshot, WaveBounds, WaveParams, WavefrontSegment};

// ── Initial wavefront ────────────────────────────────────────────────────────

/// Generate the initial wavefront with left/right sentinels and evenly-spaced
/// interior rays spanning the perpendicular extent of the wave bounds.
pub fn generate_initial_wavefront(
    bounds: &WaveBounds,
    wp: &WaveParams,
) -> WavefrontSegment {
    let width = bounds.max_perp - bounds.min_perp;
    let num_interior = (width / wp.vertex_spacing).ceil() as usize + 1;
    let num_interior = num_interior.max(3);
    let num_vertices = num_interior + 2;

    let mut wf = WavefrontSegment::with_capacity(0, None, 0, num_vertices);

    // Left sentinel
    let left_perp = bounds.min_perp;
    wf.push(
        bounds.min_proj * wp.wave_dx + left_perp * wp.perp_dx,
        bounds.min_proj * wp.wave_dy + left_perp * wp.perp_dy,
        0.0, wp.wave_dx, wp.wave_dy,
        1.0, 0.0, wp.wavelength, 0.0, 0.0, 0.0, 1.0,
    );

    // Interior rays
    for i in 0..num_interior {
        let ti = (i + 1) as f64 / (num_interior + 1) as f64;
        let perp_pos = bounds.min_perp + (i as f64 / (num_interior - 1) as f64) * width;
        wf.push(
            bounds.min_proj * wp.wave_dx + perp_pos * wp.perp_dx,
            bounds.min_proj * wp.wave_dy + perp_pos * wp.perp_dy,
            ti, wp.wave_dx, wp.wave_dy,
            1.0, 0.0, 0.0, f64::NAN, f64::NAN, 0.0, 1.0,
        );
    }

    // Right sentinel
    let right_perp = bounds.max_perp;
    wf.push(
        bounds.min_proj * wp.wave_dx + right_perp * wp.perp_dx,
        bounds.min_proj * wp.wave_dy + right_perp * wp.perp_dy,
        1.0, wp.wave_dx, wp.wave_dy,
        1.0, 0.0, wp.wavelength, 0.0, 0.0, 0.0, 1.0,
    );

    assert_eq!(wf.len(), num_vertices);
    wf
}

// ── Single track step ────────────────────────────────────────────────────────

/// Result of advancing a single ray one step. Computed in parallel, then
/// assembled sequentially to handle splits and refinement.
enum RayStepOutcome {
    /// Ray died (out of bounds) or energy too low — triggers a segment break.
    Gap,
    /// Ray advanced successfully.
    Advanced {
        nx: f64, ny: f64, t: f64,
        dir_x: f64, dir_y: f64,
        energy: f64, turbulence: f64, depth: f64,
        terrain_grad_x: f64, terrain_grad_y: f64,
        blend: f64,
        is_sentinel: bool,
        refracted: bool,
        turn_clamped: bool,
    },
}

#[allow(clippy::too_many_arguments)]
fn advance_track_segment_step(
    segment: &WavefrontSegment,
    parent_track_id: Option<i32>,
    wp: &WaveParams,
    bounds: &WaveBounds,
    breaking_depth: f64,
    terrain: &TerrainCPUData,
    contours: &[ParsedContour],
    config: &MeshBuildConfig,
    stats: &mut RefineStats,
) -> (usize, Vec<WavefrontSegment>, u64, u64) {
    let next_source_step = segment.source_step_index + 1;
    let src_len = segment.len();

    // ── Pass 1: advance all rays in parallel ────────────────────────────────
    let outcomes: Vec<RayStepOutcome> = (0..src_len)
        .into_par_iter()
        .map(|i| {
            let energy = segment.energy[i];
            let px = segment.x[i];
            let py = segment.y[i];
            let pt = segment.t[i];
            let is_sentinel = pt == 0.0 || pt == 1.0;

            if !is_sentinel && energy < config.refinement.min_energy {
                return RayStepOutcome::Gap;
            }

            if is_sentinel {
                return match advance_sentinel_ray(px, py, wp, bounds) {
                    Some(sr) => RayStepOutcome::Advanced {
                        nx: sr.nx, ny: sr.ny, t: pt,
                        dir_x: wp.wave_dx, dir_y: wp.wave_dy,
                        energy: 1.0, turbulence: 0.0, depth: wp.wavelength,
                        terrain_grad_x: 0.0, terrain_grad_y: 0.0,
                        blend: 1.0, is_sentinel: true,
                        refracted: false, turn_clamped: false,
                    },
                    None => RayStepOutcome::Gap,
                };
            }

            let ray = RayState {
                x: px, y: py, energy,
                turbulence: segment.turbulence[i],
                dir_x: segment.dir_x[i], dir_y: segment.dir_y[i],
                depth: segment.depth[i],
                terrain_grad_x: segment.terrain_grad_x[i],
                terrain_grad_y: segment.terrain_grad_y[i],
            };

            match advance_interior_ray(&ray, wp, bounds, breaking_depth, &config.physics, terrain, contours) {
                Some(ir) => RayStepOutcome::Advanced {
                    nx: ir.nx, ny: ir.ny, t: pt,
                    dir_x: ir.dir_x, dir_y: ir.dir_y,
                    energy: ir.energy, turbulence: ir.turbulence, depth: ir.depth,
                    terrain_grad_x: ir.terrain_grad_x, terrain_grad_y: ir.terrain_grad_y,
                    blend: 1.0, is_sentinel: false,
                    refracted: ir.refracted, turn_clamped: ir.turn_clamped,
                },
                None => RayStepOutcome::Gap,
            }
        })
        .collect();

    // ── Pass 2: sequential assembly with split/flush logic ──────────────────
    let mut produced: Vec<WavefrontSegment> = Vec::new();
    let mut refracted_count = 0u64;
    let mut turn_clamped_count = 0u64;

    let mut current = WavefrontSegment::with_capacity(-1, parent_track_id, next_source_step, src_len);

    let mut flush = |current: &mut WavefrontSegment, produced: &mut Vec<WavefrontSegment>| {
        if current.len() == 0 { return; }
        let refined = refine_wavefront(current, wp.vertex_spacing, wp.initial_delta_t, stats, &config.refinement);
        produced.push(refined);
        *current = WavefrontSegment::with_capacity(-1, parent_track_id, next_source_step, src_len);
    };

    for outcome in &outcomes {
        match outcome {
            RayStepOutcome::Gap => {
                flush(&mut current, &mut produced);
            }
            RayStepOutcome::Advanced {
                nx, ny, t, dir_x, dir_y, energy, turbulence, depth,
                terrain_grad_x, terrain_grad_y, blend, is_sentinel,
                refracted, turn_clamped,
            } => {
                if *refracted { refracted_count += 1; }
                if *turn_clamped { turn_clamped_count += 1; }

                // Energy ratio check → segment break (skip for sentinels)
                if !is_sentinel && !current.energy.is_empty() {
                    let prev_e = *current.energy.last().unwrap();
                    let ratio = if *energy > prev_e { energy / prev_e } else { prev_e / energy };
                    if ratio > config.refinement.max_energy_ratio {
                        flush(&mut current, &mut produced);
                    }
                }

                current.push(
                    *nx, *ny, *t,
                    *dir_x, *dir_y,
                    *energy, *turbulence, *depth,
                    *terrain_grad_x, *terrain_grad_y,
                    0.0, *blend,
                );
            }
        }
    }

    if current.len() > 0 {
        let refined = refine_wavefront(&current, wp.vertex_spacing, wp.initial_delta_t, stats, &config.refinement);
        produced.push(refined);
    }

    (next_source_step, produced, refracted_count, turn_clamped_count)
}

// ── March a single track to completion ───────────────────────────────────────

type TrackResult = (
    SegmentTrack,
    Vec<WavefrontSegment>, // child seeds
    RefineStats,
    u64, // refractions
    u64, // turn clamps
    u64, // marched verts
);

fn march_single_track(
    seed: WavefrontSegment,
    wp: &WaveParams,
    bounds: &WaveBounds,
    terrain: &TerrainCPUData,
    contours: &[ParsedContour],
    config: &MeshBuildConfig,
) -> TrackResult {
    let breaking_depth = config.physics.breaking_depth_ratio * wp.wavelength;

    let mut stats = RefineStats { splits: 0, merges: 0 };
    let mut total_refractions = 0u64;
    let mut total_clamps = 0u64;
    let mut marched_verts = seed.len() as u64;

    let mut track = SegmentTrack {
        track_id: seed.track_id,
        parent_track_id: seed.parent_track_id,
        child_track_ids: vec![],
        snapshots: vec![SegmentTrackSnapshot {
            step_index: 0,
            segment_index: 0,
            source_step_index: seed.source_step_index,
            segment: seed.clone(),
        }],
    };

    let mut segment = seed;

    // Post-process seed segment
    post_process_segments(&mut [&mut segment], wp, &config.post);
    // Copy back to track
    track.snapshots[0].segment = segment.clone();

    let mut child_seeds: Vec<WavefrontSegment> = Vec::new();

    loop {
        let (next_step, produced, refractions, clamps) = advance_track_segment_step(
            &segment, segment.parent_track_id,
            wp, bounds, breaking_depth,
            terrain, contours, config, &mut stats,
        );
        total_refractions += refractions;
        total_clamps += clamps;

        if produced.is_empty() {
            break;
        }

        if produced.len() == 1 {
            let mut next_seg = produced.into_iter().next().unwrap();
            next_seg.track_id = track.track_id;
            next_seg.parent_track_id = track.parent_track_id;

            // Post-process
            post_process_segments(&mut [&mut next_seg], wp, &config.post);

            marched_verts += next_seg.len() as u64;
            track.snapshots.push(SegmentTrackSnapshot {
                step_index: next_step,
                segment_index: 0,
                source_step_index: next_seg.source_step_index,
                segment: next_seg.clone(),
            });
            segment = next_seg;
            continue;
        }

        // Split: multiple segments produced
        let mut children: Vec<WavefrontSegment> = produced;
        // Post-process all children as a wavefront step
        {
            let mut refs: Vec<&mut WavefrontSegment> = children.iter_mut().collect();
            post_process_segments(&mut refs, wp, &config.post);
        }

        for child in children {
            marched_verts += child.len() as u64;
            child_seeds.push(child);
        }
        break;
    }

    (track, child_seeds, stats, total_refractions, total_clamps, marched_verts)
}

fn post_process_segments(
    segments: &mut [&mut WavefrontSegment],
    wp: &WaveParams,
    config: &crate::config::MeshBuildPostConfig,
) {
    let spacing_per_t = wp.vertex_spacing / wp.initial_delta_t;

    for seg in segments.iter_mut() {
        let n = seg.len();
        if n == 0 { continue; }

        for i in 0..n {
            if seg.t[i] == 0.0 || seg.t[i] == 1.0 {
                seg.amplitude[i] = 1.0;
                continue;
            }

            let p_depth = seg.depth[i];
            let kh = wp.k * p_depth;
            let shoaling = if p_depth > 0.0 {
                let s = if kh > 10.0 { 1.0 } else {
                    let sinh2kh = (2.0 * kh).sinh();
                    let n_val = 0.5 * (1.0 + (2.0 * kh) / sinh2kh);
                    1.0 / (2.0 * n_val * kh.tanh()).sqrt()
                };
                s.min(config.max_amplification)
            } else { 1.0 };

            let (local_spacing, delta_t) = if n <= 1 {
                (wp.vertex_spacing, wp.initial_delta_t)
            } else if i == 0 {
                let dx = seg.x[0] - seg.x[1];
                let dy = seg.y[0] - seg.y[1];
                ((dx * dx + dy * dy).sqrt(), seg.t[1] - seg.t[0])
            } else if i == n - 1 {
                let prev = n - 2;
                let dx = seg.x[n - 1] - seg.x[prev];
                let dy = seg.y[n - 1] - seg.y[prev];
                ((dx * dx + dy * dy).sqrt(), seg.t[n - 1] - seg.t[prev])
            } else {
                let dxp = seg.x[i] - seg.x[i - 1];
                let dyp = seg.y[i] - seg.y[i - 1];
                let dp = (dxp * dxp + dyp * dyp).sqrt();
                let dxn = seg.x[i] - seg.x[i + 1];
                let dyn_ = seg.y[i] - seg.y[i + 1];
                let dn = (dxn * dxn + dyn_ * dyn_).sqrt();
                ((dp + dn) / 2.0, (seg.t[i + 1] - seg.t[i - 1]) / 2.0)
            };

            let expected = delta_t * spacing_per_t;
            let divergence = (expected / local_spacing).sqrt().min(config.max_amplification);
            seg.amplitude[i] = seg.energy[i] * shoaling * divergence;
        }
    }

    // Diffraction
    let d = (wp.step_size / (2.0 * wp.k * wp.vertex_spacing * wp.vertex_spacing)).min(config.max_diffusion_d);
    let mut scratch = Vec::new();

    for seg in segments.iter_mut() {
        let n = seg.len();
        if n <= 1 { continue; }

        let edge_threshold = wp.initial_delta_t * 0.5;
        let left_is_edge = seg.t[0] < edge_threshold;
        let right_is_edge = seg.t[n - 1] > 1.0 - edge_threshold;

        scratch.resize(n, 0.0);
        for _ in 0..config.diffraction_iterations {
            scratch[..n].copy_from_slice(&seg.amplitude[..n]);
            for i in 0..n {
                let left = if i > 0 { scratch[i - 1] } else if left_is_edge { 1.0 } else { 0.0 };
                let right = if i < n - 1 { scratch[i + 1] } else if right_is_edge { 1.0 } else { 0.0 };
                seg.amplitude[i] = (scratch[i] + d * (left - 2.0 * scratch[i] + right)).max(0.0);
            }
        }
    }

    // Turbulence diffusion
    for seg in segments.iter_mut() {
        let n = seg.len();
        if n <= 2 { continue; }
        scratch.resize(n, 0.0);
        for _ in 0..config.turbulence_diffusion_iterations {
            scratch[..n].copy_from_slice(&seg.turbulence[..n]);
            for i in 0..n {
                let left = if i > 0 { scratch[i - 1] } else { 0.0 };
                let right = if i < n - 1 { scratch[i + 1] } else { 0.0 };
                seg.turbulence[i] = (scratch[i] + config.turbulence_diffusion_d * (left - 2.0 * scratch[i] + right)).max(0.0);
            }
        }
    }
}

// ── Parallel march orchestration ─────────────────────────────────────────────

/// Aggregated results from marching all wavefronts for a single wave source.
pub struct MarchResult {
    pub tracks: Vec<SegmentTrack>,
    pub marched_vertices_before_decimation: u64,
    pub removed_snapshots: u64,
    pub removed_vertices: u64,
    pub splits: u64,
    pub merges: u64,
    pub turn_clamp_count: u64,
    pub total_refractions: u64,
}

/// March all wavefronts using rayon::scope for track-level parallelism
/// and rayon par_iter for ray-level parallelism within each step.
pub fn march_wavefronts(
    first_wavefront: WavefrontSegment,
    wp: &WaveParams,
    bounds: &WaveBounds,
    terrain: &TerrainCPUData,
    config: &MeshBuildConfig,
) -> MarchResult {
    use std::sync::atomic::{AtomicI32, AtomicU64, Ordering};
    use std::sync::Mutex;

    let contours = parse_contours(terrain);

    let mut wp = wp.clone();
    wp.initial_delta_t = if first_wavefront.len() > 2 {
        first_wavefront.t[2] - first_wavefront.t[1]
    } else if first_wavefront.len() > 1 {
        first_wavefront.t[1] - first_wavefront.t[0]
    } else {
        1.0
    };

    let num_threads = std::env::var("WAVEMESH_THREADS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| {
            let cpus = std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(4);
            cpus.min(8)
        });
    eprintln!("    [march] using {num_threads} rayon threads");

    // Configure rayon's global thread pool (only takes effect on first call)
    let _ = rayon::ThreadPoolBuilder::new()
        .num_threads(num_threads)
        .build_global();

    let start = Instant::now();

    let next_track_id = AtomicI32::new(first_wavefront.track_id + 1);
    let all_tracks: Mutex<Vec<SegmentTrack>> = Mutex::new(Vec::new());
    let total_splits = AtomicU64::new(0);
    let total_merges = AtomicU64::new(0);
    let total_refractions = AtomicU64::new(0);
    let turn_clamp_count = AtomicU64::new(0);
    let marched_verts = AtomicU64::new(0);
    let removed_snapshots = AtomicU64::new(0);
    let removed_vertices = AtomicU64::new(0);
    let tracks_done = AtomicU64::new(0);

    // Process a single track end-to-end: march all steps (with par_iter on rays),
    // spawn child tracks on split, then decimate.
    fn process_track<'scope>(
        s: &rayon::Scope<'scope>,
        mut seed: WavefrontSegment,
        wp: &'scope WaveParams,
        bounds: &'scope WaveBounds,
        terrain: &'scope TerrainCPUData,
        contours: &'scope [ParsedContour],
        config: &'scope MeshBuildConfig,
        next_track_id: &'scope AtomicI32,
        all_tracks: &'scope Mutex<Vec<SegmentTrack>>,
        total_splits: &'scope AtomicU64,
        total_merges: &'scope AtomicU64,
        total_refractions: &'scope AtomicU64,
        turn_clamp_count: &'scope AtomicU64,
        marched_verts: &'scope AtomicU64,
        removed_snapshots: &'scope AtomicU64,
        removed_vertices: &'scope AtomicU64,
        tracks_done: &'scope AtomicU64,
        start: &'scope Instant,
    ) {
        if seed.track_id < 0 {
            seed.track_id = next_track_id.fetch_add(1, Ordering::Relaxed);
        }

        let (track, child_seeds, stats, refractions, clamped, verts) =
            march_single_track(seed, wp, bounds, terrain, contours, config);

        total_splits.fetch_add(stats.splits, Ordering::Relaxed);
        total_merges.fetch_add(stats.merges, Ordering::Relaxed);
        total_refractions.fetch_add(refractions, Ordering::Relaxed);
        turn_clamp_count.fetch_add(clamped, Ordering::Relaxed);
        marched_verts.fetch_add(verts, Ordering::Relaxed);

        // Assign IDs and spawn child tracks immediately
        let child_ids: Vec<i32> = child_seeds
            .iter()
            .map(|_| next_track_id.fetch_add(1, Ordering::Relaxed))
            .collect();

        for (mut child, &id) in child_seeds.into_iter().zip(child_ids.iter()) {
            child.track_id = id;
            s.spawn(move |s| {
                process_track(
                    s, child, wp, bounds, terrain, contours, config,
                    next_track_id, all_tracks,
                    total_splits, total_merges, total_refractions, turn_clamp_count,
                    marched_verts, removed_snapshots, removed_vertices, tracks_done, start,
                );
            });
        }

        let mut final_track = track;
        final_track.child_track_ids = child_ids;

        // Decimate while children are already running on other threads
        let dec = decimate_track_snapshots(&final_track, wp, config.decimation.tolerance);
        removed_snapshots.fetch_add(dec.removed_snapshots, Ordering::Relaxed);
        removed_vertices.fetch_add(dec.removed_vertices, Ordering::Relaxed);

        all_tracks.lock().unwrap().push(dec.track);
        let done = tracks_done.fetch_add(1, Ordering::Relaxed) + 1;
        if done % 500 == 0 {
            eprintln!("    [march] {} tracks done ({:.1}s)",
                done, start.elapsed().as_secs_f64());
        }
    }

    rayon::scope(|s| {
        s.spawn(|s| {
            process_track(
                s, first_wavefront, &wp, bounds, terrain, &contours, config,
                &next_track_id, &all_tracks,
                &total_splits, &total_merges, &total_refractions, &turn_clamp_count,
                &marched_verts, &removed_snapshots, &removed_vertices, &tracks_done, &start,
            );
        });
    }); // blocks until all tracks (including children) are done

    let mut tracks = all_tracks.into_inner().unwrap();
    tracks.sort_by_key(|t| t.track_id);

    let total_elapsed = start.elapsed();
    eprintln!(
        "    [marching] complete — {} tracks, {:.1}s total",
        tracks.len(),
        total_elapsed.as_secs_f64(),
    );

    MarchResult {
        tracks,
        marched_vertices_before_decimation: marched_verts.into_inner(),
        removed_snapshots: removed_snapshots.into_inner(),
        removed_vertices: removed_vertices.into_inner(),
        splits: total_splits.into_inner(),
        merges: total_merges.into_inner(),
        turn_clamp_count: turn_clamp_count.into_inner(),
        total_refractions: total_refractions.into_inner(),
    }
}
