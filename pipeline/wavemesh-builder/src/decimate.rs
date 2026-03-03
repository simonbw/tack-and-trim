//! Segment and track-level decimation.
//! Mirrors decimateSegment.ts and decimateWavefrontTracks.ts.

use rayon::prelude::*;

use crate::wavefront::{SegmentTrack, SegmentTrackSnapshot, WaveParams, WavefrontSegment};

fn lerp(a: f64, b: f64, f: f64) -> f64 {
    a + (b - a) * f
}

// ── Segment-level decimation ─────────────────────────────────────────────────

fn build_segment_from_kept(seg: &WavefrontSegment, kept: &[usize]) -> WavefrontSegment {
    let mut out = WavefrontSegment::with_capacity(
        seg.track_id,
        seg.parent_track_id,
        seg.source_step_index,
        kept.len(),
    );
    for &idx in kept {
        out.push(
            seg.x[idx],
            seg.y[idx],
            seg.t[idx],
            if !seg.dir_x.is_empty() {
                seg.dir_x[idx]
            } else {
                0.0
            },
            if !seg.dir_y.is_empty() {
                seg.dir_y[idx]
            } else {
                0.0
            },
            if !seg.energy.is_empty() {
                seg.energy[idx]
            } else {
                0.0
            },
            seg.turbulence[idx],
            if !seg.depth.is_empty() {
                seg.depth[idx]
            } else {
                0.0
            },
            if !seg.terrain_grad_x.is_empty() {
                seg.terrain_grad_x[idx]
            } else {
                0.0
            },
            if !seg.terrain_grad_y.is_empty() {
                seg.terrain_grad_y[idx]
            } else {
                0.0
            },
            seg.amplitude[idx],
            seg.blend[idx],
        );
    }
    out
}


/// Decimate a single segment using Imai-Iri shortest-path DP with slope-interval
/// pruning for O(n × avg_reach) performance.
///
/// For each source vertex, we track the range of valid slopes (one interval per
/// property) that satisfy all intermediate vertices seen so far. Each new
/// intermediate narrows the intervals in O(1). When any interval becomes empty,
/// no future endpoint can work — we break provably, not heuristically.
pub fn decimate_segment(seg: &WavefrontSegment, pos_tol_sq: f64, amp_tol: f64) -> WavefrontSegment {
    let n = seg.len();
    if n <= 2 {
        return seg.clone();
    }

    let pos_tol = pos_tol_sq.sqrt();

    let mut dist = vec![u32::MAX; n];
    let mut prev = vec![0usize; n];
    dist[0] = 0;

    for i in 0..n - 1 {
        if dist[i] == u32::MAX {
            continue;
        }
        let d = dist[i] + 1;

        let ti = seg.t[i];
        let xi = seg.x[i];
        let yi = seg.y[i];
        let ai = seg.amplitude[i];
        let turbi = seg.turbulence[i];
        let bi = seg.blend[i];

        // Slope intervals: valid range of (value[j] - value[i]) / (t[j] - t[i])
        let mut sx_min = f64::NEG_INFINITY;
        let mut sx_max = f64::INFINITY;
        let mut sy_min = f64::NEG_INFINITY;
        let mut sy_max = f64::INFINITY;
        let mut sa_min = f64::NEG_INFINITY;
        let mut sa_max = f64::INFINITY;
        let mut st_min = f64::NEG_INFINITY;
        let mut st_max = f64::INFINITY;
        let mut sb_min = f64::NEG_INFINITY;
        let mut sb_max = f64::INFINITY;

        for j in (i + 1)..n {
            // Check edge i→j: intervals reflect constraints from intermediates i+1..j-1
            let dt = seg.t[j] - ti;
            let inv_dt = if dt > 0.0 { 1.0 / dt } else { 0.0 };

            let slope_x = (seg.x[j] - xi) * inv_dt;
            let slope_y = (seg.y[j] - yi) * inv_dt;
            let slope_a = (seg.amplitude[j] - ai) * inv_dt;
            let slope_t = (seg.turbulence[j] - turbi) * inv_dt;
            let slope_b = (seg.blend[j] - bi) * inv_dt;

            let edge_exists = slope_x >= sx_min
                && slope_x <= sx_max
                && slope_y >= sy_min
                && slope_y <= sy_max
                && slope_a >= sa_min
                && slope_a <= sa_max
                && slope_t >= st_min
                && slope_t <= st_max
                && slope_b >= sb_min
                && slope_b <= sb_max;

            if edge_exists && d < dist[j] {
                dist[j] = d;
                prev[j] = i;
            }

            // Narrow intervals using vertex j as intermediate for future edges
            let pos_inv = pos_tol * inv_dt;
            let amp_inv = amp_tol * inv_dt;

            sx_min = sx_min.max(slope_x - pos_inv);
            sx_max = sx_max.min(slope_x + pos_inv);
            sy_min = sy_min.max(slope_y - pos_inv);
            sy_max = sy_max.min(slope_y + pos_inv);
            sa_min = sa_min.max(slope_a - amp_inv);
            sa_max = sa_max.min(slope_a + amp_inv);
            st_min = st_min.max(slope_t - amp_inv);
            st_max = st_max.min(slope_t + amp_inv);
            sb_min = sb_min.max(slope_b - amp_inv);
            sb_max = sb_max.min(slope_b + amp_inv);

            if sx_min > sx_max
                || sy_min > sy_max
                || sa_min > sa_max
                || st_min > st_max
                || sb_min > sb_max
            {
                break;
            }
        }
    }

    // Reconstruct path
    let mut kept = Vec::new();
    let mut cur = n - 1;
    while cur != 0 {
        kept.push(cur);
        cur = prev[cur];
    }
    kept.push(0);
    kept.reverse();

    if kept.len() == n {
        return seg.clone();
    }
    build_segment_from_kept(seg, &kept)
}

