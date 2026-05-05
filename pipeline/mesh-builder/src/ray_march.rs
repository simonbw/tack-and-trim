//! Wavefront marching — initial wavefront generation, per-track marching,
//! and parallel orchestration via concurrent work queue.
//! Mirrors marching.ts.

use std::collections::HashMap;
use std::sync::atomic::AtomicUsize;

use rayon::prelude::*;

use crate::config::MeshBuildConfig;
use crate::decimate::decimate_track_snapshots;
use crate::physics::{advance_interior_ray, advance_sentinel_ray, RayState};
use crate::refine::{refine_wavefront, RefineStats};
use pipeline_core::level::TerrainCPUData;
use pipeline_core::terrain::{ContourLookupGrid, ParsedContour};
use crate::wavefront::{
    SegmentTrack, SegmentTrackSnapshot, WaveBounds, WaveParams, WavefrontSegment,
};

// ── Initial wavefront ────────────────────────────────────────────────────────

/// Generate the initial wavefront with left/right sentinels and evenly-spaced
/// interior rays spanning the perpendicular extent of the wave bounds.
pub fn generate_initial_wavefront(bounds: &WaveBounds, wp: &WaveParams) -> WavefrontSegment {
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
        0.0,
        wp.wave_dx,
        wp.wave_dy,
        1.0,
        0.0,
        wp.wavelength,
        0.0,
        0.0,
        0.0,
    );

    // Interior rays
    for i in 0..num_interior {
        let ti = (i + 1) as f64 / (num_interior + 1) as f64;
        let perp_pos = bounds.min_perp + (i as f64 / (num_interior - 1) as f64) * width;
        wf.push(
            bounds.min_proj * wp.wave_dx + perp_pos * wp.perp_dx,
            bounds.min_proj * wp.wave_dy + perp_pos * wp.perp_dy,
            ti,
            wp.wave_dx,
            wp.wave_dy,
            1.0,
            0.0,
            0.0,
            f64::NAN,
            f64::NAN,
            0.0,
        );
    }

    // Right sentinel
    let right_perp = bounds.max_perp;
    wf.push(
        bounds.min_proj * wp.wave_dx + right_perp * wp.perp_dx,
        bounds.min_proj * wp.wave_dy + right_perp * wp.perp_dy,
        1.0,
        wp.wave_dx,
        wp.wave_dy,
        1.0,
        0.0,
        wp.wavelength,
        0.0,
        0.0,
        0.0,
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
        nx: f64,
        ny: f64,
        t: f64,
        dir_x: f64,
        dir_y: f64,
        energy: f64,
        turbulence: f64,
        depth: f64,
        terrain_grad_x: f64,
        terrain_grad_y: f64,
        is_sentinel: bool,
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
    lookup_grid: &ContourLookupGrid,
    config: &MeshBuildConfig,
    stats: &mut RefineStats,
) -> Vec<WavefrontSegment> {
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
                        nx: sr.nx,
                        ny: sr.ny,
                        t: pt,
                        dir_x: wp.wave_dx,
                        dir_y: wp.wave_dy,
                        energy: 1.0,
                        turbulence: 0.0,
                        depth: wp.wavelength,
                        terrain_grad_x: 0.0,
                        terrain_grad_y: 0.0,
                        is_sentinel: true,
                    },
                    None => RayStepOutcome::Gap,
                };
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

            match advance_interior_ray(
                &ray,
                wp,
                bounds,
                breaking_depth,
                &config.physics,
                terrain,
                contours,
                lookup_grid,
            ) {
                Some(ir) => RayStepOutcome::Advanced {
                    nx: ir.nx,
                    ny: ir.ny,
                    t: pt,
                    dir_x: ir.dir_x,
                    dir_y: ir.dir_y,
                    energy: ir.energy,
                    turbulence: ir.turbulence,
                    depth: ir.depth,
                    terrain_grad_x: ir.terrain_grad_x,
                    terrain_grad_y: ir.terrain_grad_y,
                    is_sentinel: false,
                },
                None => RayStepOutcome::Gap,
            }
        })
        .collect();

    // ── Pass 2: sequential assembly with split/flush logic ──────────────────
    let mut raw_segments: Vec<WavefrontSegment> = Vec::new();

    let mut current =
        WavefrontSegment::with_capacity(-1, parent_track_id, next_source_step, src_len);

    let flush = |current: &mut WavefrontSegment, raw_segments: &mut Vec<WavefrontSegment>| {
        if current.len() == 0 {
            return;
        }
        raw_segments.push(std::mem::replace(
            current,
            WavefrontSegment::with_capacity(-1, parent_track_id, next_source_step, src_len),
        ));
    };

    for outcome in &outcomes {
        match outcome {
            RayStepOutcome::Gap => {
                flush(&mut current, &mut raw_segments);
            }
            RayStepOutcome::Advanced {
                nx,
                ny,
                t,
                dir_x,
                dir_y,
                energy,
                turbulence,
                depth,
                terrain_grad_x,
                terrain_grad_y,
                is_sentinel,
            } => {
                // Energy ratio check → segment break (skip for sentinels)
                if !is_sentinel && !current.energy.is_empty() {
                    let prev_e = *current.energy.last().unwrap();
                    let ratio = if *energy > prev_e {
                        energy / prev_e
                    } else {
                        prev_e / energy
                    };
                    if ratio > config.refinement.max_energy_ratio {
                        flush(&mut current, &mut raw_segments);
                    }
                }

                current.push(
                    *nx,
                    *ny,
                    *t,
                    *dir_x,
                    *dir_y,
                    *energy,
                    *turbulence,
                    *depth,
                    *terrain_grad_x,
                    *terrain_grad_y,
                    0.0,
                );
            }
        }
    }

    flush(&mut current, &mut raw_segments);

    // ── Pass 3: refine assembled segments (parallel if we have multiple) ────
    let refined: Vec<(WavefrontSegment, RefineStats)> = if raw_segments.len() <= 1 {
        raw_segments
            .into_iter()
            .map(|seg| {
                refine_wavefront(
                    seg,
                    wp.vertex_spacing,
                    wp.initial_delta_t,
                    &config.refinement,
                )
            })
            .collect()
    } else {
        raw_segments
            .into_par_iter()
            .map(|seg| {
                refine_wavefront(
                    seg,
                    wp.vertex_spacing,
                    wp.initial_delta_t,
                    &config.refinement,
                )
            })
            .collect()
    };

    let mut produced: Vec<WavefrontSegment> = Vec::with_capacity(refined.len());
    for (seg, local_stats) in refined {
        stats.splits += local_stats.splits;
        stats.merges += local_stats.merges;
        produced.push(seg);
    }

    produced
}

