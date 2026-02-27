//! Wavefront marching — initial wavefront generation, per-track marching,
//! and parallel orchestration via concurrent work queue.
//! Mirrors marching.ts.

use std::time::Instant;

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

    let mut wf = WavefrontSegment::new(0, None, 0);

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
    let mut produced: Vec<WavefrontSegment> = Vec::new();
    let mut refracted_count = 0u64;
    let mut turn_clamped_count = 0u64;

    let mut current = WavefrontSegment::new(-1, parent_track_id, next_source_step);

    let mut flush = |current: &mut WavefrontSegment, produced: &mut Vec<WavefrontSegment>| {
        if current.len() == 0 { return; }
        let refined = refine_wavefront(current, wp.vertex_spacing, wp.initial_delta_t, stats, &config.refinement);
        produced.push(refined);
        *current = WavefrontSegment::new(-1, parent_track_id, next_source_step);
    };

    for i in 0..src_len {
        let energy = segment.energy[i];
        let px = segment.x[i];
        let py = segment.y[i];
        let pt = segment.t[i];
        let is_sentinel = pt == 0.0 || pt == 1.0;

        if !is_sentinel && energy < config.refinement.min_energy {
            flush(&mut current, &mut produced);
            continue;
        }

        if is_sentinel {
            if let Some(sr) = advance_sentinel_ray(px, py, wp, bounds) {
                current.push(sr.nx, sr.ny, pt, wp.wave_dx, wp.wave_dy, 1.0, 0.0, wp.wavelength, 0.0, 0.0, 0.0, 1.0);
            } else {
                flush(&mut current, &mut produced);
            }
            continue;
        }

        let ray = RayState {
            x: px,
            y: py,
            energy,
            turbulence: segment.turbulence[i],
            dir_x: segment.dir_x[i],
            dir_y: segment.dir_y[i],
            depth: segment.depth[i],
            terrain_grad_x: segment.terrain_grad_x[i],
            terrain_grad_y: segment.terrain_grad_y[i],
        };

        let result = advance_interior_ray(
            &ray, wp, bounds, breaking_depth,
            &config.physics, terrain, contours,
        );

        let ir = match result {
            Some(r) => r,
            None => { flush(&mut current, &mut produced); continue; }
        };

        if ir.refracted { refracted_count += 1; }
        if ir.turn_clamped { turn_clamped_count += 1; }

        // Energy ratio check → segment break
        if !current.energy.is_empty() {
            let prev_e = *current.energy.last().unwrap();
            let ratio = if ir.energy > prev_e { ir.energy / prev_e } else { prev_e / ir.energy };
            if ratio > config.refinement.max_energy_ratio {
                flush(&mut current, &mut produced);
            }
        }

        current.push(
            ir.nx, ir.ny, pt,
            ir.dir_x, ir.dir_y,
            ir.energy, ir.turbulence, ir.depth,
            ir.terrain_grad_x, ir.terrain_grad_y,
            0.0, 1.0,
        );
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

/// March all wavefronts using a concurrent work-queue with dedicated threads.
pub fn march_wavefronts(
    first_wavefront: WavefrontSegment,
    wp: &WaveParams,
    bounds: &WaveBounds,
    terrain: &TerrainCPUData,
    config: &MeshBuildConfig,
) -> MarchResult {
    use std::sync::atomic::{AtomicI32, AtomicU64, Ordering};
    use std::sync::{Arc, Condvar, Mutex};

    let contours = parse_contours(terrain);

    let mut wp = wp.clone();
    wp.initial_delta_t = if first_wavefront.len() > 2 {
        first_wavefront.t[2] - first_wavefront.t[1]
    } else if first_wavefront.len() > 1 {
        first_wavefront.t[1] - first_wavefront.t[0]
    } else {
        1.0
    };

    let start = Instant::now();

    struct SharedState {
        next_track_id: AtomicI32,
        seeds: Mutex<Vec<WavefrontSegment>>,
        condvar: Condvar,
        in_flight: AtomicU64,
        done: Mutex<bool>,
        all_tracks: Mutex<Vec<SegmentTrack>>,
        total_splits: AtomicU64,
        total_merges: AtomicU64,
        total_refractions: AtomicU64,
        turn_clamp_count: AtomicU64,
        marched_verts: AtomicU64,
        removed_snapshots: AtomicU64,
        removed_vertices: AtomicU64,
        tracks_done: AtomicU64,
    }

    let shared = Arc::new(SharedState {
        next_track_id: AtomicI32::new(first_wavefront.track_id + 1),
        seeds: Mutex::new(vec![first_wavefront]),
        condvar: Condvar::new(),
        in_flight: AtomicU64::new(1),
        done: Mutex::new(false),
        all_tracks: Mutex::new(Vec::new()),
        total_splits: AtomicU64::new(0),
        total_merges: AtomicU64::new(0),
        total_refractions: AtomicU64::new(0),
        turn_clamp_count: AtomicU64::new(0),
        marched_verts: AtomicU64::new(0),
        removed_snapshots: AtomicU64::new(0),
        removed_vertices: AtomicU64::new(0),
        tracks_done: AtomicU64::new(0),
    });

    let num_threads = std::env::var("WAVEMESH_THREADS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or_else(|| {
            let cpus = std::thread::available_parallelism()
                .map(|n| n.get())
                .unwrap_or(4);
            cpus.min(4)
        });
    eprintln!("    [march] using {num_threads} threads");

    // Use Arc for immutable shared data so threads (which must be 'static) can access it.
    let contours = Arc::new(contours);
    let terrain = Arc::new(terrain.clone());
    let bounds = Arc::new(*bounds);
    let config = Arc::new(config.clone());
    let wp = Arc::new(wp);

    let stack_size = 64 * 1024 * 1024; // 64 MB stacks to avoid overflow on large maps
    let mut handles = Vec::new();

    for _ in 0..num_threads {
        let shared = shared.clone();
        let contours = contours.clone();
        let terrain = terrain.clone();
        let bounds = bounds.clone();
        let config = config.clone();
        let wp = wp.clone();

        let handle = std::thread::Builder::new()
            .stack_size(stack_size)
            .spawn(move || {
                loop {
                    let seed = {
                        let mut seeds = shared.seeds.lock().unwrap();
                        loop {
                            if let Some(s) = seeds.pop() {
                                break Some(s);
                            }
                            if *shared.done.lock().unwrap() {
                                break None;
                            }
                            seeds = shared.condvar.wait_timeout(
                                seeds, std::time::Duration::from_millis(10)
                            ).unwrap().0;
                            if *shared.done.lock().unwrap() {
                                break None;
                            }
                        }
                    };

                    let mut seed = match seed {
                        Some(s) => s,
                        None => return,
                    };

                    if seed.track_id < 0 {
                        seed.track_id = shared.next_track_id.fetch_add(1, Ordering::Relaxed);
                    }

                    let (track, child_seeds, stats, refractions, clamped, verts) =
                        march_single_track(
                            seed, &wp, &bounds, &terrain, &contours, &config,
                        );

                    shared.total_splits.fetch_add(stats.splits, Ordering::Relaxed);
                    shared.total_merges.fetch_add(stats.merges, Ordering::Relaxed);
                    shared.total_refractions.fetch_add(refractions, Ordering::Relaxed);
                    shared.turn_clamp_count.fetch_add(clamped, Ordering::Relaxed);
                    shared.marched_verts.fetch_add(verts, Ordering::Relaxed);

                    let child_ids: Vec<i32> = child_seeds
                        .iter()
                        .map(|_| shared.next_track_id.fetch_add(1, Ordering::Relaxed))
                        .collect();

                    let mut final_track = track;
                    final_track.child_track_ids = child_ids.clone();

                    let dec = decimate_track_snapshots(
                        &final_track, &wp,
                        config.decimation.tolerance,
                    );
                    shared.removed_snapshots.fetch_add(dec.removed_snapshots, Ordering::Relaxed);
                    shared.removed_vertices.fetch_add(dec.removed_vertices, Ordering::Relaxed);

                    shared.all_tracks.lock().unwrap().push(dec.track);
                    let done = shared.tracks_done.fetch_add(1, Ordering::Relaxed) + 1;
                    if done % 500 == 0 {
                        eprintln!("    [march] {} tracks done ({:.1}s)",
                            done, start.elapsed().as_secs_f64());
                    }

                    let num_children = child_seeds.len() as u64;
                    if num_children > 0 {
                        shared.in_flight.fetch_add(num_children, Ordering::Release);
                        let mut seeds = shared.seeds.lock().unwrap();
                        for (mut child, &id) in child_seeds.into_iter().zip(child_ids.iter()) {
                            child.track_id = id;
                            seeds.push(child);
                        }
                        drop(seeds);
                        shared.condvar.notify_all();
                    }

                    let remaining = shared.in_flight.fetch_sub(1, Ordering::AcqRel) - 1;
                    if remaining == 0 {
                        *shared.done.lock().unwrap() = true;
                        shared.condvar.notify_all();
                    }
                }
            })
            .expect("failed to spawn thread");
        handles.push(handle);
    }

    for h in handles {
        h.join().expect("worker thread panicked");
    }

    let final_marched_verts = shared.marched_verts.load(std::sync::atomic::Ordering::Relaxed);
    let final_removed_snapshots = shared.removed_snapshots.load(std::sync::atomic::Ordering::Relaxed);
    let final_removed_vertices = shared.removed_vertices.load(std::sync::atomic::Ordering::Relaxed);
    let final_splits = shared.total_splits.load(std::sync::atomic::Ordering::Relaxed);
    let final_merges = shared.total_merges.load(std::sync::atomic::Ordering::Relaxed);
    let final_turn_clamp = shared.turn_clamp_count.load(std::sync::atomic::Ordering::Relaxed);
    let final_refractions = shared.total_refractions.load(std::sync::atomic::Ordering::Relaxed);

    let mut tracks = Arc::try_unwrap(shared)
        .ok()
        .expect("all threads should have joined")
        .all_tracks
        .into_inner()
        .unwrap();
    tracks.sort_by_key(|t| t.track_id);

    let total_elapsed = start.elapsed();
    eprintln!(
        "    [marching] complete — {} tracks, {:.1}s total",
        tracks.len(),
        total_elapsed.as_secs_f64(),
    );

    MarchResult {
        tracks,
        marched_vertices_before_decimation: final_marched_verts,
        removed_snapshots: final_removed_snapshots,
        removed_vertices: final_removed_vertices,
        splits: final_splits,
        merges: final_merges,
        turn_clamp_count: final_turn_clamp,
        total_refractions: final_refractions,
    }
}