// ── Track-level decimation ───────────────────────────────────────────────────

struct SegmentSample {
    x: f64,
    y: f64,
    amplitude: f64,
    turbulence: f64,
    blend: f64,
}

/// Forward-only sampler for monotonically increasing t queries on a segment.
/// Maintains a cursor to avoid binary search, giving O(1) amortized per query.
struct SegmentScanner<'a> {
    seg: &'a WavefrontSegment,
    cursor: usize,
    n: usize,
    t_min: f64,
    t_max: f64,
}

impl<'a> SegmentScanner<'a> {
    fn new(seg: &'a WavefrontSegment) -> Self {
        let n = seg.len();
        let (t_min, t_max) = if n > 0 {
            (seg.t[0], seg.t[n - 1])
        } else {
            (0.0, 0.0)
        };
        SegmentScanner {
            seg,
            cursor: 0,
            n,
            t_min,
            t_max,
        }
    }

    /// Sample interpolated values at t. Queries must be monotonically increasing.
    fn sample(&mut self, t: f64) -> Option<SegmentSample> {
        if self.n == 0 {
            return None;
        }
        if t < self.t_min - 1e-9 || t > self.t_max + 1e-9 {
            return None;
        }

        if t <= self.t_min {
            return Some(SegmentSample {
                x: self.seg.x[0],
                y: self.seg.y[0],
                amplitude: self.seg.amplitude[0],
                turbulence: self.seg.turbulence[0],
                blend: self.seg.blend[0],
            });
        }
        if t >= self.t_max {
            let i = self.n - 1;
            return Some(SegmentSample {
                x: self.seg.x[i],
                y: self.seg.y[i],
                amplitude: self.seg.amplitude[i],
                turbulence: self.seg.turbulence[i],
                blend: self.seg.blend[i],
            });
        }

        // Advance cursor forward until we bracket t
        while self.cursor < self.n - 2 && self.seg.t[self.cursor + 1] <= t {
            self.cursor += 1;
        }

        let left = self.cursor;
        let right = left + 1;
        let span = self.seg.t[right] - self.seg.t[left];
        let f = if span > 0.0 {
            (t - self.seg.t[left]) / span
        } else {
            0.0
        };
        Some(SegmentSample {
            x: lerp(self.seg.x[left], self.seg.x[right], f),
            y: lerp(self.seg.y[left], self.seg.y[right], f),
            amplitude: lerp(self.seg.amplitude[left], self.seg.amplitude[right], f),
            turbulence: lerp(self.seg.turbulence[left], self.seg.turbulence[right], f),
            blend: lerp(self.seg.blend[left], self.seg.blend[right], f),
        })
    }
}

fn normalized_error(error: f64, tolerance: f64) -> f64 {
    if tolerance <= 0.0 {
        return if error == 0.0 { 0.0 } else { f64::INFINITY };
    }
    error / tolerance
}