// ── March a single track to completion ───────────────────────────────────────

type TrackResult = (
    SegmentTrack,
    Vec<WavefrontSegment>, // child seeds
    RefineStats,
    u64, // marched verts
);

fn march_single_track(
    seed: WavefrontSegment,
    wp: &WaveParams,
    bounds: &WaveBounds,
    terrain: &TerrainCPUData,
    contours: &[ParsedContour],
    lookup_grid: &ContourLookupGrid,
    config: &MeshBuildConfig,
) -> TrackResult {
    let breaking_depth = config.physics.breaking_depth_ratio * wp.wavelength;

    let mut stats = RefineStats {
        splits: 0,
        merges: 0,
    };
    let mut marched_verts = seed.len() as u64;

    let mut track = SegmentTrack {
        track_id: seed.track_id,
        parent_track_id: seed.parent_track_id,
        child_track_ids: vec![],
        snapshots: vec![SegmentTrackSnapshot {
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
        let produced = advance_track_segment_step(
            &segment,
            Some(track.track_id),
            wp,
            bounds,
            breaking_depth,
            terrain,
            contours,
            lookup_grid,
            config,
            &mut stats,
        );

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
                segment: next_seg.clone(),
            });
            segment = next_seg;
            continue;
        }

        // Split: multiple segments produced.
        // Do not post-process children here; each child track post-processes its
        // seed exactly once at track start.
        for child in produced {
            marched_verts += child.len() as u64;
            child_seeds.push(child);
        }
        break;
    }

    (track, child_seeds, stats, marched_verts)
}

fn post_process_segments(
    segments: &mut [&mut WavefrontSegment],
    wp: &WaveParams,
    config: &crate::config::MeshBuildPostConfig,
) {
    let spacing_per_t = wp.vertex_spacing / wp.initial_delta_t;

    for seg in segments.iter_mut() {
        let n = seg.len();
        if n == 0 {
            continue;
        }

        for i in 0..n {
            if seg.t[i] == 0.0 || seg.t[i] == 1.0 {
                seg.amplitude[i] = 1.0;
                continue;
            }

            let p_depth = seg.depth[i];
            let kh = wp.k * p_depth;
            let shoaling = if p_depth > 0.0 {
                let s = if kh > 10.0 {
                    1.0
                } else {
                    let sinh2kh = (2.0 * kh).sinh();
                    let n_val = 0.5 * (1.0 + (2.0 * kh) / sinh2kh);
                    1.0 / (2.0 * n_val * kh.tanh()).sqrt()
                };
                s.min(config.max_amplification)
            } else {
                1.0
            };

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
            let divergence = (expected / local_spacing)
                .sqrt()
                .min(config.max_amplification);
            seg.amplitude[i] = seg.energy[i] * shoaling * divergence;
        }
    }

    // Diffraction
    let d = (wp.step_size / (2.0 * wp.k * wp.vertex_spacing * wp.vertex_spacing))
        .min(config.max_diffusion_d);
    let mut scratch = Vec::new();

    for seg in segments.iter_mut() {
        let n = seg.len();
        if n <= 1 {
            continue;
        }

        let edge_threshold = wp.initial_delta_t * 0.5;
        let left_is_edge = seg.t[0] < edge_threshold;
        let right_is_edge = seg.t[n - 1] > 1.0 - edge_threshold;

        scratch.resize(n, 0.0);
        for _ in 0..config.diffraction_iterations {
            scratch[..n].copy_from_slice(&seg.amplitude[..n]);
            for i in 0..n {
                let left = if i > 0 {
                    scratch[i - 1]
                } else if left_is_edge {
                    1.0
                } else {
                    0.0
                };
                let right = if i < n - 1 {
                    scratch[i + 1]
                } else if right_is_edge {
                    1.0
                } else {
                    0.0
                };
                seg.amplitude[i] = (scratch[i] + d * (left - 2.0 * scratch[i] + right)).max(0.0);
            }
        }
    }

    // Turbulence diffusion
    for seg in segments.iter_mut() {
        let n = seg.len();
        if n <= 2 {
            continue;
        }
        scratch.resize(n, 0.0);
        for _ in 0..config.turbulence_diffusion_iterations {
            scratch[..n].copy_from_slice(&seg.turbulence[..n]);
            for i in 0..n {
                let left = if i > 0 { scratch[i - 1] } else { 0.0 };
                let right = if i < n - 1 { scratch[i + 1] } else { 0.0 };
                seg.turbulence[i] = (scratch[i]
                    + config.turbulence_diffusion_d * (left - 2.0 * scratch[i] + right))
                    .max(0.0);
            }
        }
    }
}

// ── Parallel march orchestration ─────────────────────────────────────────────