#[allow(clippy::too_many_arguments)]
fn evaluate_snapshot_removal(
    track: &SegmentTrack,
    snapshot_idx: usize,
    anchor_idx: usize,
    endpoint_idx: usize,
    k: f64,
    wave_dx: f64,
    wave_dy: f64,
    pos_tol_sq: f64,
    amp_tol: f64,
    phase_tol: f64,
    phase_per_step: f64,
) -> bool {
    let snapshot = &track.snapshots[snapshot_idx].segment;
    let anchor = &track.snapshots[anchor_idx].segment;
    let endpoint = &track.snapshots[endpoint_idx].segment;
    let span = endpoint_idx - anchor_idx;
    if span <= 1 {
        return false;
    }

    let fraction = (snapshot_idx - anchor_idx) as f64 / span as f64;
    let step_phase_base = snapshot.source_step_index as f64 * phase_per_step;
    let anchor_phase_base = anchor.source_step_index as f64 * phase_per_step;
    let endpoint_phase_base = endpoint.source_step_index as f64 * phase_per_step;

    let mut anchor_scan = SegmentScanner::new(anchor);
    let mut endpoint_scan = SegmentScanner::new(endpoint);

    for i in 0..snapshot.len() {
        let pt = snapshot.t[i];
        let a = match anchor_scan.sample(pt) {
            Some(s) => s,
            None => return false,
        };
        let e = match endpoint_scan.sample(pt) {
            Some(s) => s,
            None => return false,
        };

        let ix = lerp(a.x, e.x, fraction);
        let iy = lerp(a.y, e.y, fraction);
        let dx = snapshot.x[i] - ix;
        let dy = snapshot.y[i] - iy;
        if normalized_error(dx * dx + dy * dy, pos_tol_sq) > 1.0 {
            return false;
        }

        let i_amp = lerp(a.amplitude, e.amplitude, fraction);
        if normalized_error((snapshot.amplitude[i] - i_amp).abs(), amp_tol) > 1.0 {
            return false;
        }

        let i_turb = lerp(a.turbulence, e.turbulence, fraction);
        if normalized_error((snapshot.turbulence[i] - i_turb).abs(), amp_tol) > 1.0 {
            return false;
        }

        let i_blend = lerp(a.blend, e.blend, fraction);
        if normalized_error((snapshot.blend[i] - i_blend).abs(), amp_tol) > 1.0 {
            return false;
        }

        let actual_phase =
            step_phase_base - k * (snapshot.x[i] * wave_dx + snapshot.y[i] * wave_dy);
        let anchor_phase = anchor_phase_base - k * (a.x * wave_dx + a.y * wave_dy);
        let endpoint_phase = endpoint_phase_base - k * (e.x * wave_dx + e.y * wave_dy);
        let i_phase = lerp(anchor_phase, endpoint_phase, fraction);
        if normalized_error((actual_phase - i_phase).abs(), phase_tol) > 1.0 {
            return false;
        }
    }
    true
}

#[allow(clippy::too_many_arguments)]
fn keep_mask_for_track(
    track: &SegmentTrack,
    k: f64,
    wave_dx: f64,
    wave_dy: f64,
    pos_tol_sq: f64,
    amp_tol: f64,
    phase_tol: f64,
    phase_per_step: f64,
) -> Vec<bool> {
    let len = track.snapshots.len();
    if len <= 2 {
        return vec![true; len];
    }

    let mut keep = vec![false; len];
    keep[0] = true;
    keep[len - 1] = true;

    let mut anchor = 0;
    let mut endpoint = 2;

    while endpoint < len {
        let removable = evaluate_snapshot_removal(
            track,
            endpoint - 1,
            anchor,
            endpoint,
            k,
            wave_dx,
            wave_dy,
            pos_tol_sq,
            amp_tol,
            phase_tol,
            phase_per_step,
        );
        if removable {
            if endpoint == len - 1 {
                break;
            }
            endpoint += 1;
        } else {
            keep[endpoint - 1] = true;
            anchor = endpoint - 1;
            endpoint = anchor + 2;
        }
    }
    keep
}

/// Result of decimating a single segment track.
pub struct SingleTrackDecimationResult {
    pub track: SegmentTrack,
    pub removed_snapshots: u64,
    pub removed_vertices: u64,
}

/// Decimate a track by removing snapshots and vertices that can be linearly
/// interpolated within the given tolerance.
pub fn decimate_track_snapshots(
    track: &SegmentTrack,
    wp: &WaveParams,
    tolerance: f64,
) -> SingleTrackDecimationResult {
    let k = wp.k;
    let pos_tol_sq = (tolerance * wp.wavelength).powi(2);
    let amp_tol = tolerance;
    let phase_tol = tolerance * std::f64::consts::PI;

    let mut verts_before: u64 = 0;
    for snap in &track.snapshots {
        verts_before += snap.segment.len() as u64;
    }

    let keep_mask = keep_mask_for_track(
        track,
        k,
        wp.wave_dx,
        wp.wave_dy,
        pos_tol_sq,
        amp_tol,
        phase_tol,
        wp.phase_per_step,
    );

    let removed_snapshots = keep_mask.iter().filter(|&&k| !k).count() as u64;

    // Decimate kept snapshots in parallel
    let snapshots: Vec<SegmentTrackSnapshot> = track
        .snapshots
        .par_iter()
        .enumerate()
        .filter(|(i, _)| keep_mask[*i])
        .map(|(_, snap)| {
            let decimated_seg = decimate_segment(&snap.segment, pos_tol_sq, amp_tol);
            SegmentTrackSnapshot {
                step_index: snap.step_index,
                segment_index: snap.segment_index,
                source_step_index: snap.source_step_index,
                segment: decimated_seg,
            }
        })
        .collect();

    let verts_after: u64 = snapshots.iter().map(|s| s.segment.len() as u64).sum();

    SingleTrackDecimationResult {
        track: SegmentTrack {
            track_id: track.track_id,
            parent_track_id: track.parent_track_id,
            child_track_ids: track.child_track_ids.clone(),
            snapshots,
        },
        removed_snapshots,
        removed_vertices: verts_before.saturating_sub(verts_after),
    }
}