/// Aggregated results from marching all wavefronts for a single wave source.
/// Reorder tracks in deterministic DFS order based on the parent-child tree.
/// This eliminates dependence on rayon scheduling order for track_id assignment.
fn reorder_tracks_deterministic(mut tracks: Vec<SegmentTrack>) -> Vec<SegmentTrack> {
    if tracks.is_empty() {
        return tracks;
    }

    // Build a map from old track_id → index in the tracks vec.
    let id_to_idx: HashMap<i32, usize> = tracks
        .iter()
        .enumerate()
        .map(|(i, t)| (t.track_id, i))
        .collect();

    // Sort each track's children by the midpoint of their first snapshot's t range.
    // This is deterministic because t values come from geometry, not scheduling.
    for i in 0..tracks.len() {
        let child_ids = tracks[i].child_track_ids.clone();
        if child_ids.len() <= 1 {
            continue;
        }
        let mut children_with_key: Vec<(i32, f64)> = child_ids
            .iter()
            .map(|&cid| {
                let midpoint = id_to_idx.get(&cid).map_or(0.0, |&idx| {
                    let snap = &tracks[idx].snapshots;
                    if snap.is_empty() || snap[0].segment.t.is_empty() {
                        0.0
                    } else {
                        let t = &snap[0].segment.t;
                        (t[0] + t[t.len() - 1]) / 2.0
                    }
                });
                (cid, midpoint)
            })
            .collect();
        children_with_key
            .sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        tracks[i].child_track_ids = children_with_key.iter().map(|&(id, _)| id).collect();
    }

    // DFS from root (the track with parent_track_id == None).
    let root_idx = tracks
        .iter()
        .position(|t| t.parent_track_id.is_none())
        .expect("no root track found");

    let mut visit_order: Vec<usize> = Vec::with_capacity(tracks.len());
    let mut stack: Vec<usize> = vec![root_idx];
    while let Some(idx) = stack.pop() {
        visit_order.push(idx);
        // Push children in reverse so leftmost child is visited first.
        let child_ids = &tracks[idx].child_track_ids;
        for &cid in child_ids.iter().rev() {
            if let Some(&cidx) = id_to_idx.get(&cid) {
                stack.push(cidx);
            }
        }
    }

    debug_assert_eq!(
        visit_order.len(),
        tracks.len(),
        "DFS did not visit all tracks: visited {} of {}",
        visit_order.len(),
        tracks.len()
    );

    // Build old_id → new_id mapping.
    let mut old_to_new: HashMap<i32, i32> = HashMap::with_capacity(tracks.len());
    for (new_id, &old_idx) in visit_order.iter().enumerate() {
        old_to_new.insert(tracks[old_idx].track_id, new_id as i32);
    }

    // Extract tracks in DFS order using indices (avoids ownership issues).
    // We swap-remove from the end to avoid shifting, but we need stable indices,
    // so instead we'll use a temporary vec of Options.
    let mut slots: Vec<Option<SegmentTrack>> = tracks.into_iter().map(Some).collect();
    let mut ordered: Vec<SegmentTrack> = Vec::with_capacity(visit_order.len());

    for &idx in &visit_order {
        let mut track = slots[idx].take().unwrap();
        track.track_id = old_to_new[&track.track_id];
        track.parent_track_id = track.parent_track_id.map(|pid| old_to_new[&pid]);
        track.child_track_ids = track
            .child_track_ids
            .iter()
            .map(|&cid| old_to_new[&cid])
            .collect();
        ordered.push(track);
    }

    ordered
}

pub struct MarchResult {
    pub tracks: Vec<SegmentTrack>,
    pub marched_vertices_before_decimation: u64,
    pub splits: u64,
    pub merges: u64,
}

/// March all wavefronts using rayon::scope_fifo for track-level scheduling
/// and rayon par_iter for ray-level parallelism within each step.
pub fn march_wavefronts(
    first_wavefront: WavefrontSegment,
    wp: &WaveParams,
    bounds: &WaveBounds,
    terrain: &TerrainCPUData,
    contours: &[ParsedContour],
    lookup_grid: &ContourLookupGrid,
    config: &MeshBuildConfig,
    progress: Option<&AtomicUsize>,
) -> MarchResult {
    use std::sync::atomic::{AtomicI32, AtomicU64, Ordering};
    use std::sync::Mutex;

    let mut wp = wp.clone();
    wp.initial_delta_t = if first_wavefront.len() > 2 {
        first_wavefront.t[2] - first_wavefront.t[1]
    } else if first_wavefront.len() > 1 {
        first_wavefront.t[1] - first_wavefront.t[0]
    } else {
        1.0
    };

    let next_track_id = AtomicI32::new(first_wavefront.track_id + 1);
    let all_tracks: Mutex<Vec<SegmentTrack>> = Mutex::new(Vec::new());
    let total_splits = AtomicU64::new(0);
    let total_merges = AtomicU64::new(0);
    let marched_verts = AtomicU64::new(0);

    // Process a single track end-to-end: march all steps (with par_iter on rays),
    // spawn child tracks first, then queue decimation work.
    fn process_track<'scope>(
        s: &rayon::ScopeFifo<'scope>,
        mut seed: WavefrontSegment,
        wp: &'scope WaveParams,
        bounds: &'scope WaveBounds,
        terrain: &'scope TerrainCPUData,
        contours: &'scope [ParsedContour],
        lookup_grid: &'scope ContourLookupGrid,
        config: &'scope MeshBuildConfig,
        next_track_id: &'scope AtomicI32,
        all_tracks: &'scope Mutex<Vec<SegmentTrack>>,
        total_splits: &'scope AtomicU64,
        total_merges: &'scope AtomicU64,
        marched_verts: &'scope AtomicU64,
        progress: Option<&'scope AtomicUsize>,
    ) {
        if seed.track_id < 0 {
            seed.track_id = next_track_id.fetch_add(1, Ordering::Relaxed);
        }

        let (track, child_seeds, stats, verts) =
            march_single_track(seed, wp, bounds, terrain, contours, lookup_grid, config);

        total_splits.fetch_add(stats.splits, Ordering::Relaxed);
        total_merges.fetch_add(stats.merges, Ordering::Relaxed);
        marched_verts.fetch_add(verts, Ordering::Relaxed);

        // Assign IDs and spawn child tracks immediately
        let child_ids: Vec<i32> = child_seeds
            .iter()
            .map(|_| next_track_id.fetch_add(1, Ordering::Relaxed))
            .collect();

        for (mut child, &id) in child_seeds.into_iter().zip(child_ids.iter()) {
            child.track_id = id;
            s.spawn_fifo(move |s| {
                process_track(
                    s,
                    child,
                    wp,
                    bounds,
                    terrain,
                    contours,
                    lookup_grid,
                    config,
                    next_track_id,
                    all_tracks,
                    total_splits,
                    total_merges,
                    marched_verts,
                    progress,
                );
            });
        }

        let mut final_track = track;
        final_track.child_track_ids = child_ids;

        // Queue decimation after child marches so FIFO scheduling tends to
        // prioritize frontier expansion before cleanup.
        let tolerance = config.decimation.tolerance;
        s.spawn_fifo(move |_| {
            let decimated = decimate_track_snapshots(final_track, wp, tolerance);
            all_tracks.lock().unwrap().push(decimated);
            if let Some(p) = progress {
                p.fetch_add(1, Ordering::Relaxed);
            }
        });
    }

    rayon::scope_fifo(|s| {
        s.spawn_fifo(|s| {
            process_track(
                s,
                first_wavefront,
                &wp,
                bounds,
                terrain,
                contours,
                lookup_grid,
                config,
                &next_track_id,
                &all_tracks,
                &total_splits,
                &total_merges,
                &marched_verts,
                progress,
            );
        });
    }); // blocks until all tracks (including children) are done

    let tracks = all_tracks.into_inner().unwrap();
    let tracks = reorder_tracks_deterministic(tracks);

    MarchResult {
        tracks,
        marched_vertices_before_decimation: marched_verts.into_inner(),
        splits: total_splits.into_inner(),
        merges: total_merges.into_inner(),
    }
}
